// 模型工具规划（function calling）
//
// 规则规划覆盖不了所有口语说法（"我那单鞋子到哪了"），这类情况交给模型做一次
// function calling，但只作为**规则没命中时的补充**：
//   - 模型只能从我们给出的工具清单里选，参数必须落在 Schema 白名单内
//   - 订单号/手机号按格式校验，不合法的参数直接丢弃（宁可追问，不可乱查）
//   - 写操作依旧走二次确认与归属校验，模型无法绕过
//   - 任何异常都降级为空结果，不影响主链路
import { streamModel } from '../llm/index.js';
import { router } from '../router/modelRouter.js';

export function plannerMode() {
  return process.env.PLANNER === 'llm' ? 'llm' : 'rules';
}

const SYSTEM_PROMPT = [
  '你是电商售后系统的工具规划器。',
  '根据用户这句话，选择一个最合适的工具并给出参数；不需要工具就不要调用。',
  '只能使用给定的工具，不得编造参数值；用户没提供的订单号或手机号一律不要猜。',
  '如果用户只是咨询政策、闲聊或与售后无关，不要调用任何工具。',
].join('\n');

function normalizeOrderId(v) {
  const s = String(v || '').toUpperCase().replace(/\s+/g, '');
  if (/^SO\d{6,}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return s;
  return null;
}

function normalizePhone(v) {
  const s = String(v || '').replace(/\D/g, '');
  return /^1[3-9]\d{9}$/.test(s) ? s : null;
}

/**
 * 校验并清洗模型给出的工具调用：未知工具、非法参数、空参数调用全部丢掉
 * @param {Array<{name:string,args:object}>} calls
 * @param {Array} tools toolSchemas() 的结果
 */
export function sanitizeToolCalls(calls, tools) {
  const allowed = new Map(tools.map((t) => [t.function.name, t.function.parameters || {}]));
  const out = [];
  for (const call of calls || []) {
    if (!call?.name || !allowed.has(call.name)) continue;
    const props = Object.keys(allowed.get(call.name).properties || {});
    const args = {};
    for (const [k, v] of Object.entries(call.args || {})) {
      if (!props.includes(k) || v === null || v === undefined) continue;
      if (k === 'orderId') {
        const id = normalizeOrderId(v);
        if (id) args.orderId = id;
      } else if (k === 'phone') {
        const p = normalizePhone(v);
        if (p) args.phone = p;
      } else if (typeof v === 'string' || typeof v === 'number') {
        args[k] = String(v).trim().slice(0, 100);
      }
    }
    // 一个参数都没有的调用没有执行价值，交给追问逻辑处理
    if (!Object.keys(args).length) continue;
    out.push({ name: call.name, args });
  }
  return out;
}

/**
 * 让模型规划一次工具调用
 * @returns {Promise<{calls:Array<{name:string,args:object}>, modelId:string|null}>}
 */
export async function planByModel({
  message, history = [], tools, complexity = 'medium', strategy = null, stream = streamModel, model: forcedModel = null,
}) {
  if (!tools?.length || !message) return { calls: [], modelId: null };

  const model = forcedModel || router.select(complexity, strategy).model;
  // Mock 模型不会真的返回 tool_calls，交给规则链路
  if (!model || model.adapter === 'mock' || !model.supportsTools) {
    return { calls: [], modelId: null };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-2),
    { role: 'user', content: message },
  ];

  const acc = new Map();
  try {
    for await (const ev of stream({ model, messages, tools })) {
      if (ev.type !== 'tool_call_delta') continue;
      const cur = acc.get(ev.index) || { name: '', argsText: '' };
      if (ev.name) cur.name = ev.name;
      if (ev.argsText) cur.argsText += ev.argsText;
      acc.set(ev.index, cur);
    }
  } catch {
    // 规划失败就走规则链路，不把错误暴露给用户
    return { calls: [], modelId: model.id };
  }

  const raw = [...acc.values()]
    .filter((c) => c.name)
    .map((c) => {
      let args = {};
      try {
        args = c.argsText ? JSON.parse(c.argsText) : {};
      } catch {
        args = {};
      }
      return { name: c.name, args };
    });

  return { calls: sanitizeToolCalls(raw, tools), modelId: model.id };
}
