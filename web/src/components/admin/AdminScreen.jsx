// 运营屏幕：路由策略切换 + 模型注册表 + 成本报表 + 调用日志 + 外部集成
import React, { useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { useAdmin } from '../../hooks/useAdmin.js';
import { postJSON, getAdminToken, setAdminToken } from '../../api.js';

const STRATEGIES = [
  { id: 'auto', label: '自动' },
  { id: 'price', label: '价格优先' },
  { id: 'quality', label: '质量优先' },
  { id: 'latency', label: '延迟优先' },
  { id: 'balanced', label: '均衡' },
];

export default function AdminScreen() {
  const { setStrategy: setCtxStrategy } = useApp();
  const { models, strategy, cost, logs, integrations, loading, error, reload } = useAdmin();
  const [token, setToken] = useState(getAdminToken());

  const changeStrategy = async (s) => {
    try {
      const r = await postJSON('/api/admin/strategy', { strategy: s });
      setCtxStrategy(r.strategy);
    } catch {
      // 401 时下方会提示输入令牌
    }
    reload();
  };

  const saveToken = () => {
    setAdminToken(token.trim());
    reload();
  };

  return (
    <div className="screen page">
      <div className="page-head">
        <h2>运营监控</h2>
        <button className="btn" onClick={reload}>刷新</button>
      </div>

      {error?.status === 401 && (
        <section className="card error-card">
          <h3>需要管理令牌</h3>
          <p className="hint">服务端已开启 ADMIN_TOKEN，管理接口需要令牌才能访问。</p>
          <input
            className="field"
            type="password"
            value={token}
            placeholder="输入 ADMIN_TOKEN"
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveToken(); }}
          />
          <button className="btn primary block" onClick={saveToken}>保存并刷新</button>
        </section>
      )}

      {error && error.status !== 401 && (
        <section className="card error-card">
          <p className="hint">加载失败：{error.message}</p>
        </section>
      )}

      <section className="card">
        <h3>路由策略</h3>
        <div className="strategy-row">
          {STRATEGIES.map((s) => (
            <button key={s.id} className={strategy === s.id ? 'btn primary' : 'btn'} onClick={() => changeStrategy(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <p className="hint">“自动”按任务复杂度分流：简单问题走便宜模型，复杂问题走强模型。</p>
      </section>

      <section className="card">
        <h3>模型注册表</h3>
        {loading && <p className="hint">加载中…</p>}
        <table>
          <thead><tr><th>模型</th><th>档位</th><th>类型</th><th>质量</th><th>延迟</th><th>单次成本</th><th>状态</th></tr></thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td><td>{m.tier}</td>
                <td>{m.adapter === 'mock' ? '离线' : '真实'}</td>
                <td>{m.quality}</td><td>{m.latencyMs}ms</td>
                <td>¥{m.estimatedCostPerCall}</td>
                <td>
                  {!m.enabled
                    ? (m.adapter === 'mock'
                      ? <span className="muted">已由真实模型替代</span>
                      : <span className="muted">未配置 Key</span>)
                    : (m.healthy ? <span className="ok">健康</span> : <span className="bad">熔断</span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {models.some((m) => !m.enabled) && (
          <p className="hint">「未配置 Key」的模型已注册但未参与路由；在 server/.env 填入对应 Key 并重启即可启用。「已由真实模型替代」是离线 Mock，只在完全没有 Key 时兜底。</p>
        )}
      </section>

      <section className="card">
        <h3>外部系统集成</h3>
        {!integrations && <p className="hint">未加载</p>}
        {integrations?.connectors?.length === 0 && (
          <p className="hint">还没有配置连接器。在 server/integrations/ 下加一个 JSON 即可接入 CRM / 工单系统。</p>
        )}
        {integrations?.connectors?.map((c) => (
          <div key={c.id} className="intg-row">
            <div>
              <b>{c.name}</b>
              <span className={c.enabled ? 'ok' : 'bad'}>{c.enabled ? '已启用' : '未配置地址'}</span>
              <div className="hint">
                {c.authType} · 成功 {c.stat.ok} / 失败 {c.stat.fail}
                {c.stat.lastError ? ` · 最近错误：${c.stat.lastError}` : ''}
              </div>
            </div>
            <div>
              {c.tools.map((t) => (
                <span key={t.name} className={t.readonly ? 'tool-chip' : 'tool-chip warn'}>
                  {t.name}{t.readonly ? '' : '（需确认）'}
                </span>
              ))}
            </div>
          </div>
        ))}
        {integrations?.events?.outbound?.length > 0 && (
          <p className="hint">
            最近出站事件：{integrations.events.outbound.slice(0, 5).map((e) => e.type).join('、')}
          </p>
        )}
        {integrations?.events?.inbound?.length > 0 && (
          <p className="hint">
            最近入站事件：{integrations.events.inbound.slice(0, 5).map((e) => e.type).join('、')}
          </p>
        )}
      </section>

      <section className="card">
        <h3>成本报表</h3>
        {cost && (
          <>
            <div className="kpi-row">
              <div className="kpi"><div className="kpi-num">{cost.totalCalls}</div><div className="kpi-label">总调用</div></div>
              <div className="kpi"><div className="kpi-num">¥{cost.totalCost.toFixed(6)}</div><div className="kpi-label">总成本</div></div>
            </div>
            <table>
              <thead><tr><th>模型</th><th>次数</th><th>成本</th><th>平均延迟</th></tr></thead>
              <tbody>
                {cost.byModel.map((r) => (
                  <tr key={r.modelId}><td>{r.modelName}</td><td>{r.calls}</td><td>¥{r.cost}</td><td>{r.avgLatencyMs}ms</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="card">
        <h3>最近调用日志</h3>
        <table>
          <thead><tr><th>模型</th><th>策略</th><th>复杂度</th><th>延迟</th><th>成本</th></tr></thead>
          <tbody>
            {logs.slice(0, 10).map((l, i) => (
              <tr key={i}><td>{l.modelName}</td><td>{l.strategy}</td><td>{l.complexity}</td><td>{l.latencyMs}ms</td><td>¥{(l.cost || 0).toFixed(6)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
