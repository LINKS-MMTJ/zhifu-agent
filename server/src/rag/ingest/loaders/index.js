// 解析器注册表：扩展名 → 加载函数
// 新增格式只需在这里注册，入库流水线无需改动
import { loadPlainText, loadHtml, loadJson } from './text.js';
import { loadDocx, loadSpreadsheet, loadPptx } from './office.js';
import { loadPdf } from './pdf.js';

export const LOADERS = {
  '.txt': (buf, ctx) => loadPlainText(buf, ctx),
  '.md': (buf, ctx) => loadPlainText(buf, ctx),
  '.markdown': (buf, ctx) => loadPlainText(buf, ctx),
  '.log': (buf, ctx) => loadPlainText(buf, ctx),
  '.html': (buf) => loadHtml(buf),
  '.htm': (buf) => loadHtml(buf),
  '.json': (buf, ctx) => loadJson(buf, ctx),
  '.jsonl': (buf, ctx) => loadJson(buf, ctx),
  '.ndjson': (buf, ctx) => loadJson(buf, ctx),
  '.docx': (buf) => loadDocx(buf),
  '.pdf': (buf) => loadPdf(buf),
  '.xlsx': (buf, ctx) => loadSpreadsheet(buf, ctx),
  '.csv': (buf, ctx) => loadSpreadsheet(buf, ctx),
  '.pptx': (buf) => loadPptx(buf),
};

export const SUPPORTED_EXT = Object.keys(LOADERS);
export const FORMAT_LABEL = {
  '.txt': 'text', '.md': 'markdown', '.markdown': 'markdown', '.log': 'text',
  '.html': 'html', '.htm': 'html',
  '.json': 'json', '.jsonl': 'jsonl', '.ndjson': 'jsonl',
  '.docx': 'word', '.pdf': 'pdf',
  '.xlsx': 'excel', '.csv': 'csv',
  '.pptx': 'ppt',
};

// 老格式 .xls（BIFF）已不再解析：解析库换成 exceljs 后不支持，
// 保留映射只为给出更明确的报错，而不是笼统的"不支持的格式"
export const LEGACY_EXT = {
  '.xls': '暂不支持老格式 .xls，请用 Excel 另存为 .xlsx 后再上传',
};

export function getLoader(ext) {
  return LOADERS[String(ext || '').toLowerCase()] || null;
}

export async function loadDocument(buffer, ctx) {
  const loader = getLoader(ctx.ext);
  if (!loader) {
    const err = new Error(`不支持的格式：${ctx.ext}`);
    err.code = 'UNSUPPORTED';
    throw err;
  }
  const out = await loader(buffer, ctx);
  return {
    title: out.title || '',
    text: out.text || '',
    meta: out.meta || {},
  };
}
