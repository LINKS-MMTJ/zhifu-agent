// 会话记录屏幕：历史会话列表，点开查看对话明细
import React from 'react';
import { useAdmin } from '../../hooks/useAdmin.js';

function fmt(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function SessionsScreen() {
  const { sessions, loading, reload } = useAdmin();

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
          <details key={s.id} className="doc-card">
            <summary>
              <span className="sess-id">{s.id}</span>
              <span className="sess-meta">{s.messageCount} 条 · {fmt(s.createdAt)}</span>
            </summary>
            {s.preview && <p className="hint">首问：{s.preview}</p>}
            {s.messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'hist user' : 'hist bot'}>
                <b>{m.role === 'user' ? '用户' : '客服'}</b>：{m.content}
              </div>
            ))}
          </details>
        ))}
      </div>
    </div>
  );
}
