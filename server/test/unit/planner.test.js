// 白盒测试：模型工具规划（function calling）的参数清洗与增量合并
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeToolCalls, planByModel, plannerMode } from '../../src/agent/planner.js';
import { toolSchemas } from '../../src/tools/registry.js';

const TOOLS = toolSchemas();

test('规划: 工具 Schema 只暴露白名单参数', () => {
  const names = TOOLS.map((t) => t.function.name);
  assert.ok(names.includes('queryOrder'));
  assert.ok(names.includes('createReturn'));
  const q = TOOLS.find((t) => t.function.name === 'queryOrder');
  assert.deepEqual(Object.keys(q.function.parameters.properties), ['orderId', 'phone']);
});

test('规划: 未知工具与未声明参数被丢弃', () => {
  const calls = sanitizeToolCalls([
    { name: 'dropDatabase', args: { sql: 'x' } },
    { name: 'queryOrder', args: { orderId: 'SO20260001', evil: 'rm -rf', phone: '13800001234' } },
  ], TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'queryOrder');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['orderId', 'phone']);
});

test('规划: 订单号与手机号按格式校验，非法值直接丢弃', () => {
  const calls = sanitizeToolCalls([
    { name: 'applyRefund', args: { orderId: '随便写一个' } },
    { name: 'queryOrder', args: { phone: '12345' } },
    { name: 'queryOrder', args: { orderId: 'so20260002', phone: '13800001234' } },
  ], TOOLS);
  // 第一条订单号非法 → 无参数 → 整条丢弃；第二条手机号非法 → 丢弃
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.orderId, 'SO20260002');
});

test('规划: 空参数调用没有执行价值，直接丢弃', () => {
  const calls = sanitizeToolCalls([{ name: 'createReturn', args: {} }], TOOLS);
  assert.equal(calls.length, 0);
});

test('规划: 增量 tool_call 帧会合并 name 与 arguments', async () => {
  const fakeModel = { id: 'fake-tool-model', adapter: 'openai', supportsTools: true };
  const fakeStream = async function* () {
    yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'trackLogistics', argsText: '{"order' };
    yield { type: 'tool_call_delta', index: 0, argsText: 'Id":"SO20260001"}' };
  };
  const out = await planByModel({
    message: '我那单鞋子到哪了',
    tools: TOOLS,
    model: fakeModel,
    stream: fakeStream,
  });
  assert.equal(out.modelId, 'fake-tool-model');
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].name, 'trackLogistics');
  assert.equal(out.calls[0].args.orderId, 'SO20260001');
});

test('规划: 模型流异常时降级为空规划，不向上抛', async () => {
  const fakeModel = { id: 'boom', adapter: 'openai', supportsTools: true };
  const fakeStream = async function* () {
    yield { type: 'tool_call_delta', index: 0, name: 'queryOrder', argsText: '{"orderId":"SO' };
    throw new Error('upstream reset');
  };
  const out = await planByModel({ message: '查单', tools: TOOLS, model: fakeModel, stream: fakeStream });
  assert.deepEqual(out.calls, []);
});

test('规划: 不支持工具的模型直接返回空', async () => {
  const out = await planByModel({
    message: '查单', tools: TOOLS, model: { id: 'mock', adapter: 'mock', supportsTools: false },
  });
  assert.deepEqual(out.calls, []);
  assert.equal(out.modelId, null);
});

test('规划: 默认模式是规则链路', () => {
  delete process.env.PLANNER;
  assert.equal(plannerMode(), 'rules');
  process.env.PLANNER = 'llm';
  assert.equal(plannerMode(), 'llm');
  delete process.env.PLANNER;
});
