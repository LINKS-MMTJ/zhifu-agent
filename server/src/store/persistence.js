// 轻量持久化：只做"原子写 JSON / 读 JSON"两件事，具体存什么由调用方决定
//
// 为什么不直接上数据库：这个项目的状态量（会话快照、配额计数）很小，
// 一个原子写的 JSON 文件足够，且没有额外运维成本。
// 需要多副本共享状态时，把这一层换成 Redis / PostgreSQL 即可，
// 上层（sessions.js）不用改。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

let dataDir = null;

export function initPersistence({ dir } = {}) {
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  dataDir = dir;
  return true;
}

export function persistenceEnabled() {
  return Boolean(dataDir);
}

export function dataPath(name) {
  return dataDir ? path.join(dataDir, name) : null;
}

export async function readJSON(name, fallback = null) {
  const p = dataPath(name);
  if (!p || !fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (err) {
    console.warn(`[persistence] 读取 ${name} 失败，忽略：${err.message}`);
    return fallback;
  }
}

// 先写临时文件再 rename：进程崩溃不会留下半截 JSON
export async function writeJSONAtomic(name, obj) {
  const p = dataPath(name);
  if (!p) return false;
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fsp.rename(tmp, p);
  return true;
}

export function dataDirInfo() {
  return dataDir;
}

export function resetPersistenceForTest() {
  dataDir = null;
}
