// 白盒测试：持久化（原子写 / 会话恢复 / 过期丢弃）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initPersistence, readJSON, writeJSONAtomic, persistenceEnabled, resetPersistenceForTest,
} from '../../src/store/persistence.js';
import {
  getSession, addMessage, restoreSessions, snapshotSessionsNow, resetSessions, flushSessions, storeStats,
} from '../../src/store/sessions.js';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'persist-'));
}

test('持久化: 未初始化时不落盘', async () => {
  resetPersistenceForTest();
  assert.equal(persistenceEnabled(), false);
  assert.equal(await writeJSONAtomic('x.json', { a: 1 }), false);
  assert.deepEqual(await readJSON('x.json', { fallback: true }), { fallback: true });
});

test('持久化: 原子写可往返，且不残留 .tmp', async () => {
  const dir = freshDir();
  initPersistence({ dir });
  await writeJSONAtomic('a.json', { hello: 'world' });
  assert.deepEqual(await readJSON('a.json'), { hello: 'world' });
  assert.ok(!fs.existsSync(path.join(dir, 'a.json.tmp')));
});

test('持久化: 文件损坏时回退默认值而不是抛错', async () => {
  const dir = freshDir();
  initPersistence({ dir });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops', 'utf8');
  assert.deepEqual(await readJSON('bad.json', { ok: true }), { ok: true });
});

test('会话恢复: 快照后重启可恢复消息与待确认动作', async () => {
  const dir = freshDir();
  initPersistence({ dir });
  resetSessions();

  const s = getSession('s-restore');
  addMessage('s-restore', { role: 'user', content: '我要退货' });
  addMessage('s-restore', { role: 'assistant', content: '请提供订单号' });
  s.pendingAction = { tool: 'createReturn', args: { orderId: 'SO20260001' }, at: Date.now(), idem: 'idem-1' };

  assert.equal(await snapshotSessionsNow(), true);

  // 模拟进程重启
  resetSessions();
  const result = await restoreSessions();

  assert.equal(result.restored, 1);
  const back = getSession('s-restore');
  assert.equal(back.messages.length, 2);
  assert.equal(back.messages[0].content, '我要退货');
  assert.equal(back.pendingAction.tool, 'createReturn');
  assert.equal(back.pendingAction.idem, 'idem-1');
  // 路由策略不再存在会话里：唯一真相在 router.strategy
  assert.equal(back.strategy, undefined);

  resetSessions();
  resetPersistenceForTest();
});

test('会话恢复: 超过 TTL 的会话被丢弃', async () => {
  const dir = freshDir();
  initPersistence({ dir });
  resetSessions();

  const stale = Date.now() - 3 * 60 * 60 * 1000; // 3 小时前
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
    version: 1,
    sessions: [
      { id: 'old', createdAt: stale, lastAccess: stale, messages: [{ role: 'user', content: 'hi' }], strategy: 'auto' },
    ],
  }), 'utf8');

  const result = await restoreSessions();
  assert.equal(result.restored, 0);
  assert.equal(result.skipped, 1);

  resetSessions();
  resetPersistenceForTest();
});

test('会话恢复: 单会话消息超限时只保留最近 200 条', async () => {
  const dir = freshDir();
  initPersistence({ dir });
  resetSessions();

  const messages = Array.from({ length: 260 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
    version: 1,
    sessions: [{ id: 'long', createdAt: Date.now(), lastAccess: Date.now(), messages, strategy: 'auto' }],
  }), 'utf8');

  await restoreSessions();
  const s = getSession('long');
  assert.equal(s.messages.length, 200);
  assert.equal(s.messages.at(-1).content, 'm259');

  resetSessions();
  resetPersistenceForTest();
});

test('会话恢复: flush 会把未落盘的变更立即写入', async () => {
  const dir = freshDir();
  initPersistence({ dir });
  resetSessions();

  addMessage('s-flush', { role: 'user', content: '还没到 2 秒就去落盘' });
  const wrote = await flushSessions();
  assert.equal(wrote, true);
  assert.ok(fs.existsSync(path.join(dir, 'sessions.json')));

  resetSessions();
  resetPersistenceForTest();
});

test('存储统计: 标明是否启用持久化', () => {
  resetPersistenceForTest();
  assert.equal(storeStats().persisted, false);
  initPersistence({ dir: freshDir() });
  assert.equal(storeStats().persisted, true);
  resetPersistenceForTest();
});
