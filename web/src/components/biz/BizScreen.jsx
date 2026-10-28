// 业务页面：由对话中的"一键跳转"进入，模拟真实商家后台/自助服务页面
import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { getJSON, postJSON } from '../../api.js';

const TITLE = {
  order: '订单详情',
  logistics: '物流轨迹',
  return: '退货办理',
  refund: '退款办理',
};

export default function BizScreen({ view }) {
  const { closeBiz, openBiz } = useApp();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('商品与描述不符');
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setOrder(null);
    setResult(null);
    setError('');
    getJSON(`/api/biz/orders/${view.orderId}`)
      .then((d) => { if (alive) { if (d.error) setError(d.error); else setOrder(d); } })
      .catch(() => { if (alive) setError('加载订单失败'); });
    return () => { alive = false; };
  }, [view.orderId, view.type]);

  const submitReturn = async () => {
    setSubmitting(true);
    try {
      const r = await postJSON(`/api/biz/orders/${view.orderId}/return`, { reason });
      if (r.error) setError(r.error);
      else setResult(r);
    } catch {
      setError('提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const submitRefund = async () => {
    setSubmitting(true);
    try {
      const r = await postJSON(`/api/biz/orders/${view.orderId}/refund`, {});
      if (r.error) setError(r.error);
      else setResult(r);
    } catch {
      setError('提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="screen page">
      <div className="page-head">
        <button className="btn" onClick={closeBiz}>← 返回对话</button>
        <h2>{TITLE[view.type] || '业务办理'}</h2>
        <span className="sess-id">{view.orderId}</span>
      </div>

      {error && <div className="card error-card">{error}</div>}
      {!order && !error && <p className="hint">加载中…</p>}

      {order && (
        <>
          <section className="card">
            <h3>{order.product}</h3>
            <div className="kv"><span>订单号</span><b>{order.orderId}</b></div>
            <div className="kv"><span>金额</span><b>¥{order.amount}</b></div>
            <div className="kv"><span>状态</span><b>{order.status}</b></div>
            <div className="kv"><span>下单时间</span><b>{order.payTime}</b></div>
          </section>

          {(view.type === 'order') && (
            <section className="card">
              <h3>可办理</h3>
              <div className="strategy-row">
                <button className="btn" onClick={() => openBiz({ type: 'logistics', orderId: order.orderId })}>查看物流</button>
                {order.actions?.canReturn && (
                  <button className="btn primary" onClick={() => openBiz({ type: 'return', orderId: order.orderId })}>申请退货</button>
                )}
                <button className="btn" onClick={() => openBiz({ type: 'refund', orderId: order.orderId })}>申请退款</button>
              </div>
            </section>
          )}

          {(view.type === 'logistics' || view.type === 'order') && order.traces?.length > 0 && (
            <section className="card">
              <h3>物流轨迹</h3>
              <div className="timeline">
                {(view.type === 'order' ? order.traces.slice(0, 1) : order.traces).map((t, i) => (
                  <div key={i} className={i === 0 ? 'tl-item latest' : 'tl-item'}>
                    <span className="tl-dot" />
                    <div>
                      <div className="tl-desc">{t.desc}</div>
                      <div className="tl-time">{t.time}</div>
                    </div>
                  </div>
                ))}
              </div>
              {view.type === 'order' && order.traces.length > 1 && (
                <button
                  className="btn block"
                  onClick={() => openBiz({ type: 'logistics', orderId: order.orderId })}
                >
                  查看全部 {order.traces.length} 条轨迹 →
                </button>
              )}
            </section>
          )}

          {view.type === 'return' && (
            <section className="card">
              <h3>退货原因</h3>
              <select className="select" value={reason} onChange={(e) => setReason(e.target.value)} disabled={!!result}>
                <option>商品与描述不符</option>
                <option>质量问题</option>
                <option>尺码不合适</option>
                <option>七天无理由</option>
                <option>其他</option>
              </select>
              <button
                className="btn primary block"
                disabled={submitting || !!result || !order.actions?.canReturn}
                onClick={submitReturn}
              >
                {result ? '已提交' : submitting ? '提交中…' : '提交退货申请'}
              </button>
              {!order.actions?.canReturn && <p className="hint">该订单当前状态暂不支持退货。</p>}
            </section>
          )}

          {view.type === 'refund' && (
            <section className="card">
              <h3>退款申请</h3>
              <p className="hint">将按原支付方式退回 ¥{order.amount}，预计 1-7 个工作日到账。</p>
              <button className="btn primary block" disabled={submitting || !!result} onClick={submitRefund}>
                {result ? '已提交' : submitting ? '提交中…' : '提交退款申请'}
              </button>
            </section>
          )}

          {result && (
            <section className="card success-card">
              <h3>提交成功</h3>
              <div className="kv"><span>单号</span><b>{result.returnId || result.orderId}</b></div>
              {result.status && <div className="kv"><span>状态</span><b>{result.status}</b></div>}
              {result.note && <p className="hint">{result.note}</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
