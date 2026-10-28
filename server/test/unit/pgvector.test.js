// 白盒测试：pgvector 后端的参数构造、表名白名单与降级行为
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toVectorLiteral, safeTableName, buildSearchSql, createPgVectorStore,
} from '../../src/rag/store/pgvector.js';
import { retrieve, retrieveAsync } from '../../src/rag/knowledge.js';

test('pgvector: 向量字面量格式正确', () => {
  assert.equal(toVectorLiteral([0.1, 0.25, -1]), '[0.1,0.25,-1]');
  assert.equal(toVectorLiteral(new Int8Array([1, 2, 3])), '[1,2,3]');
  assert.equal(toVectorLiteral([]), '[]');
});

test('pgvector: 表名白名单拦截注入', () => {
  assert.equal(safeTableName('kb_chunks'), 'kb_chunks');
  assert.equal(safeTableName('kb_chunks; DROP TABLE users'), 'kb_chunks');
  assert.equal(safeTableName('1bad'), 'kb_chunks');
  assert.equal(safeTableName(''), 'kb_chunks');
});

test('pgvector: 检索 SQL 使用安全表名且带格式过滤', () => {
  const sql = buildSearchSql('docs; DELETE FROM x');
  assert.ok(sql.includes('FROM kb_chunks'));
  assert.ok(!sql.includes('DELETE'));
  assert.ok(sql.includes('$2::text IS NULL'));
  assert.ok(sql.includes('<=>'));
});

test('pgvector: 未配置连接串时不启用', async () => {
  const r = await createPgVectorStore({ dsn: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /VECTOR_DB_URL/);
});

test('pgvector: 连接失败返回 ok:false 而不是抛错（便于回退内存）', async () => {
  const r = await createPgVectorStore({ dsn: 'postgres://127.0.0.1:1/none', dim: 256 });
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

test('检索: retrieveAsync 在内存后端与同步检索结果一致', async () => {
  const q = '退货运费谁出？';
  const sync = retrieve(q);
  const async = await retrieveAsync(q);
  assert.deepEqual(async.map((h) => h.id), sync.map((h) => h.id));
  assert.deepEqual(async.map((h) => h.score), sync.map((h) => h.score));
});
