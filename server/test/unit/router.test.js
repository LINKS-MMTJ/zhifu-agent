// 白盒测试：智能模型路由（策略选择 / 成本估算 / 熔断降级）
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../src/router/modelRouter.js';

const makeModels = () => [
  { id: 'lite', tier: 'lite', adapter: 'mock', priceIn: 0.3, priceOut: 0.6, quality: 60, latencyMs: 300, enabled: true },
  { id: 'std', tier: 'standard', adapter: 'mock', priceIn: 1.2, priceOut: 2.4, quality: 78, latencyMs: 550, enabled: true },
  { id: 'pro', tier: 'pro', adapter: 'mock', priceIn: 4.0, priceOut: 12.0, quality: 92, latencyMs: 850, enabled: true },
  { id: 'off', tier: 'standard', adapter: 'mock', priceIn: 0, priceOut: 0, quality: 99, latencyMs: 1, enabled: false },
];

test('路由: 未启用的模型仍展示，但不参与选择', () => {
  const r = new ModelRouter(makeModels());
  // 管理页要能看到"已注册未配置 Key"的模型
  assert.equal(r.list().length, 4);
  assert.ok(r.list().some((m) => m.id === 'off' && m.enabled === false));
  assert.equal(r.list().find((m) => m.id === 'off').healthy, false);
  // 但路由候选里不能出现
  assert.ok(!r.candidates('simple').some((m) => m.id === 'off'));
  assert.ok(!r.candidates('complex').some((m) => m.id === 'off'));
});

test('路由: 简单任务按价格优先选最便宜', () => {
  const r = new ModelRouter(makeModels());
  const { model, strategy } = r.select('simple');
  assert.equal(model.id, 'lite');
  assert.equal(strategy, 'price');
});

test('路由: 复杂任务按质量优先选最强', () => {
  const r = new ModelRouter(makeModels());
  const { model, strategy } = r.select('complex');
  assert.equal(model.id, 'pro');
  assert.equal(strategy, 'quality');
});

test('路由: 显式指定 latency 策略选最快', () => {
  const r = new ModelRouter(makeModels());
  const { model } = r.select('simple', 'latency');
  assert.equal(model.id, 'lite');
});

test('路由: 显式指定 price 策略在候选档内选最便宜', () => {
  const r = new ModelRouter(makeModels());
  const { model } = r.select('medium', 'price');
  assert.equal(model.id, 'std');
});

test('路由: 均衡策略不会无脑选最贵（质量差距不足以抵消成本）', () => {
  const r = new ModelRouter(makeModels());
  // medium 候选为 [std, pro]，均衡应在质量与成本间取平衡，选中 std
  const { model } = r.select('medium', 'balanced');
  assert.equal(model.id, 'std');
});

test('路由: 均衡策略在质量差距极大时仍可选强模型', () => {
  const r = new ModelRouter([
    { id: 'cheap', tier: 'standard', adapter: 'mock', priceIn: 1, priceOut: 2, quality: 40, latencyMs: 400, enabled: true },
    { id: 'strong', tier: 'standard', adapter: 'mock', priceIn: 1.2, priceOut: 2.2, quality: 95, latencyMs: 420, enabled: true },
  ]);
  const { model } = r.select('medium', 'balanced');
  assert.equal(model.id, 'strong');
});

test('路由: 返回降级候选链', () => {
  const r = new ModelRouter(makeModels());
  const { model, fallbacks } = r.select('simple');
  assert.ok(fallbacks.length >= 1);
  assert.ok(!fallbacks.some((f) => f.id === model.id));
});

test('路由: 成本估算按 1M tokens 线性计算', () => {
  const r = new ModelRouter(makeModels());
  const lite = r.list().find((m) => m.id === 'lite');
  // priceIn 0.3/1M → 1M 输入 token 应等于 0.3
  assert.equal(r.estimateCost(lite, 1000000, 0), 0.3);
  assert.equal(r.estimateCost(lite, 0, 1000000), 0.6);
});

test('路由: 连续失败触发熔断，健康后不进入候选', () => {
  const r = new ModelRouter(makeModels());
  const lite = r.models.find((m) => m.id === 'lite');
  r.reportFailure(lite);
  assert.equal(r.isHealthy(lite), true, '一次失败还不应熔断');
  r.reportFailure(lite);
  assert.equal(r.isHealthy(lite), false, '连续两次失败应熔断');
  r.reportSuccess(lite);
  assert.equal(r.isHealthy(lite), true, '成功后应恢复');
});

test('路由: 全部熔断时仍返回可用候选（避免无模型可调）', () => {
  const r = new ModelRouter(makeModels());
  for (const m of r.models) { r.reportFailure(m); r.reportFailure(m); }
  const { model } = r.select('simple');
  assert.ok(model, '全熔断时仍应返回一个兜底模型');
});
