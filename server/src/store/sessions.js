// 会话与调用日志存储（内存 + 可选落盘，带 LRU 上限与空闲过期）
//
// 7×24 长稳的关键：会话不能无限增长。
// 早期版本 Map 只增不减，长时间运行必然 OOM。
// 现在：超出容量按 LRU 淘汰最久未访问的会话；空闲超时自动清理。
// 生产环境可替换为 Redis + 关系库，接口保持不变。
//
// 持久化：调用 initPersistence 后，变更会在 2 秒内合并成一次原子快照，
// 进程重启时由 restoreSessions 恢复，避免"重启就丢历史"。
import { persistenceEnabled, readJSON, writeJSONAtomic } from './persistence.js';

const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 5000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 2 * 60 * 60 * 1000); // 默认 2 小时
const MAX_LOGS = Number(process.env.MAX_LOGS || 1000);
const SNAPSHOT_FILE = 'sessions.json';
const SNAPSHOT_DEBOUNCE_MS = 2000;

const sessions = new Map(); // key -> session（Map 保序，末位为最近访问）
const callLogs = [];
let evicted = 0;

let snapshotTimer = null;
let snapshotPending = false;

function scheduleSnapshot() {
  if (!persistenceEnabled()) return;
  snapshotPending = true;
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    snapshotSessionsNow().catch((err) => console.warn(`[sessions] 快照失败：${err.message}`));
  }, SNAPSHOT_DEBOUNCE_MS);
  if (snapshotTimer.unref) snapshotTimer.unref();
}

export async function snapshotSessionsNow() {
  if (!persistenceEnabled()) return false;
  snapshotPending = false;
  const list = [...sessions.values()].map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    lastAccess: s.lastAccess,
    pendingAction: s.pendingAction || null,
    messages: s.messages,
  }));
  return writeJSONAtomic(SNAPSHOT_FILE, { version: 1, savedAt: Date.now(), sessions: list });
}

// 启动时恢复：丢弃已过期的会话，保留最近访问的 MAX_SESSIONS 个
export async function restoreSessions() {
  if (!persistenceEnabled()) return { restored: 0, skipped: 0 };
  const data = await readJSON(SNAPSHOT_FILE);
  if (!data || !Array.isArray(data.sessions)) return { restored: 0, skipped: 0 };

  const now = Date.now();
  const alive = data.sessions
    .filter((s) => s && s.id && Array.isArray(s.messages))
    .filter((s) => now - (s.lastAccess || 0) <= SESSION_TTL_MS)
    .sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0))
    .slice(-MAX_SESSIONS);

  for (const s of alive) {
    sessions.set(s.id, {
      id: s.id,
      createdAt: s.createdAt || now,
      lastAccess: s.lastAccess || now,
      messages: s.messages.slice(-200),
      pendingAction: s.pendingAction || null,
    });
  }
  return { restored: alive.length, skipped: data.sessions.length - alive.length };
}

// 优雅关闭时调用：立刻落盘并清掉定时器
export async function flushSessions() {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  if (!persistenceEnabled() || !snapshotPending) return false;
  return snapshotSessionsNow();
}

function touch(session) {
  session.lastAccess = Date.now();
  // 移到末尾，维持 LRU 顺序
  sessions.delete(session.id);
  sessions.set(session.id, session);
}

export function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, createdAt: Date.now(), lastAccess: Date.now(), messages: [], pendingAction: null };
    sessions.set(id, s);
    if (sessions.size > MAX_SESSIONS) {
      // 淘汰最久未访问的一个
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
      evicted += 1;
    }
    scheduleSnapshot();
  } else {
    touch(s);
  }
  return s;
}

export function addMessage(sessionId, msg) {
  const s = getSession(sessionId);
  s.messages.push({ ...msg, at: Date.now() });
  // 单会话消息也设上限，避免超长会话撑爆内存
  const MAX_MSG = 200;
  if (s.messages.length > MAX_MSG) s.messages.splice(0, s.messages.length - MAX_MSG);
  scheduleSnapshot();
}

export function logCall(entry) {
  callLogs.push({ ...entry, at: Date.now() });
  if (callLogs.length > MAX_LOGS) callLogs.shift();
}

export function getCallLogs(limit = 50) {
  return callLogs.slice(-limit).reverse();
}

// 评测/测试用
export function resetSessions() { sessions.clear(); }

/** 清理空闲超时的会话，返回清理数量 */
export function pruneSessions(now = Date.now()) {
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - s.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
      removed += 1;
    }
  }
  if (removed) scheduleSnapshot();
  return removed;
}

/** 运行期统计，供 /api/admin/metrics 使用 */
export function storeStats() {
  let messages = 0;
  for (const s of sessions.values()) messages += s.messages.length;
  return {
    sessions: sessions.size,
    messages,
    callLogs: callLogs.length,
    evicted,
    maxSessions: MAX_SESSIONS,
    sessionTtlMs: SESSION_TTL_MS,
    persisted: persistenceEnabled(),
  };
}

export function listSessions() {
  return [...sessions.values()]
    .map((s) => ({
      id: s.id,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      preview: (s.messages.find((m) => m.role === 'user') || {}).content || '',
      messages: s.messages,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// —— 成本报表 ——
export function costReport() {
  const byModel = {};
  let totalCost = 0;
  for (const log of callLogs) {
    const k = log.modelId;
    if (!byModel[k]) byModel[k] = { modelId: k, modelName: log.modelName, calls: 0, cost: 0, latencySum: 0 };
    byModel[k].calls += 1;
    byModel[k].cost += log.cost || 0;
    byModel[k].latencySum += log.latencyMs || 0;
    totalCost += log.cost || 0;
  }
  const rows = Object.values(byModel).map((r) => ({
    modelId: r.modelId,
    modelName: r.modelName,
    calls: r.calls,
    cost: Number(r.cost.toFixed(6)),
    avgLatencyMs: r.calls ? Math.round(r.latencySum / r.calls) : 0,
  }));
  return { totalCalls: callLogs.length, totalCost: Number(totalCost.toFixed(6)), byModel: rows };
}

// —— 后台清理定时器（unref：不阻止进程退出）——
let sweepTimer = null;
export function startSessionSweeper(intervalMs = 5 * 60 * 1000) {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => pruneSessions(), intervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
}
export function stopSessionSweeper() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
