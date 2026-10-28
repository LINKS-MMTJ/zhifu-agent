// API 客户端：SSE 流式对话 + 管理接口
// 管理接口可能需要令牌（服务端设置 ADMIN_TOKEN 后），令牌存在 localStorage
// 终端用户身份：服务端开启 USER_AUTH=enforce 时，对话必须带访客令牌；
// 未开启时拿到的令牌也会照常带上，服务端忽略即可，避免两套代码分支

const TOKEN_KEY = 'zhifu-admin-token';
const USER_TOKEN_KEY = 'zhifu-user-token';

export function getAdminToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setAdminToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 不可用，忽略
  }
}

function adminHeaders(extra = {}) {
  const headers = { ...extra };
  const a = getAdminToken();
  if (a) headers['x-admin-token'] = a;
  const u = getUserToken();
  if (u) headers.Authorization = `Bearer ${u}`;
  return headers;
}

export function getUserToken() {
  try { return localStorage.getItem(USER_TOKEN_KEY) || ''; } catch { return ''; }
}

function setUserToken(token) {
  try {
    if (token) localStorage.setItem(USER_TOKEN_KEY, token);
    else localStorage.removeItem(USER_TOKEN_KEY);
  } catch {
    // 忽略
  }
}

// 领取访客令牌；服务端异常时返回空串，退化为无令牌（USER_AUTH=off 时仍可正常对话）
let guestTried = false;
export async function ensureUserToken({ force = false } = {}) {
  if (!force) {
    const cached = getUserToken();
    if (cached) return cached;
    // 已经问过一次且服务端说不需要令牌：不要每次对话都再打一次接口
    if (guestTried) return '';
  }
  guestTried = true;
  try {
    const r = await fetch('/api/auth/guest', { method: 'POST' });
    if (!r.ok) return '';
    const d = await r.json();
    setUserToken(d.token || '');
    return d.token || '';
  } catch {
    return '';
  }
}

// 发起对话并流式接收事件
export async function chatStream({ sessionId, message, confirm = false, strategy, onEvent }) {
  let token = await ensureUserToken();
  const send = () => fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ sessionId, message, confirm, strategy }),
  });

  let res = await send();
  // 令牌过期：换一张再试一次，避免用户聊到一半突然中断
  if (res.status === 401) {
    token = await ensureUserToken({ force: true });
    if (token) res = await send();
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail.error || `请求失败 ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) {
          const json = line.slice(5).trim();
          if (!json) continue;
          try { onEvent(JSON.parse(json)); } catch { /* 忽略解析失败 */ }
        }
      }
    }
  }
}

export async function getJSON(url) {
  const r = await fetch(url, { headers: adminHeaders() });
  if (!r.ok) {
    const err = new Error(r.status === 401 ? '需要管理令牌' : `请求失败 ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error(r.status === 401 ? '需要管理令牌' : `请求失败 ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// 上传知识库文件：原始字节流 + 文件名头，服务端落盘后增量入库
export async function uploadKnowledgeFile(file) {
  const r = await fetch('/api/admin/kb/upload', {
    method: 'POST',
    headers: adminHeaders({
      'Content-Type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    }),
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || (r.status === 401 ? '需要管理令牌' : `上传失败 ${r.status}`));
    err.status = r.status;
    err.code = data.code;
    throw err;
  }
  return data;
}
