// 压测 / 长稳测试脚本（零依赖）
//
// 用法：
//   node bench/loadtest.js --concurrency 100 --duration 60
//   node bench/loadtest.js --concurrency 200 --requests 5000 --url http://localhost:4000
//
// 输出：成功/失败数、QPS、客户端延迟 P50/P95/P99、状态码分布，
// 并每 10 秒抓一次服务端指标（内存 / 事件循环延迟 / 在途请求 / 会话数）用于判断是否有内存泄漏。

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const BASE = arg('url', 'http://127.0.0.1:4000');
const CONCURRENCY = Number(arg('concurrency', 50));
const DURATION_SEC = Number(arg('duration', 30));
const TOTAL_REQUESTS = Number(arg('requests', 0)); // 0 表示按时长跑
const REPORT_EVERY = Number(arg('report', 10));
const SESSIONS = Number(arg('sessions', 500)); // 会话池大小，用于验证 LRU 淘汰

// 混合任务，尽量贴近真实流量分布
const MESSAGES = [
  '退货运费谁出？',
  '保修期多久？',
  '查一下订单 SO20260001',
  '看看 SO20260001 的物流',
  '你是谁',
  '推荐一本书',
  '我要退货，订单号 SO20260001',
  '订单 SO20260002 申请退款',
];

const stats = {
  ok: 0, fail: 0,
  status: {},
  latencies: [],
  eventsCount: 0,
};

let stopAt = Date.now() + DURATION_SEC * 1000;
let issued = 0;

function pick(i) { return MESSAGES[i % MESSAGES.length]; }

async function oneRequest(idx) {
  const sessionId = `bench-${idx % SESSIONS}`; // 会话池，超出服务端上限会触发 LRU 淘汰
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: pick(idx) }),
    });
    stats.status[res.status] = (stats.status[res.status] || 0) + 1;
    if (!res.ok) {
      stats.fail += 1;
      await res.text();
      return;
    }
    // 消费完整个 SSE 流，确保服务端真的把这一轮跑完了
    const reader = res.body.getReader();
    let events = 0;
    while (true) {
      const { done } = await reader.read();
      if (done) break;
      events += 1;
    }
    stats.eventsCount += events;
    stats.ok += 1;
    stats.latencies.push(Date.now() - t0);
  } catch {
    stats.fail += 1;
    stats.status['ERR'] = (stats.status['ERR'] || 0) + 1;
  }
}

async function worker(id) {
  while (Date.now() < stopAt) {
    if (TOTAL_REQUESTS && issued >= TOTAL_REQUESTS) return;
    issued += 1;
    await oneRequest(issued);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function sampleMetrics() {
  try {
    const r = await fetch(`${BASE}/api/admin/metrics`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function main() {
  console.log(`压测目标: ${BASE}`);
  console.log(`并发: ${CONCURRENCY}　会话池: ${SESSIONS}　${TOTAL_REQUESTS ? `共 ${TOTAL_REQUESTS} 请求` : `${DURATION_SEC}s`}`);
  console.log('');

  const begin = Date.now();
  const memSeries = [];
  const reporter = setInterval(async () => {
    const m = await sampleMetrics();
    if (!m) return;
    memSeries.push({ t: Math.round((Date.now() - begin) / 1000), rss: m.memory.rssMB, heap: m.memory.heapUsedMB });
    console.log(
      `[${String(Math.round((Date.now() - begin) / 1000)).padStart(3)}s] ` +
      `内存 RSS ${String(m.memory.rssMB).padStart(6)}MB / Heap ${String(m.memory.heapUsedMB).padStart(5)}MB　` +
      `在途 ${m.inFlight}　会话 ${m.store.sessions}　QPS ${m.qps}　` +
      `事件循环 P99 ${m.eventLoopDelayMs.p99}ms　累计失败 ${m.counters.error}`
    );
  }, REPORT_EVERY * 1000);
  reporter.unref?.();

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  clearInterval(reporter);
  const elapsed = (Date.now() - begin) / 1000;
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const total = stats.ok + stats.fail;

  console.log('');
  console.log('==================== 压测结果 ====================');
  console.log(`总请求: ${total}　成功: ${stats.ok}　失败: ${stats.fail}`);
  console.log(`耗时: ${elapsed.toFixed(1)}s　吞吐: ${(total / elapsed).toFixed(1)} req/s`);
  console.log(`客户端延迟 P50: ${percentile(sorted, 50)}ms　P95: ${percentile(sorted, 95)}ms　P99: ${percentile(sorted, 99)}ms　最大: ${sorted.at(-1) || 0}ms`);
  console.log(`状态码分布: ${JSON.stringify(stats.status)}`);
  console.log(`SSE 分片总数: ${stats.eventsCount}`);

  const last = await sampleMetrics();
  if (last) {
    console.log('--------------------------------------------------');
    console.log(`服务端内存: RSS ${last.memory.rssMB}MB　Heap ${last.memory.heapUsedMB}/${last.memory.heapTotalMB}MB`);
    console.log(`事件循环延迟: mean ${last.eventLoopDelayMs.mean}ms　P99 ${last.eventLoopDelayMs.p99}ms　max ${last.eventLoopDelayMs.max}ms`);
    console.log(`服务端统计: 总请求 ${last.counters.total}　失败 ${last.counters.error}　限流 ${last.counters.rateLimited}　超时 ${last.counters.timeout}`);
    console.log(`会话数 ${last.store.sessions}/${last.store.maxSessions}　淘汰 ${last.store.evicted}　最大在途 ${last.maxInFlight}`);
  }

  if (memSeries.length >= 3) {
    const first = memSeries[0].rss;
    const lastRss = memSeries.at(-1).rss;
    const delta = +(lastRss - first).toFixed(1);

    // 判定要排除启动期的一次性分配：只比较后半段是否还在持续上涨
    const half = Math.floor(memSeries.length / 2);
    const secondHalf = memSeries.slice(half);
    const shFirst = secondHalf[0].rss;
    const shLast = secondHalf.at(-1).rss;
    const shGrowth = +(shLast - shFirst).toFixed(1);
    const shPct = shFirst > 0 ? (shGrowth / shFirst) * 100 : 0;

    console.log('--------------------------------------------------');
    console.log(`RSS 全期: ${first}MB → ${lastRss}MB（${delta >= 0 ? '+' : ''}${delta}MB）`);
    console.log(`RSS 后半段: ${shFirst}MB → ${shLast}MB（${shGrowth >= 0 ? '+' : ''}${shGrowth}MB, ${shPct.toFixed(1)}%）`);
    console.log(
      shPct < 10
        ? '✅ 后半段内存已走平，未见泄漏（启动期的增长属于一次性分配）'
        : '⚠️ 后半段内存仍在持续上涨，存在泄漏风险，建议加长 soak 并抓 heap snapshot'
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
