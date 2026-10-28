// 白盒测试：多轮上下文的读取与省略句判定
import test from 'node:test';
import assert from 'node:assert/strict';
import { readContext, isContextDependent } from '../../src/agent/orchestrator.js';

test('上下文: 恢复上一句用户问题、上一句回答、意图与订单号', () => {
  const msgs = [
    { role: 'user', content: '查一下订单 SO20260001' },
    { role: 'assistant', content: '查到订单 SO20260001，当前状态【待发货】', mode: 'tool', intent: 'order' },
  ];
  const ctx = readContext(msgs);
  assert.equal(ctx.lastUser, '查一下订单 SO20260001');
  assert.ok(ctx.lastAnswer.includes('待发货'));
  assert.equal(ctx.lastIntent, 'order');
  assert.equal(ctx.lastMode, 'tool');
  assert.equal(ctx.orderId, 'SO20260001');
});

test('上下文: 空历史不报错', () => {
  const ctx = readContext([]);
  assert.equal(ctx.lastUser, '');
  assert.equal(ctx.lastAnswer, '');
  assert.equal(ctx.orderId, null);
});

test('上下文: 识别省略式追问', () => {
  assert.equal(isContextDependent('那退款呢'), true);
  assert.equal(isContextDependent('为什么这么慢'), true);
  assert.equal(isContextDependent('那能退吗'), true);
  assert.equal(isContextDependent('这笔订单呢'), true);
  assert.equal(isContextDependent('退货'), false);
});

test('上下文: 完整问句不算追问', () => {
  assert.equal(isContextDependent('退货运费谁出？'), false);
  assert.equal(isContextDependent('推荐一本书'), false);
  assert.equal(isContextDependent(''), false);
  // 超长句子按新问题处理，避免误继承上一轮意图
  assert.equal(isContextDependent('那我想问一下你们这个七天无理由退货到底是怎么计算的'), false);
});
