// 并发保护：全局并发上限、单 IP 速率限制、单会话串行锁
// 三者都是为了高并发下的稳定性：防止压垮自己、防止被刷、防止同会话重复执行写操作

import { currentInFlight, recordRejection } from '../observability/metrics.js';

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 64);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 600);
const WINDOW_MS = 60_000;

// —— 单 IP 滑动窗口 ——
const ipHits = new Map();

function hitsFor(ip, now) {
  const arr = ipHits.get(ip) || [];
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i += 1;
  if (i > 0) arr.splice(0, i);
  ipHits.set(ip, arr);
  return arr;
}

// 定期清理空窗口，避免 ipHits 无限增长
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipHits) {
    if (!arr.length || arr[arr.length - 1] < now - WINDOW_MS) ipHits.delete(ip);
  }
}, WINDOW_MS);
if (cleanup.unref) cleanup.unref();

/** 全局并发上限：超过直接 429，保护事件循环与上游模型连接 */
export function concurrencyGuard(req, res, next) {
  if (currentInFlight() >= MAX_CONCURRENT) {
    recordRejection('rateLimited');
    res.setHeader('Retry-After', '1');
    // 参考 Sentinel 的 block 语义：明确告诉调用方是流量控制，而不是服务坏了
    return res.status(429).json({
      error: '服务繁忙，请稍后重试',
      code: 'FLOW_LIMIT',
      reason: 'concurrency',
      limit: MAX_CONCURRENT,
      retryAfterMs: 1000,
    });
  }
  next();
}

/** 单 IP 每分钟请求上限 */
export function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const arr = hitsFor(ip, now);
  if (arr.length >= RATE_LIMIT_PER_MIN) {
    recordRejection('rateLimited');
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: '请求过于频繁，请稍后再试',
      code: 'FLOW_LIMIT',
      reason: 'rate_limit',
      limit: RATE_LIMIT_PER_MIN,
      windowMs: WINDOW_MS,
      retryAfterMs: WINDOW_MS,
    });
  }
  arr.push(now);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_PER_MIN));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_PER_MIN - arr.length)));
  next();
}

// —— 单会话串行锁 ——
// 同一会话的并发请求会排队，避免两个"确认"请求同时执行写操作
const locks = new Map(); // sessionId -> tail promise

export async function acquireSessionLock(sessionId) {
  const prev = locks.get(sessionId) || Promise.resolve();
  let release;
  const current = new Promise((r) => { release = r; });
  // 新请求排在队尾
  const tail = prev.then(() => current);
  locks.set(sessionId, tail);
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    // 若后面没人排队，清掉 entry，避免锁表无限增长
    if (locks.get(sessionId) === tail) locks.delete(sessionId);
  };
}

export function lockStats() {
  return { activeSessions: locks.size };
}
