// 请求级 traceId：贯穿 HTTP 响应头、SSE 事件、结构化日志与审计记录
//
// 企业排障的现实需求：用户反馈"刚才那条回答错了"，需要能凭一个 id 找到
// 这次请求的模型、检索、工具调用与耗时。没有 traceId 就只能靠时间猜。
//
// 兼容 W3C Trace Context：上游若传 traceparent，直接沿用它的 trace-id 并回写响应头，
// 这样能接阿里云 ARMS / OpenTelemetry Collector / Jaeger 等链路系统。
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function parseTraceparent(value) {
  const m = TRACEPARENT.exec(String(value || '').trim());
  if (!m) return null;
  // 规范要求 trace-id / span-id 不能全 0
  if (/^0+$/.test(m[2]) || /^0+$/.test(m[3])) return null;
  return { traceId: m[2].toLowerCase(), parentSpanId: m[3].toLowerCase(), flags: m[4].toLowerCase() };
}

export function traceMiddleware(req, res, next) {
  const incoming = parseTraceparent(req.get('traceparent'));
  const custom = req.get('x-request-id');

  const id = incoming?.traceId
    || (custom && custom.length <= 128 ? custom : crypto.randomBytes(16).toString('hex'));
  const spanId = crypto.randomBytes(8).toString('hex');

  req.traceId = id;
  req.spanId = spanId;
  res.setHeader('x-request-id', id);
  // 只有合法的 32 位十六进制才回写 traceparent，避免生成非法 trace 上下文
  if (/^[0-9a-f]{32}$/i.test(id)) {
    res.setHeader('traceparent', `00-${id.toLowerCase()}-${spanId}-01`);
  }
  als.run({ id, spanId }, next);
}

export function currentTraceId() {
  return als.getStore()?.id || null;
}

export function currentSpanId() {
  return als.getStore()?.spanId || null;
}

// 后台任务（如出站 webhook）需要手动带上上下文
export function runWithTrace(id, fn) {
  return als.run({ id, spanId: crypto.randomBytes(8).toString('hex') }, fn);
}
