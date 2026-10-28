// 成本护栏：企业里 Agent 不能"无限花"，尤其接了真实模型之后
//
// 两道阈值：
//   软阈值（默认 80%）：不拒绝，但把本请求的路由策略降级为"价格优先"，
//                       先保住可用性，再控制成本
//   硬阈值（100%）   ：直接拒绝新请求，返回明确原因并写审计
//
// 计数按自然日滚动。多副本部署时应换成 Redis 计数或数据库汇总，
// 否则每个副本各算各的，实际额度会被放大 N 倍。
const SOFT_RATIO_DEFAULT = 0.8;

let day = '';
let spent = 0;
let blocked = 0;
let degraded = 0;

// 每次读取环境变量：便于测试与不重启调整额度
function limit() {
  return Number(process.env.DAILY_COST_LIMIT || 0);
}

function softRatio() {
  const v = Number(process.env.DAILY_COST_SOFT_RATIO || SOFT_RATIO_DEFAULT);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : SOFT_RATIO_DEFAULT;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function roll() {
  const d = today();
  if (d !== day) {
    day = d;
    spent = 0;
    blocked = 0;
    degraded = 0;
  }
}

export function recordCost(amount) {
  const v = Number(amount) || 0;
  if (v <= 0) return;
  roll();
  spent += v;
}

export function quotaState() {
  roll();
  const cap = limit();
  if (!cap) {
    return { date: day, limit: 0, spent: Number(spent.toFixed(6)), ratio: 0, degrade: false, exhausted: false, blocked, degraded };
  }
  const ratio = spent / cap;
  return {
    date: day,
    limit: cap,
    spent: Number(spent.toFixed(6)),
    ratio: Number(ratio.toFixed(4)),
    remaining: Number(Math.max(0, cap - spent).toFixed(6)),
    degrade: ratio >= softRatio() && ratio < 1,
    exhausted: ratio >= 1,
    blocked,
    degraded,
  };
}

// 请求进入前调用：返回是否放行，以及是否要降级路由策略
export function checkQuota() {
  const s = quotaState();
  if (s.exhausted) {
    blocked += 1;
    return { allowed: false, reason: '今日成本额度已用完', state: s };
  }
  if (s.degrade) degraded += 1;
  return { allowed: true, degrade: s.degrade, state: s };
}

export function resetQuotaForTest() {
  day = '';
  spent = 0;
  blocked = 0;
  degraded = 0;
}
