// 运行期指标：为 7×24 长稳与压测提供可观测数据
// 不依赖任何第三方库，直接暴露内存、事件循环延迟、QPS、延迟分位

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { storeStats } from '../store/sessions.js';

const startedAt = Date.now();
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

// 最近 2000 次请求耗时（毫秒），用于算分位
const LAT_CAP = 2000;
const latencies = [];

// 最近 60 秒的请求时间戳，用于算 QPS
const QPS_WINDOW_MS = 60_000;
const recent = [];

const counters = { total: 0, ok: 0, error: 0, rateLimited: 0, timeout: 0 };

/**
 * 记录一次被前置守卫拒绝的请求（并发超限 / 触发限流）
 * 这类请求没有进入业务处理，不计入 total，单独统计便于容量规划
 */
export function recordRejection(kind = 'rateLimited') {
  if (kind === 'timeout') counters.timeout += 1;
  else counters.rateLimited += 1;
}

let inFlight = 0;
let maxInFlight = 0;

export function beginRequest() {
  inFlight += 1;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  return inFlight;
}

/** 当前在途请求数（供并发保护判断） */
export function currentInFlight() {
  return inFlight;
}

export function endRequest({ latencyMs = 0, ok = true, kind = 'ok' } = {}) {
  inFlight = Math.max(0, inFlight - 1);
  counters.total += 1;
  if (ok) counters.ok += 1; else counters.error += 1;
  if (kind === 'rateLimited') counters.rateLimited += 1;
  if (kind === 'timeout') counters.timeout += 1;

  const now = Date.now();
  recent.push(now);
  latencies.push(latencyMs);
  if (latencies.length > LAT_CAP) latencies.shift();
  trimRecent(now);
}

function trimRecent(now) {
  const cutoff = now - QPS_WINDOW_MS;
  let i = 0;
  while (i < recent.length && recent[i] < cutoff) i += 1;
  if (i > 0) recent.splice(0, i);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

export function snapshot() {
  const now = Date.now();
  trimRecent(now);
  const mem = process.memoryUsage();
  const sorted = [...latencies].sort((a, b) => a - b);
  const windowSec = Math.max(1, Math.min(QPS_WINDOW_MS, now - startedAt) / 1000);

  return {
    uptimeSec: Math.round((now - startedAt) / 1000),
    memory: {
      rssMB: +(mem.rss / 1024 / 1024).toFixed(1),
      heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
      heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      externalMB: +(mem.external / 1024 / 1024).toFixed(1),
    },
    eventLoopDelayMs: {
      mean: +(histogram.mean / 1e6).toFixed(2),
      p99: +(histogram.percentile(99) / 1e6).toFixed(2),
      max: +(histogram.max / 1e6).toFixed(2),
    },
    qps: +(recent.length / windowSec).toFixed(2),
    inFlight,
    maxInFlight,
    counters: { ...counters },
    latencyMs: {
      samples: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    store: storeStats(),
  };
}

/** 压测/长稳脚本读这个格式判断内存是否稳定增长 */
export function resetMetrics() {
  counters.total = counters.ok = counters.error = counters.rateLimited = counters.timeout = 0;
  latencies.length = 0;
  recent.length = 0;
  maxInFlight = inFlight;
  histogram.reset();
}
