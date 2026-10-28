// 入库流水线：扫描 → 分类（增量） → 解析 → 切块 → 向量化 → 落盘
//
// 企业语料的现实约束与对应处理：
//   - 文件多、体积大：逐文件流式处理，切块写盘处理背压，内存不随语料线性增长
//   - 格式杂：解析器注册表按扩展名分发，单文件失败只记录不中断整批
//   - 经常增量更新：size + mtime 快速判定，mtime 变了再用 sha1 做内容比对；
//     未变文件直接从旧索引流式拷贝对应行，既不重新解析也不重新向量化
//   - 需要可追溯：每个切块保留来源路径、标题路径、序号
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { getLoader, FORMAT_LABEL } from './loaders/index.js';
import { chunkText } from './chunker.js';
import {
  createIndexWriter, readManifest, indexExists, encodeVector, CHUNKS_FILE,
} from './indexStore.js';
import { embed } from '../embedding.js';

const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.idea', '.vscode', 'dist', 'build', '__pycache__']);

export function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

export async function scanFiles(root, { maxFileSize = 50 * 1024 * 1024 } = {}) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name.toLowerCase())) continue;
        await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!getLoader(ext)) continue;
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (st.size === 0 || st.size > maxFileSize) continue;
      out.push({
        abs,
        rel: path.relative(root, abs).split(path.sep).join('/'),
        ext,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      });
    }
  };
  await walk(root);
  return out;
}

function baseName(rel) {
  return path.basename(rel).replace(/\.[^.]+$/, '');
}

// 从旧索引里流式拷贝"未变更文档"的切块行，避免把整个索引读进内存
async function copyUnchanged(writer, oldDir, keepDocIds, onLine) {
  const file = path.join(oldDir, CHUNKS_FILE);
  if (!fs.existsSync(file) || keepDocIds.size === 0) return 0;

  let copied = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    // 只解析到能拿到 docId 为止：切块行由本模块生成，字段顺序固定
    const marker = '","docId":"';
    const at = s.indexOf(marker);
    if (at === -1) continue;
    const start = at + marker.length;
    const end = s.indexOf('"', start);
    if (end === -1) continue;
    const docId = s.slice(start, end);
    if (!keepDocIds.has(docId)) continue;
    await writer.addRaw(s);
    copied++;
    if (onLine) onLine(copied);
  }
  return copied;
}

