// Office 文档解析：Word(.docx) / Excel(.xlsx .csv) / PowerPoint(.pptx)
// 依赖：mammoth（Word 转 HTML，保留标题层级）、exceljs（读表格）、jszip（拆 OOXML 容器）
//
// 为什么不用 SheetJS：npm 上的 xlsx 停在 0.18.5，ReDoS 与原型污染公告长期无修复版，
// 而上传的文件是不可信的；exceljs 在 registry 上持续维护，且覆盖 .xlsx 与 .csv。
// 代价是不再支持老格式 .xls（BIFF），需要时先另存为 .xlsx。
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { htmlToText, tidy, decodeEntities } from './text.js';

function xmlTag(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? tidy(decodeEntities(m[1])) : '';
}

async function readCoreProps(zip) {
  try {
    const f = zip.file('docProps/core.xml');
    if (!f) return {};
    const xml = await f.async('string');
    return {
      title: xmlTag(xml, 'dc:title'),
      creator: xmlTag(xml, 'dc:creator'),
      modified: xmlTag(xml, 'dcterms:modified'),
    };
  } catch {
    return {};
  }
}

export async function loadDocx(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer }, {
    // 表格与标题保留下来，切块器才有结构可用
    includeDefaultStyleMap: true,
  });
  let core = {};
  try {
    const zip = await JSZip.loadAsync(buffer);
    core = await readCoreProps(zip);
  } catch {
    // 非标准 zip 时忽略元数据
  }
  return {
    title: core.title || '',
    text: htmlToText(html),
    meta: { creator: core.creator || '', modified: core.modified || '', bytes: buffer.length },
  };
}

// 每个工作表输出为一段带 ## 标题的文本；每 30 行重复表头，避免切片后列语义丢失
// 行列数做上限：上传的文件不可信，先限制解析规模，避免畸形表格把事件循环拖死
const MAX_SHEETS = Number(process.env.KB_MAX_SHEETS || 50);
const MAX_ROWS_PER_SHEET = Number(process.env.KB_MAX_ROWS || 5000);

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text).trim();
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('').trim();
    if (v.result !== undefined) return String(v.result).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.hyperlink) return String(v.text || v.hyperlink).trim();
    return '';
  }
  return String(v).trim();
}

export async function loadSpreadsheet(buffer, { ext = '.xlsx' } = {}) {
  const wb = new ExcelJS.Workbook();
  if (ext === '.csv') {
    // ExcelJS 的 csv 解析器按流读取；先去掉 BOM，否则首列表头会带不可见字符
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    await wb.csv.read(Readable.from([text]));
  } else {
    await wb.xlsx.load(buffer);
  }

  const lines = [];
  let totalRows = 0;
  let truncated = 0;
  let sheetCount = 0;

  wb.eachSheet((ws) => {
    if (sheetCount >= MAX_SHEETS) return;
    sheetCount += 1;
    lines.push(`## 工作表：${ws.name}`);

    let header = [];
    let rowIndex = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rowIndex >= MAX_ROWS_PER_SHEET) { truncated += 1; return; }
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellText(cell); });
      if (!cells.some(Boolean)) return;
      if (rowIndex === 0) header = cells;
      rowIndex += 1;
      totalRows += 1;
      lines.push(cells.join(' | '));
      if (rowIndex > 1 && rowIndex % 30 === 0 && header.some(Boolean)) lines.push(header.join(' | '));
    });
    lines.push('');
  });

  return {
    title: '',
    text: tidy(lines.join('\n')),
    meta: { sheets: sheetCount, rows: totalRows, truncatedRows: truncated, ext },
  };
}

function slideNo(name) {
  const m = name.match(/(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

export async function loadPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b));
  const noteFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b));

  const noteMap = new Map();
  for (const n of noteFiles) {
    const xml = await zip.file(n).async('string');
    noteMap.set(slideNo(n), extractTextRuns(xml));
  }

  const parts = [];
  let title = '';
  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string');
    const texts = extractTextRuns(xml).filter((t) => t.trim());
    if (!texts.length) continue;
    const no = slideNo(name);
    if (!title) title = texts[0].slice(0, 60);
    parts.push(`## 第 ${no} 页\n${texts.join('\n')}`);
    const note = (noteMap.get(no) || []).join('\n').trim();
    if (note) parts.push(`### 备注\n${note}`);
  }

  let core = {};
  try {
    core = await readCoreProps(zip);
  } catch {
    // 忽略
  }

  return {
    title: core.title || title,
    text: tidy(parts.join('\n\n')),
    meta: { slides: slideFiles.length, bytes: buffer.length },
  };
}

// 提取 <a:t> 文本；按段落 <a:p> 断行，保留较自然的阅读顺序
function extractTextRuns(xml) {
  const out = [];
  const paragraphs = String(xml).match(/<a:p\b[\s\S]*?<\/a:p>/g) || [];
  for (const p of paragraphs) {
    const runs = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeEntities(m[1]));
    const line = runs.join('').trim();
    if (line) out.push(line);
  }
  if (!out.length) {
    const runs = [...String(xml).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeEntities(m[1]));
    if (runs.length) out.push(runs.join(' '));
  }
  return out;
}
