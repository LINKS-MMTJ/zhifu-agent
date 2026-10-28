// API 客户端：SSE 流式对话 + 管理接口
// 管理接口可能需要令牌（服务端设置 ADMIN_TOKEN 后），令牌存在 localStorage

const TOKEN_KEY = 'zhifu-admin-token';

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
  const t = getAdminToken();
  return t ? { ...extra, 'x-admin-token': t } : extra;
}

// 发起对话并流式接收事件
export async function chatStream({ sessionId, message, confirm = false, strategy, onEvent }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, confirm, strategy }),
  });
  if (!res.ok) throw new Error('请求失败 ' + res.status);

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
