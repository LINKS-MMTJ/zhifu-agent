// 轻量级 embedding：字符 + 字符二元组 哈希计数向量 + L2 归一化
// 无需外部模型即可离线运行，能较好刻画中文语义相似度（用于演示与教学）
// 生产环境可无缝替换为 bge-m3 / 厂商 embedding API（保持 embed() 签名不变即可）
//
// 采用 signed hashing：索引取一个哈希、符号取另一个哈希的最低位，
// 相比直接取模，可显著降低哈希冲突带来的虚假相似度（语料越大越明显）

const DIM = 256;

function hashIndex(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % DIM;
}

function hashSign(str) {
  let g = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    g ^= str.charCodeAt(i);
    g = Math.imul(g, 0x85ebca6b);
  }
  return (g >>> 0) & 1 ? 1 : -1;
}

export function embed(text) {
  const v = new Float32Array(DIM);
  const t = String(text).replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i < t.length; i++) {
    const uni = t[i];
    v[hashIndex(uni)] += hashSign(uni);
    if (i + 1 < t.length) {
      const bi = t.slice(i, i + 2);
      v[hashIndex(bi)] += 1.5 * hashSign(bi); // 二元组权重更高
    }
  }
  let sum = 0;
  for (let i = 0; i < DIM; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

export function cosine(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  // int8 量化向量（±127）相乘后需还原量纲，保证与浮点余弦可比
  const sa = a instanceof Int8Array ? 127 : 1;
  const sb = b instanceof Int8Array ? 127 : 1;
  return d / (sa * sb);
}

// 量化：单位向量 → int8。索引体积与内存占用降到 1/4，排序结果基本不变
export function quantize(vec) {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = Math.round(vec[i] * 127);
    out[i] = v > 127 ? 127 : v < -127 ? -127 : v;
  }
  return out;
}

export { DIM };
