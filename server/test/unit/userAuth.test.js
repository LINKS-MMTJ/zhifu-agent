// 白盒测试：终端用户令牌的签发、校验与中间件行为
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueGuestToken, verifyUserToken, userAuth, userAuthEnabled,
} from '../../src/middleware/userAuth.js';

function req(headers = {}) {
  return { get: (k) => headers[String(k).toLowerCase()] };
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

test('用户令牌: 签发后可校验，userId 一致', () => {
  process.env.USER_TOKEN_SECRET = 'unit-test-secret-1234';
  const { token, userId, expiresAt } = issueGuestToken();
  assert.match(userId, /^g-[0-9a-f]{16}$/);
  assert.ok(expiresAt > Date.now());
  const payload = verifyUserToken(token);
  assert.equal(payload.sub, userId);
  delete process.env.USER_TOKEN_SECRET;
});

test('用户令牌: 被篡改或格式错误一律拒绝', () => {
  process.env.USER_TOKEN_SECRET = 'unit-test-secret-1234';
  const { token } = issueGuestToken();
  const [body, sig] = token.split('.');
  assert.equal(verifyUserToken(`${body}.${sig.slice(0, -2)}xx`), null);
  assert.equal(verifyUserToken('not-a-token'), null);
  assert.equal(verifyUserToken(''), null);
  // 换一个签名密钥也必须失败
  process.env.USER_TOKEN_SECRET = 'another-secret-987654';
  assert.equal(verifyUserToken(token), null);
  delete process.env.USER_TOKEN_SECRET;
});

test('用户令牌: 过期后校验失败', () => {
  process.env.USER_TOKEN_SECRET = 'unit-test-secret-1234';
  const { token } = issueGuestToken({ ttlMs: -1000 });
  assert.equal(verifyUserToken(token), null);
  delete process.env.USER_TOKEN_SECRET;
});

test('用户鉴权: 未开启 enforce 时放行', () => {
  delete process.env.USER_AUTH;
  assert.equal(userAuthEnabled(), false);
  assert.equal(run(userAuth, req()).passed, true);
});

test('用户鉴权: enforce 时缺令牌 401，带合法令牌放行', () => {
  process.env.USER_AUTH = 'enforce';
  process.env.USER_TOKEN_SECRET = 'unit-test-secret-1234';

  const noToken = run(userAuth, req());
  assert.equal(noToken.passed, false);
  assert.equal(noToken.res.code, 401);
  assert.equal(noToken.res.body.needToken, true);

  const { token } = issueGuestToken();
  const request = req({ authorization: `Bearer ${token}` });
  const ok = run(userAuth, request);
  assert.equal(ok.passed, true);
  assert.match(request.userId, /^g-/);

  delete process.env.USER_AUTH;
  delete process.env.USER_TOKEN_SECRET;
});
