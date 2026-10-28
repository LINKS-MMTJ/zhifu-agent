// 结构感知切块
//
// 与"固定长度滑动窗口"的区别：
//   1. 先识别标题层级，切块带上标题路径（headingPath），检索命中后能说清出处
//   2. 段落优先：标题 + 段落一起成块，不把一条政策拆成两半
//   3. 只有单个段落超过上限时才退化为按句切分，且尽量不越过句末标点
//   4. 相邻块保留少量句子重叠，避免答案正好落在边界上被切断

const SENTENCE_END = /(?<=[。！？；!?;])/;

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const CN_HEADING = /^(第[一二三四五六七八九十百零两\d]+[章节条款]|[一二三四五六七八九十]+、|\d+(?:\.\d+)+\s*)(.*)$/;
const BRACKET_HEADING = /^【([^】]{2,30})】$/;

// 识别一行是否是标题，返回 { level, text }；不是则返回 null
export function detectHeading(line) {
  const s = String(line).trim();
  if (!s || s.length > 60) return null;

  const md = s.match(MD_HEADING);
  if (md) return { level: md[1].length, text: md[2].trim() };

  const br = s.match(BRACKET_HEADING);
  if (br) return { level: 3, text: br[1] };

  const cn = s.match(CN_HEADING);
  if (cn && !/[。！？；]/.test(s)) {
    // "1.1 退款时效" 视为三级标题；"一、" 视为二级
    const marker = cn[1];
    const level = marker.startsWith('第') ? 2 : marker.includes('.') ? 3 : 2;
    return { level, text: s };
  }
  return null;
}

// 把长段落按句切开；单句仍超长时，退化为在逗号处断开，最后才硬切
function splitLong(text, maxChars) {
  const parts = [];
  let rest = text;

  while (rest.length > maxChars) {
    // 在 maxChars 附近找句末
    const window = rest.slice(0, Math.floor(maxChars * 1.2));
    const sentences = window.split(SENTENCE_END).filter((x) => x);
    if (sentences.length > 1) {
      let head = '';
      let i = 0;
      while (i < sentences.length && head.length + sentences[i].length <= maxChars) head += sentences[i++];
      if (head) {
        parts.push(head.trim());
        rest = rest.slice(head.length).trimStart();
        continue;
      }
    }
    // 单句超长：找逗号
    const cut = rest.lastIndexOf('，', maxChars);
    if (cut > maxChars * 0.5) {
      parts.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trimStart();
      continue;
    }
    parts.push(rest.slice(0, maxChars).trim());
    rest = rest.slice(maxChars).trimStart();
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

// 取尾部若干句作为重叠内容，长度不超过 n
function tailSentences(text, n) {
  if (n <= 0) return '';
  const arr = String(text).split(SENTENCE_END).filter((x) => x.trim());
  let out = '';
  for (let i = arr.length - 1; i >= 0; i--) {
    if ((out + arr[i]).length > n) break;
    out = arr[i] + out;
  }
  return out.trim();
}

// 把文档正文转成带标题路径的语义段
// 连续的标题会累积起来，一并并入下一段正文，避免出现"只有一行标题"的碎片块
function toSegments(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const path = [];
  const segs = [];
  let para = [];
  let pending = [];   // 尚未并入正文的标题行

  const flush = () => {
    const body = para.join('\n').trim();
    para = [];
    if (!body) return;   // 没有正文就先攒着，标题留到下一段
    const merged = [...pending, body].join('\n').trim();
    pending = [];
    if (merged) segs.push({ text: merged, headingPath: path.filter(Boolean).join(' > ') });
  };

  for (const raw of lines) {
    const line = raw.replace(/[\t\u00a0]+/g, ' ').replace(/ {2,}/g, ' ').trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = detectHeading(line);
    if (h) {
      flush();
      path.length = Math.min(path.length, Math.max(0, h.level - 1));
      path[h.level - 1] = h.text;
      pending.push(line.trim());
      continue;
    }
    para.push(line);
  }
  flush();
  if (pending.length) {
    segs.push({ text: pending.join('\n'), headingPath: path.filter(Boolean).join(' > ') });
  }

  return segs;
}

export function chunkText(text, options = {}) {
  const maxChars = Math.max(120, options.maxChars ?? 480);
  const overlapChars = Math.min(options.overlapChars ?? 80, Math.floor(maxChars / 3));
  const minChars = Math.min(options.minChars ?? 40, Math.floor(maxChars / 3));

  const segs = toSegments(text);
  const chunks = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.text.trim();
    if (!body) {
      cur = null;
      return;
    }
    // 过短的尾块并入上一块，避免产生"只有半句话"的噪声块
    if (body.length < minChars && chunks.length) {
      const prev = chunks[chunks.length - 1];
      if (prev.headingPath === cur.headingPath && prev.text.length + body.length + 1 <= maxChars * 1.4) {
        prev.text = `${prev.text}\n${body}`;
        cur = null;
        return;
      }
    }
    chunks.push({ text: body, headingPath: cur.headingPath });
    cur = null;
  };

  for (const seg of segs) {
    const parts = seg.text.length > maxChars ? splitLong(seg.text, maxChars) : [seg.text];
    for (const part of parts) {
      if (cur && cur.headingPath === seg.headingPath && cur.text.length + part.length + 1 <= maxChars) {
        cur.text += `\n${part}`;
        continue;
      }
      // 只在同一标题下做跨块重叠，避免把上一章的句子带进下一章
      const carry = cur && cur.headingPath === seg.headingPath ? tailSentences(cur.text, overlapChars) : '';
      flush();
      cur = { text: carry ? `${carry}\n${part}` : part, headingPath: seg.headingPath };
    }
  }
  flush();

  return chunks;
}

// 切块统计，便于入库日志与调试
export function chunkStats(chunks) {
  const lengths = chunks.map((c) => c.text.length).sort((a, b) => a - b);
  const sum = lengths.reduce((a, b) => a + b, 0);
  return {
    count: chunks.length,
    avgChars: lengths.length ? Math.round(sum / lengths.length) : 0,
    p50: lengths.length ? lengths[Math.floor(lengths.length * 0.5)] : 0,
    maxChars: lengths.length ? lengths[lengths.length - 1] : 0,
  };
}
