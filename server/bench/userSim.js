#!/usr/bin/env node
// 用户模拟器：按真实用户口吻提问 → Agent 回答/调工具 → 记录耗时与结果
//
// 用途：
//   1. 短测：定位功能与延迟问题（--minutes 5）
//   2. 长稳：连续跑 10 小时，观察错误率与响应时间是否漂移（--hours 10）
//
// 设计要点：
//   - 问题按模板随机组合（礼貌前缀、后缀、错别字、缺订单号），避免命中缓存或固定路径
//   - 写操作走完整两轮：第一次触发确认，第二次 confirm=true
//   - 每条记录落 JSONL，随时可中断，报告由 JSONL 生成，不依赖进程状态
//   - 每个会话 id 唯一，避免上下文互相污染；长时间跑时按 --session-pool 复用，控制内存
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// —— 语料：贴近真实用户的说法 ——
const PREFIX = ['', '你好，', '请问一下，', '那个，', '麻烦问下，', '在吗，'];
const SUFFIX = ['', '？', '，谢谢', '，急', '，在线等'];

const FAQ = [
  '退货运费谁出', '退款多久到账', '七天无理由怎么算', '保修期多久', '发票怎么开',
  '价保怎么申请', '大促期间退款会变慢吗', '物流一直不更新怎么办', '内衣可以退吗',
  '手机激活了还能退吗', '大家电安装收费吗', '维修要多久', '改地址可以吗',
];
const ORDER = ['查一下订单 SO20260001', '帮我看看 SO20260003 的状态', '订单 SO20260001 多少钱', '订单 SO20260002 什么状态'];
const LOGISTICS = ['帮我看看 SO20260002 的物流', 'SO20260001 快递到哪了', '查下物流 SO20260003', '订单 SO20260002 到哪了'];
const RETURN = ['我要退货，订单号 SO20260001', '帮我退货 SO20260001', '这个不想要了，帮我退一下 SO20260001'];
const REFUND = ['帮我退款，订单 SO20260003', 'SO20260003 申请退款', '帮我退钱，订单 SO20260003'];
const NONBUSINESS = ['你是谁', '你能帮我做什么', '今天几号', '推荐一本书', '今天天气怎么样', '1+1等于几'];
const OFFTOPIC = ['今天股市怎么样', '帮我写一首诗', '苹果手机怎么截屏'];
const CRM = ['帮我查一下客户档案 13800001234', '查客户资料 13900005678'];

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

