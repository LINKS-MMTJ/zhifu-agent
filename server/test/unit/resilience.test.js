// 白盒测试：流控响应语义、内容安全、脱敏规则
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep } from '../../src/privacy/redact.js';
import { checkContent } from '../../src/guard/moderation.js';

// 触发流控需要很小的阈值，这里用独立模块实例（env 在加载时读取）
process.env.MAX_CONCURRENT = '0';
process.env.RATE_LIMIT_PER_MIN = '1';
const { rateLimit, concurrencyGuard } = await import(`../../src/middleware/guards.js?flow=${Date.now()}`);

function makeRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    headers,
  };
}

function makeReq(ip = '127.0.0.1') {
  return { ip, socket: { remoteAddress: ip } };
}

test('流控: 超出单 IP 速率返回 429 + Retry-After + 原因码', () => {
  const req = makeReq('10.0.0.1');
  const first = makeRes();
  let passed = false;
  rateLimit(req, first, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(first.headers['x-ratelimit-limit'], '1');
  assert.equal(first.headers['x-ratelimit-remaining'], '0');

  const second = makeRes();
  let passed2 = false;
  rateLimit(req, second, () => { passed2 = true; });
  assert.equal(passed2, false);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.code, 'FLOW_LIMIT');
  assert.equal(second.body.reason, 'rate_limit');
  assert.equal(second.headers['retry-after'], '60');
});

test('流控: 并发上限返回独立原因码，便于区分是流量而非故障', () => {
  const res = makeRes();
  let passed = false;
  concurrencyGuard(makeReq(), res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'FLOW_LIMIT');
  assert.equal(res.body.reason, 'concurrency');
  assert.equal(res.headers['retry-after'], '1');
});

test('内容安全: 未配置词表时不拦截任何内容', () => {
  delete process.env.MODERATION_BLOCKLIST;
  assert.equal(checkContent('退货运费谁出？').ok, true);
  assert.equal(checkContent('随便什么').ok, true);
});

test('内容安全: 配置词表后命中即拦截，并返回命中词', () => {
  process.env.MODERATION_BLOCKLIST = '刷单,代开发票';
  const hit = checkContent('帮我刷单，可以吗');
  assert.equal(hit.ok, false);
  assert.equal(hit.reason, 'moderation');
  assert.equal(hit.hit, '刷单');
  assert.equal(checkContent('退货运费谁出？').ok, true);
  delete process.env.MODERATION_BLOCKLIST;
});

test('脱敏: 手机号 / 身份证 / 银行卡 / 邮箱', () => {
  assert.equal(redact('联系 13800001234'), '联系 138****1234');
  assert.equal(redact('身份证 110101199001011234'), '身份证 110101********1234');
  assert.equal(redact('卡号 6222021234567890123'), '卡号 6222 **** **** 0123');
  assert.equal(redact('邮箱 zhang.wei@example.com'), '邮箱 z***@example.com');
});

test('脱敏: 订单号与普通数字不被误伤', () => {
  assert.equal(redact('订单 SO20260001'), '订单 SO20260001');
  assert.equal(redact('金额 299 元'), '金额 299 元');
});

test('脱敏: 递归处理嵌套对象与数组', () => {
  const out = redactDeep({
    user: { phone: '13800001234', tags: ['vip', '13900005678'] },
    note: '身份证 110101199001011234',
    count: 3,
    flag: true,
    none: null,
  });
  assert.equal(out.user.phone, '138****1234');
  assert.equal(out.user.tags[1], '139****5678');
  assert.ok(out.note.includes('110101********1234'));
  assert.equal(out.count, 3);
  assert.equal(out.flag, true);
  assert.equal(out.none, null);
});
