// 对话屏幕：状态由上层传入（避免切屏卸载后丢失记录）
import React, { useState, useRef, useEffect } from 'react';
import MessageBubble from './MessageBubble.jsx';
import ConfirmBar from './ConfirmBar.jsx';

// 首屏快捷提问：覆盖四类典型意图，点一下就能看到工具调用 / 知识库引用
const SUGGESTIONS = [
  { label: '我要退货，订单号 SO20260001', tag: '办理' },
  { label: '查一下订单 SO20260001', tag: '查询' },
  { label: '退货运费谁出？', tag: '政策' },
  { label: '你能帮我做什么？', tag: '能力' },
];

const CAPABILITIES = ['查订单', '查物流', '退货', '退款', '售后政策', '转人工'];

export default function ChatScreen({ chat }) {
  const { messages, busy, pendingConfirm, send, cancelConfirm } = chat;
  const [input, setInput] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    // 首屏欢迎卡不需要滚到底；只有产生对话后才跟随最新消息
    if (messages.length > 0 && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
      setInput('');
    }
  };

  return (
    <div className="screen chat">
      <div className={messages.length === 0 ? 'msg-list empty' : 'msg-list'} ref={listRef}>
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-hero">
              <span className="welcome-eyebrow">智服客服 Agent</span>
              <h1>售后问题，直接说</h1>
              <p>查订单、看物流、办退换货，或问售后政策。涉及退货、退款这类写操作，我会先跟你确认再执行。</p>
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} className="suggestion" onClick={() => send(s.label)} disabled={busy}>
                  <span>{s.label}</span>
                  <span className="arrow">→</span>
                </button>
              ))}
            </div>
            <div className="capabilities">
              {CAPABILITIES.map((c) => <span key={c} className="chip">{c}</span>)}
            </div>
          </div>
        ) : (
          messages.map((m, i) => <MessageBubble key={i} m={m} />)
        )}
      </div>
      {pendingConfirm && (
        <ConfirmBar
          onConfirm={() => send('确认', true)}
          onCancel={cancelConfirm}
          action={pendingConfirm.action}
        />
      )}
      <div className="input-bar">
        <input
          value={input}
          placeholder="输入售后问题，如：我要退货…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
        />
        <button
          className="send-btn"
          aria-label="发送"
          disabled={busy || !input.trim()}
          onClick={() => { send(input); setInput(''); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 12h15" />
            <path d="m13 5.5 6.5 6.5L13 18.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
