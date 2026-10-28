// 黑盒测试：开启 USER_AUTH=enforce 后的对话鉴权与会话归属
// 单独一个文件：node --test 每个测试文件独立进程，改环境变量不会影响其他用例
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EVAL_FAST = '1';
process.env.LOG_LEVEL = 'error';
process.env.USER_AUTH = 'enforce';
process.env.USER_TOKEN_SECRET = 'e2e-secret-1234567890';

const { startServer } = await import('../helpers.js');

const srv = await startServer();
const guest = async () => (await (await fetch(`http://127.0.0.1:${srv.port}/api/auth/guest`, { method: 'POST' })).json());

async function chatWith(token, { sessionId, message }) {
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ sessionId, message }),
  });
  const raw = await res.text();
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '{}') continue;
    try { events.push(JSON.parse(payload)); } catch { /* 忽略 */ }
  }
  return { status: res.status, events };
}

test('身份: /api/auth/guest 可领取访客令牌', async () => {
  const d = await guest();
  assert.match(d.userId, /^g-[0-9a-f]{16}$/);
  assert.ok(d.token.includes('.'));
  assert.equal(d.enforced, true);
});

test('身份: 开启 enforce 后无令牌对话返回 401', async () => {
  const r = await chatWith('', { sessionId: 'ua-no-token', message: '你好' });
  assert.equal(r.status, 401);
});

test('身份: 带令牌可正常对话并写入会话', async () => {
  const { token } = await guest();
  const r = await chatWith(token, { sessionId: 'ua-own', message: '退货运费谁出？' });
  assert.equal(r.status, 200);
  assert.ok(r.events.some((e) => e.type === 'session'));
  assert.ok(r.events.some((e) => e.type === 'done'));
});

test('身份: 别人的 sessionId 不能续聊（403）', async () => {
  const a = await guest();
  const b = await guest();
  const first = await chatWith(a.token, { sessionId: 'ua-shared', message: '退货运费谁出？' });
  assert.equal(first.status, 200);

  const second = await chatWith(b.token, { sessionId: 'ua-shared', message: '那退款呢' });
  assert.equal(second.status, 403);
});

test('身份: 会话列表只返回自己的会话', async () => {
  const a = await guest();
  const b = await guest();
  await chatWith(a.token, { sessionId: 'ua-list-a', message: '退货运费谁出？' });

  const listA = await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions`, {
    headers: { Authorization: `Bearer ${a.token}` },
  })).json();
  const listB = await (await fetch(`http://127.0.0.1:${srv.port}/api/sessions`, {
    headers: { Authorization: `Bearer ${b.token}` },
  })).json();

  assert.ok(listA.sessions.some((s) => s.id === 'ua-list-a'));
  assert.ok(!listB.sessions.some((s) => s.id === 'ua-list-a'));
});

after(async () => { await srv.close(); });
