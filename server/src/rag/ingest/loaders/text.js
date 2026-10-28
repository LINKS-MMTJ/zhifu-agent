// 文本 / 标记 / 结构化文本解析
// 统一出口：{ title, text, meta }
//   - title: 文档标题（用于检索辅助与展示）
//   - text : 结构化纯文本（保留 # 标题、列表、表格分隔符），供切块器识别层级
//   - meta : 解析到的附加元数据（如 json 记录数、html 标题）

const REPLACEMENT_LIMIT = 0.002;

// 国内企业文档里 GBK/GB18030 很常见，UTF-8 解出大量替换字符时自动回退
export function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (text.match(/\uFFFD/g) || []).length;
  if (bad > Math.max(3, text.length * REPLACEMENT_LIMIT)) {
    try {
      const alt = new TextDecoder('gb18030', { fatal: false }).decode(buf);
      if ((alt.match(/\uFFFD/g) || []).length < bad) text = alt;
    } catch {
      // 运行环境不带全量 ICU 时忽略，保留 UTF-8 结果
    }
  }
  return text.replace(/^\uFEFF/, '');
}

export function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0\u200b]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×', yensign: '¥',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

// HTML → 结构化文本：保留标题层级、列表、表格单元格分隔
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, inner) => `\n${'#'.repeat(Number(lv))} ${stripTags(inner)}\n`);
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|blockquote|tr|table|ul|ol|dl|dd|dt)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ');
  s = stripTags(s);
  return tidy(decodeEntities(s));
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '');
}

export function titleFromHtml(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? tidy(decodeEntities(stripTags(m[1]))) : '';
}

export function loadPlainText(buffer, { ext = '.txt', name = '' } = {}) {
  const text = tidy(decodeText(buffer));
  // Markdown 的首个一级标题优先作为文档标题
  const h1 = ext === '.md' || ext === '.markdown' ? text.match(/^#\s+(.+)$/m) : null;
  return { title: h1 ? h1[1].trim() : '', text, meta: { bytes: buffer.length } };
}

export function loadHtml(buffer) {
  const raw = decodeText(buffer);
  return { title: titleFromHtml(raw), text: htmlToText(raw), meta: { bytes: buffer.length } };
}

// JSON / JSONL：抽出所有字符串字段，按 key 路径拼成可检索段落
// 常见字段名转成中文标签，便于阅读与转述（问答对尤其明显）
const FIELD_LABEL = {
  q: '问', question: '问', title: '标题', a: '答', answer: '答', content: '内容',
  tag: '标签', category: '分类', type: '类型', desc: '说明', description: '说明',
};

function fieldLabel(path) {
  const key = String(path || '').split('.').pop() || '';
  return FIELD_LABEL[key.toLowerCase()] || key || 'value';
}

export function loadJson(buffer, { ext = '.json', name = '' } = {}) {
  const raw = decodeText(buffer);
  const records = [];

  if (ext === '.jsonl' || ext === '.ndjson') {
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        records.push(JSON.parse(s));
      } catch {
        // 单行坏数据不影响整份文件
      }
    }
  } else {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        records.push(...data);
      } else if (data && typeof data === 'object') {
        // 常见形态：{ updatedAt, items: [...] } —— 把数组字段当作记录列表
        const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object');
        const scalars = Object.entries(data).filter(([, v]) => v === null || typeof v !== 'object');
        if (arrays.length) {
          if (scalars.length) records.push(Object.fromEntries(scalars));
          for (const [, arr] of arrays) records.push(...arr);
        } else {
          records.push(data);
        }
      } else {
        records.push(data);
      }
    } catch {
      // 不是合法 JSON 时按纯文本兜底，至少不丢内容
      return { title: '', text: tidy(raw), meta: { fallback: 'plain' } };
    }
  }

  const lines = [];
  const walk = (node, path, depth, skip = null) => {
    if (depth > 6 || lines.length > 20000) return;
    if (node == null) return;
    if (Array.isArray(node)) {
      node.slice(0, 500).forEach((v) => walk(v, path, depth + 1, skip));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, depth + 1, skip);
      return;
    }
    if (skip && path && skip.has(String(path).split('.').pop().toLowerCase())) return;
    if (typeof node === 'string' && node.trim()) {
      const v = tidy(node);
      // 用 "字段：值" 而不是二级标题，保证同一条记录的问答落在同一个切块里
      if (v) lines.push(`${fieldLabel(path)}：${v}`);
    } else if (typeof node === 'number' || typeof node === 'boolean') {
      lines.push(`${fieldLabel(path)}：${node}`);
    }
  };

  records.forEach((r, i) => {
    // 有问答/标题字段时，用它作小节名：引用里能直接看到"问的是什么"
    const label = r && typeof r === 'object'
      ? (r.q || r.question || r.title || r.name || '')
      : '';
    lines.push(`## ${label ? String(label).slice(0, 48) : `记录 ${i + 1}`}`);
    walk(r, '', 0, label ? new Set(['q', 'question', 'title', 'name']) : null);
    lines.push('');
  });

  return { title: '', text: tidy(lines.join('\n\n')), meta: { records: records.length } };
}
