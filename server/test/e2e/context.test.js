// 黑盒测试：多轮对话能否接上下文（省略句、槽位沿用、追问）
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chat, first, textOf, sid } from '../helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('上下文: 第二句省略订单号也能查物流', async () => {
  const sessionId = sid('ctx-tool');
  const first1 = await chat(srv.port, { sessionId, message: '查一下订单 SO20260001' });
  assert.equal(first(first1, 'meta').intent, 'order');

  const second = await chat(srv.port, { sessionId, message: '物流到哪了？' });
  const tool = first(second, 'tool');
  assert.ok(tool, '第二句应调用工具');
  assert.equal(tool.name, 'trackLogistics');
  assert.equal(tool.args.orderId, 'SO20260001');
  assert.ok(textOf(second).includes('物流轨迹'));
});

test('上下文: 省略式追问沿上一轮意图并带上下文检索', async () => {
  const sessionId = sid('ctx-rag');
  const first1 = await chat(srv.port, { sessionId, message: '退货运费谁出？' });
  assert.equal(first(first1, 'meta').mode, 'rag');

  const second = await chat(srv.port, { sessionId, message: '那退款呢' });
  const meta = first(second, 'meta');
  assert.equal(meta.mode, 'rag', '追问应继续走知识库，而不是通用对话');
  const retrieval = first(second, 'retrieval');
  assert.ok(retrieval, '应有检索结果');
  assert.ok(
    retrieval.snippets.some((s) => /退款|到账|原路/.test(`${s.title}${s.text}`)),
    '检索应命中退款相关文档',
  );
  const text = textOf(second);
  assert.ok(text.startsWith('接着刚才的问题说'), '回答应体现上下文承接');
  assert.ok(/退款|到账/.test(text), '不能拿上一轮的运费结论糊弄');
  assert.ok(!/退货运费由用户承担/.test(text), '不应重复上一轮主题的答案');
});

test('上下文: 追问“为什么”不再答非所问', async () => {
  const sessionId = sid('ctx-why');
  await chat(srv.port, { sessionId, message: '查一下订单 SO20260001' });
  const second = await chat(srv.port, { sessionId, message: '为什么这么慢' });
  const text = textOf(second);
  assert.ok(text.length > 20, '应有实质回答');
  assert.ok(!text.includes('一时答不上来'), '不应掉进通用兜底');
  assert.ok(/刚才|物流|发货|订单/.test(text), '回答应承接上一轮内容');
  assert.ok(!/发票/.test(text), '不应把“为什么慢”匹配到发票政策');
});

test('上下文: 新会话的独立问题不受上下文影响', async () => {
  const events = await chat(srv.port, { sessionId: sid('ctx-none'), message: '推荐一本书' });
  const meta = first(events, 'meta');
  assert.equal(meta.mode, 'general');
  const text = textOf(events);
  assert.ok(!text.startsWith('接着刚才'), '无上下文时不应强行承接');
});
