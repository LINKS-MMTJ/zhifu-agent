// 白盒测试：成本护栏与配置校验
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCost, quotaState, checkQuota, resetQuotaForTest } from '../../src/guard/quota.js';
import { validateEnv } from '../../src/config/env.js';

test('配额: 未设上限时不拦截', () => {
  delete process.env.DAILY_COST_LIMIT;
  resetQuotaForTest();
  recordCost(10);
  const s = quotaState();
  assert.equal(s.limit, 0);
  assert.equal(s.exhausted, false);
  assert.equal(checkQuota().allowed, true);
});

test('配额: 未超软阈值时正常放行', () => {
  process.env.DAILY_COST_LIMIT = '1';
  resetQuotaForTest();
  recordCost(0.5);
  const q = checkQuota();
  assert.equal(q.allowed, true);
  assert.equal(q.degrade, false);
  assert.equal(quotaState().spent, 0.5);
});

test('配额: 超过软阈值触发降级但不拒绝', () => {
  process.env.DAILY_COST_LIMIT = '1';
  process.env.DAILY_COST_SOFT_RATIO = '0.8';
  resetQuotaForTest();
  recordCost(0.85);
  const q = checkQuota();
  assert.equal(q.allowed, true);
  assert.equal(q.degrade, true);
  assert.equal(quotaState().degrade, true);
});

test('配额: 达到硬阈值后拒绝并计数', () => {
  process.env.DAILY_COST_LIMIT = '1';
  resetQuotaForTest();
  recordCost(1.2);
  const q = checkQuota();
  assert.equal(q.allowed, false);
  assert.match(q.reason, /额度/);
  assert.equal(quotaState().blocked, 1);
});

test('配额: 零成本不累计', () => {
  process.env.DAILY_COST_LIMIT = '1';
  resetQuotaForTest();
  recordCost(0);
  recordCost(-1);
  assert.equal(quotaState().spent, 0);
  delete process.env.DAILY_COST_LIMIT;
  delete process.env.DAILY_COST_SOFT_RATIO;
});

test('配置校验: 默认配置没有致命错误', () => {
  const { errors } = validateEnv({});
  assert.deepEqual(errors, []);
});

test('配置校验: 非法数字与越界会被拦下', () => {
  const { errors } = validateEnv({ MAX_CONCURRENT: 'abc', PORT: '70000', SESSION_TTL_MS: '100' });
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.includes('MAX_CONCURRENT')));
  assert.ok(errors.some((e) => e.includes('PORT')));
  assert.ok(errors.some((e) => e.includes('SESSION_TTL_MS')));
});

test('配置校验: 生产环境缺 ADMIN_TOKEN 视为致命错误', () => {
  const { errors } = validateEnv({ NODE_ENV: 'production' });
  assert.ok(errors.some((e) => e.includes('ADMIN_TOKEN')));
});

test('配置校验: 弱令牌与缺失 Key 给出告警', () => {
  const { warnings } = validateEnv({ ADMIN_TOKEN: 'short', NODE_ENV: 'production' });
  assert.ok(warnings.some((w) => w.includes('ADMIN_TOKEN')));
  assert.ok(warnings.some((w) => w.includes('DEEPSEEK_API_KEY')));
});
