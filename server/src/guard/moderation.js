// 内容安全前置检查
//
// 企业 Agent 必须在调用模型前做一次输入审核，否则违规内容会直接进模型、进日志、进审计。
// 这里提供的是可插拔的最小实现：
//   - 默认按 MODERATION_BLOCKLIST 环境变量做关键词拦截（逗号分隔）
//   - 生产环境建议替换为阿里云内容安全（Green）等文本审核服务，
//     只需把 checkContent 换成异步调用，接口保持不变
//
// 注意：默认不开启任何内置词表，避免误伤正常售后对话；
// 是否开启由部署方显式配置。

function configuredBlocklist() {
  return String(process.env.MODERATION_BLOCKLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkContent(text, { blocklist } = {}) {
  const words = blocklist || configuredBlocklist();
  if (!words.length) return { ok: true };

  const t = String(text || '');
  for (const w of words) {
    if (t.includes(w)) {
      return { ok: false, reason: 'moderation', hit: w };
    }
  }
  return { ok: true };
}
