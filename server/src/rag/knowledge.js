// 售后知识库：真实文档索引优先，缺失时回退内置种子文档
//
// - 运行时从 data/kb（可用 KB_INDEX_DIR 覆盖）加载由入库流水线生成的索引
// - 索引文件变化后自动热加载（最多 5 秒检查一次），无需重启服务
// - 没有任何索引时退回 KNOWLEDGE_DOCS，保证开箱即用
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, DIM } from './embedding.js';
import { VectorStore } from './vectorStore.js';
import { createPgVectorStore } from './store/pgvector.js';
import { chunkText } from './ingest/chunker.js';
import { readIndex, indexMtime, indexSizeBytes } from './ingest/indexStore.js';
import { hasLexicalSupport } from './lexical.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '../..');

export const KNOWLEDGE_DOCS = [
  {
    id: 'return-policy', title: '7 天无理由退货政策',
    content: '自签收之日起 7 天内，商品完好、不影响二次销售的，支持 7 天无理由退货。退货运费由买家承担；若因质量问题退货，运费由商家承担。定制商品、贴身衣物、已拆封的数码商品不支持无理由退货。',
  },
  {
    id: 'refund-time', title: '退款到账时效',
    content: '退款审核通过后，款项将原路退回。余额支付一般 1-2 小时到账，银行卡支付一般 1-7 个工作日到账，具体以银行处理为准。如超时未到账，可联系人工客服查询。',
  },
  {
    id: 'quality-return', title: '质量问题退换',
    content: '商品存在质量问题（如破损、功能故障、与描述严重不符），自签收 15 天内可申请退货或换货，往返运费均由商家承担。请上传问题照片以便快速审核。',
  },
  {
    id: 'logistics', title: '物流与发货时效',
    content: '现货商品一般 48 小时内发货，发货后可在订单详情查看物流轨迹。偏远地区可能延迟 1-3 天。如长时间未更新物流，可联系人工客服催促。',
  },
  {
    id: 'warranty', title: '保修政策',
    content: '数码电器类商品享受国家三包政策：7 天包退、15 天包换、1 年保修。保修期内非人为损坏可免费维修。请保留订单信息作为保修凭证。',
  },
  {
    id: 'human', title: '人工客服与投诉',
    content: '人工客服服务时间为每日 9:00-21:00。您可以说“转人工”接入人工客服。如需投诉，可通过订单页“投诉商家”提交，平台将在 48 小时内处理并反馈。',
  },
];

export const DEFAULT_INDEX_DIR = path.resolve(
  process.env.KB_INDEX_DIR || path.join(SERVER_ROOT, 'data', 'kb')
);

export function buildKnowledge(docs = KNOWLEDGE_DOCS) {
  const store = new VectorStore();
  for (const doc of docs) {
    const chunks = chunkText(doc.content, { maxChars: 480, overlapChars: 0 });
    chunks.forEach((c, i) => {
      const indexText = `${doc.title}｜${c.headingPath ? `${c.headingPath}｜` : ''}${c.text}`;
      store.add({
        id: `${doc.id}-${i}`,
        docId: doc.id,
        title: doc.title,
        headingPath: c.headingPath,
        text: c.text,
        source: doc.id,
        format: 'seed',
        locator: c.headingPath || '',
        seq: i,
        vector: embed(indexText),
      });
    });
  }
  return store;
}

function storeFromChunks(chunks) {
  const store = new VectorStore();
  for (const c of chunks) {
    store.add({
      id: c.id, docId: c.docId, title: c.title,
      headingPath: c.headingPath || '', text: c.text,
      source: c.source, format: c.format, locator: c.locator || '',
      seq: c.seq ?? 0, vector: c.vector,
    });
  }
  return store;
}

// —— 运行时状态（kbStore 引用保持稳定，热加载只替换内部 items）——
export const kbStore = new VectorStore();

let state = {
  mode: 'seed',
  indexDir: DEFAULT_INDEX_DIR,
  builtAt: null,
  root: null,
  mtimeMs: 0,
  files: [],
  byFormat: {},
  failures: [],
};

let lastCheck = 0;
let reloading = null;

function apply(store, next) {
  store.finalizeGroups();
  kbStore.items = store.items;
  kbStore.groups = store.groups;
  state = { ...state, ...next };
}

// —— 向量后端：默认内存；VECTOR_STORE=pgvector 时额外写入 PG 并优先走 DB 检索 ——
// 体积大了以后内存索引会撑爆进程，外置是唯一的长期方案；
// 但连不上 DB 时必须能回退内存，否则一次配置失误就让知识库整体不可用。
let pgStore = null;
let pgStatus = { backend: 'memory', reason: process.env.VECTOR_STORE === 'pgvector' ? '初始化中' : '未启用' };

export function vectorBackendInfo() {
  return { ...pgStatus, configured: process.env.VECTOR_STORE === 'pgvector' };
}

async function syncPg(items = []) {
  if (process.env.VECTOR_STORE !== 'pgvector') return;
  try {
    if (!pgStore) {
      const store = await createPgVectorStore({
        dsn: process.env.VECTOR_DB_URL,
        dim: DIM,
        table: process.env.VECTOR_TABLE,
      });
      if (!store.ok) {
        pgStatus = { backend: 'memory', reason: store.reason };
        console.warn(`[kb] pgvector 不可用，继续使用内存索引：${store.reason}`);
        return;
      }
      pgStore = store;
    }
    const n = await pgStore.upsert(items);
    pgStatus = { backend: 'pgvector', table: pgStore.table, chunks: n };
  } catch (err) {
    pgStatus = { backend: 'memory', reason: err.message };
    if (pgStore) await pgStore.close().catch(() => {});
    pgStore = null;
    console.warn(`[kb] pgvector 同步失败，回退内存索引：${err.message}`);
  }
}

