// 业务引导：把工具执行结果转成"可一键跳转"的业务入口
// 前端据此渲染按钮，点击直达对应的业务页面（订单详情 / 物流轨迹 / 退货办理）

/**
 * @param {string} toolName 工具名
 * @param {object} args     调用参数
 * @param {object} result   执行结果
 * @returns {{type:string,label:string,orderId:string}|null}
 */
export function buildAction(toolName, args, result) {
  const orderId = args?.orderId || result?.orderId;
  if (!orderId) return null;

  switch (toolName) {
    case 'queryOrder':
      return { type: 'order', label: '查看订单详情', orderId };
    case 'trackLogistics':
      return { type: 'logistics', label: '查看物流轨迹', orderId };
    case 'createReturn':
      return { type: 'order', label: '查看订单', orderId };
    case 'applyRefund':
      return { type: 'order', label: '查看退款进度', orderId };
    default:
      return null;
  }
}

/**
 * 写操作确认时的引导入口：让用户可以去业务页自己填表办理
 */
export function buildConfirmAction(toolName, args) {
  const orderId = args?.orderId;
  if (!orderId) return null;
  if (toolName === 'createReturn') return { type: 'return', label: '去退货办理页', orderId };
  if (toolName === 'applyRefund') return { type: 'refund', label: '去退款办理页', orderId };
  return { type: 'order', label: '查看订单', orderId };
}
