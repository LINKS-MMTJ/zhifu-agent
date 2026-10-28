// 测试辅助：启动隔离端口的应用实例 + SSE 解析
process.env.EVAL_FAST = '1';      // 评测/测试模式下跳过模拟延迟
process.env.LOG_LEVEL = 'error';  // 测试时不输出访问日志

import { createApp } from '../src/app.js';

/**
 * 在随机端口启动应用，返回 { port, close }
 */
export async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * 发起一轮对话，解析 SSE 事件
 */
export async function chat(port, { sessionId, message, confirm = false }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, confirm }),
  });
  const raw = await res.text();
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '{}') continue;
    try { events.push(JSON.parse(payload)); } catch { /* 忽略非 JSON 行 */ }
  }
  return events;
}

/** 从事件流里取第一条指定类型 */
export function first(events, type) {
  return events.find((e) => e.type === type);
}

/** 把 token 事件拼成完整文本 */
export function textOf(events) {
  return events.filter((e) => e.type === 'token').map((e) => e.text).join('');
}

/** 唯一会话 ID，避免测试之间互相污染 */
export function sid(prefix = 't') {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}
