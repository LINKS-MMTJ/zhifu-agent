// 外部系统连接器：用声明式 JSON 把第三方 HTTP 接口变成 Agent 的工具
//
// 为什么用声明而不是写代码：
//   - 接入 CRM / 工单 / ERP 这类系统，80% 的工作是"哪个接口、要什么参数、怎么鉴权"
//   - 声明式配置可以被非研发同学维护，也便于做权限与审计
//   - 新增一个系统只需加一个 JSON 文件，不改 Agent 代码
//
// 能力边界（写在配置里，运行时强制执行）：
//   readonly: false  → 写操作必须经过用户确认（与内置工具共用同一套确认流程）
//   timeoutMs        → 单次调用超时，避免拖垮对话
//   retries          → 只对网络错误与 5xx 重试，4xx 不重试（重试也没用）
//   idempotencyKey   → 写操作可带幂等键，避免重试导致重复建单
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_RETRIES = 1;

function expandEnv(value) {
  return String(value).replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] || '');
}

function authHeaders(auth) {
  if (!auth) return {};
  const token = auth.tokenEnv ? process.env[auth.tokenEnv] : auth.token;
  if (!token) return {};
  if (auth.type === 'bearer') return { Authorization: `Bearer ${token}` };
  if (auth.type === 'basic') return { Authorization: `Basic ${token}` };
  if (auth.type === 'header') return { [auth.header || 'X-Api-Key']: token };
  return {};
}

// 从用户原话里抽参数：配置里给一条正则，命中即取值
export function extractArgs(params = {}, message = '') {
  const out = {};
  const missing = [];
  for (const [name, spec] of Object.entries(params)) {
    let value;
    if (spec.extract) {
      const re = new RegExp(spec.extract, 'i');
      const m = String(message).match(re);
      if (m) value = m[0];
    }
    if (value === undefined && spec.default !== undefined) value = spec.default;
    if (value === undefined || value === '') {
      if (spec.required) missing.push(name);
      continue;
    }
    out[name] = value;
  }
  return { args: out, missing };
}

function fillPath(template, args) {
  return template.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(args[key] ?? ''));
}

function splitArgs(tool, args) {
  const query = new URLSearchParams();
  const body = {};
  const headers = {};
  for (const [name, spec] of Object.entries(tool.params || {})) {
    const v = args[name];
    if (v === undefined) continue;
    if (spec.in === 'query') query.set(name, v);
    else if (spec.in === 'header') headers[name] = v;
    else if (spec.in === 'path') continue; // 已填进 URL
    else body[name] = coerce(v, spec.type);
  }
  return { query, body, headers };
}

function coerce(v, type) {
  if (type === 'number') return Number(v);
  if (type === 'boolean') return v === true || v === 'true';
  return v;
}

// 单次 HTTP 调用，带超时
async function requestOnce({ method, url, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function callConnector(connector, tool, args) {
  const { query, body, headers } = splitArgs(tool, args);
  let url = `${connector.baseUrl.replace(/\/$/, '')}${fillPath(tool.path, args)}`;
  if ([...query.keys()].length) url += `?${query}`;

  const finalHeaders = { ...authHeaders(connector.auth), ...headers };
  if (!tool.readonly && connector.idempotencyHeader) {
    finalHeaders[connector.idempotencyHeader] = `${connector.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const attempts = 1 + Math.max(0, connector.retries ?? DEFAULT_RETRIES);
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await requestOnce({
        method: tool.method || 'GET',
        url,
        headers: finalHeaders,
        body: (tool.method || 'GET').toUpperCase() === 'GET' ? undefined : body,
        timeoutMs: connector.timeoutMs,
      });
      connector._stat.lastAt = Date.now();
      connector._stat.lastStatus = res.status;
      if (res.ok) {
        connector._stat.ok++;
        connector._stat.lastError = '';
        return { ...res, attempts: i + 1 };
      }
      // 4xx 是业务拒绝，重试无意义
      if (res.status < 500) {
        connector._stat.fail++;
        connector._stat.lastError = `HTTP ${res.status}`;
        return { ...res, attempts: i + 1, retryable: false };
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  connector._stat.fail++;
  connector._stat.lastAt = Date.now();
  connector._stat.lastError = lastError?.name === 'AbortError' ? '超时' : (lastError?.message || '调用失败');
  return { ok: false, status: 0, data: null, error: connector._stat.lastError, attempts };
}

// 把连接器配置转成工具定义（结构与内置工具一致，编排器无需区分）
export function buildTools(connectors) {
  const tools = [];
  for (const c of connectors) {
    for (const t of c.tools || []) {
      tools.push({
        name: t.name,
        desc: t.desc,
        readonly: t.readonly !== false,
        source: `integration:${c.id}`,
        triggers: t.triggers || [],
        params: Object.keys(t.params || {}),
        paramSpec: t.params || {},
        handler: async (args) => {
          const res = await callConnector(c, t, args);
          return {
            ok: res.ok,
            status: res.status,
            source: c.name,
            data: res.data,
            error: res.error,
          };
        },
      });
    }
  }
  return tools;
}

export function loadConnectors(dir) {
  const connectors = [];
  if (!fs.existsSync(dir)) return connectors;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      console.warn(`[integrations] 跳过 ${file}：JSON 解析失败（${err.message}）`);
      continue;
    }

    // webhooks.json 是事件订阅配置，不是连接器
    if (raw.subscribers || !Array.isArray(raw.tools)) continue;

    const baseUrl = expandEnv(raw.baseUrl || '');
    const enabled = Boolean(baseUrl);
    connectors.push({
      ...raw,
      baseUrl,
      enabled,
      auth: raw.auth ? { ...raw.auth } : null,
      timeoutMs: raw.timeoutMs || DEFAULT_TIMEOUT,
      retries: raw.retries ?? DEFAULT_RETRIES,
      _file: file,
      _stat: { ok: 0, fail: 0, lastAt: null, lastStatus: null, lastError: '' },
    });

    if (!enabled) {
      console.warn(`[integrations] ${file} 未配置 baseUrl，连接器保持禁用`);
    }
  }
  return connectors;
}

export function connectorInfo(connectors) {
  return connectors.map((c) => ({
    id: c.id,
    name: c.name,
    enabled: c.enabled,
    baseUrl: c.enabled ? c.baseUrl : '',
    authType: c.auth?.type || 'none',
    tools: (c.tools || []).map((t) => ({
      name: t.name,
      desc: t.desc,
      readonly: t.readonly !== false,
      triggers: t.triggers || [],
    })),
    stat: { ...c._stat },
  }));
}