async function loadIndex() {
  const dir = state.indexDir;
  let loaded = null;
  try {
    loaded = await readIndex(dir);
  } catch (err) {
    console.warn(`[kb] 索引读取失败，回退种子文档：${err.message}`);
  }

  if (!loaded || !loaded.chunks.length) {
    apply(buildKnowledge(), {
      mode: 'seed', builtAt: null, mtimeMs: 0, root: null, files: [], byFormat: {}, failures: [],
    });
    // 种子文档同样同步一份到 PG，保证两种后端结果一致
    syncPg(kbStore.items).catch(() => {});
    return false;
  }

  const m = loaded.manifest;
  apply(storeFromChunks(loaded.chunks), {
    mode: 'index',
    builtAt: m.builtAt || null,
    root: m.root || null,
    mtimeMs: indexMtime(dir),
    files: m.files || [],
    byFormat: m.byFormat || {},
    failures: m.failures || [],
  });
  // 索引变了就把新切块刷进 PG（后台执行，不阻塞热加载）
  syncPg(kbStore.items).catch(() => {});
  return true;
}

// 启动时同步等待索引就绪：之后的请求一定基于最新索引
await loadIndex();

export function knowledgeInfo() {
  const chunks = kbStore.size();
  const docs = state.mode === 'index' ? state.files.length : KNOWLEDGE_DOCS.length;
  return {
    mode: state.mode,
    chunks,
    docs,
    builtAt: state.builtAt,
    root: state.root,
    indexDir: state.indexDir,
    indexBytes: indexSizeBytes(state.indexDir),
    byFormat: state.byFormat,
    failures: state.failures,
    vectorBackend: vectorBackendInfo(),
    sources: state.mode === 'index'
      ? state.files.map((f) => ({ path: f.path, title: f.title, format: f.format, chunks: f.chunks, size: f.size }))
      : KNOWLEDGE_DOCS.map((d) => ({ path: d.id, title: d.title, format: 'seed', chunks: 1, size: d.content.length })),
  };
}

// 索引文件变了就后台重建，当前请求继续用旧索引，避免抖动
export function checkForUpdates() {
  if (reloading) return reloading;
  const now = Date.now();
  if (now - lastCheck < 5000) return Promise.resolve(false);
  lastCheck = now;

  const m = indexMtime(state.indexDir);
  if (!m || m === state.mtimeMs) return Promise.resolve(false);

  reloading = loadIndex()
    .catch((err) => {
      console.warn(`[kb] 热加载失败：${err.message}`);
      return false;
    })
    .finally(() => { reloading = null; });
  return reloading;
}

export async function reloadKnowledge() {
  lastCheck = Date.now();
  return loadIndex();
}

// 大语料下走两级检索：先按文档质心选出候选文档，再在候选文档的块里精排。
// 块数较少时全量扫描更准，没必要引入近似。
const HIERARCHICAL_MIN_CHUNKS = Number(process.env.KB_HIERARCHICAL_MIN || 20_000);

function resolveDocLimit(store) {
  if (process.env.KB_HIERARCHICAL === '0') return 0;
  if (store.items.length < HIERARCHICAL_MIN_CHUNKS) return 0;
  const docs = store.groups ? store.groups.length : 0;
  if (!docs) return 0;
  return Math.min(512, Math.max(64, Math.ceil(docs * 0.05)));
}

// 命中结果的后处理：分数过滤、引用章节、词面闸门
function postProcess(hits, query, { minScore = 0.12, requireEvidence = false } = {}) {
  const kept = hits
    .filter((r) => r.score > minScore)
    .map(({ vector, ...rest }) => {
      // 引用展示到"章节"一级，便于用户核对出处
      const parts = String(rest.headingPath || '').split(' > ').map((s) => s.trim()).filter(Boolean);
      const last = parts[parts.length - 1] || '';
      return { ...rest, section: last && last !== rest.title ? last : '' };
    });

  // 词面闸门：向量相似但字面完全对不上，多半是无关问题蹭到了常用字
  if (requireEvidence && kept.length && !hasLexicalSupport(query, kept)) return [];
  return kept;
}

export function retrieveFrom(store, query, k = 3, {
  minScore = 0.12, format = null, docLimit, requireEvidence = false,
} = {}) {
  // 从指定 store 检索，便于测试与多知识库场景
  const qv = embed(query);
  const filter = format ? (it) => it.format === format : null;
  const hits = store.search(qv, k, { filter, docLimit: docLimit ?? resolveDocLimit(store) });
  return postProcess(hits, query, { minScore, requireEvidence });
}

export function retrieve(query, k = 3, opts = {}) {
  // 后台检查索引更新，不阻塞本次检索
  checkForUpdates().catch(() => {});
  return retrieveFrom(kbStore, query, k, opts);
}

/**
 * 异步检索：pgvector 可用时走数据库，否则回退内存索引。
 * 返回结构与 retrieve 完全一致，调用方不需要区分后端。
 */
export async function retrieveAsync(query, k = 3, opts = {}) {
  checkForUpdates().catch(() => {});
  if (!pgStore) return retrieveFrom(kbStore, query, k, opts);
  try {
    // 多取一些再过滤：DB 侧无法套用词面闸门，留给 postProcess 处理
    const hits = await pgStore.search(embed(query), Math.max(k * 3, k), { format: opts.format || null });
    return postProcess(hits, query, opts);
  } catch (err) {
    console.warn(`[kb] pgvector 检索失败，回退内存索引：${err.message}`);
    return retrieveFrom(kbStore, query, k, opts);
  }
}
