// 会话记录屏幕：历史会话列表，点开按需拉取对话明细
//
// 列表接口只返回摘要（消息条数、首问、时间）；正文在展开时才请求，
// 这样会话多的时候页面不会被几百条消息的正文拖慢，也避免一次性把所有对话摊在页面上。
import React, { useState } from 'react';
import { useAdmin } from '../../hooks/useAdmin.js';
import { getJSON } from '../../api.js';

function fmt(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function SessionsScreen() {
  const { sessions, loading, reload } = useAdmin();
  // id -> { loading, messages, error }
  const [details, setDetails] = useState({});

  const loadDetail = async (id) => {
    const cur = details[id];
    if (cur?.messages || cur?.loading) return;
    setDetails((d) => ({ ...d, [id]: { loading: true } }));
    try {
      const r = await getJSON(`/api/admin/sessions/${encodeURIComponent(id)}`);
      setDetails((d) => ({ ...d, [id]: { messages: r.messages || [] } }));
    } catch (err) {
      const msg = err.status === 401 ? '需要管理令牌，请到「运营」页填写' : err.message;
      setDetails((d) => ({ ...d, [id]: { error: msg } }));
    }
  };

  return (
    <div className="screen page">
      <div className="page-head">
        <h2>会话记录</h2>
        <button className="btn" onClick={reload}>刷新</button>
      </div>
      {loading && <p className="hint">加载中…</p>}
      {!loading && sessions.length === 0 && <p className="hint">暂无会话，去“对话”里聊几句吧。</p>}
      <div className="doc-list">
        {sessions.map((s) => (
          <details
            key={s.id}
            className="doc-card"
            onToggle={(e) => { if (e.currentTarget.open) loadDetail(s.id); }}
          >
            <summary>
              <span className="sess-id">{s.id}</span>
              <span className="sess-meta">{s.messageCount} 条 · {fmt(s.createdAt)}</span>
            </summary>
            {s.preview && <p className="hint">首问：{s.preview}</p>}
            {details[s.id]?.loading && <p className="hint">加载明细…</p>}
            {details[s.id]?.error && <p className="hint">明细加载失败：{details[s.id].error}</p>}
            {(details[s.id]?.messages || []).map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'hist user' : 'hist bot'}>
                <b>{m.role === 'user' ? '用户' : '客服'}</b>：{m.content}
              </div>
            ))}
            {details[s.id]?.messages?.length === 0 && <p className="hint">该会话暂无消息。</p>}
          </details>
        ))}
      </div>
    </div>
  );
}
