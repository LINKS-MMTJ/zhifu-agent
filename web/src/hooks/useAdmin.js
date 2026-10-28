// useAdmin：聚合运营/知识/集成/会话数据的拉取与刷新
import { useState, useEffect, useCallback } from 'react';
import { getJSON } from '../api.js';

export function useAdmin() {
  const [data, setData] = useState({
    models: [], strategy: 'auto', cost: null, logs: [], knowledge: null, sessions: [], integrations: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
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
      setData({ models: m.models, strategy: m.strategy, cost: c, logs: l, knowledge, sessions: s, integrations: i });
      setError(null);
    } catch (e) {
      // 401 时需要管理令牌，由界面提示用户输入
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { ...data, loading, error, reload: load };
}
