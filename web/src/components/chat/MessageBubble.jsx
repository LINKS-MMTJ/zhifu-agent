// 单条消息气泡：展示模型芯片、工具调用、正文、引用、成本、业务引导按钮
import React from 'react';
import { useApp } from '../../context/AppContext.jsx';

const STRATEGY_LABEL = { price: '价格优先', quality: '质量优先', latency: '延迟优先', balanced: '均衡', auto: '自动', local: '本地应答' };
const MODE_LABEL = { rag: '知识库', tool: '业务办理', general: '通用对话', handoff: '转人工' };
const COMPLEXITY_LABEL = { simple: '简单', medium: '中等', complex: '复杂' };

// 引用片段来自切块原文，带 Markdown 标题符号，直接展示会很粗糙
function cleanText(s) {
  return String(s || '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*/g, '')
    .trim();
}

// 真实模型的回答带 Markdown（加粗、有序/无序列表）。不渲染就会把 ** 和 - 原样吐出来。
// 这里只做客服场景用得到的子集，避免为一点格式引入整个 Markdown 库。
function renderInline(text) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((p, i) => (
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{p}</React.Fragment>
  ));
}

function renderRich(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let list = [];
  const flush = () => {
    if (!list.length) return;
    out.push(<ul className="md-ul" key={`ul-${out.length}`}>{list}</ul>);
    list = [];
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s{0,2}[-*]\s+(.*)$/);
    if (bullet) {
      list.push(<li key={i}>{renderInline(bullet[1])}</li>);
      return;
    }
    flush();
    if (!line.trim()) { out.push(<div className="md-gap" key={i} />); return; }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) return;
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) { out.push(<div className="md-h" key={i}>{renderInline(h[1])}</div>); return; }
    out.push(<div className="md-p" key={i}>{renderInline(line)}</div>);
  });
  flush();
  return out;
}

export default function MessageBubble({ m }) {
  const isUser = m.role === 'user';
  const { openBiz } = useApp();
  // 工具执行后返回的业务入口（查看订单 / 查看物流）
  const actions = (m.tools || []).map((t) => t.action).filter(Boolean);

  return (
    <div className={isUser ? 'row user' : 'row bot'}>
      {!isUser && <span className="avatar" aria-hidden="true">智</span>}
      <div className={isUser ? 'bubble user' : 'bubble bot'}>
        {!isUser && m.meta && (
          <div className="chips">
            <span className="chip model">{m.meta.model}</span>
            {m.meta.mode && <span className="chip mode">{MODE_LABEL[m.meta.mode] || m.meta.mode}</span>}
            <span className="chip">{STRATEGY_LABEL[m.meta.strategy] || m.meta.strategy}</span>
            <span className="chip">复杂度：{COMPLEXITY_LABEL[m.meta.complexity] || m.meta.complexity}</span>
          </div>
        )}
        {!isUser && m.tools?.length > 0 && (
          <div className="tools">
            {m.tools.map((t, i) => (
              <div key={i} className="tool-chip">{t.name}{t.result?.orderId ? ` · ${t.result.orderId}` : ''}</div>
            ))}
          </div>
        )}
        <div className={isUser ? 'text' : 'text md'}>
          {isUser ? m.content : renderRich(m.content)}
          {m.streaming && <span className="cursor">▍</span>}
        </div>
        {!isUser && actions.length > 0 && (
          <div className="action-row">
            {actions.map((a, i) => (
              <button
                key={i}
                className="btn primary action-btn"
                onClick={() => openBiz({ type: a.type, orderId: a.orderId })}
              >
                {a.label} →
              </button>
            ))}
          </div>
        )}
        {!isUser && m.retrieval?.length > 0 && (
          <details className="retrieval">
            <summary>引用知识（{m.retrieval.length}）</summary>
            {m.retrieval.map((r, i) => (
              <div key={i} className="ref">
                <b>《{r.title}》{r.section ? ` › ${cleanText(r.section)}` : ''}</b>
                <span>{cleanText(r.text)}</span>
              </div>
            ))}
          </details>
        )}
        {!isUser && typeof m.cost === 'number' && m.cost > 0 && (
          <div className="cost-line">
            成本 ¥{m.cost.toFixed(6)} · 首字 {m.firstTokenMs ?? '—'}ms · 总 {m.latencyMs}ms
          </div>
        )}
      </div>
    </div>
  );
}
