// 集成层入口：加载连接器 → 注册成工具 → 加载事件订阅
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnectors, buildTools, connectorInfo } from './connectors.js';
import { loadSubscribers, listEvents } from './events.js';
import { registerTool, removeToolsBySource } from '../tools/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '../..');
export const INTEGRATIONS_DIR = path.resolve(process.env.INTEGRATIONS_DIR || path.join(SERVER_ROOT, 'integrations'));

let connectors = [];
let initialized = false;

export function initIntegrations({ dir = INTEGRATIONS_DIR, silent = false } = {}) {
  connectors = loadConnectors(dir);

  // 先清掉上一次注册的外部工具，避免热重载后残留
  for (const c of connectors) removeToolsBySource(`integration:${c.id}`);

  for (const def of buildTools(connectors.filter((c) => c.enabled))) {
    registerTool(def);
  }
  loadSubscribers(dir);
  initialized = true;

  if (!silent) {
    const enabled = connectors.filter((c) => c.enabled);
    const tools = enabled.reduce((a, c) => a + (c.tools || []).length, 0);
    if (connectors.length) {
      console.log(`[integrations] 连接器 ${connectors.length} 个（启用 ${enabled.length}），注册外部工具 ${tools} 个`);
    }
  }
  return connectors;
}

export function ensureIntegrations() {
  if (!initialized) initIntegrations();
  return connectors;
}

export function getConnectors() {
  return connectors;
}

export function integrationsInfo() {
  return {
    dir: INTEGRATIONS_DIR,
    connectors: connectorInfo(connectors),
    events: listEvents(20),
  };
}
