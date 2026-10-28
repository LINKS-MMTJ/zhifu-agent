// 全局应用状态：会话 ID、当前路由标签、路由策略、业务页面视图
import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [sessionId] = useState(() => 's-' + Date.now() + '-' + Math.floor(Math.random() * 1000));
  const [tab, setTab] = useState('chat');       // chat | knowledge | sessions | admin
  const [strategy, setStrategy] = useState('auto');
  // 业务页面视图：{ type: 'order'|'logistics'|'return'|'refund', orderId }
  // 由对话中的"一键跳转"按钮打开，null 表示不显示
  const [bizView, setBizView] = useState(null);

  const openBiz = useCallback((view) => setBizView(view), []);
  const closeBiz = useCallback(() => setBizView(null), []);

  const value = useMemo(
    () => ({ sessionId, tab, setTab, strategy, setStrategy, bizView, openBiz, closeBiz }),
    [sessionId, tab, strategy, bizView, openBiz, closeBiz]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 <AppProvider> 内使用');
  return ctx;
}
