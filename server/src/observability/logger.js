// 结构化日志：默认输出 JSON 行，方便直接接 Loki / ELK / CloudWatch
// LOG_FORMAT=text 时退回人类可读格式（本地开发更舒服）
import { currentTraceId } from './trace.js';
import { redactDeep } from '../privacy/redact.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const FORMAT = process.env.LOG_FORMAT || 'json';

// 每次读取：便于测试与运行期调整，不必重启
function minLevel() {
  return LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
}

function emit(level, event, fields) {
  if (LEVELS[level] < minLevel()) return;
  const ts = new Date().toISOString();
  const traceId = currentTraceId();
  const safeFields = redactDeep(fields || {});

  if (FORMAT === 'text') {
    const extra = Object.entries(safeFields)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    const line = `${ts} ${level.toUpperCase()} ${event}${traceId ? ` trace=${traceId}` : ''}${extra ? ` ${extra}` : ''}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    return;
  }

  const record = { ts, level, event, ...(traceId ? { traceId } : {}), ...safeFields };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function logDebug(event, fields) { emit('debug', event, fields); }
export function logInfo(event, fields) { emit('info', event, fields); }
export function logWarn(event, fields) { emit('warn', event, fields); }
export function logError(event, fields) { emit('error', event, fields); }
