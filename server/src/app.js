// Express 应用装配：只负责路由与中间件，不负责监听
// 拆出来是为了让测试可以 import app 并在随机端口启动

import express from 'express';
import cors from 'cors';
import { runAgent } from './agent/orchestrator.js';
import { router } from './router/modelRouter.js';
import { getCallLogs, listSessions, costReport, storeStats, addMessage } from './store/sessions.js';
import { kbStore, knowledgeInfo } from './rag/knowledge.js';
import { saveAndIngest, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from './rag/upload.js';
import { getOrderDetail, createReturn, applyRefund } from './tools/ecommerce.js';
import { getTool, listTools } from './tools/registry.js';
import { ensureIntegrations, integrationsInfo } from './integrations/index.js';
import { verify } from './integrations/signature.js';
import { recordInbound, emitEvent } from './integrations/events.js';
import { beginRequest, endRequest, snapshot } from './observability/metrics.js';
import { traceMiddleware } from './observability/trace.js';
import { audit, queryAudit, auditEnabled } from './observability/audit.js';
import { logInfo, logError } from './observability/logger.js';
import { checkQuota, quotaState } from './guard/quota.js';
import { checkContent } from './guard/moderation.js';
import { concurrencyGuard, rateLimit, acquireSessionLock, lockStats } from './middleware/guards.js';
import { requireAdmin, adminOrWebhook } from './middleware/auth.js';

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15_000);
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 4000);
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// CORS：开发默认放开，生产必须显式配置允许的来源（未配置则不开启跨域）
const CORS_ORIGINS = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const isProd = process.env.NODE_ENV === 'production';

