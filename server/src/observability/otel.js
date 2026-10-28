// 可选的 OpenTelemetry 接入
//
// 设计原则：
//   - 只有配置了 OTEL_EXPORTER_OTLP_ENDPOINT 才动态加载 SDK；未配置时所有 API 退化为 no-op，
//     不装依赖也能跑、不影响 299 项测试与离线演示
//   - 追踪是增强能力：初始化失败只告警，绝不阻断服务启动
//   - 与现有 traceId（W3C traceparent）打通：span 上带 app.trace_id，日志与链路可互查
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { currentTraceId } from './trace.js';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'zhifu-agent';
const TRACER_NAME = 'zhifu-agent';

let sdk = null;
let enabled = false;

export function otelEnabled() {
  return enabled;
}

export async function initOtel({ endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT } = {}) {
  if (!endpoint) return false;
  try {
    const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
    ]);
    const url = `${String(endpoint).replace(/\/$/, '')}/v1/traces`;
    sdk = new NodeSDK({
      serviceName: SERVICE_NAME,
      traceExporter: new OTLPTraceExporter({ url }),
    });
    await sdk.start();
    enabled = true;
    return true;
  } catch (err) {
    // 不要因为追踪组件的问题把业务服务带崩
    console.warn(`[otel] 初始化失败，已退化为仅本地 traceId：${err.message}`);
    sdk = null;
    enabled = false;
    return false;
  }
}

export async function shutdownOtel() {
  if (!sdk) return false;
  try {
    await sdk.shutdown();
  } catch {
    // 关闭阶段失败没有补救价值
  }
  sdk = null;
  enabled = false;
  return true;
}

// 给 span 打上通用属性：当前 traceId 必带，便于和 JSON 日志对齐
function decorate(span, attrs) {
  const tid = currentTraceId();
  if (tid) span.setAttribute('app.trace_id', tid);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    span.setAttribute(k, typeof v === 'number' || typeof v === 'boolean' ? v : String(v));
  }
}

/**
 * 开启一个 span；未启用 OTel 时返回 null，调用方无需判空（endSpan 会忽略 null）
 */
export function startSpan(name, attrs = {}) {
  if (!enabled) return null;
  const span = trace.getTracer(TRACER_NAME).startSpan(name);
  decorate(span, attrs);
  return span;
}

export function setSpanAttrs(span, attrs = {}) {
  if (!span) return;
  decorate(span, attrs);
}

export function endSpan(span, err) {
  if (!span) return;
  if (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message || String(err) });
  }
  span.end();
}

/** 包一个普通异步函数，异常会标记 ERROR 后重新抛出 */
export async function withSpan(name, attrs, fn) {
  const span = startSpan(name, attrs);
  try {
    const out = await fn();
    endSpan(span);
    return out;
  } catch (err) {
    endSpan(span, err);
    throw err;
  }
}
