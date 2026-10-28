// pgvector 后端：把切块与向量放进 PostgreSQL，检索用余弦距离走 DB
//
// 什么时候需要它：当切块到百万级，内存索引（VectorStore）会占满进程内存、启动也越来越慢。
// 默认仍是 memory 后端，零依赖零配置；设置 VECTOR_STORE=pgvector + VECTOR_DB_URL 才启用。
//
// 设计取舍：
//   - 连接不上 / 没装 pgvector 扩展时只告警并回退内存索引，绝不让检索整体不可用
//   - 写入用批量 upsert，重复入库不会产生重复行
//   - 表名来自环境变量，必须做白名单校验，避免 SQL 注入
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DEFAULT_TABLE = 'kb_chunks';

/** 向量转 pgvector 字面量：[0.1,0.2,...] */
export function toVectorLiteral(vec) {
  return `[${Array.from(vec, (v) => Number(v) || 0).join(',')}]`;
}

/** 表名白名单：只允许小写字母、数字、下划线，且不以数字开头 */
export function safeTableName(name) {
  const t = String(name || DEFAULT_TABLE);
  return /^[a-z_][a-z0-9_]{0,62}$/.test(t) ? t : DEFAULT_TABLE;
}

export function buildSearchSql(table = DEFAULT_TABLE) {
  const t = safeTableName(table);
  return `SELECT id, doc_id, title, heading, text, source, format, locator, seq,
                 1 - (vector <=> $1::vector) AS score
          FROM ${t}
          WHERE ($2::text IS NULL OR format = $2)
          ORDER BY vector <=> $1::vector
          LIMIT $3`;
}

/**
 * 连接 PG 并确保表/索引存在
 * @returns {Promise<{ok:true, upsert, search, size, close, table, dim} | {ok:false, reason:string}>}
 */
export async function createPgVectorStore({
  dsn = process.env.VECTOR_DB_URL,
  dim = 256,
  table = process.env.VECTOR_TABLE || DEFAULT_TABLE,
} = {}) {
  if (!dsn) return { ok: false, reason: '未配置 VECTOR_DB_URL' };

  let pg;
  try {
    pg = require('pg');
  } catch {
    return { ok: false, reason: '未安装 pg 依赖' };
  }

  const name = safeTableName(table);
  const pool = new pg.Pool({ connectionString: dsn, max: 4, connectionTimeoutMillis: 3000 });

  try {
    await pool.query('SELECT 1');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (
      id text PRIMARY KEY,
      doc_id text NOT NULL,
      title text,
      heading text,
      text text NOT NULL,
      source text,
      format text,
      locator text,
      seq int DEFAULT 0,
      vector vector(${Number(dim) || 256})
    )`);
    // HNSW 在大语料下比 ivfflat 更省调参；建不出来（老版本扩展）就退化为顺序扫描
    await pool.query(`CREATE INDEX IF NOT EXISTS ${name}_vec_idx ON ${name} USING hnsw (vector vector_cosine_ops)`)
      .catch(() => {});
  } catch (err) {
    await pool.end().catch(() => {});
    return { ok: false, reason: err.message };
  }

  async function upsert(items = [], batchSize = 500) {
    let written = 0;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const values = [];
      const params = [];
      batch.forEach((it, idx) => {
        const base = idx * 10;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::vector)`);
        params.push(
          it.id, it.docId, it.title || '', it.headingPath || '', it.text,
          it.source || '', it.format || '', it.locator || '', it.seq ?? 0, toVectorLiteral(it.vector)
        );
      });
      if (!values.length) continue;
      await pool.query(
        `INSERT INTO ${name} (id, doc_id, title, heading, text, source, format, locator, seq, vector)
         VALUES ${values.join(',')}
         ON CONFLICT (id) DO UPDATE SET
           doc_id = EXCLUDED.doc_id, title = EXCLUDED.title, heading = EXCLUDED.heading,
           text = EXCLUDED.text, source = EXCLUDED.source, format = EXCLUDED.format,
           locator = EXCLUDED.locator, seq = EXCLUDED.seq, vector = EXCLUDED.vector`,
        params
      );
      written += batch.length;
    }
    return written;
  }

  async function search(vec, k = 3, { format = null } = {}) {
    const { rows } = await pool.query(buildSearchSql(name), [toVectorLiteral(vec), format, k]);
    return rows.map((r) => ({
      id: r.id,
      docId: r.doc_id,
      title: r.title,
      headingPath: r.heading,
      text: r.text,
      source: r.source,
      format: r.format,
      locator: r.locator,
      seq: r.seq,
      score: Number(r.score),
    }));
  }

  async function size() {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${name}`);
    return rows[0]?.n || 0;
  }

  async function close() {
    await pool.end().catch(() => {});
  }

  return { ok: true, upsert, search, size, close, table: name, dim: Number(dim) || 256 };
}
