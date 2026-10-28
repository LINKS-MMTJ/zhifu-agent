// 外部系统集成的签名工具：webhook 双向都用 HMAC-SHA256
// 入站：第三方推送事件时签名，服务端验签，防止伪造
// 出站：服务端推送事件时签名，第三方验签
import crypto from 'node:crypto';

export function sign(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');
}

export function verify(secret, payload, signature) {
  if (!secret || !signature) return false;
  const expected = sign(secret, payload);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature).replace(/^sha256=/, ''), 'utf8');
  if (a.length !== b.length) return false;
  // 定长比较，避免时序侧信道
  return crypto.timingSafeEqual(a, b);
}
