#!/usr/bin/env node
// 浸泡报告生成器：从 JSONL 明细生成 Markdown 报告
//
// 只用明细文件做输入，进程挂了也能出报告；这也是长测必须"边跑边落盘"的原因。
// 统计口径：
//   - 响应时间：首字（TTFT）与整轮（从发请求到 done）
//   - 分位：P50 / P90 / P95 / P99 / max
//   - 漂移：按小时分桶看 P95 是否随运行时间上升
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const soakDir = path.resolve(ROOT, 'data/soak');
const inArg = arg('in', null);
let input;
if (inArg) {
  input = path.resolve(ROOT, String(inArg));
} else {
  const files = fs.existsSync(soakDir)
    ? fs.readdirSync(soakDir).filter((f) => /^run-.*\.jsonl$/.test(f)).sort()
    : [];
  if (!files.length) {
    console.error('[report] data/soak 下没有 run-*.jsonl，请先运行 npm run soak');
    process.exit(1);
  }
  input = path.join(soakDir, files[files.length - 1]);
}
const output = path.resolve(ROOT, String(arg('out', 'data/soak/report.md')));

if (!fs.existsSync(input)) {
  console.error(`[report] 找不到明细文件：${input}`);
  process.exit(1);
}

const records = fs.readFileSync(input, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter(Boolean);

if (!records.length) {
  console.error('[report] 明细为空');
  process.exit(1);
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(s.length * p));
  return s[idx];
};
const f = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '—');

const ttfts = records.map((r) => r.ttftMs).filter((v) => typeof v === 'number');
const latencies = records.map((r) => r.latencyMs).filter((v) => typeof v === 'number');
const okCount = records.filter((r) => r.ok).length;

const byScenario = new Map();
for (const r of records) {
  const s = byScenario.get(r.scenario) || { count: 0, ok: 0, lat: [], ttft: [] };
  s.count++;
  if (r.ok) s.ok++;
  if (typeof r.latencyMs === 'number') s.lat.push(r.latencyMs);
  if (typeof r.ttftMs === 'number') s.ttft.push(r.ttftMs);
  byScenario.set(r.scenario, s);
}

const issueCount = new Map();
for (const r of records) {
  for (const issue of r.issues || []) issueCount.set(issue, (issueCount.get(issue) || 0) + 1);
}

// 按小时分桶，观察延迟漂移
const hourly = new Map();
for (const r of records) {
  const d = new Date(r.ts);
  if (Number.isNaN(d.getTime())) continue;
  const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
  const b = hourly.get(key) || { count: 0, ok: 0, lat: [] };
  b.count++;
  if (r.ok) b.ok++;
  if (typeof r.latencyMs === 'number') b.lat.push(r.latencyMs);
  hourly.set(key, b);
}

const firstTs = records[0].ts;
const lastTs = records[records.length - 1].ts;
const wallMs = new Date(lastTs) - new Date(firstTs);

// 有效对话时长：剔除超过 5 分钟的静默（机器休眠/进程被暂停/人工中断），
// 否则"墙钟跨度"会把休眠时间也算成运行时间，对外汇报会失真
const SILENCE_MS = 5 * 60 * 1000;
let activeMs = 0;
const silences = [];
for (let i = 1; i < records.length; i++) {
  const delta = new Date(records[i].ts) - new Date(records[i - 1].ts);
  if (!Number.isFinite(delta) || delta < 0) continue;
  if (delta > SILENCE_MS) silences.push({ from: records[i - 1].ts, to: records[i].ts, ms: delta });
  else activeMs += delta;
}
const throughput = activeMs > 0 ? (records.length / (activeMs / 60000)) : 0;

