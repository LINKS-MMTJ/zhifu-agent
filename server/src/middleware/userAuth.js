// 终端用户身份：轻量访客令牌（HMAC 签名，无外部依赖）
//
// 为什么需要：原来客户侧只有 sessionId，任何人拿到它就能续聊、甚至替别人确认写操作。
// 这里补一层最小可用的身份：
//   - POST /api/auth/guest 签发 24h 访客令牌（sub=userId）
//   - USER_AUTH=enforce 时，对话与会话接口必须带 Authorization: Bearer <token>
//   - 未开启时行为与之前完全一致，本地演示与自动化测试不受影响
//
// 接企业 SSO 时，把这里换成 OIDC 的 id_token 校验即可，调用方仍是同一个请求头。
import crypto from 'node:crypto';

const TOKEN_TTL_MS = Number(process.env.USER_TOKEN_TTL_MS || 24 * 3600 * 1000);

export function userAuthEnabled() {
  return process.env.USER_AUTH === 'enforce';
}

function secret() {
  return process.env.USER_TOKEN_SECRET || '';
}

function sign(bodyB64) {
  const s = secret();
  if (!s) throw new Error('USER_AUTH=enforce 时必须配置 USER_TOKEN_SECRET');
  return crypto.createHmac('sha256', s).update(bodyB64).digest('base64url');
}

/**
 * 签发访客令牌
 * @returns {{token:string,userId:string,expiresAt:number}}
 */
export function issueGuestToken({ userId, ttlMs = TOKEN_TTL_MS } = {}) {
  const sub = userId || `g-${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const payload = { sub, iat: now, exp: now + ttlMs };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(body)}`, userId: sub, expiresAt: payload.exp };
}

/**
 * 校验令牌；任何异常（签名缺失、被篡改、过期）都返回 null
 */
export function verifyUserToken(token) {
  const raw = String(token || '');
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;

  let expect;
  try {
    expect = sign(body);
  } catch {
    return null;
  }
  const a = Buffer.from(expect);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.sub || !payload?.exp) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

// Express 中间件：未开启鉴权时直接放行，开启后把 userId 挂到 req 上
export function userAuth(req, res, next) {
  if (!userAuthEnabled()) return next();
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const payload = token ? verifyUserToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: '需要用户令牌', needToken: true });
  }
  req.userId = payload.sub;
  return next();
}
