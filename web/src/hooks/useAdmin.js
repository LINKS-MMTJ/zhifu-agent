// useAdmin：聚合运营/知识/集成/会话数据的拉取与刷新
//
// 三个屏幕（知识库 / 会话 / 运营）都要这份数据。早期每个屏幕各调一次 useAdmin，
// 一次切屏就是 5 个请求、各闪一次 loading，而且运营页改完策略后别的屏不会更新。
// 现在改成模块级共享缓存：
//   - 同一时刻只允许一个请求在飞（in-flight 去重）
//   - 15 秒冷却期内直接复用，切屏不重复拉
//   - 任一屏 reload 后通过订阅通知其他屏一起刷新，状态只有一份
import { useState, useEffect, useCallback } from 'react';
import { getJSON } from '../api.js';

const EMPTY = {
  models: [], strategy: 'auto', cost: null, logs: [], knowledge: null, sessions: [], integrations: null,
};
const CACHE_TTL_MS = 15_000;

let sharedData = null;
let sharedError = null;
let fetchedAt = 0;
let inflight = null;
const listeners = new Set();

function snapshot() {
  return {
    data: sharedData || EMPTY,
    error: sharedError,
    loading: !sharedData && !sharedError,
  };
}

function emit() {
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

function isFresh() {
  return Boolean(sharedData) && Date.now() - fetchedAt < CACHE_TTL_MS;
}

async function fetchAll() {
  // 文档清单属于内部信息，走管理接口；没有令牌时退化为"只有规模统计"的公开接口
  const knowledge = await getJSON('/api/admin/knowledge').catch(async (e) => {
    if (e.status !== 401) throw e;
    const pub = await getJSON('/api/knowledge');
    return { ...pub, docs: [], failures: [], limited: true };
  });
  const [m, c, l, s, i] = await Promise.all([
    getJSON('/api/admin/models'),
    getJSON('/api/admin/cost'),
    getJSON('/api/admin/logs'),
    getJSON('/api/admin/sessions'),
    getJSON('/api/integrations').catch(() => null),
  ]);
  return { models: m.models, strategy: m.strategy, cost: c, logs: l, knowledge, sessions: s, integrations: i };
}

function refresh({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && isFresh()) {
    emit();
    return Promise.resolve(sharedData);
  }
  inflight = fetchAll()
    .then((data) => {
      sharedData = data;
      sharedError = null;
      fetchedAt = Date.now();
      emit();
      return data;
    })
    .catch((err) => {
      sharedError = err;
      emit();
      throw err;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useAdmin() {
  const [state, setState] = useState(snapshot);

  useEffect(() => {
    listeners.add(setState);
    // 订阅后先同步一次：可能别的屏幕已经把数据拉好了
    setState(snapshot());
    if (!isFresh()) refresh().catch(() => {});
    return () => { listeners.delete(setState); };
  }, []);

  // 手动刷新：强制绕过缓存；错误留在 state 里由界面提示，不向上抛
  const reload = useCallback(() => refresh({ force: true }).catch(() => null), []);

  return { ...state.data, loading: state.loading, error: state.error, reload };
}
