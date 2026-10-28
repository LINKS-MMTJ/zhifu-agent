// 知识库文件上传：浏览器 → 落盘 → 增量入库 → 热加载
//
// 与 CLI 入库共用同一条流水线（解析 → 切块 → 向量化 → 原子写索引），
// 区别只在入口：这里把上传文件放进 <源目录>/uploads，再对源目录做增量入库，
// 未变更的文档会直接复用旧切块，所以上传一个文件不会重建整库。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestKnowledge, sha1 } from './ingest/pipeline.js';
import { getLoader, SUPPORTED_EXT, LEGACY_EXT } from './ingest/loaders/index.js';
import { readManifest } from './ingest/indexStore.js';
import { knowledgeInfo, reloadKnowledge } from './knowledge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '../..');

export const MAX_UPLOAD_BYTES = Number(process.env.KB_MAX_UPLOAD_MB || 50) * 1024 * 1024;
export const UPLOAD_EXTENSIONS = SUPPORTED_EXT;

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 源目录：环境变量优先（容器/多知识库场景），否则用仓库自带的 knowledge/
function resolveSourceRoot() {
  if (process.env.KB_SOURCE_DIR) return path.resolve(process.env.KB_SOURCE_DIR);
  const info = knowledgeInfo();
  if (info.root && fs.existsSync(info.root)) return info.root;
  return path.join(SERVER_ROOT, 'knowledge');
}

// 文件名清洗：去掉路径、控制字符与 Windows 非法字符，保留中文，限制长度但保留扩展名
export function safeFileName(raw) {
  let name = String(raw || '').trim();
  try { name = decodeURIComponent(name); } catch { /* 非法转义按原样处理 */ }
  name = name.split(/[\\/]/).pop() || '';
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') name = 'upload';
  const ext = path.extname(name).toLowerCase();
  const base = (name.slice(0, name.length - ext.length) || 'upload').slice(0, 80);
  return `${base}${ext}`;
}

// 串行执行入库：索引是整目录原子重写，两个上传并发跑会互相覆盖
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 保存上传文件并增量入库
 * @returns {Promise<{name,rel,bytes,chunks,title,format,duplicate,totalDocs,totalChunks,durationMs}>}
 */
export async function saveAndIngest(rawName, buffer, {
  maxBytes = MAX_UPLOAD_BYTES, root, outDir, reload = true,
} = {}) {
  const name = safeFileName(rawName);
  const ext = path.extname(name).toLowerCase();
  if (!getLoader(ext)) {
    throw errWithCode(LEGACY_EXT[ext] || `不支持的格式：${ext || '(无扩展名)'}`, 'UNSUPPORTED');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw errWithCode('文件内容为空', 'EMPTY');
  }
  if (buffer.length > maxBytes) {
    throw errWithCode(`文件超过 ${Math.round(maxBytes / 1048576)}MB 上限`, 'TOO_LARGE');
  }

  return enqueue(async () => {
    const srcRoot = root ? path.resolve(root) : resolveSourceRoot();
    const indexDir = outDir ? path.resolve(outDir) : knowledgeInfo().indexDir;
    const uploadDir = path.join(srcRoot, 'uploads');
    await fsp.mkdir(uploadDir, { recursive: true });

    const hash = sha1(buffer);
    let finalName = name;
    let abs = path.join(uploadDir, finalName);
    if (fs.existsSync(abs)) {
      // 同名同内容：直接当成功返回，避免重复解析与重复切块
      const existing = await fsp.readFile(abs).catch(() => null);
      if (existing && sha1(existing) === hash) {
        return {
          name: finalName,
          rel: `uploads/${finalName}`,
          bytes: buffer.length,
          duplicate: true,
          chunks: 0,
          totalDocs: knowledgeInfo().docs,
          totalChunks: knowledgeInfo().chunks,
        };
      }
      // 同名不同内容：加序号，不覆盖用户已有文件
      const suffix = path.extname(finalName);
      const base = finalName.slice(0, finalName.length - suffix.length);
      let i = 1;
      while (fs.existsSync(path.join(uploadDir, `${base}-${i}${suffix}`))) i += 1;
      finalName = `${base}-${i}${suffix}`;
      abs = path.join(uploadDir, finalName);
    }

    await fsp.writeFile(abs, buffer);

    const rel = `uploads/${finalName}`;
    const stats = await ingestKnowledge({ root: srcRoot, outDir: indexDir, maxFileSize: maxBytes });
    const manifest = (() => {
      try { return readManifest(indexDir); } catch { return null; }
    })();
    const entry = (manifest?.files || []).find((f) => f.path === rel);
    const failure = (stats.failures || []).find((f) => f.path === rel);

    if (!entry || failure) {
      // 解析失败（扫描件 PDF、加密文档等）：删掉文件并回滚索引，避免每次入库都重复失败
      await fsp.unlink(abs).catch(() => {});
      await ingestKnowledge({ root: srcRoot, outDir: indexDir, maxFileSize: maxBytes }).catch(() => {});
      if (reload) await reloadKnowledge().catch(() => {});
      throw errWithCode(failure?.error || '解析后没有产生可检索的切块', 'PARSE_FAILED');
    }

    if (reload) await reloadKnowledge().catch(() => {});
    const info = knowledgeInfo();
    return {
      name: finalName,
      rel,
      bytes: buffer.length,
      chunks: entry.chunks,
      title: entry.title,
      format: entry.format,
      duplicate: false,
      totalDocs: info.docs,
      totalChunks: info.chunks,
      durationMs: stats.durationMs ?? 0,
    };
  });
}