// 可复现的伪随机（mulberry32），便于复现某次异常
function makeRand(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decorate(text, rand) {
  return `${pick(PREFIX, rand)}${text}${pick(SUFFIX, rand)}`;
}

// 生成一轮场景：{ scenario, turns:[{message, confirm}], expect }
export function nextScenario(rand, { crm = false } = {}) {
  const r = rand();
  if (r < 0.3) {
    return { scenario: 'faq', turns: [{ message: decorate(pick(FAQ, rand), rand) }], expect: { mode: 'rag' } };
  }
  if (r < 0.45) {
    return { scenario: 'order', turns: [{ message: decorate(pick(ORDER, rand), rand) }], expect: { tool: 'queryOrder' } };
  }
  if (r < 0.57) {
    return { scenario: 'logistics', turns: [{ message: decorate(pick(LOGISTICS, rand), rand) }], expect: { tool: 'trackLogistics' } };
  }
  if (r < 0.68) {
    return {
      scenario: 'return',
      turns: [{ message: decorate(pick(RETURN, rand), rand) }, { message: '确认', confirm: true }],
      expect: { tool: 'createReturn' },
    };
  }
  if (r < 0.75) {
    return {
      scenario: 'refund',
      turns: [{ message: decorate(pick(REFUND, rand), rand) }, { message: '确认', confirm: true }],
      expect: { tool: 'applyRefund' },
    };
  }
  if (crm && r < 0.83) {
    return { scenario: 'crm', turns: [{ message: decorate(pick(CRM, rand), rand) }], expect: { tool: 'crmCustomerProfile' } };
  }
  if (r < 0.9) {
    return { scenario: 'nonbusiness', turns: [{ message: decorate(pick(NONBUSINESS, rand), rand) }], expect: { mode: 'general' } };
  }
  return { scenario: 'offtopic', turns: [{ message: decorate(pick(OFFTOPIC, rand), rand) }], expect: { mode: 'general' } };
}

// —— SSE 客户端：逐事件解析，记录首字时间 ——
async function streamChat({ port, sessionId, message, confirm }) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, confirm }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let text = '';
  let ttftMs = null;
  const events = [];

  const handle = (raw) => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '{}') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      events.push(ev);
      if (ev.type === 'token') {
        if (ttftMs === null) ttftMs = Number(process.hrtime.bigint() - t0) / 1e6;
        text += ev.text;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      handle(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handle(buf);

  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { events, text, ttftMs, latencyMs };
}

// —— 判定：只做确定性检查，主观质量交给 DeepSeek 评委 ——
function evaluate(scenario, expect, runs) {
  const issues = [];
  const last = runs[runs.length - 1];
  const allTools = runs.flatMap((r) => r.events.filter((e) => e.type === 'tool').map((e) => e.name));
  const modes = runs.map((r) => r.events.find((e) => e.type === 'meta')?.mode).filter(Boolean);

  if (expect.tool) {
    if (!allTools.includes(expect.tool)) issues.push(`未调用预期工具 ${expect.tool}（实际 ${allTools.join(',') || '无'}）`);
    const toolEv = runs.flatMap((r) => r.events.filter((e) => e.type === 'tool')).find((e) => e.name === expect.tool);
    if (toolEv && toolEv.result && toolEv.result.ok === false) issues.push(`工具返回失败：${toolEv.result.error || ''}`);
  }
  if (expect.mode) {
    const mode = modes[modes.length - 1];
    if (mode !== expect.mode) issues.push(`模式应为 ${expect.mode}，实际 ${mode || '无'}`);
  }
  if (scenario === 'return' || scenario === 'refund') {
    const hasConfirm = runs[0].events.some((e) => e.type === 'confirm_request');
    if (!hasConfirm) issues.push('写操作未触发二次确认');
  }
  if (scenario === 'nonbusiness' || scenario === 'offtopic') {
    const hitPolicy = last.text.includes('根据《');
    if (hitPolicy) issues.push('无关问题硬套了知识库政策');
  }
  if (!last.text || last.text.trim().length < 4) issues.push('回答为空或过短');
  if (last.text.includes('不在我的服务范围')) issues.push('出现硬拒话术');

  return { ok: issues.length === 0, issues };
}

/**
 * 运行一次模拟（可长可短）
 * @param {object} opts
 * @param {number} opts.port
 * @param {number} opts.durationMs      总时长
 * @param {number} opts.gapMs           每轮之间间隔（长稳用 2000 更贴近真实）
 * @param {number} opts.sessionPool     复用多少个会话 id（0=每条新建）
 * @param {string} opts.outFile         JSONL 输出
 * @param {boolean} opts.crm            是否包含外部 CRM 场景
 * @param {(p:object)=>void} opts.onProgress
 */
export async function runSimulation({
  port = 4000,
  durationMs = 3 * 60 * 1000,
  gapMs = 0,
  sessionPool = 0,
  outFile,
  crm = true,
  seed = Date.now(),
  onProgress,
} = {}) {
  const rand = makeRand(seed);
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  const stream = fs.createWriteStream(outFile, { flags: 'a' });
  const counters = { total: 0, ok: 0, fail: 0 };
  const issueCount = new Map();
  const pool = [];

  const write = (rec) => new Promise((resolve) => {
    if (stream.write(`${JSON.stringify(rec)}\n`)) resolve();
    else stream.once('drain', resolve);
  });

  while (Date.now() < deadline) {
    const sc = nextScenario(rand, { crm });
    let sid;
    if (sessionPool > 0) {
      if (pool.length < sessionPool) {
        sid = `sim-${pool.length}-${seed}`;
        pool.push(sid);
      } else {
        sid = pick(pool, rand);
      }
    } else {
      sid = `sim-${counters.total}-${seed}-${Math.floor(rand() * 1e6)}`;
    }

    const t0 = Date.now();
    const runs = [];
    let error = null;
    try {
      const first = await streamChat({ port, sessionId: sid, message: sc.turns[0].message, confirm: false });
      runs.push(first);
      if (sc.turns[1]) {
        const second = await streamChat({ port, sessionId: sid, message: sc.turns[1].message, confirm: true });
        runs.push(second);
      }
    } catch (err) {
      error = err.message;
    }

    const totalMs = Date.now() - t0;
    const ttfts = runs.map((r) => r.ttftMs).filter((v) => typeof v === 'number');
    const ttftMs = ttfts.length ? ttfts[0] : null;
    const last = runs[runs.length - 1];
    const verdict = error
      ? { ok: false, issues: [`请求失败：${error}`] }
      : evaluate(sc.scenario, sc.expect, runs);

    for (const issue of verdict.issues) issueCount.set(issue, (issueCount.get(issue) || 0) + 1);

    counters.total++;
    if (verdict.ok) counters.ok++; else counters.fail++;

    await write({
      id: counters.total,
      ts: new Date().toISOString(),
      scenario: sc.scenario,
      question: sc.turns.map((t) => t.message).join(' → '),
      answer: last ? (last.text || '').slice(0, 500) : '',
      mode: last?.events.find((e) => e.type === 'meta')?.mode || null,
      intent: last?.events.find((e) => e.type === 'meta')?.intent || null,
      model: last?.events.find((e) => e.type === 'meta')?.model?.id || null,
      tools: runs.flatMap((r) => r.events.filter((e) => e.type === 'tool').map((e) => ({
        name: e.name,
        ok: e.result?.ok !== false,
        result: e.result,
      }))),
      citations: (last?.events.find((e) => e.type === 'retrieval')?.snippets || []).map((s) => ({
        title: s.title, section: s.section, text: (s.text || '').slice(0, 200),
      })),
      ttftMs,
      latencyMs: totalMs,
      ok: verdict.ok,
      issues: verdict.issues,
    });

    if (onProgress && counters.total % 20 === 0) {
      onProgress({
        ...counters,
        elapsedMs: Date.now() - startedAt,
        topIssues: [...issueCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      });
    }

    if (gapMs > 0) {
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(gapMs, remain)));
    }
  }

  await new Promise((resolve) => stream.end(resolve));
  return {
    startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    ...counters,
    topIssues: [...issueCount.entries()].sort((a, b) => b[1] - a[1]),
    outFile,
  };
}

