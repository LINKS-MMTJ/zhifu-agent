// 工具注册表：定义工具、是否只读（写操作需二次确认）、参数与处理器
// 内置工具与外部集成工具共用一张表，编排器与 HTTP 接口无需区分来源
import * as ec from './ecommerce.js';

const ORDER_ID_PROP = { type: 'string', description: '订单号，形如 SO20260001' };
const PHONE_PROP = { type: 'string', description: '下单手机号，11 位数字' };

const BUILTIN = {
  queryOrder: {
    desc: '查询订单状态',
    readonly: true,
    source: 'builtin',
    params: ['orderId', 'phone'],
    // require 的每个子数组是"任选其一"：订单号或手机号有一个就能查
    require: [['orderId', 'phone']],
    // function calling 用的 JSON Schema：只暴露允许的参数，模型不能凭空加字段
    parameters: {
      type: 'object',
      properties: { orderId: ORDER_ID_PROP, phone: PHONE_PROP },
      required: [],
      description: 'orderId 与 phone 至少提供一个',
    },
    handler: ec.queryOrder,
  },
  trackLogistics: {
    desc: '查询物流轨迹',
    readonly: true,
    source: 'builtin',
    params: ['orderId', 'phone'],
    require: [['orderId', 'phone']],
    parameters: {
      type: 'object',
      properties: { orderId: ORDER_ID_PROP, phone: PHONE_PROP },
      required: [],
      description: 'orderId 与 phone 至少提供一个',
    },
    handler: ec.trackLogistics,
  },
  createReturn: {
    desc: '发起退货申请',
    readonly: false,
    source: 'builtin',
    params: ['orderId', 'reason'],
    require: [['orderId']],
    parameters: {
      type: 'object',
      properties: {
        orderId: ORDER_ID_PROP,
        reason: { type: 'string', description: '退货原因，可省略' },
      },
      required: ['orderId'],
    },
    handler: ec.createReturn,
  },
  applyRefund: {
    desc: '申请退款',
    readonly: false,
    source: 'builtin',
    params: ['orderId'],
    require: [['orderId']],
    parameters: {
      type: 'object',
      properties: { orderId: ORDER_ID_PROP },
      required: ['orderId'],
    },
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

// 交给模型的工具声明（OpenAI tools 格式）。
// 只有声明了 parameters 的工具才暴露：没有 Schema 的工具（外部系统未给参数定义）
// 让模型去猜参数只会产生无效调用。
export function toolSchemas() {
  return Object.entries(TOOLS)
    .filter(([, t]) => t.parameters)
    .map(([name, t]) => ({
      type: 'function',
      function: {
        name,
        description: t.desc,
        parameters: t.parameters,
      },
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