export async function ingestKnowledge(options = {}) {
  const root = path.resolve(options.root || 'knowledge');
  const outDir = path.resolve(options.outDir || 'data/kb');
  const maxChars = options.maxChars ?? 480;
  const overlapChars = options.overlapChars ?? 80;
  const maxFileSize = options.maxFileSize ?? 50 * 1024 * 1024;
  const force = Boolean(options.force);
  const onProgress = options.onProgress || null;

  const startedAt = Date.now();
  const files = await scanFiles(root, { maxFileSize });

  const stats = {
    root,
    outDir,
    scanned: files.length,
    parsed: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    chunks: 0,
    chars: 0,
    byFormat: {},
    failures: [],
  };

  const prevManifest = !force && indexExists(outDir) ? readManifest(outDir) : null;
  const prevFiles = new Map((prevManifest?.files || []).map((f) => [f.path, f]));

  // —— 第一遍：分类，只对 mtime 变化的文件做内容哈希 ——
  const keep = [];     // 未变：直接拷贝旧切块
  const work = [];     // 需要重新解析
  for (const file of files) {
    const prev = prevFiles.get(file.rel);
    if (!force && prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs) {
      keep.push({ file, entry: prev });
      continue;
    }
    if (!force && prev) {
      // mtime 变了，用内容哈希确认是否真的变化（编辑器另存、touch 都可能改 mtime）
      let hash = '';
      try {
        hash = sha1(await fsp.readFile(file.abs));
      } catch {
        hash = '';
      }
      if (hash && hash === prev.hash) {
        keep.push({ file, entry: { ...prev, mtimeMs: file.mtimeMs } });
        continue;
      }
    }
    work.push({ file, prev });
  }

  // 全部文件都未变更、且没有文件被删除：直接返回，连索引文件都不用重写
  const currentPaths = new Set(files.map((f) => f.rel));
  const removed = (prevManifest?.files || []).filter((f) => !currentPaths.has(f.path));
  if (!force && prevManifest && work.length === 0 && keep.length === files.length && files.length > 0 && removed.length === 0) {
    Object.assign(stats, {
      reused: keep.length,
      chunks: prevManifest.counts?.chunks || 0,
      byFormat: prevManifest.byFormat || {},
      builtAt: prevManifest.builtAt,
      durationMs: Date.now() - startedAt,
      bytesRead: 0,
      unchanged: true,
    });
    stats.chunksPerSec = stats.durationMs > 0 ? Math.round((stats.chunks / stats.durationMs) * 1000) : stats.chunks;
    return stats;
  }

  const writer = createIndexWriter(outDir);
  const manifestFiles = [];
  const keepDocIds = new Set(keep.map((k) => k.file.rel));
  const failedDocIds = new Set();

  const trackFormat = (fmt, chunks) => {
    stats.byFormat[fmt] = stats.byFormat[fmt] || { files: 0, chunks: 0 };
    stats.byFormat[fmt].files++;
    stats.byFormat[fmt].chunks += chunks;
  };

  try {
    // —— 第二遍：先流式拷贝未变文档，再解析变更文档 ——
    const copied = await copyUnchanged(writer, outDir, keepDocIds);
    stats.reused = keep.length;
    stats.chunks += copied;
    for (const { file, entry } of keep) {
      manifestFiles.push(entry);
      trackFormat(entry.format || FORMAT_LABEL[file.ext] || 'other', entry.chunks || 0);
    }

    for (const { file, prev } of work) {
      let buffer;
      try {
        buffer = await fsp.readFile(file.abs);
      } catch (err) {
        stats.failed++;
        stats.failures.push({ path: file.rel, error: err.message });
        if (prev) failedDocIds.add(file.rel);
        continue;
      }
      const hash = sha1(buffer);

      try {
        const loaded = await getLoader(file.ext)(buffer, { ext: file.ext, name: file.rel });
        const text = String(loaded.text || '');
        if (text.length < 20) {
          stats.skipped++;
          stats.failures.push({ path: file.rel, error: '解析结果过短，已跳过（可能是扫描件/加密文档）' });
          continue;
        }

        const title = loaded.title || baseName(file.rel);
        const chunks = chunkText(text, { maxChars, overlapChars });
        const fmt = FORMAT_LABEL[file.ext] || 'other';

        for (let i = 0; i < chunks.length; i++) {
          const { text: body, headingPath } = chunks[i];
          const indexText = [title, headingPath, body].filter(Boolean).join('｜');
          await writer.add({
            id: `${file.rel}#${i}`,
            docId: file.rel,
            title,
            headingPath,
            text: body,
            source: file.rel,
            format: fmt,
            locator: headingPath || `第 ${i + 1} 段`,
            seq: i,
            v: encodeVector(embed(indexText)),
          });
        }

        stats.parsed++;
        stats.chunks += chunks.length;
        stats.chars += text.length;
        trackFormat(fmt, chunks.length);

        manifestFiles.push({
          path: file.rel,
          size: file.size,
          mtimeMs: file.mtimeMs,
          hash,
          format: fmt,
          title,
          chunks: chunks.length,
        });

        if (onProgress && (stats.parsed + stats.reused) % 50 === 0) onProgress(stats);
      } catch (err) {
        stats.failed++;
        stats.failures.push({ path: file.rel, error: err.message });
        if (prev) failedDocIds.add(file.rel);
      }
    }

    // 解析失败的文档保留旧切块：临时性失败（文件被占用、字体缺失）不应让知识凭空消失
    if (failedDocIds.size) {
      stats.chunks += await copyUnchanged(writer, outDir, failedDocIds);
      for (const id of failedDocIds) {
        const entry = prevFiles.get(id);
        if (!entry) continue;
        manifestFiles.push(entry);
        trackFormat(entry.format || 'other', entry.chunks || 0);
        stats.reused++;
      }
    }

    const manifest = await writer.commit({
      root,
      chunker: { maxChars, overlapChars },
      counts: {
        files: manifestFiles.length,
        chunks: stats.chunks,
        chars: stats.chars,
      },
      byFormat: stats.byFormat,
      failures: stats.failures,
      files: manifestFiles,
    });

    const durationMs = Date.now() - startedAt;
    Object.assign(stats, {
      durationMs,
      bytesRead: manifestFiles.reduce((a, f) => a + (f.size || 0), 0),
      builtAt: manifest.builtAt,
      chunksPerSec: durationMs > 0 ? Math.round((stats.chunks / durationMs) * 1000) : stats.chunks,
    });
    return stats;
  } catch (err) {
    await writer.abort();
    throw err;
  }
}
