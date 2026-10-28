#!/usr/bin/env node
// 知识库规模验证：生成大批量文档 → 入库 → 增量 → 检索延迟
//
// 目的：证明入库流水线的内存占用与语料规模无关（流式写盘），
// 并给出可外推到 GB 级的吞吐数字。
//
// 用法：
//   node bench/kbScale.js                              # 500 篇 × 12KB ≈ 6MB
//   node bench/kbScale.js --docs 3000 --kb 60          # ≈ 180MB
//   node bench/kbScale.js --docs 3000 --kb 60 --keep   # 保留生成的语料与索引
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestKnowledge } from '../src/rag/ingest/pipeline.js';
import { readIndex, indexSizeBytes } from '../src/rag/ingest/indexStore.js';
import { retrieveFrom } from '../src/rag/knowledge.js';
import { VectorStore } from '../src/rag/vectorStore.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const DOCS = Number(arg('docs', 500));
const TARGET_KB = Number(arg('kb', 12));
const KEEP = Boolean(arg('keep', false));
const INGEST_ONLY = Boolean(arg('ingest-only', false));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-scale-src-'));
const outDir = path.join(os.tmpdir(), `kb-scale-index-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

// —— 生成语料：结构相似但主题各异的售后文档 ——
const TOPICS = ['退货', '换货', '退款', '物流', '保修', '发票', '价保', '投诉', '安装', '清洗'];
const AREAS = ['江浙沪皖', '京津冀', '珠三角', '成渝', '西北', '东北'];
const PARAS = [
  '用户在申请售后时需提供订单号与问题描述，必要时上传照片或视频作为凭证。',
  '客服应在首次响应时给出明确的处理结论，避免使用含糊表述造成二次咨询。',
  '涉及金额超过一千元的争议需升级至售后专员，由专员在四小时内给出方案。',
  '商品签收后七天内支持无理由退货，退货运费由消费者承担；质量问题由商家承担。',
  '质量问题需在签收后十五天内提出，超过期限的按保修流程处理，不再支持退货。',
  '退款审核通过后原路退回，余额支付一般两小时内到账，银行卡支付需一至七个工作日。',
  '物流超过四十八小时未更新，可提交物流查询工单，由承运商在二十四小时内核实。',
  '大件商品退货运费按重量与区域计费，通常在一百五十元至四百元之间。',
  '安装服务由品牌授权服务商提供，高空作业费按楼层收取，最高不超过三百元。',
  '发票可在订单完成后申请，电子普票即时开具，增值税专票需七个工作日寄出。',
];

function makeDoc(i) {
  const topic = TOPICS[i % TOPICS.length];
  const area = AREAS[i % AREAS.length];
  const lines = [`# ${topic}处理规范（${area}·第 ${i + 1} 版）`, ''];
  let bytes = lines.join('\n').length;
  let section = 1;
  while (bytes < TARGET_KB * 1024) {
    lines.push(`## 第 ${section} 条 ${topic}执行细则`, '');
    for (let p = 0; p < 3; p++) {
      const para = `${PARAS[(i + section + p) % PARAS.length]}本条款适用于${area}区域的${topic}场景，编号 ${i + 1}-${section}-${p}。`;
      lines.push(para, '');
      bytes += para.length + 2;
    }
    section++;
  }
  return lines.join('\n');
}