// —— CLI ——
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(arg('port', 4000));
  const hours = Number(arg('hours', 0));
  const minutes = Number(arg('minutes', hours ? 0 : 3));
  const gapMs = Number(arg('gap', hours ? 2000 : 0));
  const sessionPool = Number(arg('session-pool', hours ? 200 : 0));
  const crm = arg('crm', '1') !== '0';
  const seed = Number(arg('seed', Date.now()));
  const out = path.resolve(ROOT, String(arg('out', `data/soak/run-${new Date().toISOString().slice(0, 10)}.jsonl`)));

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const durationMs = hours ? hours * 3600 * 1000 : minutes * 60 * 1000;

  console.log(`[sim] 目标 http://127.0.0.1:${port}，时长 ${(durationMs / 3600000).toFixed(2)}h，间隔 ${gapMs}ms，输出 ${out}`);
  const summary = await runSimulation({
    port, durationMs, gapMs, sessionPool, outFile: out, crm, seed,
    onProgress: (p) => {
      const rate = ((p.ok / Math.max(1, p.total)) * 100).toFixed(1);
      const issues = p.topIssues.map(([k, v]) => `${k}(${v})`).join('；');
      console.log(`[sim] ${p.total} 轮 成功率 ${rate}%  ${(p.elapsedMs / 60000).toFixed(1)}min  ${issues}`);
    },
  });
  console.log(`[sim] 结束：${summary.total} 轮，成功 ${summary.ok}，失败 ${summary.fail}`);
  fs.writeFileSync(path.join(path.dirname(out), 'last-summary.json'), JSON.stringify(summary, null, 2));
}
