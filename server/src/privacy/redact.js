// 敏感信息脱敏：日志与审计落盘前必须处理
//
// 原则：会话存储保留原文（多轮对话要用手机号/订单号继续办事），
// 但**日志与审计只保留脱敏后的内容**——它们是长期保存、被多方读取的数据。
//
// 覆盖：手机号、身份证、银行卡、邮箱。
// 更严格的做法是接入阿里云敏感数据保护 / 内容安全做识别与分级，这里先覆盖确定性规则。
const RULES = [
  {
    name: 'idcard',
    re: /(?<!\d)(\d{17}[\dXx])(?!\d)/g,
    mask: (m) => `${m.slice(0, 6)}********${m.slice(-4)}`,
  },
  {
    name: 'bankcard',
    re: /(?<!\d)(\d{16,19})(?!\d)/g,
    mask: (m) => `${m.slice(0, 4)} **** **** ${m.slice(-4)}`,
  },
  {
    name: 'phone',
    re: /(?<!\d)(1[3-9]\d{9})(?!\d)/g,
    mask: (m) => `${m.slice(0, 3)}****${m.slice(-4)}`,
  },
  {
    name: 'email',
    re: /([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})/gi,
    mask: (m, user, domain) => `${user.slice(0, 1)}***@${domain}`,
  },
];

export function redact(text) {
  let out = String(text);
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => rule.mask(...args));
  }
  return out;
}

// 递归脱敏对象（用于审计 meta / 日志字段），限制深度防止环
export function redactDeep(value, depth = 0) {
  if (value == null || depth > 5) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}
