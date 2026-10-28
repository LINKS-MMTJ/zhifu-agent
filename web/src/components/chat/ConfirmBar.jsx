// 写操作二次确认条：确认执行 / 取消 / 去业务页自己办理
import React from 'react';
import { useApp } from '../../context/AppContext.jsx';

export default function ConfirmBar({ onConfirm, onCancel, action }) {
  const { openBiz } = useApp();
  return (
    <div className="confirm-bar">
      <button className="btn primary" onClick={onConfirm}>确认执行</button>
      {action && (
        <button className="btn" onClick={() => openBiz({ type: action.type, orderId: action.orderId })}>
          {action.label} →
        </button>
      )}
      <button className="btn" onClick={onCancel}>取消</button>
    </div>
  );
}
