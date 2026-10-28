// 白盒测试：OpenTelemetry 可选接入的降级行为
// 线上没配 OTLP 端点时，所有 span API 必须是安全 no-op，不能影响调用方
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initOtel, shutdownOtel, otelEnabled, startSpan, setSpanAttrs, endSpan, withSpan,
} from '../../src/observability/otel.js';

test('OTel: 未配置端点时不启用，span API 全部安全降级', async () => {
  const on = await initOtel({ endpoint: '' });
  assert.equal(on, false);
  assert.equal(otelEnabled(), false);

  const span = startSpan('chat.request', { sessionId: 's-1' });
  assert.equal(span, null);
  assert.doesNotThrow(() => setSpanAttrs(span, { intent: 'faq' }));
  assert.doesNotThrow(() => endSpan(span));
  assert.doesNotThrow(() => endSpan(null, new Error('ignored')));
});

test('OTel: withSpan 在关闭状态下等价于直接调用，异常原样抛出', async () => {
  assert.equal(await withSpan('tool.call', { tool: 'queryOrder' }, async () => 42), 42);
  await assert.rejects(
    () => withSpan('tool.call', {}, async () => { throw new Error('boom'); }),
    /boom/
  );
});

test('OTel: 重复关闭不会抛错', async () => {
  assert.equal(await shutdownOtel(), false);
});
