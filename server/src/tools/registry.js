// 工具注册表：定义工具、是否只读（写操作需二次确认）、参数与处理器
// 内置工具与外部集成工具共用一张表，编排器与 HTTP 接口无需区分来源
import * as ec from './ecommerce.js';

const BUILTIN = {
  queryOrder: {
    desc: '查询订单状态',
    readonly: true,
    source: 'builtin',
    params: ['orderId', 'phone'],
    // require 的每个子数组是"任选其一"：订单号或手机号有一个就能查
    require: [['orderId', 'phone']],
    handler: ec.queryOrder,
  },
  trackLogistics: {
    desc: '查询物流轨迹',
    readonly: true,
    source: 'builtin',
    params: ['orderId', 'phone'],
    require: [['orderId', 'phone']],
    handler: ec.trackLogistics,
  },
  createReturn: {
    desc: '发起退货申请',
    readonly: false,
    source: 'builtin',
    params: ['orderId', 'reason'],
    require: [['orderId']],
    handler: ec.createReturn,
  },
  applyRefund: {
    desc: '申请退款',
    readonly: false,
    source: 'builtin',
    params: ['orderId'],
    require: [['orderId']],
    handler: ec.applyRefund,
  },
};

export const TOOLS = { ...BUILTIN };

export function getTool(name) { return TOOLS[name]; }

// 外部系统接入的工具在启动时注册进来
export function registerTool(def) {
  if (!def || !def.name || typeof def.handler !== 'function') {
    throw new Error('registerTool 需要 name 与 handler');
  }
  TOOLS[def.name] = def;
  return def;
}

export function listTools() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    desc: t.desc,
    readonly: t.readonly,
    source: t.source || 'builtin',
    params: t.params || [],
    triggers: t.triggers || [],
  }));
}

export function removeToolsBySource(source) {
  for (const [name, t] of Object.entries(TOOLS)) {
    if (t.source === source) delete TOOLS[name];
  }
}

export function matchToolByTrigger(message) {
  const text = String(message || '');
  for (const [name, t] of Object.entries(TOOLS)) {
    if (!t.triggers || !t.triggers.length) continue;
    if (t.triggers.some((kw) => text.includes(kw))) return { name, tool: t };
  }
  return null;
}
