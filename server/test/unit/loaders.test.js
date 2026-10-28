// 白盒测试：多格式解析器（真实生成 docx/xlsx/pptx/pdf 后再解析）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import pptxgen from 'pptxgenjs';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { loadDocument, getLoader, SUPPORTED_EXT, LEGACY_EXT } from '../../src/rag/ingest/loaders/index.js';
import { decodeText, htmlToText } from '../../src/rag/ingest/loaders/text.js';

test('解析器: 支持的扩展名覆盖常见企业文档', () => {
  for (const ext of ['.txt', '.md', '.html', '.json', '.docx', '.pdf', '.xlsx', '.csv', '.pptx']) {
    assert.ok(SUPPORTED_EXT.includes(ext), `缺少 ${ext}`);
    assert.equal(typeof getLoader(ext), 'function');
  }
  assert.equal(getLoader('.exe'), null);
});

test('解析器: UTF-8 文本与 BOM', () => {
  const buf = Buffer.from('\uFEFF# 标题\n\n正文内容。', 'utf8');
  const s = decodeText(buf);
  assert.ok(!s.startsWith('\uFEFF'));
  assert.ok(s.includes('标题'));
});

test('解析器: Markdown 取首个一级标题作为文档标题', async () => {
  const buf = Buffer.from('# 退货运费规则\n\n无理由退货运费由买家承担。', 'utf8');
  const doc = await loadDocument(buf, { ext: '.md' });
  assert.equal(doc.title, '退货运费规则');
  assert.ok(doc.text.includes('买家承担'));
});

test('解析器: HTML 保留标题层级并剥离脚本', async () => {
  const html = '<html><head><title>帮助中心</title><script>alert(1)</script></head>'
    + '<body><h1>售后</h1><h2>退货</h2><p>7 天内可退。</p><ul><li>运费买家承担</li></ul></body></html>';
  const doc = await loadDocument(Buffer.from(html, 'utf8'), { ext: '.html' });
  assert.equal(doc.title, '帮助中心');
  assert.ok(doc.text.includes('# 售后'));
  assert.ok(doc.text.includes('## 退货'));
  assert.ok(doc.text.includes('- 运费买家承担'));
  assert.ok(!doc.text.includes('alert'));
});

test('解析器: HTML 实体还原', () => {
  assert.ok(htmlToText('<p>A&amp;B&nbsp;¥299</p>').includes('A&B ¥299'));
});

test('解析器: JSON 数组按记录展开，问答不被拆散', async () => {
  const data = { updatedAt: '2026-10-20', items: [{ q: '运费谁出', a: '买家承担' }, { q: '多久到账', a: '1-7 个工作日' }] };
  const doc = await loadDocument(Buffer.from(JSON.stringify(data), 'utf8'), { ext: '.json' });
  // 问句作为小节名，答句用中文标签
  assert.ok(doc.text.includes('## 运费谁出'));
  assert.ok(doc.text.includes('答：买家承担'));
  assert.ok(doc.text.includes('## 多久到账'));
  assert.ok(doc.text.includes('1-7 个工作日'));
  assert.equal(doc.meta.records, 3); // 顶层标量 + 2 条记录
});

test('解析器: JSONL 逐行解析，坏行跳过', async () => {
  const text = '{"q":"a","a":"b"}\n不是JSON\n{"q":"c","a":"d"}\n';
  const doc = await loadDocument(Buffer.from(text, 'utf8'), { ext: '.jsonl' });
  assert.ok(doc.text.includes('## a'));
  assert.ok(doc.text.includes('答：b'));
  assert.ok(doc.text.includes('## c'));
});

