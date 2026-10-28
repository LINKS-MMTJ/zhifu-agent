// 索引持久化
//
// 设计目标（企业语料的现实约束）：
//   - 不能把几 GB 原文一次性读进内存 → 边解析边写盘，流式产出 chunks.ndjson
//   - 不能写一半崩溃留下坏索引 → 先写 .tmp，完成后原子 rename
//   - 向量体积大 → Float32 + base64 编码，比 JSON 数字数组小一个数量级
//   - 需要知道"哪些文件已经入过库" → manifest.json 记录 path/size/mtime/hash
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { quantize } from '../embedding.js';

export const INDEX_VERSION = 3;
export const CHUNKS_FILE = 'chunks.ndjson';
export const MANIFEST_FILE = 'manifest.json';

// 向量以 int8 量化后存盘：单条约 256B，比 Float32 小 4 倍
export function encodeVector(vec) {
  const i8 = vec instanceof Int8Array ? vec : quantize(vec);
  return Buffer.from(i8.buffer, i8.byteOffset, i8.byteLength).toString('base64');
}

export function decodeVector(b64) {
  const buf = Buffer.from(b64, 'base64');
  // 直接复用底层内存，避免逐个元素拷贝
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function manifestPath(dir) { return path.join(dir, MANIFEST_FILE); }

export function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

export function indexMtime(dir) {
  try {
    return fs.statSync(manifestPath(dir)).mtimeMs;
  } catch {
    return 0;
  }
}

export function indexExists(dir) {
  const m = readManifest(dir);
  return Boolean(m && m.version === INDEX_VERSION && fs.existsSync(path.join(dir, CHUNKS_FILE)));
}

export function createIndexWriter(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const chunksPath = path.join(dir, CHUNKS_FILE);
  const tmpPath = `${chunksPath}.tmp`;
  const stream = fs.createWriteStream(tmpPath, { encoding: 'utf8' });

  let pending = Promise.resolve();
  let count = 0;
  let closed = false;
  let streamError = null;
  stream.on('error', (err) => { streamError = err; });

  // 单条写入：处理背压，避免大语料把内存撑爆
  const write = (line) => {
    pending = pending.then(
      () => new Promise((resolve, reject) => {
        if (streamError) return reject(streamError);
        if (stream.write(line)) return resolve();
        stream.once('drain', resolve);
        return undefined;
      })
    );
    return pending;
  };

  return {
    // 写入一条切块，立即落盘，内存占用与语料规模无关
    async add(chunk) {
      if (closed) throw new Error('索引写入已关闭');
      count++;
      await write(`${JSON.stringify(chunk)}\n`);
    },

    // 原样拷贝旧索引中的一行（增量时复用未变更文档，避免重新序列化向量）
    async addRaw(line) {
      if (closed) throw new Error('索引写入已关闭');
      count++;
      await write(`${line}\n`);
    },

    async commit(manifest) {
      if (closed) throw new Error('索引写入已关闭');
      closed = true;
      await pending;
      await new Promise((resolve, reject) => {
        stream.end((err) => (err ? reject(err) : resolve()));
      });

      const full = { ...manifest, version: INDEX_VERSION, builtAt: new Date().toISOString(), chunks: count };
      const mTmp = `${manifestPath(dir)}.tmp`;
      await fsp.writeFile(mTmp, JSON.stringify(full, null, 2), 'utf8');
      await fsp.rename(tmpPath, chunksPath);
      await fsp.rename(mTmp, manifestPath(dir));
      return full;
    },

    async abort() {
      if (closed) return;
      closed = true;
      try {
        await new Promise((resolve) => stream.destroy(resolve));
      } catch {
        // 忽略
      }
      await fsp.rm(tmpPath, { force: true });
    },

    get count() { return count; },
    get dir() { return dir; },
  };
}

// 读取索引：逐行反序列化，避免 JSON.parse 整个大文件
export async function readIndex(dir, { onChunk } = {}) {
  const manifest = readManifest(dir);
  if (!manifest || manifest.version !== INDEX_VERSION) return null;
  const file = path.join(dir, CHUNKS_FILE);
  if (!fs.existsSync(file)) return null;

  const chunks = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      continue;
    }
    rec.vector = decodeVector(rec.v);
    delete rec.v;
    if (onChunk) onChunk(rec);
    chunks.push(rec);
  }
  return { manifest, chunks };
}

export function indexSizeBytes(dir) {
  let total = 0;
  for (const f of [CHUNKS_FILE, MANIFEST_FILE]) {
    try {
      total += fs.statSync(path.join(dir, f)).size;
    } catch {
      // 忽略缺失文件
    }
  }
  return total;
}
