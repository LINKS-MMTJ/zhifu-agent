// 全局应用状态：会话 ID、当前路由标签、业务页面视图
//
// 路由策略不放在这里：它的事实来源只有一个——服务端 router.strategy，
// 由 /api/admin/models 读取、由 /api/admin/strategy 修改。前端各屏都展示这份数据，
// 之前前后端各存一份，会出现"界面显示价格优先、实际按自动在路由"的错位。
import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [sessionId] = useState(() => 's-' + Date.now() + '-' + Math.floor(Math.random() * 1000));
  const [tab, setTab] = useState('chat');       // chat | knowledge | sessions | admin
  // 业务页面视图：{ type: 'order'|'logistics'|'return'|'refund', orderId }
  // 由对话中的"一键跳转"按钮打开，null 表示不显示
  const [bizView, setBizView] = useState(null);

  const openBiz = useCallback((view) => setBizView(view), []);
  const closeBiz = useCallback(() => setBizView(null), []);

  const value = useMemo(
    () => ({ sessionId, tab, setTab, bizView, openBiz, closeBiz }),
    [sessionId, tab, bizView, openBiz, closeBiz]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 <AppProvider> 内使用');
  return ctx;
}
