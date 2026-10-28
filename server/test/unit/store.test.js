// 白盒测试：会话存储的 LRU 上限与空闲过期
// 单独一个文件，便于在导入前设置环境变量（node --test 每个文件独立进程）
process.env.MAX_SESSIONS = '3';
process.env.SESSION_TTL_MS = '1000';

const { getSession, pruneSessions, storeStats, resetSessions } = await import('../../src/store/sessions.js');
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');

test('会话: 相同 id 返回同一实例', () => {
  resetSessions();
  const a = getSession('x1');
  const b = getSession('x1');
  assert.equal(a, b);
});

test('会话: 超过上限按 LRU 淘汰最久未访问的', () => {
  resetSessions();
  getSession('a');
  getSession('b');
  getSession('c');
  // 访问 a，使其成为最近使用；此时 b 是最久未访问
  getSession('a');
  getSession('d'); // 触发淘汰
  const stats = storeStats();
  assert.equal(stats.sessions, 3);
  assert.equal(stats.evicted, 1);
});

test('会话: 空闲超时会被清理', async () => {
  resetSessions();
  getSession('idle');
  assert.equal(storeStats().sessions, 1);
  // TTL 设为 1 秒，等 1.1 秒后清理
  await new Promise((r) => setTimeout(r, 1100));
  const removed = pruneSessions();
  assert.equal(removed, 1);
  assert.equal(storeStats().sessions, 0);
});

test('会话: 单会话消息数有上限，不会无限增长', async () => {
  resetSessions();
  const { addMessage } = await import('../../src/store/sessions.js');
  for (let i = 0; i < 260; i++) addMessage('long', { role: 'user', content: `m${i}` });
  const s = getSession('long');
  assert.ok(s.messages.length <= 200, `消息应被截断，实际 ${s.messages.length}`);
});
