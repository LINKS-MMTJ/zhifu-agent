// 内存向量库：int8 量化向量 + Top-K 检索
// 检索路径做了两件事避免大语料下退化：
//   1. 不生成中间对象（否则 50 万块会产生 50 万个临时对象，GC 直接压垮延迟）
//   2. 只维护 K 个候选做插入排序，而不是把全量结果排序
// 生产可替换为 Chroma / pgvector / Milvus（保持 add/search 接口即可）
import { quantize } from './embedding.js';

export class VectorStore {
  constructor() { this.items = []; }

  add(item) {
    // 统一 int8 量化：内存为浮点的 1/4，点积为整数运算
    const vector = item.vector instanceof Int8Array ? item.vector : quantize(item.vector);
    this.items.push({ ...item, vector });
  }

  // 构建文档级质心，用于大语料下的两级检索（先选文档，再扫块）
  // 切块按文档顺序写入，因此同一文档的块在数组中连续
  finalizeGroups() {
    const map = new Map();
    this.items.forEach((it, i) => {
      const key = it.docId || it.id;
      let g = map.get(key);
      if (!g) {
        g = { key, start: i, end: i + 1, sum: new Int32Array(it.vector.length), count: 0 };
        map.set(key, g);
      }
      g.start = Math.min(g.start, i);
      g.end = Math.max(g.end, i + 1);
      g.count++;
      const v = it.vector;
      for (let d = 0; d < v.length; d++) g.sum[d] += v[d];
    });

    this.groups = [...map.values()].map((g) => {
      const f = new Float32Array(g.sum.length);
      let norm = 0;
      for (let d = 0; d < f.length; d++) {
        f[d] = g.sum[d] / g.count;
        norm += f[d] * f[d];
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < f.length; d++) f[d] /= norm;
      return { docId: g.key, start: g.start, end: g.end, count: g.count, vector: quantize(f) };
    });
    return this.groups.length;
  }

  // 返回参与精排的块下标区间；null 表示全量扫描
  candidateRanges(vec, docLimit) {
    if (!docLimit || !this.groups || this.groups.length <= docLimit) return null;
    const want = Math.min(docLimit, this.groups.length);
    const idx = new Int32Array(want).fill(-1);
    const score = new Float64Array(want).fill(-Infinity);
    const div = vec instanceof Int8Array ? 127 * 127 : 127;
    let filled = 0;

    for (let i = 0; i < this.groups.length; i++) {
      const v = this.groups[i].vector;
      let d = 0;
      const len = Math.min(v.length, vec.length);
      for (let j = 0; j < len; j++) d += v[j] * vec[j];
      const s = d / div;
      if (filled === want && s <= score[want - 1]) continue;
      let pos = filled < want ? filled : want - 1;
      while (pos > 0 && score[pos - 1] < s) {
        score[pos] = score[pos - 1];
        idx[pos] = idx[pos - 1];
        pos--;
      }
      score[pos] = s;
      idx[pos] = i;
      if (filled < want) filled++;
    }

    const ranges = [];
    for (let i = 0; i < filled; i++) {
      const g = this.groups[idx[i]];
      ranges.push([g.start, g.end]);
    }
    return ranges;
  }

  search(vec, k = 4, { filter = null, docLimit = 0 } = {}) {
    const n = this.items.length;
    const want = Math.max(1, Math.min(k, n));
    const topIdx = new Int32Array(want).fill(-1);
    const topScore = new Float64Array(want).fill(-Infinity);
    // 库内向量固定为 int8；查询向量可能是 float32 或 int8
    const div = vec instanceof Int8Array ? 127 * 127 : 127;
    let filled = 0;

    const ranges = this.candidateRanges(vec, docLimit);
    const scanRange = (from, to) => {
      for (let i = from; i < to; i++) {
        const it = this.items[i];
        if (filter && !filter(it)) continue;

        const v = it.vector;
        const len = v.length < vec.length ? v.length : vec.length;
        let d = 0;
        for (let j = 0; j < len; j++) d += v[j] * vec[j];
        const score = d / div;

        if (filled === want && score <= topScore[want - 1]) continue;

        // 插入到有序候选数组
        let pos = filled < want ? filled : want - 1;
        while (pos > 0 && topScore[pos - 1] < score) {
          topScore[pos] = topScore[pos - 1];
          topIdx[pos] = topIdx[pos - 1];
          pos--;
        }
        topScore[pos] = score;
        topIdx[pos] = i;
        if (filled < want) filled++;
      }
    };

    if (ranges) {
      for (const [from, to] of ranges) scanRange(from, to);
    } else {
      scanRange(0, n);
    }

    const out = [];
    for (let i = 0; i < filled; i++) {
      out.push({ ...this.items[topIdx[i]], score: topScore[i] });
    }
    return out;
  }

  size() { return this.items.length; }
}
