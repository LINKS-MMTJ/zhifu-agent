// 服务启动入口：配置校验 → 持久化与审计初始化 → 监听 → 优雅关闭
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { router } from './router/modelRouter.js';
import { kbStore, knowledgeInfo } from './rag/knowledge.js';
import {
  startSessionSweeper, stopSessionSweeper, restoreSessions, flushSessions, storeStats,
} from './store/sessions.js';
import { initIntegrations } from './integrations/index.js';
import { listTools } from './tools/registry.js';
import { validateEnv } from './config/env.js';
import { initPersistence } from './store/persistence.js';
import { initAudit, flushAudit, auditEnabled } from './observability/audit.js';
import { logInfo, logWarn, logError } from './observability/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');

const PORT = process.env.PORT || 4000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15_000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(SERVER_ROOT, 'data'));

// —— 1. 配置校验：宁可起不来，也不要带着错误配置运行 ——
const { errors, warnings } = validateEnv();
for (const w of warnings) logWarn('config.warning', { message: w });
if (errors.length) {
  for (const e of errors) logError('config.invalid', { message: e });
  console.error(`[zhifu-agent] 配置错误 ${errors.length} 项，拒绝启动`);
  process.exit(1);
}

// —— 2. 持久化与审计：重启不丢会话，关键操作可追溯 ——
// 长稳/压力测试实例（PERSIST=0）不落盘，避免快照写入干扰延迟统计
if (process.env.PERSIST !== '0') {
  initPersistence({ dir: DATA_DIR });
  initAudit({ dir: path.join(DATA_DIR, 'audit') });
}
const restored = await restoreSessions();

// —— 3. 连接器与 HTTP 服务 ——
initIntegrations();
const app = createApp();
const server = app.listen(PORT, () => {
  const kb = knowledgeInfo();
  const models = router.list();
  const enabled = models.filter((m) => m.enabled);
  logInfo('server.started', { port: Number(PORT), models: models.length, enabledModels: enabled.length });
  console.log(`[zhifu-agent] 后端已启动: http://localhost:${PORT}`);
  console.log(`[zhifu-agent] 模型注册 ${models.length} 个（启用 ${enabled.length}），知识块 ${kbStore.size()} 条`);
  const pending = models.filter((m) => !m.enabled && m.adapter !== 'mock');
  if (pending.length) {
    console.log(`[zhifu-agent] 待配置 Key：${pending.map((m) => m.name).join('、')}（填入 .env 后重启即可启用）`);
  }
  const offline = models.filter((m) => !m.enabled && m.adapter === 'mock');
  if (offline.length) {
    console.log(`[zhifu-agent] 离线 Mock 模型 ${offline.length} 个已退出路由（已有真实模型可用，Mock 仅作无 Key 时的兜底）`);
  }
  console.log(
    kb.mode === 'index'
      ? `[zhifu-agent] 知识库：${kb.docs} 篇文档 → ${kb.chunks} 个切块（索引 ${(kb.indexBytes / 1024 / 1024).toFixed(1)}MB，构建于 ${kb.builtAt}）`
      : '[zhifu-agent] 知识库：未找到文档索引，使用内置种子文档（运行 npm run ingest 接入真实文档）'
  );
  console.log(`[zhifu-agent] 并发上限 ${process.env.MAX_CONCURRENT || 64}，会话上限 ${process.env.MAX_SESSIONS || 5000}`);
  console.log(`[zhifu-agent] 可用工具 ${listTools().length} 个（内置 + 外部集成）`);
  console.log(
    `[zhifu-agent] 会话恢复 ${restored.restored} 个（过期丢弃 ${restored.skipped}），数据目录 ${DATA_DIR}`
  );
  console.log(`[zhifu-agent] 审计日志 ${auditEnabled() ? '已开启' : '未开启'}，配额 ${process.env.DAILY_COST_LIMIT || '不限'}`);
  if (!process.env.ADMIN_TOKEN) {
    console.warn('[auth] 未设置 ADMIN_TOKEN：管理/工具接口无鉴权，仅适合内网或本地演示');
  }
});

// 后台清理空闲会话（7×24 运行必需）
startSessionSweeper();

// —— 优雅关闭：容器编排滚动更新/缩容时必须能干净退出 ——
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[zhifu-agent] 收到 ${signal}，停止接收新请求，等待在途请求完成…`);
  stopSessionSweeper();

  server.close(async () => {
    await Promise.all([flushSessions(), flushAudit()]).catch((err) => {
      console.warn(`[zhifu-agent] 关闭前落盘失败：${err.message}`);
    });
    console.log(`[zhifu-agent] 已优雅退出（会话 ${storeStats().sessions} 个已落盘）`);
    process.exit(0);
  });

  // 兜底：超时强制退出，避免被长连接（SSE）拖住
  const timer = setTimeout(async () => {
    console.warn('[zhifu-agent] 关闭超时，强制退出');
    await flushSessions().catch(() => {});
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (timer.unref) timer.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  // 不让单个未捕获的异步错误打垮整个进程
  logError('process.unhandled_rejection', { error: err?.message || String(err) });
});