console.log(`[kbScale] 生成 ${DOCS} 篇文档（每篇约 ${TARGET_KB}KB）到 ${tmpRoot}`);
const genStart = Date.now();
for (let i = 0; i < DOCS; i++) {
  const dir = path.join(tmpRoot, `batch-${String(Math.floor(i / 100)).padStart(3, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `doc-${String(i).padStart(5, '0')}.md`), makeDoc(i));
}
const totalBytes = (() => {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += fs.statSync(p).size;
    }
  };
  walk(tmpRoot);
  return n;
})();
console.log(`[kbScale] 生成完成：${(totalBytes / 1024 / 1024).toFixed(1)} MB，耗时 ${Date.now() - genStart} ms`);
console.log('');

// —— 采样内存峰值 ——
let peakRss = 0;
let peakHeap = 0;
const timer = setInterval(() => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
}, 100);

const t0 = Date.now();
const first = await ingestKnowledge({
  root: tmpRoot,
  outDir,
  maxChars: 480,
  overlapChars: 80,
  onProgress: (s) => {
    if ((s.parsed + s.reused) % 500 === 0) {
      const m = process.memoryUsage();
      console.log(`[kbScale] ${s.parsed + s.reused}/${s.scanned} 文件，${s.chunks} 块，heap ${(m.heapUsed / 1024 / 1024).toFixed(0)}MB / rss ${(m.rss / 1024 / 1024).toFixed(0)}MB`);
    }
  },
});
const t1 = Date.now();

peakRss = Math.max(peakRss, process.memoryUsage().rss);

// 主动 GC 一次，区分"GC 惰性导致的峰值"与"真实存活内存"
if (global.gc) global.gc();
const liveHeap = process.memoryUsage().heapUsed;
clearInterval(timer);

const ingestMs = t1 - t0;
const mb = totalBytes / 1024 / 1024;

console.log('');
console.log('—— 首次全量入库 ——');
console.log(`文件数        : ${first.scanned}`);
console.log(`语料体积      : ${mb.toFixed(1)} MB`);
console.log(`切块数        : ${first.chunks}`);
console.log(`字符数        : ${first.chars.toLocaleString('zh-CN')}`);
console.log(`耗时          : ${(ingestMs / 1000).toFixed(2)} s`);
console.log(`吞吐          : ${(mb / (ingestMs / 1000)).toFixed(2)} MB/s · ${Math.round(first.chunks / (ingestMs / 1000))} 块/s`);
console.log(`峰值 RSS      : ${(peakRss / 1024 / 1024).toFixed(0)} MB`);
console.log(`峰值 Heap     : ${(peakHeap / 1024 / 1024).toFixed(0)} MB（V8 惰性 GC，非存活量）`);
console.log(`GC 后存活 Heap: ${(liveHeap / 1024 / 1024).toFixed(0)} MB`);
console.log(`索引体积      : ${(indexSizeBytes(outDir) / 1024 / 1024).toFixed(1)} MB（原文的 ${(indexSizeBytes(outDir) / totalBytes * 100).toFixed(0)}%）`);

// —— 增量入库 ——
const t2 = Date.now();
const second = await ingestKnowledge({ root: tmpRoot, outDir, maxChars: 480, overlapChars: 80 });
const incMs = Date.now() - t2;
console.log('');
console.log('—— 二次增量入库（无变更）——');
console.log(`复用文件      : ${second.reused} / ${second.scanned}`);
console.log(`重新解析      : ${second.parsed}`);
console.log(`耗时          : ${incMs} ms（全量的 ${(incMs / ingestMs * 100).toFixed(1)}%）`);

// —— 检索延迟 ——
if (!INGEST_ONLY) {
  const loaded = await readIndex(outDir);
  const store = new VectorStore();
  for (const c of loaded.chunks) store.add(c);
  store.finalizeGroups();

  const queries = TOPICS.flatMap((t) => [
    `${t}需要多久`, `${t}运费谁承担`, `${t}超过时效怎么办`, `如何申请${t}`, `${t}政策是什么`,
  ]);

  const full = [];
  const hier = [];
  let top1Miss = 0;

  for (let round = 0; round < 3; round++) {
    for (const q of queries) {
      let t = process.hrtime.bigint();
      const a = retrieveFrom(store, q, 3, { docLimit: 0 });
      full.push(Number(process.hrtime.bigint() - t) / 1e6);

      t = process.hrtime.bigint();
      const b = retrieveFrom(store, q, 3);
      hier.push(Number(process.hrtime.bigint() - t) / 1e6);

      if (round === 0 && a[0]?.id !== b[0]?.id) top1Miss++;
    }
  }

  const pick = (arr, q) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  };

  console.log('');
  console.log(`—— 检索延迟（${store.size()} 块 / ${store.groups.length} 篇文档）——`);
  console.log(`全量扫描 P50/P95 : ${pick(full, 0.5).toFixed(2)} / ${pick(full, 0.95).toFixed(2)} ms`);
  console.log(`两级检索 P50/P95 : ${pick(hier, 0.5).toFixed(2)} / ${pick(hier, 0.95).toFixed(2)} ms`);
  console.log(`两级检索 Top-1 一致率 : ${(((queries.length - top1Miss) / queries.length) * 100).toFixed(1)}%`);
}

console.log('');
console.log(`[kbScale] 索引目录：${outDir}`);

if (!KEEP) {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('[kbScale] 已清理临时语料与索引（加 --keep 可保留）');
} else {
  console.log(`[kbScale] 语料保留在：${tmpRoot}`);
}
