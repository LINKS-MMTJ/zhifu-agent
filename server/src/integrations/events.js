// 事件总线：让 Agent 与外部系统双向联动
//
// 出站：Agent 发生的事（调用了什么工具、转人工、答案完成）推给订阅方，
//       带 HMAC 签名与重试，订阅方验签后落库或触发自己的流程。
// 入站：外部系统（订单中心、工单系统）推送事件进来，可作为主动服务的触发源。
//
// 事件只保留最近 N 条在内存里，用于管理页展示与排障；真正的持久化应由订阅方负责。
import fs from 'node:fs';
import path from 'node:path';
import { sign } from './signature.js';

const MAX_EVENTS = 200;

const state = {
  subscribers: [],
  outbound: [],
  inbound: [],
};

function push(list, item) {
  list.unshift(item);
  if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
}

export function loadSubscribers(dir) {
  const file = path.join(dir, 'webhooks.json');
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.subscribers = (raw.subscribers || [])
      .map((s) => ({
        ...s,
        url: String(s.url || '').replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] || ''),
        secret: s.secretEnv ? process.env[s.secretEnv] || '' : (s.secret || ''),
      }))
      // 环境变量没配时 URL 会变成相对路径，直接忽略，避免每次事件都失败
      .filter((s) => /^https?:\/\//i.test(s.url));
  } catch (err) {
    console.warn(`[events] webhooks.json 解析失败：${err.message}`);
    state.subscribers = [];
  }
  return state.subscribers;
}

async function postOnce(sub, payload, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json', 'x-zhifu-event': payload.type };
    if (sub.secret) headers['x-zhifu-signature'] = sign(sub.secret, JSON.stringify(payload));
    const res = await fetch(sub.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok;
  } finally {
    clearTimeout(timer);
  }
}

// 出站事件：不阻塞主链路，失败只记录
export function emitEvent(type, data = {}) {
  const payload = { type, at: new Date().toISOString(), data };
  const targets = state.subscribers.filter((s) => s.url && (!s.events || s.events.includes(type)));
  push(state.outbound, { ...payload, targets: targets.length });

  for (const sub of targets) {
    (async () => {
      for (let i = 0; i < 2; i++) {
        try {
          const ok = await postOnce(sub, payload);
          if (ok) return;
        } catch {
          // 重试一次
        }
      }
      push(state.outbound, { type: 'delivery.failed', at: new Date().toISOString(), data: { subscriber: sub.id, event: type } });
    })();
  }
  return payload;
}

export function recordInbound(event) {
  const item = { ...event, direction: 'in', at: new Date().toISOString() };
  push(state.inbound, item);
  return item;
}

export function listEvents(limit = 50) {
  return {
    subscribers: state.subscribers.map((s) => ({ id: s.id, url: s.url, events: s.events || ['*'] })),
    outbound: state.outbound.slice(0, limit),
    inbound: state.inbound.slice(0, limit),
  };
}

export function resetEventsForTest() {
  state.subscribers = [];
  state.outbound = [];
  state.inbound = [];
}
