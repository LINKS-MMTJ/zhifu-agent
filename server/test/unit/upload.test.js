// 白盒测试：知识库上传（文件名清洗、格式/大小校验、落盘、增量入库、去重）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveAndIngest, safeFileName } from '../../src/rag/upload.js';

async function tempDirs() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-upload-'));
  return { root: path.join(base, 'knowledge'), outDir: path.join(base, 'kb') };
}

const DOC = [
  '# 价格保护规则',
  '## 一、价保范围',
  '支付后 7 天内，同一商品降价可申请价保；参与百亿补贴与清仓活动的商品不参与价保。',
  '## 二、申请方式',
  '在订单详情页点击“申请价保”，系统自动比价，符合条件的最迟 24 小时内退还差价。',
].join('\n');

test('上传: 文件名去掉路径与非法字符，保留中文', () => {
  assert.equal(safeFileName('../../etc/pass.md'), 'pass.md');
  assert.equal(safeFileName('C:\\docs\\退货政策.docx'), '退货政策.docx');
  assert.equal(safeFileName('a<b>?.md'), 'a_b__.md');
  assert.equal(safeFileName(''), 'upload');
  assert.equal(safeFileName('..'), 'upload');
});

test('上传: 拒绝不支持的格式', async () => {
  const { root, outDir } = await tempDirs();
  await assert.rejects(
    saveAndIngest('virus.exe', Buffer.from('MZ'), { root, outDir, reload: false }),
    (err) => err.code === 'UNSUPPORTED',
  );
});

test('上传: 拒绝空文件与超大文件', async () => {
  const { root, outDir } = await tempDirs();
  await assert.rejects(
    saveAndIngest('a.md', Buffer.alloc(0), { root, outDir, reload: false }),
    (err) => err.code === 'EMPTY',
  );
  await assert.rejects(
    saveAndIngest('a.md', Buffer.from(DOC), { root, outDir, reload: false, maxBytes: 10 }),
    (err) => err.code === 'TOO_LARGE',
  );
});

test('上传: 落盘到 uploads 并增量入库', async () => {
  const { root, outDir } = await tempDirs();
  const r = await saveAndIngest('价格保护.md', Buffer.from(DOC), { root, outDir, reload: false });

  assert.equal(r.duplicate, false);
  assert.equal(r.rel, 'uploads/价格保护.md');
  assert.ok(r.chunks >= 1);
  assert.equal(r.format, 'markdown');
  assert.ok(r.totalChunks >= r.chunks);
  assert.ok(fs.existsSync(path.join(root, 'uploads', '价格保护.md')));

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((f) => f.path === 'uploads/价格保护.md'));
});

test('上传: 同名同内容不重复入库', async () => {
  const { root, outDir } = await tempDirs();
  await saveAndIngest('价保.md', Buffer.from(DOC), { root, outDir, reload: false });
  const again = await saveAndIngest('价保.md', Buffer.from(DOC), { root, outDir, reload: false });
  assert.equal(again.duplicate, true);
  assert.equal(again.chunks, 0);
});

test('上传: 同名不同内容追加序号，不覆盖已有文件', async () => {
  const { root, outDir } = await tempDirs();
  await saveAndIngest('政策.md', Buffer.from(DOC), { root, outDir, reload: false });
  const changed = `${DOC}\n## 三、补充\n价保每个订单仅可申请一次。`;
  const r = await saveAndIngest('政策.md', Buffer.from(changed), { root, outDir, reload: false });
  assert.equal(r.duplicate, false);
  assert.equal(r.rel, 'uploads/政策-1.md');
  assert.ok(fs.existsSync(path.join(root, 'uploads', '政策.md')));
  assert.ok(fs.existsSync(path.join(root, 'uploads', '政策-1.md')));
});