// 服务端当前指标（可选，服务在跑时才有）
let serverMetrics = null;
const port = Number(arg('port', 0));
if (port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/metrics`);
    if (res.ok) serverMetrics = await res.json();
  } catch {
    // 服务已停，报告照出
  }
}

// DeepSeek 评分（若已跑过评委）
let judge = null;
const judgeDir = path.dirname(input);
const judgeFiles = fs.readdirSync(judgeDir).filter((f) => f.startsWith('judge-') && f.endsWith('.json')).sort();
if (judgeFiles.length) {
  try {
    judge = JSON.parse(fs.readFileSync(path.join(judgeDir, judgeFiles[judgeFiles.length - 1]), 'utf8'));
  } catch {
    judge = null;
  }
}

const lines = [];
lines.push('# Agent 用户模拟与长稳测试报告');
lines.push('');
lines.push(`- 明细文件：\`${path.relative(ROOT, input).split(path.sep).join('/')}\``);
lines.push(`- 首条记录：${firstTs}`);
lines.push(`- 末条记录：${lastTs}`);
lines.push(`- 墙钟跨度：**${(wallMs / 3600000).toFixed(2)} 小时**`);
lines.push(`- 有效对话时长：**${(activeMs / 3600000).toFixed(2)} 小时**（${records.length} 轮，约 ${f(throughput, 1)} 轮/分钟）`);
if (silences.length) {
  const totalSilence = silences.reduce((s, x) => s + x.ms, 0);
  lines.push(`- 静默时段：${silences.length} 段，合计 ${(totalSilence / 3600000).toFixed(2)} 小时（机器休眠/进程暂停，已从有效时长中剔除）`);
  for (const s of silences) {
    lines.push(`  - ${s.from} → ${s.to}（${(s.ms / 3600000).toFixed(2)}h）`);
  }
}
lines.push(`- 成功率：**${((okCount / records.length) * 100).toFixed(2)}%**（${okCount}/${records.length}）`);
lines.push('');

lines.push('## 一、响应时间');
lines.push('');
lines.push('| 指标 | P50 | P90 | P95 | P99 | 最大 | 样本 |');
lines.push('|---|---|---|---|---|---|---|');
lines.push(`| 首字延迟 TTFT (ms) | ${f(pct(ttfts, 0.5))} | ${f(pct(ttfts, 0.9))} | ${f(pct(ttfts, 0.95))} | ${f(pct(ttfts, 0.99))} | ${f(ttfts.length ? Math.max(...ttfts) : 0)} | ${ttfts.length} |`);
lines.push(`| 整轮耗时 (ms) | ${f(pct(latencies, 0.5))} | ${f(pct(latencies, 0.9))} | ${f(pct(latencies, 0.95))} | ${f(pct(latencies, 0.99))} | ${f(latencies.length ? Math.max(...latencies) : 0)} | ${latencies.length} |`);
lines.push('');
lines.push('> 说明：整轮耗时包含多轮确认（退货/退款会发两次请求）。离线 Mock 模式的耗时主要来自模拟打字延迟；接入真实模型后，耗时以真实网络往返与推理时间为准。');
lines.push('');

lines.push('### 按场景');
lines.push('');
lines.push('| 场景 | 轮数 | 成功率 | 整轮 P50 | 整轮 P95 | 首字 P50 |');
lines.push('|---|---|---|---|---|---|');
for (const [name, s] of [...byScenario.entries()].sort((a, b) => b[1].count - a[1].count)) {
  lines.push(`| ${name} | ${s.count} | ${((s.ok / s.count) * 100).toFixed(1)}% | ${f(pct(s.lat, 0.5))} | ${f(pct(s.lat, 0.95))} | ${f(pct(s.ttft, 0.5))} |`);
}
lines.push('');

