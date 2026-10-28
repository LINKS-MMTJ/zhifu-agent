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
      const [m, c, l, k, s, i] = await Promise.all([
        getJSON('/api/admin/models'),
        getJSON('/api/admin/cost'),
        getJSON('/api/admin/logs'),
        getJSON('/api/knowledge'),
        getJSON('/api/admin/sessions'),
        getJSON('/api/integrations').catch(() => null),
      ]);
      setData({ models: m.models, strategy: m.strategy, cost: c, logs: l, knowledge: k, sessions: s, integrations: i });
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
