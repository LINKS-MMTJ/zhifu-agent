// 底部导航栏：移动 App 风格的四个标签（线性图标，避免 emoji 在不同系统上风格不一）
import React from 'react';
import { useApp } from '../context/AppContext.jsx';

const ICONS = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 9.3 9.3 0 0 1-3.7-.8L3 21l1.9-5.4A8.3 8.3 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
    </svg>
  ),
  knowledge: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z" />
      <path d="M4 5.5v15" />
      <path d="M8 7.5h8M8 11h5" />
    </svg>
  ),
  sessions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z" />
    </svg>
  ),
  admin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  ),
};

const TABS = [
  { id: 'chat', label: '对话', icon: ICONS.chat },
  { id: 'knowledge', label: '知识库', icon: ICONS.knowledge },
  { id: 'sessions', label: '会话', icon: ICONS.sessions },
  { id: 'admin', label: '运营', icon: ICONS.admin },
];

export default function BottomNav() {
  const { tab, setTab } = useApp();
  return (
    <nav className="bottom-nav">
      {TABS.map((t) => (
        <button key={t.id} className={tab === t.id ? 'nav-item active' : 'nav-item'} onClick={() => setTab(t.id)}>
          <span className="nav-icon">{t.icon}</span>
          <span className="nav-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
