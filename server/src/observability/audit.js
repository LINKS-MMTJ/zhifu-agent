// 审计日志：把"谁、在什么时候、对什么、做了什么、结果如何"落盘
//
// 与普通日志的区别：普通日志用于排障，可以随进程消失；
// 审计日志用于合规与追责，必须持久化、按天归档、只追加不修改。
//
// 设计取舍：
//   - 追加写 JSONL，不引入数据库；一行一条，便于 grep 与投递到日志平台
//   - 写失败只告警，绝不阻断业务请求（审计不能把主链路拖死）
//   - 按天分文件，避免单文件无限增长
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { currentTraceId } from './trace.js';
import { redactDeep } from '../privacy/redact.js';

let auditDir = null;
let queue = Promise.resolve();

export function initAudit({ dir } = {}) {
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  auditDir = dir;
  return true;
}

export function auditEnabled() {
  return Boolean(auditDir);
}

function dayFile(date) {
  return path.join(auditDir, `audit-${date}.jsonl`);
}

// 记录一条审计；不等待落盘，返回 Promise 便于测试与优雅关闭时 flush
export function audit(entry = {}) {
  if (!auditDir) return Promise.resolve(null);
  const ts = new Date().toISOString();
  const record = redactDeep({
    actor: 'anonymous',
    action: 'unknown',
    target: '',
    result: 'ok',
    ...entry,
    // 时间与 traceId 由服务端生成，不允许调用方覆盖
    ts,
    traceId: currentTraceId(),
  });

  const file = dayFile(ts.slice(0, 10));
  const line = `${JSON.stringify(record)}\n`;
  queue = queue
    .then(() => fsp.appendFile(file, line, 'utf8'))
    .catch((err) => {
      console.warn(`[audit] 写入失败：${err.message}`);
    });
  return queue;
}

export async function flushAudit() {
  await queue;
}

// 查询：默认读当天，返回最近的 N 条（倒序）
export async function queryAudit({ limit = 100, date } = {}) {
  if (!auditDir) return { date: null, entries: [] };
  const day = date || new Date().toISOString().slice(0, 10);
  const file = dayFile(day);
  if (!fs.existsSync(file)) return { date: day, entries: [] };

  await flushAudit();
  const raw = await fsp.readFile(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const picked = lines.slice(-Math.max(1, Math.min(limit, 1000)));

  const entries = [];
  for (const line of picked) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 半行（进程被杀）直接跳过，不让整页查询失败
    }
  }
  return { date: day, entries: entries.reverse() };
}

export function resetAuditForTest() {
  auditDir = null;
  queue = Promise.resolve();
}