function formatSize(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // traceId 必须最先注入：后面的日志、审计、SSE 事件都要用到
  app.use(traceMiddleware);
  if (CORS_ORIGINS.length) app.use(cors({ origin: CORS_ORIGINS }));
  else if (!isProd) app.use(cors());
  // 基础安全响应头：不需要引入 helmet，三条就够挡住常见的 sniff/点击劫持
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // 保留 rawBody：入站 webhook 的 HMAC 必须对原始字节验签
  app.use(express.json({
    limit: '256kb',
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));

  // 访问日志：一条请求一行 JSON，含 traceId，便于与审计记录对齐
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const start = Date.now();
    res.on('finish', () => {
      logInfo('http.request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    return next();
  });

  // 外部系统连接器（未配置 baseUrl 的会保持禁用）
  ensureIntegrations();

  // —— 管理类接口统一鉴权 ——
  // 设置 ADMIN_TOKEN 后，改路由策略 / 直接调用写操作 / 看调用日志都需要令牌；
  // 未设置时放行并告警一次（本地演示与自动化测试不受影响）。
  // 入站 webhook 例外：它用 HMAC 验签，不依赖管理令牌。
  app.use('/api/admin', requireAdmin);
  app.use('/api/tools', requireAdmin);
  app.use('/api/integrations', adminOrWebhook);

  // —— 存活探针（liveness）：进程还在就返回 200 ——
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'zhifu-agent', models: router.list().length });
  });

  // —— 就绪探针（readiness）：依赖是否可用 ——
  app.get('/api/ready', (req, res) => {
    const enabled = router.list().filter((m) => m.enabled);
    const models = enabled.filter((m) => m.healthy);
    const ready = models.length > 0 && kbStore.size() > 0;
    res.status(ready ? 200 : 503).json({
      ready,
      healthyModels: models.length,
      registeredModels: router.list().length,
      knowledgeChunks: kbStore.size(),
    });
  });

  // —— 对话（SSE 流式）——
  // 限流 → 并发上限 → 会话串行锁 → 流式输出（含心跳与客户端断开处理）
  app.post('/api/chat', rateLimit, concurrencyGuard, async (req, res) => {
    const { sessionId = 's-' + Date.now(), message = '', confirm = false, strategy } = req.body || {};

    // 入参校验：不合法直接 400，不进业务链路。
    // sessionId 会作为内存 Map 的 key，必须限长限字符集，否则可被用来撑爆会话表。
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: '消息不能为空' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `消息过长（上限 ${MAX_MESSAGE_CHARS} 字）` });
    }
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      return res.status(400).json({ error: 'sessionId 不合法（1-64 位字母、数字、下划线或短横线）' });
    }

    // 成本护栏：超过硬阈值直接拒绝；到软阈值自动把策略降级为"价格优先"
    const quota = checkQuota();
    if (!quota.allowed) {
      beginRequest();
      endRequest({ latencyMs: 0, ok: false, kind: 'quota' });
      audit({
        action: 'chat.blocked',
        target: sessionId,
        result: 'cost_limit',
        meta: { spent: quota.state.spent, limit: quota.state.limit },
      });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(`data: ${JSON.stringify({
        type: 'error',
        message: `今日成本额度已用完（${quota.state.spent} / ${quota.state.limit} 元），请明天再试或联系管理员`,
      })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }
    const effectiveStrategy = quota.degrade && !strategy ? 'price' : strategy;

    // 内容安全：违规输入不进入模型调用，也不写入会话
    const moderation = checkContent(message);
    if (!moderation.ok) {
      beginRequest();
      endRequest({ latencyMs: 0, ok: false, kind: 'moderation' });
      audit({ action: 'chat.blocked', target: sessionId, result: 'moderation' });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(`data: ${JSON.stringify({ type: 'error', message: '内容不符合平台规范，请调整后重试' })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }

    beginRequest();
    const t0 = Date.now();
    let counted = false;
    const finish = (ok = true, kind = 'ok') => {
      if (counted) return;
      counted = true;
      endRequest({ latencyMs: Date.now() - t0, ok, kind });
    };

    const release = await acquireSessionLock(sessionId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 让 nginx 知道不要缓冲
    if (res.flushHeaders) res.flushHeaders();

    // 心跳：长连接空闲时定期发注释行，防止代理/网关掐断
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    let clientClosed = false;
    req.on('close', () => { clientClosed = true; });

    const send = (ev) => {
      if (clientClosed || res.writableEnded) return false;
      return res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    send({ type: 'session', sessionId });

    try {
      for await (const ev of runAgent({ sessionId, message, confirm, strategy: effectiveStrategy })) {
        if (clientClosed) break; // 客户端走了就停止生成，释放资源
        send(ev);
      }
      finish(true);
    } catch {
      send({ type: 'error', message: '服务暂时不可用，请稍后重试' });
      finish(false, 'error');
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        res.write('event: done\ndata: {}\n\n');
        res.end();
      }
      release();
    }
  });

  // —— 管理：运行期指标 ——
  app.get('/api/admin/metrics', (req, res) => {
    res.json({ ...snapshot(), locks: lockStats(), quota: quotaState(), store: storeStats() });
  });

  // —— 管理：审计日志查询（按天归档，倒序）——
  app.get('/api/admin/audit', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 100) || 100, 500);
      const date = req.query.date ? String(req.query.date) : undefined;
      const data = await queryAudit({ limit, date });
      res.json({ enabled: auditEnabled(), ...data });
    } catch (err) {
      logError('audit.query_failed', { error: err.message });
      res.status(500).json({ error: '审计日志读取失败' });
    }
  });

  // —— 管理：模型注册表 ——
  app.get('/api/admin/models', (req, res) => {
    res.json({ strategy: router.strategy, models: router.list() });
  });

  // —— 管理：切换默认路由策略（带取值校验）——
  const STRATEGIES = new Set(['auto', 'price', 'quality', 'latency', 'balanced']);
  app.post('/api/admin/strategy', (req, res) => {
    const s = req.body?.strategy;
    if (!STRATEGIES.has(s)) {
      return res.status(400).json({ error: `strategy 必须是 ${[...STRATEGIES].join('/')} 之一` });
    }
    const before = router.strategy;
    router.setStrategy(s);
    // 改路由策略会影响成本，属于必须留痕的操作
    audit({
      actor: process.env.ADMIN_TOKEN ? 'admin' : 'anonymous',
      action: 'admin.strategy',
      target: s,
      result: 'ok',
      meta: { before, after: s },
    });
    res.json({ strategy: router.strategy });
  });

  // —— 管理：成本报表 / 调用日志 / 会话 ——
  app.get('/api/admin/cost', (req, res) => res.json(costReport()));
  app.get('/api/admin/logs', (req, res) => res.json(getCallLogs(50)));
  app.get('/api/admin/sessions', (req, res) => res.json(listSessions()));
  app.get('/api/admin/store', (req, res) => res.json(storeStats()));

  // —— 知识库：返回真实接入的文档清单与索引统计 ——
  app.get('/api/knowledge', (req, res) => {
    const info = knowledgeInfo();
    res.json({
      mode: info.mode,                 // index=真实文档索引 / seed=内置种子
      chunks: info.chunks,
      docs: info.sources.map((s) => ({
        id: s.path,
        title: s.title || s.path,
        content: `${s.format} · ${s.chunks} 个切块 · ${formatSize(s.size)}`,
        format: s.format,
        chunks: s.chunks,
        size: s.size,
      })),
      builtAt: info.builtAt,
      indexBytes: info.indexBytes,
      byFormat: info.byFormat,
      failures: info.failures,
      supportedFormats: UPLOAD_EXTENSIONS,
      maxUploadMb: Math.round(MAX_UPLOAD_BYTES / 1048576),
    });
  });

  // —— 知识库上传：浏览器直接传文件，落盘后增量入库并热加载 ——
  // 走 raw body（application/octet-stream），文件名放在 x-file-name，避免引入 multipart 依赖
  app.post(
    '/api/admin/kb/upload',
    express.raw({ type: () => true, limit: `${Math.round(MAX_UPLOAD_BYTES / 1048576) + 10}mb` }),
    async (req, res) => {
      const rawName = req.headers['x-file-name'];
      if (!rawName) return res.status(400).json({ error: '缺少 x-file-name 请求头' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: '请求体为空' });
      }
      try {
        const result = await saveAndIngest(String(rawName), req.body);
        audit({
          action: 'kb.upload',
          target: result.rel,
          result: result.duplicate ? 'duplicate' : 'ok',
          meta: { bytes: result.bytes, chunks: result.chunks, format: result.format },
        });
        return res.json({ ok: true, ...result });
      } catch (err) {
        const status = {
          UNSUPPORTED: 415, EMPTY: 400, TOO_LARGE: 413, PARSE_FAILED: 422,
        }[err.code] || 500;
        logError('kb.upload_failed', { file: String(rawName), error: err.message });
        return res.status(status).json({ error: err.message, code: err.code || 'UPLOAD_FAILED' });
      }
    }
  );

  // —— 工具目录：内置 + 外部集成，供其他软件发现 Agent 的能力 ——
  app.get('/api/tools', (req, res) => {
    res.json({ tools: listTools() });
  });

  // —— 工具调用：其他软件可直接调用，不必走对话 ——
  app.post('/api/tools/:name', async (req, res) => {
    const def = getTool(req.params.name);
    if (!def) return res.status(404).json({ error: `工具不存在：${req.params.name}` });

    const args = req.body?.args || req.body || {};
    const confirmed = req.body?.confirm === true;
    // 写操作强制确认：HTTP 调用方也必须显式传 confirm=true，防止误建单
    if (!def.readonly && !confirmed) {
      audit({
        actor: 'api',
        action: 'tool.call',
        target: def.name,
        result: 'denied_need_confirm',
        meta: { argKeys: Object.keys(args) },
      });
      return res.status(409).json({
        error: '写操作需要确认', needConfirm: true, tool: def.name, desc: def.desc, args,
      });
    }

    try {
      const result = await def.handler(args);
      emitEvent('tool.executed', {
        tool: def.name, readonly: def.readonly, source: def.source || 'builtin',
        ok: result?.ok !== false, via: 'api',
      });
      // 审计只记参数名，不记参数值：避免手机号、订单号等落到日志里
      audit({
        actor: 'api',
        action: 'tool.call',
        target: def.name,
        result: result?.ok === false ? 'failed' : 'ok',
        meta: { argKeys: Object.keys(args), readonly: def.readonly, source: def.source || 'builtin' },
      });
      return res.json({ tool: def.name, result });
    } catch (err) {
      audit({ actor: 'api', action: 'tool.call', target: def.name, result: 'error', meta: { error: err.message } });
      return res.status(502).json({ error: err.message });
    }
  });

  // —— 集成状态：连接器健康 + 最近事件 ——
  app.get('/api/integrations', (req, res) => {
    res.json(integrationsInfo());
  });

  // —— 入站 webhook：外部系统把事件推给 Agent ——
  app.post('/api/integrations/events', (req, res) => {
    const secret = process.env.INBOUND_WEBHOOK_SECRET || '';
    if (secret) {
      const sig = req.get('x-zhifu-signature') || req.get('x-signature') || '';
      const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
      if (!verify(secret, raw, sig)) {
        return res.status(401).json({ error: '签名校验失败' });
      }
    }

    const type = req.body?.type || 'unknown';
    const data = req.body?.data || {};
    const sessionId = req.body?.sessionId || null;
    recordInbound({ type, data, sessionId });

    // 带 sessionId 的事件写进会话：用户下次打开就能看到系统通知
    if (sessionId) {
      const brief = data && typeof data === 'object'
        ? Object.entries(data).slice(0, 3).map(([k, v]) => `${k}=${v}`).join('，')
        : String(data);
      addMessage(sessionId, {
        role: 'assistant',
        content: `【系统通知】${type}${brief ? `：${brief}` : ''}`,
      });
    }
    return res.json({ ok: true, type });
  });

  // —— 业务页面：供"一键跳转"后展示与办理 ——
  app.get('/api/biz/orders/:orderId', (req, res) => {
    const detail = getOrderDetail(req.params.orderId);
    if (!detail) return res.status(404).json({ error: '订单不存在' });
    res.json(detail);
  });

  app.post('/api/biz/orders/:orderId/return', (req, res) => {
    const result = createReturn({ orderId: req.params.orderId, reason: req.body?.reason || '用户申请退货' });
    if (!result.found) return res.status(404).json({ error: '订单不存在' });
    if (result.rejected) return res.status(409).json({ error: result.note });
    res.json(result);
  });

  app.post('/api/biz/orders/:orderId/refund', (req, res) => {
    const result = applyRefund({ orderId: req.params.orderId });
    if (!result.found) return res.status(404).json({ error: '订单不存在' });
    res.json(result);
  });

  // —— 兜底 404 ——
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

  return app;
}
