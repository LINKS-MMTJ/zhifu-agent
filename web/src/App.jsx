// 应用根组件：AppProvider 提供全局状态，对话状态提升到 Shell 以免切屏丢失
import React from 'react';
import { AppProvider, useApp } from './context/AppContext.jsx';
import BottomNav from './components/BottomNav.jsx';
import ChatScreen from './components/chat/ChatScreen.jsx';
import KnowledgeScreen from './components/knowledge/KnowledgeScreen.jsx';
import SessionsScreen from './components/sessions/SessionsScreen.jsx';
import AdminScreen from './components/admin/AdminScreen.jsx';
import BizScreen from './components/biz/BizScreen.jsx';
import { useChat } from './hooks/useChat.js';

function ScreenRouter({ chat }) {
  const { tab, bizView } = useApp();
  // 业务页面优先：从对话里点"查看订单/去退货"会打开这里
  if (bizView) return <BizScreen view={bizView} />;
  switch (tab) {
    case 'knowledge': return <KnowledgeScreen />;
    case 'sessions': return <SessionsScreen />;
    case 'admin': return <AdminScreen />;
    case 'chat':
    default: return <ChatScreen chat={chat} />;
  }
}

function Shell() {
  const { sessionId } = useApp();
  // 对话状态提升到 Shell：切换底部标签时 ChatScreen 会卸载，
  // 但状态留在 Shell，切回来对话记录不会丢
  const chat = useChat(sessionId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">智</span>
          <div>
            <div className="brand-name">智服客服 Agent</div>
            <div className="brand-sub">电商售后 · 智能模型路由</div>
          </div>
        </div>
        <span className="status-pill"><i className="status-dot" />在线</span>
      </header>
      <main className="main">
        <ScreenRouter chat={chat} />
      </main>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
