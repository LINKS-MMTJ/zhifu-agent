// 启动期配置校验：宁可起不来，也不要带着错误配置跑起来
//
// 典型事故：MAX_CONCURRENT 写成 1e9、SESSION_TTL_MS 少写一个 0、
// 生产环境忘了配 ADMIN_TOKEN —— 这些都应该在启动时报错或告警，而不是等线上出问题。
const NUMBER_RULES = {
  PORT: [1, 65535],
  MAX_CONCURRENT: [1, 100000],
  RATE_LIMIT_PER_MIN: [1, 10_000_000],
  MAX_SESSIONS: [1, 10_000_000],
  SESSION_TTL_MS: [1000, 30 * 24 * 3600 * 1000],
  MAX_LOGS: [1, 1_000_000],
  UPSTREAM_TIMEOUT_MS: [1000, 600_000],
  SSE_HEARTBEAT_MS: [500, 120_000],
  SHUTDOWN_TIMEOUT_MS: [1000, 120_000],
  DAILY_COST_LIMIT: [0, 1_000_000_000],
  DAILY_COST_SOFT_RATIO: [0.1, 0.99],
  KB_HIERARCHICAL_MIN: [0, 10_000_000],
};

export function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];

  for (const [key, [min, max]] of Object.entries(NUMBER_RULES)) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) errors.push(`${key}=${raw} 不是数字`);
    else if (v < min || v > max) errors.push(`${key}=${raw} 超出允许范围 [${min}, ${max}]`);
  }

  if (env.NODE_ENV === 'production' && !env.ADMIN_TOKEN) {
    errors.push('生产环境必须设置 ADMIN_TOKEN，否则管理接口与工具调用无鉴权');
  }
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length < 16) {
    warnings.push('ADMIN_TOKEN 长度小于 16，建议使用更长的随机串');
  }
  if (!env.DEEPSEEK_API_KEY) {
    warnings.push('未配置 DEEPSEEK_API_KEY，将使用离线 Mock 模型');
  }
  if (env.WEBHOOK_SECRET && !env.INBOUND_WEBHOOK_SECRET) {
    warnings.push('配置了 WEBHOOK_SECRET（出站签名）但未配置 INBOUND_WEBHOOK_SECRET（入站验签）');
  }
  if (env.SESSION_TTL_MS && Number(env.SESSION_TTL_MS) < 60_000) {
    warnings.push('SESSION_TTL_MS 小于 1 分钟，可能导致会话频繁丢失');
  }

  return { errors, warnings };
}
