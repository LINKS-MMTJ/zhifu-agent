// 白盒测试：DeepSeek 评委提示词必须携带足够上下文
// 否则模型只能凭常识打分，评不出"有没有依据""工具用得对不对"
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgePrompt } from '../../eval/deepseekJudge.js';

const item = {
  question: '退货运费谁出？',
  scenario: 'faq',
  mode: 'rag',
  intent: 'faq',
  answer: '无理由退货运费由买家承担。',
  tools: [{ name: 'queryOrder', ok: true, result: { status: '已签收' } }],
  citations: [{ title: '退货退款总则', section: '2.2 运费承担', text: '无理由退货的退货运费由消费者承担。' }],
};

test('评委: 提示词包含评分标准与五个维度', () => {
  const p = buildJudgePrompt(item);
  assert.ok(p.includes('评分标准'));
  for (const dim of ['正确性', '有据可依', '工具使用', '语气与合规', '完整性']) {
    assert.ok(p.includes(dim), `缺少维度 ${dim}`);
  }
  assert.ok(p.includes('"score"'));
});

test('评委: 提示词带上了知识片段与章节，模型才知道依据', () => {
  const p = buildJudgePrompt(item);
  assert.ok(p.includes('退货退款总则'));
  assert.ok(p.includes('2.2 运费承担'));
  assert.ok(p.includes('无理由退货的退货运费由消费者承担'));
});

test('评委: 提示词带上了工具调用与返回结果', () => {
  const p = buildJudgePrompt(item);
  assert.ok(p.includes('queryOrder'));
  assert.ok(p.includes('已签收'));
});

test('评委: 提示词包含用户问题与 Agent 回答原文', () => {
  const p = buildJudgePrompt(item);
  assert.ok(p.includes('退货运费谁出？'));
  assert.ok(p.includes('无理由退货运费由买家承担'));
  assert.ok(p.includes('用户问题'));
  assert.ok(p.includes('Agent 回答'));
});

test('评委: 无检索、无工具时也能正常构造（不出现 undefined）', () => {
  const p = buildJudgePrompt({ question: '你是谁', scenario: 'nonbusiness', answer: '我是智服', mode: 'general' });
  assert.ok(p.includes('没有检索到知识片段'));
  assert.ok(p.includes('没有调用工具'));
  assert.ok(!p.includes('undefined'));
});

test('评委: 超长回答会被截断，避免超出上下文', () => {
  const p = buildJudgePrompt({ ...item, answer: 'x'.repeat(2000) });
  assert.ok(p.length < 4000);
  assert.ok(p.includes('…'));
});
