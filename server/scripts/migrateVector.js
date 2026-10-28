// 把本地索引（data/kb）灌进 pgvector
//
// 用法：
//   $env:VECTOR_DB_URL='postgres://user:pass@host:5432/db'
//   node scripts/migrateVector.js
// 说明：表会在首次运行时自动创建（需要数据库已安装 vector 扩展，脚本会尝试 CREATE EXTENSION）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndex } from '../src/rag/ingest/indexStore.js';
import { createPgVectorStore } from '../src/rag/store/pgvector.js';
import { DIM } from '../src/rag/embedding.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDEX_DIR = path.resolve(process.env.KB_INDEX_DIR || path.join(ROOT, 'data', 'kb'));

const chunks = (await readIndex(INDEX_DIR)).chunks || [];
if (!chunks.length) {
  console.error(`[migrate] 索引为空：${INDEX_DIR}，先运行 npm run ingest`);
  process.exit(1);
}

if (!process.env.VECTOR_DB_URL) {
  console.error('[migrate] 缺少 VECTOR_DB_URL，例如 postgres://user:pass@127.0.0.1:5432/zhifu');
  process.exit(2);
}

const store = await createPgVectorStore({ dsn: process.env.VECTOR_DB_URL, dim: DIM });
if (!store.ok) {
  console.error(`[migrate] 连接失败：${store.reason}`);
  process.exit(2);
}

const t0 = Date.now();
const written = await store.upsert(chunks);
const total = await store.size();
console.log(`[migrate] 写入 ${written} 个切块 → ${store.table}（表内共 ${total} 条），耗时 ${Date.now() - t0}ms`);
await store.close();
