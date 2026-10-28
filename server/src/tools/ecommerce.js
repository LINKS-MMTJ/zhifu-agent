// 工具实现：电商售后业务（mock 数据，模拟真实接口返回结构）

// —— 模拟订单库 ——
const ORDERS = {
  SO20260001: {
    orderId: 'SO20260001', phone: '138****1234', product: '轻便跑步鞋 42 码',
    amount: 299, status: '已签收', payTime: '2026-10-22', returnable: true,
    traces: [
      { time: '10-23 09:12', desc: '包裹已从【杭州仓】发出' },
      { time: '10-24 14:30', desc: '到达【北京转运中心】' },
      { time: '10-25 10:05', desc: '已签收，感谢使用' },
    ],
  },
  SO20260002: {
    orderId: 'SO20260002', phone: '138****1234', product: '无线蓝牙耳机',
    amount: 199, status: '运输中', payTime: '2026-10-25', returnable: false,
    traces: [
      { time: '10-26 08:00', desc: '包裹已从【深圳仓】发出' },
      { time: '10-26 20:12', desc: '到达【广州转运中心】' },
    ],
  },
  SO20260003: {
    orderId: 'SO20260003', phone: '139****5678', product: '保温杯 500ml',
    amount: 89, status: '已签收', payTime: '2026-10-18', returnable: true,
    traces: [{ time: '10-20 16:40', desc: '已签收' }],
  },
};

function findOrder({ orderId, phone }) {
  if (orderId && ORDERS[orderId]) return ORDERS[orderId];
  // 按手机号兜底找最近一单
  if (phone) {
    const hit = Object.values(ORDERS).find((o) => o.phone === phone);
    if (hit) return hit;
  }
  return null;
}

export function queryOrder(args = {}) {
  const order = findOrder(args);
  if (!order) {
    // 注意：不要把内部测试订单号回给用户，那是演示数据，不是真实业务信息
    const hasKey = Boolean(args.orderId || args.phone);
    return {
      found: false,
      hint: hasKey ? '请核对订单号是否正确，或提供下单手机号我再查一次。' : '缺少可查询的订单号或手机号。',
    };
  }
  const { traces, ...rest } = order;
  return { found: true, ...rest };
}

// 业务页面用：返回完整订单（含物流轨迹与可执行操作）
export function getOrderDetail(orderId) {
  const order = ORDERS[String(orderId || '').toUpperCase()];
  if (!order) return null;
  return {
    orderId: order.orderId,
    product: order.product,
    amount: order.amount,
    status: order.status,
    payTime: order.payTime,
    returnable: order.returnable,
    traces: order.traces,
    actions: {
      canReturn: order.returnable,
      canTrack: true,
    },
  };
}

export function trackLogistics(args = {}) {
  const order = findOrder(args);
  if (!order) return { found: false, hint: '未找到该订单，请确认订单号。' };
  return { found: true, orderId: order.orderId, product: order.product, traces: order.traces };
}

export function createReturn(args = {}) {
  const order = findOrder(args);
  if (!order) return { found: false, hint: '未找到该订单，无法发起退货。' };
  if (!order.returnable) return { found: true, orderId: order.orderId, rejected: true, note: '该订单当前状态暂不支持退货（如运输中请先确认签收）。' };
  return {
    found: true, orderId: order.orderId, product: order.product,
    returnId: 'RT' + Date.now().toString().slice(-8),
    status: '已受理',
    note: '请在 7 天内寄回商品，退款将在验收后原路退回。',
  };
}

export function applyRefund(args = {}) {
  const order = findOrder(args);
  if (!order) return { found: false, hint: '未找到该订单，无法申请退款。' };
  return {
    found: true, orderId: order.orderId, product: order.product,
    amount: order.amount, eta: '1-7 个工作日',
    note: '退款审核已通过，原路退回。',
  };
}