lines.push('### 按小时（观察是否随运行时间劣化）');
lines.push('');
lines.push('| 时段 | 轮数 | 成功率 | P50 | P95 |');
lines.push('|---|---|---|---|---|');
for (const [hour, b] of [...hourly.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  lines.push(`| ${hour} | ${b.count} | ${((b.ok / b.count) * 100).toFixed(1)}% | ${f(pct(b.lat, 0.5))} | ${f(pct(b.lat, 0.95))} |`);
}
lines.push('');

lines.push('## 二、问题清单');
lines.push('');
if (!issueCount.size) {
  lines.push('本次运行没有触发判定失败。');
} else {
  lines.push('| 问题 | 次数 | 占比 |');
  lines.push('|---|---|---|');
  for (const [issue, count] of [...issueCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${issue.replace(/\|/g, '\\|')} | ${count} | ${((count / records.length) * 100).toFixed(2)}% |`);
  }
}
lines.push('');

if (serverMetrics) {
  lines.push('## 三、服务端指标（报告生成时）');
  lines.push('');
  lines.push(`- 进程运行：${f((serverMetrics.uptimeSec || 0) / 3600, 2)} 小时`);
  lines.push(`- 内存：RSS ${f(serverMetrics.memory?.rssMB || 0, 1)} MB，heap ${f(serverMetrics.memory?.heapUsedMB || 0, 1)} MB`);
  lines.push(`- 事件循环延迟：mean ${f(serverMetrics.eventLoopDelayMs?.mean || 0, 1)} ms，P99 ${f(serverMetrics.eventLoopDelayMs?.p99 || 0, 1)} ms`);
  lines.push(`- 请求：总 ${serverMetrics.counters?.total ?? '—'}，成功 ${serverMetrics.counters?.ok ?? '—'}，失败 ${serverMetrics.counters?.error ?? '—'}，限流 ${serverMetrics.counters?.rateLimited ?? '—'}`);
  lines.push(`- 服务端延迟：P50 ${serverMetrics.latencyMs?.p50 ?? '—'} ms，P95 ${serverMetrics.latencyMs?.p95 ?? '—'} ms，P99 ${serverMetrics.latencyMs?.p99 ?? '—'} ms`);
  lines.push(`- 会话：${serverMetrics.store?.sessions ?? '—'}（持久化 ${serverMetrics.store?.persisted ? '已开启' : '关闭'}）`);
  lines.push(`- 今日成本：¥${f(serverMetrics.quota?.spent || 0, 6)} / 上限 ${serverMetrics.quota?.limit || '不限'}`);
  lines.push('');
}

// 工程问题与修复记录：长测期间踩到的坑写在这里，报告一并带出
const incidentsFile = path.join(soakDir, 'incidents.md');
if (fs.existsSync(incidentsFile)) {
  lines.push('## 四、遇到的问题与解决');
  lines.push('');
  lines.push(fs.readFileSync(incidentsFile, 'utf8').trim());
  lines.push('');
}

if (judge) {
  lines.push('## 五、DeepSeek 评审');
  lines.push('');
  lines.push(`- 评审样本：${judge.sampled} 条（模型 ${judge.model}）`);
  lines.push(`- 平均分：${judge.average}/5`);
  lines.push('');
  lines.push('| 维度 | 平均分 |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(judge.dimensions || {})) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  const lows = (judge.items || []).filter((i) => i.score <= 3).slice(0, 10);
  if (lows.length) {
    lines.push('### 低分样本');
    lines.push('');
    for (const it of lows) {
      lines.push(`- **${it.question}** → ${it.score}/5：${it.reason}`);
    }
    lines.push('');
  }
} else {
  lines.push('## 五、DeepSeek 评审');
  lines.push('');
  lines.push('本次报告未包含 DeepSeek 评分：需要配置 `DEEPSEEK_API_KEY` 后执行 `npm run judge -- --in <明细>`。');
  lines.push('');
}

lines.push('## 六、结论与待办');
lines.push('');
lines.push(`- 本轮共 ${records.length} 轮，成功率 ${((okCount / records.length) * 100).toFixed(2)}%`);
lines.push(`- 整轮 P95 ${f(pct(latencies, 0.95))} ms，首字 P95 ${f(pct(ttfts, 0.95))} ms`);
if (issueCount.size) {
  lines.push(`- 主要问题：${[...issueCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}（${v} 次）`).join('；')}`);
}
lines.push('- 待办：接真实模型后重跑，重新标定并发与超时；补充 DeepSeek 评审并据此调整提示词与检索阈值');
lines.push('');

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`[report] 已生成：${output}`);
console.log(`[report] ${records.length} 轮，成功率 ${((okCount / records.length) * 100).toFixed(2)}%，整轮 P95 ${f(pct(latencies, 0.95))}ms`);
