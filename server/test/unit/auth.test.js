// 白盒测试：管理接口鉴权
import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin, adminOrWebhook } from '../../src/middleware/auth.js';

function req(headers = {}, { path = '/', method = 'GET' } = {}) {
  return {
    path,
    method,
    get: (k) => headers[String(k).toLowerCase()],
  };
}

function res() {
  return {
    code: 200,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function run(mw, request) {
  const r = res();
  let passed = false;
  mw(request, r, () => { passed = true; });
  return { passed, res: r };
}

test('鉴权: 未设置 ADMIN_TOKEN 时放行（本地演示）', () => {
  delete process.env.ADMIN_TOKEN;
  assert.equal(run(requireAdmin, req()).passed, true);
});

test('鉴权: 设置后无令牌返回 401', () => {
  process.env.ADMIN_TOKEN = 'secret-token';
  const { passed, res: r } = run(requireAdmin, req());
  assert.equal(passed, false);
  assert.equal(r.code, 401);
  assert.equal(r.body.needToken, true);
  delete process.env.ADMIN_TOKEN;
});

test('鉴权: 令牌错误返回 401', () => {
  process.env.ADMIN_TOKEN = 'secret-token';
  const { passed, res: r } = run(requireAdmin, req({ 'x-admin-token': 'wrong' }));
  assert.equal(passed, false);
  assert.equal(r.code, 401);
  delete process.env.ADMIN_TOKEN;
});

test('鉴权: x-admin-token 正确时放行', () => {
  process.env.ADMIN_TOKEN = 'secret-token';
  assert.equal(run(requireAdmin, req({ 'x-admin-token': 'secret-token' })).passed, true);
  delete process.env.ADMIN_TOKEN;
});

test('鉴权: Authorization Bearer 也支持', () => {
  process.env.ADMIN_TOKEN = 'secret-token';
  assert.equal(run(requireAdmin, req({ authorization: 'Bearer secret-token' })).passed, true);
  delete process.env.ADMIN_TOKEN;
});

test('鉴权: 长度不同的令牌不会抛错（定长比较前先比长度）', () => {
  process.env.ADMIN_TOKEN = 'secret-token';
  const { res: r } = run(requireAdmin, req({ 'x-admin-token': 's' }));
  assert.equal(r.code, 401);
  delete process.env.ADMIN_TOKEN;
});

test('鉴权: 入站 webhook 不走管理令牌', () => {
  process.env.ADMIN_TOKEN = 'secret-token';
  const evt = run(adminOrWebhook, req({}, { path: '/events', method: 'POST' }));
  assert.equal(evt.passed, true);

  const list = run(adminOrWebhook, req({}, { path: '/', method: 'GET' }));
  assert.equal(list.passed, false);
  assert.equal(list.res.code, 401);
  delete process.env.ADMIN_TOKEN;
});
