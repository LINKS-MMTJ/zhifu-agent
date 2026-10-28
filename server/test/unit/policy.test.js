// 白盒测试：回答策略 / 提示词构造 / 复杂度判定
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_MODE, decideAnswerMode } from '../../src/agent/answerPolicy.js';
import { buildMessages } from '../../src/agent/prompts.js';
import { classifyComplexity } from '../../src/router/complexity.js';

test('回答策略: 工具结果优先', () => {
  assert.equal(decideAnswerMode({ intent: 'order', hasToolResults: true, retrievedCount: 3 }), ANSWER_MODE.TOOL);
});

test('回答策略: faq 且检索命中 → RAG', () => {
  assert.equal(decideAnswerMode({ intent: 'faq', retrievedCount: 2 }), ANSWER_MODE.RAG);
});

test('回答策略: faq 但检索未命中 → 回落通用对话', () => {
  assert.equal(decideAnswerMode({ intent: 'faq', retrievedCount: 0 }), ANSWER_MODE.GENERAL);
});

test('回答策略: 非业务 → 通用对话', () => {
  assert.equal(decideAnswerMode({ intent: 'out_of_scope' }), ANSWER_MODE.GENERAL);
});

test('回答策略: 转人工', () => {
  assert.equal(decideAnswerMode({ intent: 'human' }), ANSWER_MODE.HANDOFF);
});

test('提示词: 通用对话禁止生硬拒绝话术', () => {
  const msgs = buildMessages({ mode: ANSWER_MODE.GENERAL, message: '你是谁' });
  const sys = msgs[0].content;
  assert.equal(msgs[0].role, 'system');
  assert.match(sys, /禁止使用/);
  assert.match(sys, /正面回答/);
  assert.equal(msgs.at(-1).role, 'user');
  assert.equal(msgs.at(-1).content, '你是谁');
});

test('提示词: RAG 模式注入参考资料', () => {
  const msgs = buildMessages({
    mode: ANSWER_MODE.RAG,
    message: '退货运费谁出',
    retrieved: [{ title: '7 天无理由退货政策', text: '退货运费由买家承担。' }],
  });
  assert.match(msgs[0].content, /参考资料/);
  assert.match(msgs[0].content, /退货运费由买家承担/);
});

test('提示词: 工具模式注入执行结果', () => {
  const msgs = buildMessages({
    mode: ANSWER_MODE.TOOL,
    message: '查订单',
    toolResults: [{ name: 'queryOrder', result: { orderId: 'SO20260001' } }],
  });
  assert.match(msgs[0].content, /业务操作结果/);
  assert.match(msgs[0].content, /SO20260001/);
});

// —— 复杂度：必须按任务形态判定，而非业务敏感词 ——
test('复杂度: 一句话政策咨询 → simple（曾被误判为 complex）', () => {
  assert.equal(classifyComplexity('退货运费谁出？', 'faq').level, 'simple');
  assert.equal(classifyComplexity('退款多久到账？', 'faq').level, 'simple');
});

test('复杂度: 写操作办理 → medium', () => {
  assert.equal(classifyComplexity('我要退货，订单号 SO20260001', 'return').level, 'medium');
  assert.equal(classifyComplexity('订单 SO20260001 申请退款', 'refund').level, 'medium');
});

test('复杂度: 查询类 → medium', () => {
  assert.equal(classifyComplexity('查一下订单 SO20260001', 'order').level, 'medium');
  assert.equal(classifyComplexity('看看 SO20260001 的物流', 'logistics').level, 'medium');
});

test('复杂度: 投诉纠纷 → complex', () => {
  assert.equal(classifyComplexity('我要投诉你们', 'out_of_scope').level, 'complex');
  assert.equal(classifyComplexity('再不给我退我就去起诉', 'return').level, 'complex');
});

test('复杂度: 闲聊 → simple', () => {
  assert.equal(classifyComplexity('你是谁', 'out_of_scope').level, 'simple');
});

test('复杂度: 超长文本 → complex', () => {
  const long = '我想问一下'.repeat(30);
  assert.equal(classifyComplexity(long, 'faq').level, 'complex');
});
