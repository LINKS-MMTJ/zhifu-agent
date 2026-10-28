// 白盒测试：入库流水线（扫描 → 解析 → 切块 → 向量化 → 落盘 → 增量）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { ingestKnowledge, scanFiles } from '../../src/rag/ingest/pipeline.js';
import { readIndex, readManifest, indexExists, encodeVector, decodeVector, INDEX_VERSION } from '../../src/rag/ingest/indexStore.js';
import { DIM } from '../../src/rag/embedding.js';

function mkTmp(prefix = 'kb-ingest-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function buildCorpus() {
  const src = mkTmp('kb-src-');
  writeFile(src, '01-政策/退货政策.md', '# 七天无理由退货\n\n自签收之日起 7 天内可申请无理由退货。\n\n## 运费\n\n无理由退货运费由买家承担。\n');
  writeFile(src, '01-政策/发票政策.md', '# 发票规则\n\n订单完成后可申请电子发票。\n');
  writeFile(src, '02-帮助/帮助中心.html', '<html><head><title>帮助中心</title></head><body><h1>售后帮助</h1><p>退款 1-7 个工作日到账。</p></body></html>');
  writeFile(src, '03-FAQ/常见问题.json', JSON.stringify({ items: [{ q: '运费谁出', a: '买家承担' }, { q: '多久到账', a: '1-7 个工作日' }] }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['区域', '首重'], ['江浙沪', 6]]), '运费');
  fs.mkdirSync(path.join(src, '04-表格'), { recursive: true });
  fs.writeFileSync(path.join(src, '04-表格/运费标准.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  writeFile(src, '05-忽略/图片说明.exe', 'not supported');
  writeFile(src, '05-忽略/空文件.txt', '');
  return src;
}

test('入库: 扫描只收集受支持且非空的文件', async () => {
  const src = buildCorpus();
  const files = await scanFiles(src, {});
  const names = files.map((f) => f.rel);
  assert.equal(files.length, 5);
  assert.ok(!names.some((n) => n.endsWith('.exe')));
  assert.ok(!names.some((n) => n.endsWith('空文件.txt')));
  assert.deepEqual(names, [...names].sort());
});

test('入库: 生成可读索引与 manifest', async () => {
  const src = buildCorpus();
  const out = mkTmp('kb-out-');
  const stats = await ingestKnowledge({ root: src, outDir: out });

  assert.equal(stats.scanned, 5);
  assert.equal(stats.parsed, 5);
  assert.equal(stats.failed, 0);
  assert.ok(stats.chunks >= 5);
  assert.ok(indexExists(out));

  const m = readManifest(out);
  assert.equal(m.version, INDEX_VERSION);
  assert.equal(m.files.length, 5);
  assert.ok(m.byFormat.markdown.files >= 2);

  const loaded = await readIndex(out);
  assert.equal(loaded.chunks.length, stats.chunks);
  for (const c of loaded.chunks) {
    assert.ok(c.text.trim().length > 0);
    assert.ok(c.source);
    assert.ok(c.format);
    assert.equal(c.vector.length, DIM);
  }
  // 落盘后不应残留临时文件
  assert.ok(!fs.existsSync(path.join(out, 'chunks.ndjson.tmp')));
  assert.ok(!fs.existsSync(path.join(out, 'manifest.json.tmp')));
});

test('入库: 向量 int8 量化编解码无损', () => {
  const v = new Int8Array([13, -32, 127, 0]);
  const back = decodeVector(encodeVector(v));
  assert.deepEqual([...back], [...v]);
});

test('入库: 浮点向量写入时自动量化到 int8 范围', () => {
  const back = decodeVector(encodeVector(Float32Array.from([1, -1, 0.5, 0])));
  assert.ok(back instanceof Int8Array);
  assert.deepEqual([...back], [127, -127, 64, 0]);
});

test('入库: 二次运行全部命中增量，不重新解析', async () => {
  const src = buildCorpus();
  const out = mkTmp('kb-out-');
  const first = await ingestKnowledge({ root: src, outDir: out });
  const second = await ingestKnowledge({ root: src, outDir: out });

  assert.equal(second.parsed, 0);
  assert.equal(second.reused, 5);
  assert.equal(second.chunks, first.chunks);
});

test('入库: 只重新解析被修改的文件', async () => {
  const src = buildCorpus();
  const out = mkTmp('kb-out-');
  await ingestKnowledge({ root: src, outDir: out });

  // 修改一个文件（内容变化，大小也变化）
  writeFile(src, '01-政策/发票政策.md', '# 发票规则\n\n订单完成后可申请电子发票，90 天内可换开。\n\n## 专票\n\n需提供纳税人识别号。\n');
  const stats = await ingestKnowledge({ root: src, outDir: out });

  assert.equal(stats.parsed, 1);
  assert.equal(stats.reused, 4);
  const loaded = await readIndex(out);
  assert.ok(loaded.chunks.some((c) => c.text.includes('纳税人识别号')));
});

test('入库: 删除源文件后索引不再包含它', async () => {
  const src = buildCorpus();
  const out = mkTmp('kb-out-');
  await ingestKnowledge({ root: src, outDir: out });

  fs.rmSync(path.join(src, '01-政策/发票政策.md'));
  const stats = await ingestKnowledge({ root: src, outDir: out });

  assert.equal(stats.scanned, 4);
  const loaded = await readIndex(out);
  assert.ok(!loaded.chunks.some((c) => c.source.includes('发票政策')));
});

test('入库: 单个坏文件只记录失败，不影响整批', async () => {
  const src = buildCorpus();
  const out = mkTmp('kb-out-');
  fs.writeFileSync(path.join(src, '02-帮助/坏文档.docx'), Buffer.from('not a zip'));

  const stats = await ingestKnowledge({ root: src, outDir: out });
  assert.equal(stats.failed, 1);
  assert.equal(stats.parsed, 5);
  assert.equal(stats.failures[0].path, '02-帮助/坏文档.docx');
});

test('入库: 超过大小上限的文件被跳过', async () => {
  const src = buildCorpus();
  const files = await scanFiles(src, { maxFileSize: 200 });
  assert.ok(files.length < 5, `应过滤掉大文件，实际 ${files.length}`);
  assert.ok(files.every((f) => f.size <= 200));
});

test('入库: force 模式忽略增量全部重解析', async () => {
  const src = buildCorpus();
  const out = mkTmp('kb-out-');
  await ingestKnowledge({ root: src, outDir: out });
  const stats = await ingestKnowledge({ root: src, outDir: out, force: true });
  assert.equal(stats.parsed, 5);
  assert.equal(stats.reused, 0);
});
