// useChat：封装对话状态与 SSE 流式逻辑（从组件中抽离，便于复用与测试）
import { useState, useCallback } from 'react';
import { chatStream } from '../api.js';

export function useChat(sessionId) {
  // 首屏不再塞一条纯文本欢迎语，改由对话页渲染欢迎卡 + 快捷提问
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(null);

  const patchLast = useCallback((patch) => {
    setMessages((prev) => {
      const arr = [...prev];
      arr[arr.length - 1] = { ...arr[arr.length - 1], ...patch };
      return arr;
    });
  }, []);

  const appendToken = useCallback((t) => {
    setMessages((prev) => {
      const arr = [...prev];
      arr[arr.length - 1] = { ...arr[arr.length - 1], content: (arr[arr.length - 1].content || '') + t };
      return arr;
    });
  }, []);

  const pushTool = useCallback((tool) => {
    setMessages((prev) => {
      const arr = [...prev];
      const last = { ...arr[arr.length - 1] };
      last.tools = [...(last.tools || []), tool];
      arr[arr.length - 1] = last;
      return arr;
    });
  }, []);

  const handleEvent = useCallback((ev) => {
    switch (ev.type) {
      case 'meta':
        patchLast({ meta: { model: ev.model.name, tier: ev.model.tier, strategy: ev.strategy, complexity: ev.complexity, mode: ev.mode, reason: ev.reason } });
        break;
      case 'retrieval': patchLast({ retrieval: ev.snippets }); break;
      case 'tool': pushTool({ name: ev.name, result: ev.result, action: ev.action }); break;
      case 'fallback': patchLast({ fallback: `${ev.from} → ${ev.to}` }); break;
      case 'confirm_request':
        setPendingConfirm(ev);
        patchLast({ streaming: false, content: ev.summary, confirmAction: ev.action });
        break;
      case 'token': appendToken(ev.text); break;
      case 'human_handoff': patchLast({ content: ev.message, streaming: false }); break;
      case 'error': patchLast({ content: '出错了：' + ev.message, streaming: false }); break;
      case 'done': patchLast({ streaming: false, cost: ev.cost, latencyMs: ev.latencyMs, firstTokenMs: ev.firstTokenMs }); break;
      default: break;
    }
  }, [patchLast, appendToken, pushTool]);

  const send = useCallback((text, confirm = false) => {
    if (busy) return;
    const msg = (text || '').trim();
    if (!msg && !confirm) return;
    setMessages((prev) => [
      ...(confirm ? prev : [...prev, { role: 'user', content: msg }]),
      { role: 'assistant', content: '', streaming: true },
    ]);
    setBusy(true);
    setPendingConfirm(null);
    chatStream({ sessionId, message: msg || '确认', confirm, onEvent: handleEvent })
      .catch((e) => patchLast({ content: '请求失败：' + e.message, streaming: false }))
      .finally(() => setBusy(false));
  }, [busy, sessionId, handleEvent, patchLast]);

  const cancelConfirm = useCallback(() => setPendingConfirm(null), []);

  return { messages, busy, pendingConfirm, send, cancelConfirm };
}
