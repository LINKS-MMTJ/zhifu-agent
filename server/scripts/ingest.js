#!/usr/bin/env node
// 知识库入库命令
//
// 用法：
//   node scripts/ingest.js                    # 默认：knowledge/ → data/kb
//   node scripts/ingest.js --src ./docs --out ./data/kb
//   node scripts/ingest.js --force             # 忽略增量，全部重建
//   node scripts/ingest.js --max-chars 600 --overlap 100
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestKnowledge } from '../src/rag/ingest/pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const args = parseArgs(process.argv.slice(2));
const src = path.resolve(ROOT, String(args.src || 'knowledge'));
const out = path.resolve(ROOT, String(args.out || 'data/kb'));
const maxChars = Number(args['max-chars'] || 480);
const overlap = Number(args.overlap ?? 80);

console.log(`[ingest] 源目录 : ${src}`);
console.log(`[ingest] 索引目录: ${out}`);
console.log(`[ingest] 切块参数: maxChars=${maxChars}, overlap=${overlap}${args.force ? ', force=1' : ''}`);
console.log('');

const startedAt = Date.now();
let lastPrint = 0;

try {
  const stats = await ingestKnowledge({
    root: src,
    outDir: out,
    maxChars,
    overlapChars: overlap,
    force: Boolean(args.force),
    maxFileSize: Number(args['max-file-size'] || 200 * 1024 * 1024),
    onProgress: (s) => {
      const now = Date.now();
      if (now - lastPrint < 1000) return;
      lastPrint = now;
      console.log(`[ingest] 已处理 ${s.parsed + s.reused}/${s.scanned} 文件，切块 ${s.chunks} 条`);
    },
  });

  console.log('');
  console.log('—— 入库完成 ——');
  if (stats.unchanged) console.log('（所有文件均未变更，索引保持不变）');
  console.log(`扫描文件      : ${stats.scanned}`);
  console.log(`解析入库      : ${stats.parsed}`);
  console.log(`增量复用      : ${stats.reused}`);
  console.log(`跳过(空/加密) : ${stats.skipped}`);
  console.log(`失败          : ${stats.failed}`);
  console.log(`切块总数      : ${stats.chunks}`);
  console.log(`本次解析字符  : ${stats.chars.toLocaleString('zh-CN')}`);
  console.log(`索引耗时      : ${(Date.now() - startedAt)} ms`);
  console.log(`吞吐          : ${stats.chunksPerSec} 块/秒`);

  const formats = Object.entries(stats.byFormat).sort((a, b) => b[1].chunks - a[1].chunks);
  if (formats.length) {
    console.log('');
    console.log('按格式统计：');
    for (const [fmt, v] of formats) {
      console.log(`  ${fmt.padEnd(10)} 文件 ${String(v.files).padStart(4)}  切块 ${String(v.chunks).padStart(6)}`);
    }
  }

  if (stats.failures.length) {
    console.log('');
    console.log('失败明细（最多展示 20 条）：');
    for (const f of stats.failures.slice(0, 20)) {
      console.log(`  - ${f.path}: ${f.error}`);
    }
    if (stats.failures.length > 20) console.log(`  ……另有 ${stats.failures.length - 20} 条`);
  }

  console.log('');
  console.log('[ingest] 服务端会在 5 秒内自动热加载新索引；也可重启进程。');
} catch (err) {
  console.error('[ingest] 失败：', err);
  process.exit(1);
}
