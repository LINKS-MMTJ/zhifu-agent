// 白盒测试：可观测性（traceId / 结构化日志 / 审计）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { traceMiddleware, currentTraceId, runWithTrace } from '../../src/observability/trace.js';
import { initAudit, audit, queryAudit, flushAudit, auditEnabled, resetAuditForTest } from '../../src/observability/audit.js';

function fakeReq(headers = {}) {
  return { get: (k) => headers[String(k).toLowerCase()] };
}
function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
}

test('trace: 自动生成 traceId 并写入响应头与上下文', () => {
  const req = fakeReq();
  const res = fakeRes();
  let seen = null;
  traceMiddleware(req, res, () => { seen = currentTraceId(); });

  assert.ok(req.traceId);
  assert.equal(res.headers['x-request-id'], req.traceId);
  assert.equal(seen, req.traceId);
});

test('trace: 复用上游传入的 x-request-id（便于跨系统串联）', () => {
  const req = fakeReq({ 'x-request-id': 'upstream-abc' });
  const res = fakeRes();
  let seen = null;
  traceMiddleware(req, res, () => { seen = currentTraceId(); });
  assert.equal(req.traceId, 'upstream-abc');
  assert.equal(seen, 'upstream-abc');
});

test('trace: 上下文外返回 null；runWithTrace 可手动带入', async () => {
  assert.equal(currentTraceId(), null);
  const got = await runWithTrace('bg-1', async () => currentTraceId());
  assert.equal(got, 'bg-1');
});

test('trace: 沿用上游 W3C traceparent 并回写合法响应头', () => {
  const req = fakeReq({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
  const res = fakeRes();
  let seen = null;
  traceMiddleware(req, res, () => { seen = currentTraceId(); });

  assert.equal(req.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(seen, req.traceId);
  assert.match(res.headers.traceparent, /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  assert.equal(res.headers['x-request-id'], req.traceId);
});

test('trace: 非法 traceparent 被忽略，仍生成合法 id', () => {
  const req = fakeReq({ traceparent: '00-00000000000000000000000000000000-0000000000000000-01' });
  const res = fakeRes();
  traceMiddleware(req, res, () => {});
  assert.match(req.traceId, /^[0-9a-f]{32}$/);
  assert.match(res.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test('审计: 未初始化时静默跳过（不影响业务）', async () => {
  resetAuditForTest();
  assert.equal(auditEnabled(), false);
  await audit({ action: 'x' });
  const out = await queryAudit({});
  assert.deepEqual(out.entries, []);
});

test('审计: 初始化后按天落盘，查询倒序返回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  initAudit({ dir });
  assert.equal(auditEnabled(), true);

  await audit({ actor: 'api', action: 'tool.call', target: 'queryOrder', result: 'ok' });
  await audit({ actor: 'admin', action: 'admin.strategy', target: 'price', result: 'ok' });

  const out = await queryAudit({ limit: 10 });
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].action, 'admin.strategy', '最新的在前');
  assert.equal(out.entries[1].action, 'tool.call');
  assert.ok(out.entries[0].ts);
  assert.ok(fs.existsSync(path.join(dir, `audit-${out.date}.jsonl`)));

  // 只追加：文件行数等于记录数
  const lines = fs.readFileSync(path.join(dir, `audit-${out.date}.jsonl`), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);

  resetAuditForTest();
});

test('审计: 时间与 traceId 不允许被调用方覆盖', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  initAudit({ dir });
  await runWithTrace('real-trace', async () => {
    await audit({ action: 'x', ts: '1999-01-01T00:00:00.000Z', traceId: 'fake' });
  });
  await flushAudit();
  const out = await queryAudit({ limit: 1 });
  assert.notEqual(out.entries[0].ts, '1999-01-01T00:00:00.000Z');
  assert.equal(out.entries[0].traceId, 'real-trace');
  resetAuditForTest();
});

test('审计: 半行损坏不会让整页查询失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  initAudit({ dir });
  await audit({ action: 'ok.entry' });
  await flushAudit();

  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(dir, `audit-${day}.jsonl`), '{"action":"broken"\n', 'utf8');

  const out = await queryAudit({ limit: 10 });
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].action, 'ok.entry');
  resetAuditForTest();
});

test('审计: 落盘前自动脱敏手机号、身份证、邮箱', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  initAudit({ dir });

  await audit({
    actor: 'api',
    action: 'tool.call',
    target: '13800001234',
    meta: {
      phone: '13900005678',
      idcard: '110101199001011234',
      email: 'zhang.wei@example.com',
      argKeys: ['phone'],
    },
  });
  await flushAudit();

  const day = new Date().toISOString().slice(0, 10);
  const raw = fs.readFileSync(path.join(dir, `audit-${day}.jsonl`), 'utf8');
  assert.ok(!raw.includes('13800001234'));
  assert.ok(!raw.includes('13900005678'));
  assert.ok(!raw.includes('110101199001011234'));
  assert.ok(!raw.includes('zhang.wei@example.com'));
  assert.ok(raw.includes('138****1234'));
  assert.ok(raw.includes('110101********1234'));
  assert.ok(raw.includes('z***@example.com'));
  resetAuditForTest();
});
