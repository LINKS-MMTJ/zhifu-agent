// 白盒测试：写操作三道闸（时效 / 归属 / 幂等）与订单归属校验
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/orchestrator.js';
import { getSession, resetSessions } from '../../src/store/sessions.js';
import { queryOrder, phoneMatches, createReturn, applyRefund } from '../../src/tools/ecommerce.js';

async function collect(sessionId, opts) {
  const events = [];
  for await (const ev of runAgent({ sessionId, ...opts })) events.push(ev);
  return events;
}
const first = (events, type) => events.find((e) => e.type === type);
const textOf = (events) => events.filter((e) => e.type === 'token').map((e) => e.text).join('');

test('写操作: 确认超过有效期后作废，不执行工具', async () => {
  resetSessions();
  const sessionId = 'wg-expired';
  const s = getSession(sessionId);
  s.pendingAction = {
    tool: 'createReturn',
    args: { orderId: 'SO20260001', reason: '用户申请退货' },
    at: Date.now() - 10 * 60 * 1000,
    idem: 'idem-expired',
  };

  const events = await collect(sessionId, { message: '确认', confirm: true });
  assert.equal(first(events, 'tool'), undefined, '过期确认不应执行');
  assert.match(textOf(events), /超过/);
  assert.equal(first(events, 'done').expired, true);
  assert.equal(getSession(sessionId).pendingAction, null, '过期后待确认动作应被清空');
});

test('写操作: 手机号与订单归属不符时拒绝执行', async () => {
  resetSessions();
  const sessionId = 'wg-owner';
  const s = getSession(sessionId);
  // SO20260003 的下单手机号是 139****5678
  s.pendingAction = {
    tool: 'createReturn',
    args: { orderId: 'SO20260003', phone: '13812341234', reason: '用户申请退货' },
    at: Date.now(),
    idem: 'idem-owner',
  };

  const events = await collect(sessionId, { message: '确认', confirm: true });
  assert.equal(first(events, 'tool'), undefined, '归属不符不应执行');
  assert.match(textOf(events), /手机号对不上/);
  assert.equal(first(events, 'done').denied, 'ownership_mismatch');
});

test('写操作: 手机号与订单归属一致时正常执行', async () => {
  resetSessions();
  const sessionId = 'wg-owner-ok';
  const s = getSession(sessionId);
  s.pendingAction = {
    tool: 'createReturn',
    args: { orderId: 'SO20260001', phone: '13812341234', reason: '用户申请退货' },
    at: Date.now(),
    idem: 'idem-owner-ok',
  };

  const events = await collect(sessionId, { message: '确认', confirm: true });
  const tool = first(events, 'tool');
  assert.ok(tool, '归属一致应执行');
  assert.match(tool.result.returnId, /^RT\d+/);
  assert.equal(getSession(sessionId).lastWrite.idem, 'idem-owner-ok');
});

test('写操作: 重复确认不会执行第二次', async () => {
  resetSessions();
  const sessionId = 'wg-dupe';
  const s = getSession(sessionId);
  s.lastWrite = {
    tool: 'createReturn', args: { orderId: 'SO20260001' }, at: Date.now(), idem: 'idem-dupe',
  };

  const events = await collect(sessionId, { message: '确认', confirm: true });
  assert.equal(first(events, 'tool'), undefined, '重复确认不应再执行');
  assert.match(textOf(events), /已经办理完成/);
  assert.equal(first(events, 'done').duplicate, true);
});

test('写操作: 会话里报过手机号后，办理他人订单被拦下', async () => {
  resetSessions();
  const sessionId = 'wg-flow';
  const firstRound = await collect(sessionId, {
    message: '我的手机号 13812341234，我要退货，订单号 SO20260003',
  });
  const confirm = first(firstRound, 'confirm_request');
  assert.ok(confirm, '应先请求确认');
  assert.equal(confirm.args.phone, '13812341234', '手机号应随确认卡一起带上');

  const secondRound = await collect(sessionId, { message: '确认', confirm: true });
  assert.equal(first(secondRound, 'tool'), undefined);
  assert.match(textOf(secondRound), /手机号对不上/);
});

test('订单查询: 订单号与手机号不一致时按查不到处理', () => {
  assert.equal(queryOrder({ orderId: 'SO20260003', phone: '13812341234' }).found, false);
  assert.equal(queryOrder({ orderId: 'SO20260001', phone: '13812341234' }).found, true);
  assert.equal(queryOrder({ phone: '13812341234' }).found, true);
});

test('订单查询: 写操作传入不匹配手机号时给出归属提示', () => {
  const r1 = createReturn({ orderId: 'SO20260003', phone: '13812341234' });
  assert.equal(r1.found, false);
  assert.match(r1.hint, /不匹配/);
  const r2 = applyRefund({ orderId: 'SO20260003', phone: '13812341234' });
  assert.equal(r2.found, false);
  assert.match(r2.hint, /不匹配/);
});

test('手机号比对: 脱敏号按前 3 后 4 比对', () => {
  assert.equal(phoneMatches('138****1234', '13812341234'), true);
  assert.equal(phoneMatches('138****1234', '13912341234'), false);
  // 演示订单只存脱敏号，中间四位不可比；真实系统应存全量或哈希后再校验
  assert.equal(phoneMatches('138****1234', '13800005678'), false);
  assert.equal(phoneMatches('138****1234', ''), false);
  assert.equal(phoneMatches('', '13812341234'), false);
});
