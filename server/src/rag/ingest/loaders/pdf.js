// PDF 解析：走 pdfjs-dist 的 legacy 构建（Node 无 DOM 环境可用）
// 按页抽取文本，依据文字块的 y 坐标还原行与段落，输出带页码定位的分页文本
import { tidy } from './text.js';

let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

// 把一页的文字块按 y 聚成行，再按行距判断段落
function itemsToText(items) {
  const rows = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    if (!it.str) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4];
    const y = tr[5];
    const h = Math.abs(tr[3]) || 10;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
    if (!row) {
      row = { y, h, cells: [] };
      rows.push(row);
    }
    row.cells.push({ x, s: it.str });
  }

  rows.sort((a, b) => b.y - a.y);
  const lines = [];
  let lastY = null;
  let lastH = 10;
  for (const r of rows) {
    const text = r.cells.sort((a, b) => a.x - b.x).map((c) => c.s).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (lastY != null) {
      const gap = lastY - r.y;
      if (gap > Math.max(lastH, r.h) * 1.8) lines.push('');
    }
    lines.push(text);
    lastY = r.y;
    lastH = r.h;
  }
  return tidy(lines.join('\n'));
}

export async function loadPdf(buffer, { maxPages = 0 } = {}) {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    // 不加载外部字体数据，避免离线环境发起网络请求
    standardFontDataUrl: null,
    verbosity: 0,
  });

  const doc = await task.promise;
  let title = '';
  try {
    const meta = await doc.getMetadata();
    title = tidy(meta?.info?.Title || '');
  } catch {
    // 无元数据
  }

  const numPages = doc.numPages;
  const limit = maxPages > 0 ? Math.min(maxPages, numPages) : numPages;
  const parts = [];
  for (let i = 1; i <= limit; i++) {
    const page = await doc.getPage(i);
    try {
      const content = await page.getTextContent();
      const text = itemsToText(content.items);
      if (text) parts.push(`## 第 ${i} 页\n${text}`);
    } finally {
      page.cleanup();
    }
  }
  await task.destroy();

  return {
    title,
    text: tidy(parts.join('\n\n')),
    meta: { pages: numPages, parsedPages: limit, bytes: buffer.length },
  };
}
