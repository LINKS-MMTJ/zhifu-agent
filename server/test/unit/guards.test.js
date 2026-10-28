// 白盒测试：并发保护（并发上限 / 单 IP 限流 / 会话串行锁）
// 独立文件，导入前设置阈值便于验证
process.env.MAX_CONCURRENT = '2';
process.env.RATE_LIMIT_PER_MIN = '3';

const { concurrencyGuard, rateLimit, acquireSessionLock } = await import('../../src/middleware/guards.js');
const { beginRequest, endRequest } = await import('../../src/observability/metrics.js');
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

test('并发上限: 未超限放行', () => {
  beginRequest();
  const res = mockRes();
  let passed = false;
  concurrencyGuard({}, res, () => { passed = true; });
  assert.equal(passed, true);
  endRequest();
});

test('并发上限: 超限返回 429 且带 Retry-After', () => {
  beginRequest();
  beginRequest();
  beginRequest(); // 超过 MAX_CONCURRENT=2
  const res = mockRes();
  let passed = false;
  concurrencyGuard({}, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '1');
  endRequest(); endRequest(); endRequest();
});

test('限流: 超过每分钟上限返回 429', () => {
  const req = { ip: '203.0.113.9', socket: {} };
  let blocked = 0;
  for (let i = 0; i < 5; i++) {
    const res = mockRes();
    let passed = false;
    rateLimit(req, res, () => { passed = true; });
    if (!passed) blocked += 1;
  }
  // 上限 3，前 3 次放行，后 2 次拦截
  assert.equal(blocked, 2);
});

test('限流: 不同 IP 互不影响', () => {
  const a = { ip: '198.51.100.1', socket: {} };
  const b = { ip: '198.51.100.2', socket: {} };
  for (let i = 0; i < 3; i++) rateLimit(a, mockRes(), () => {});
  const res = mockRes();
  let passed = false;
  rateLimit(b, res, () => { passed = true; });
  assert.equal(passed, true);
});

test('会话锁: 同会话串行执行，不会并发进入临界区', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const task = async () => {
    const release = await acquireSessionLock('same-session');
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 20));
    concurrent -= 1;
    release();
  };

  await Promise.all([task(), task(), task(), task()]);
  assert.equal(maxConcurrent, 1, '同一会话不应并发进入');
});

test('会话锁: 不同会话可并行', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const task = async (sid) => {
    const release = await acquireSessionLock(sid);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 20));
    concurrent -= 1;
    release();
  };
  await Promise.all([task('a'), task('b'), task('c')]);
  assert.ok(maxConcurrent > 1, '不同会话应能并行');
});