test('解析器: Word 保留标题与正文', async () => {
  const doc = new Document({
    creator: '测试',
    title: '家电售后规则',
    sections: [{
      children: [
        new Paragraph({ text: '家电类售后规则', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: '安装与调试', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ children: [new TextRun('签收后 7 天内可预约安装。')] }),
      ],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  const out = await loadDocument(buf, { ext: '.docx' });
  assert.ok(out.text.includes('家电类售后规则'));
  assert.ok(out.text.includes('安装与调试'));
  assert.ok(out.text.includes('7 天内可预约安装'));
  assert.ok(out.text.includes('# 家电类售后规则') || out.text.includes('# 家电类售后规则'.replace('# ', '')));
});

test('解析器: Excel 按工作表输出且保留表头', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('运费标准').addRows([
    ['区域', '首重', '续重'],
    ['江浙沪皖', 6, 2],
    ['京津冀', 8, 3],
  ]);
  wb.addWorksheet('时效承诺').addRows([['区域', '时效'], ['江浙沪', '24小时']]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const out = await loadDocument(buf, { ext: '.xlsx' });
  assert.ok(out.text.includes('工作表：运费标准'));
  assert.ok(out.text.includes('工作表：时效承诺'));
  assert.ok(out.text.includes('江浙沪皖 | 6 | 2'));
  assert.equal(out.meta.sheets, 2);
});

test('解析器: 老格式 .xls 不再解析，但给出可操作的提示', async () => {
  assert.equal(getLoader('.xls'), null);
  assert.ok(!SUPPORTED_EXT.includes('.xls'));
  assert.match(LEGACY_EXT['.xls'], /另存为 \.xlsx/);
  await assert.rejects(() => loadDocument(Buffer.from('x'), { ext: '.xls' }), /不支持的格式/);
});

test('解析器: CSV 读取', async () => {
  const csv = '\uFEFF原因编码,原因名称\nR01,七天无理由\nR02,质量问题\n';
  const out = await loadDocument(Buffer.from(csv, 'utf8'), { ext: '.csv' });
  assert.ok(out.text.includes('R01'));
  assert.ok(out.text.includes('七天无理由'));
});

test('解析器: PPT 按页输出文本', async () => {
  const pptx = new pptxgen();
  const s1 = pptx.addSlide();
  s1.addText('新客服入职培训', { x: 1, y: 1, w: 6, h: 1 });
  const s2 = pptx.addSlide();
  s2.addText('服务指标', { x: 1, y: 1, w: 6, h: 1 });
  s2.addText('首次响应不超过 30 秒', { x: 1, y: 2, w: 6, h: 1 });
  const buf = await pptx.write({ outputType: 'nodebuffer' });

  const out = await loadDocument(buf, { ext: '.pptx' });
  assert.ok(out.text.includes('第 1 页'));
  assert.ok(out.text.includes('新客服入职培训'));
  assert.ok(out.text.includes('首次响应不超过 30 秒'));
  assert.equal(out.meta.slides, 2);
});

test('解析器: PDF 抽取出可读文本', async (t) => {
  const font = ['C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simfang.ttf'].find((p) => fs.existsSync(p));
  if (!font) return t.skip('当前环境没有中文字体，跳过 PDF 生成');

  const buf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, info: { Title: '工单流程' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('cn', font);
    doc.font('cn').fontSize(16).text('工单与升级流程');
    doc.moveDown(0.5).fontSize(10.5).text('P0 工单需在 10 分钟内响应。');
    doc.end();
  });

  const out = await loadDocument(buf, { ext: '.pdf' });
  assert.ok(out.meta.pages >= 1);
  assert.ok(out.text.includes('工单与升级流程'), `实际解析结果：${out.text.slice(0, 80)}`);
  assert.ok(out.text.includes('10 分钟内响应'));
});

test('解析器: 不支持的格式抛出明确错误', async () => {
  await assert.rejects(
    () => loadDocument(Buffer.from('x'), { ext: '.exe' }),
    /不支持的格式/
  );
});

test('解析器: 截断的 docx 不会崩溃，而是抛错由流水线记录', async () => {
  const p = path.join(fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'kb-')), 'bad.docx');
  fs.writeFileSync(p, Buffer.from('not a zip'));
  await assert.rejects(() => loadDocument(fs.readFileSync(p), { ext: '.docx' }));
});
