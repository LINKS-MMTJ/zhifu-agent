// 白盒测试：业务工具与引导入口
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  queryOrder, trackLogistics, createReturn, applyRefund, getOrderDetail,
} from '../../src/tools/ecommerce.js';
import { buildAction, buildConfirmAction } from '../../src/agent/actions.js';
import { getTool, TOOLS } from '../../src/tools/registry.js';

test('工具: 查订单命中', () => {
  const r = queryOrder({ orderId: 'SO20260001' });
  assert.equal(r.found, true);
  assert.equal(r.status, '已签收');
  assert.equal(r.amount, 299);
});

test('工具: 查订单未命中给出提示，但不回传内部演示订单号', () => {
  const r = queryOrder({ orderId: 'SO99999999' });
  assert.equal(r.found, false);
  assert.match(r.hint, /核对订单号|手机号/);
  assert.ok(!r.hint.includes('SO20260001'), '不应把演示订单号当示例回给用户');
});

test('工具: 完全没给查询条件时提示缺少参数', () => {
  const r = queryOrder({});
  assert.equal(r.found, false);
  assert.match(r.hint, /缺少/);
});

test('工具: 查物流返回轨迹', () => {
  const r = trackLogistics({ orderId: 'SO20260001' });
  assert.equal(r.found, true);
  assert.ok(Array.isArray(r.traces));
  assert.ok(r.traces.length >= 1);
});

test('工具: 可退订单发起退货成功', () => {
  const r = createReturn({ orderId: 'SO20260001' });
  assert.equal(r.found, true);
  assert.match(r.returnId, /^RT\d+/);
  assert.equal(r.status, '已受理');
});

test('工具: 运输中订单不允许退货', () => {
  const r = createReturn({ orderId: 'SO20260002' });
  assert.equal(r.found, true);
  assert.equal(r.rejected, true);
});

test('工具: 退款返回金额与时效', () => {
  const r = applyRefund({ orderId: 'SO20260003' });
  assert.equal(r.found, true);
  assert.equal(r.amount, 89);
  assert.ok(r.eta);
});

test('业务页: 订单详情含轨迹与可办理项', () => {
  const d = getOrderDetail('SO20260001');
  assert.ok(d);
  assert.ok(d.traces.length >= 1);
  assert.equal(d.actions.canReturn, true);
});

test('业务页: 订单不存在返回 null', () => {
  assert.equal(getOrderDetail('NOPE'), null);
});

test('工具注册表: 写操作标记为需要确认', () => {
  assert.equal(getTool('queryOrder').readonly, true);
  assert.equal(getTool('trackLogistics').readonly, true);
  assert.equal(getTool('createReturn').readonly, false);
  assert.equal(getTool('applyRefund').readonly, false);
  assert.equal(Object.keys(TOOLS).length, 4);
});

test('引导: 工具结果生成对应业务入口', () => {
  assert.deepEqual(
    buildAction('queryOrder', { orderId: 'SO20260001' }, {}),
    { type: 'order', label: '查看订单详情', orderId: 'SO20260001' }
  );
  assert.deepEqual(
    buildAction('trackLogistics', { orderId: 'SO20260001' }, {}),
    { type: 'logistics', label: '查看物流轨迹', orderId: 'SO20260001' }
  );
});

test('引导: 无订单号时不生成入口', () => {
  assert.equal(buildAction('queryOrder', {}, {}), null);
  assert.equal(buildConfirmAction('createReturn', {}), null);
});

test('引导: 写操作确认时引导到办理页', () => {
  const a = buildConfirmAction('createReturn', { orderId: 'SO20260001' });
  assert.equal(a.type, 'return');
  assert.equal(a.orderId, 'SO20260001');
});
