// 管理接口鉴权
//
// 为什么要做：/api/admin/*、/api/tools 能改路由策略、直接执行退货退款、看到调用日志；
// 之前完全裸奔，只适合本地演示。这里用最小成本补上令牌校验：
//   - 设置 ADMIN_TOKEN 后强制校验 x-admin-token（或 Authorization: Bearer）
//   - 未设置时放行，启动日志会给出告警，保证开箱即用与自动化测试不受影响
//
// 为什么不用 JWT / OAuth：管理接口是内部后台，单个静态令牌足够；
// 真正的多用户权限体系需要接入公司 SSO，不在这个项目范围内。
import crypto from 'node:crypto';
import { audit } from '../observability/audit.js';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN || '';
  // 未配置令牌：开发/测试环境放行（启动日志有告警），生产环境直接禁用管理接口。
  // 否则部署时忘配一个环境变量，就等于把会话全文和写操作裸奔到公网。
  if (!token) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: '服务未配置 ADMIN_TOKEN，管理接口已禁用' });
    }
    return next();
  }

  const provided = req.get('x-admin-token')
    || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  if (!provided || !safeEqual(provided, token)) {
    // 鉴权失败要留痕：连续 401 往往是扫描或配置错误
    audit({ actor: req.ip || 'unknown', action: 'auth.denied', target: req.path, result: '401' });
    return res.status(401).json({ error: '需要管理令牌', needToken: true });
  }
  return next();
}

// 入站 webhook 走 HMAC 验签，不放行也不需要管理令牌
export function adminOrWebhook(req, res, next) {
  if (req.path === '/events' && req.method === 'POST') return next();
  return requireAdmin(req, res, next);
}
