// Office 文档解析：Word(.docx) / Excel(.xlsx .xls .csv) / PowerPoint(.pptx)
// 依赖：mammoth（Word 转 HTML，保留标题层级）、xlsx（SheetJS，读表格）、jszip（拆 OOXML 容器）
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
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
// 行列数做上限：SheetJS 有已知 ReDoS 公告（GHSA-5pgg-2g8v-p4x9，npm 上暂无修复版本），
// 上传的是不可信文件，先限制解析规模，避免一个畸形表格把事件循环拖死
const MAX_SHEETS = Number(process.env.KB_MAX_SHEETS || 50);
const MAX_ROWS_PER_SHEET = Number(process.env.KB_MAX_ROWS || 5000);

export function loadSpreadsheet(buffer, { ext = '.xlsx' } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: false, cellHTML: false });
  const lines = [];
  let totalRows = 0;
  let truncated = 0;

  for (const name of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    let rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false, defval: '' });
    if (!rows.length) continue;
    if (rows.length > MAX_ROWS_PER_SHEET) {
      truncated += rows.length - MAX_ROWS_PER_SHEET;
      rows = rows.slice(0, MAX_ROWS_PER_SHEET);
    }

    lines.push(`## 工作表：${name}`);
    const header = (rows[0] || []).map((c) => String(c ?? '').trim());
    rows.forEach((row, i) => {
      const cells = (row || []).map((c) => String(c ?? '').trim());
      if (!cells.some(Boolean)) return;
      totalRows++;
      lines.push(cells.join(' | '));
      if (i > 0 && i % 30 === 0 && header.some(Boolean)) lines.push(header.join(' | '));
    });
    lines.push('');
  }

  return {
    title: '',
    text: tidy(lines.join('\n')),
    meta: {
      sheets: Math.min(wb.SheetNames.length, MAX_SHEETS),
      rows: totalRows,
      truncatedRows: truncated,
      ext,
    },
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
