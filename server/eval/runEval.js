// 评测运行器：全量跑 Agent + 规则打分 + 生成报告 + 抽取非业务样本供 DeepSeek 评委
// 运行：node eval/runEval.js  （内部自动开启 EVAL_FAST）
// 输出：eval/results.json / eval/report.md / eval/judge_sample.json

process.env.EVAL_FAST = '1'; // 必须在导入编排器之前设置

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgent } from '../src/agent/orchestrator.js';
import { resetSessions } from '../src/store/sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JUDGE_SAMPLE_SIZE = Number(process.env.JUDGE_SAMPLE || 300);

// —— 消费一轮 Agent，收集事件 ——
async function runOne(sessionId, message, confirm = false) {
  const ev = { retrieval: null, tools: [], confirm: null, meta: null, text: '', done: null, fallback: null, error: null, handoff: null };
  for await (const e of runAgent({ sessionId, message, confirm })) {
    switch (e.type) {
      case 'retrieval': ev.retrieval = e.snippets; break;
      case 'tool': ev.tools.push(e); break;
      case 'confirm_request': ev.confirm = e; break;
      case 'meta': ev.meta = e; break;
      case 'token': ev.text += e.text; break;
      case 'fallback': ev.fallback = e; break;
      case 'error': ev.error = e.message; break;
      case 'human_handoff': ev.handoff = e.message; break;
      case 'done': ev.done = e; break;
      default: break;
    }
  }
  return ev;
}

const hasTool = (ev, name) => ev.tools.some((t) => t.name === name);

// —— 规则打分 ——
function score(c, ev, ev2) {
  switch (c.category) {
    case 'faq': {
      const hit = !!(ev.retrieval && ev.retrieval.length);
      return { pass: hit && ev.text.length > 0, tag: hit ? 'rag-hit' : 'rag-miss' };
    }
    case 'order': return { pass: hasTool(ev, 'queryOrder'), tag: hasTool(ev, 'queryOrder') ? 'tool-ok' : 'tool-miss' };
    case 'logistics': return { pass: hasTool(ev, 'trackLogistics'), tag: hasTool(ev, 'trackLogistics') ? 'tool-ok' : 'tool-miss' };
    case 'return': {
      const asked = ev.confirm && ev.confirm.tool === 'createReturn';
      const ran = ev2 && hasTool(ev2, 'createReturn');
      return { pass: !!(asked && ran), tag: asked ? (ran ? 'confirm+exec' : 'confirm-only') : 'no-confirm' };
    }
    case 'refund': {
      const asked = ev.confirm && ev.confirm.tool === 'applyRefund';
      const ran = ev2 && hasTool(ev2, 'applyRefund');
      return { pass: !!(asked && ran), tag: asked ? (ran ? 'confirm+exec' : 'confirm-only') : 'no-confirm' };
    }
    case 'nonbusiness':
    default: {
      // 非业务题新标准：不硬套政策（无检索命中） + 有实质回答 + 不是硬拒套话
      const noHardPolicy = !ev.retrieval || ev.retrieval.length === 0;
      const answered = (ev.text || '').trim().length >= 8;
      const notRigid = !/不在我的服务范围/.test(ev.text || '');
      const pass = noHardPolicy && answered && notRigid;
      const tag = !noHardPolicy ? 'hard-policy' : (!answered ? 'no-answer' : (!notRigid ? 'rigid-refusal' : 'natural-reply'));
      return { pass, tag };
    }
  }
}

async function main() {
  const cases = JSON.parse(readFileSync(join(__dirname, 'testset.json'), 'utf-8'));
  console.log(`载入 ${cases.length} 条用例，开始评测（EVAL_FAST 已开启）...`);

  const stats = { total: cases.length, byCat: {}, passByCat: {}, tagByCat: {}, modelDist: {}, strategyDist: {}, totalCost: 0, errors: 0 };
  const nonbusinessResults = [];
  const t0 = Date.now();

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const sid = `eval-${c.id}`;
    try {
      const ev = await runOne(sid, c.question);
      let ev2 = null;
      // 写操作：再发一次确认，验证“确认后才执行”
      if (ev.confirm) ev2 = await runOne(sid, '确认', true);

      const s = score(c, ev, ev2);
      stats.byCat[c.category] = (stats.byCat[c.category] || 0) + 1;
      if (s.pass !== null) {
        stats.passByCat[c.category] = (stats.passByCat[c.category] || 0) + (s.pass ? 1 : 0);
      }
      stats.tagByCat[c.category] = stats.tagByCat[c.category] || {};
      stats.tagByCat[c.category][s.tag] = (stats.tagByCat[c.category][s.tag] || 0) + 1;

      const modelId = (ev2 && ev2.meta?.model?.id) || ev.meta?.model?.id || (ev.confirm ? 'pending-confirm' : 'none');
      stats.modelDist[modelId] = (stats.modelDist[modelId] || 0) + 1;
      const strat = ev.meta?.strategy;
      if (strat) stats.strategyDist[strat] = (stats.strategyDist[strat] || 0) + 1;
      stats.totalCost += (ev.done?.cost || 0) + (ev2?.done?.cost || 0);

      if (c.category === 'nonbusiness') {
        nonbusinessResults.push({ id: c.id, question: c.question, answer: ev.text, model: ev.meta?.model?.name, intent: ev.meta?.intent });
      }
      if (ev.error) stats.errors++;
    } catch (err) {
      stats.errors++;
    }

    if ((i + 1) % 1000 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  进度 ${i + 1}/${cases.length}  用时 ${elapsed}s`);
    }
    if ((i + 1) % 2000 === 0) resetSessions(); // 控制内存
  }

  // —— 抽取非业务样本供 DeepSeek 评委 ——
  const sample = sampleN(nonbusinessResults, JUDGE_SAMPLE_SIZE);
  writeFileSync(join(__dirname, 'judge_sample.json'), JSON.stringify(sample, null, 1));

  // —— 写明细（非业务全量，便于复查；业务只记统计）——
  writeFileSync(join(__dirname, 'results.json'), JSON.stringify({ stats, nonbusiness: nonbusinessResults }, null, 1));

  // —— 报告 ——
  const report = buildReport(stats, sample.length, nonbusinessResults.length, ((Date.now() - t0) / 1000).toFixed(1));
  writeFileSync(join(__dirname, 'report.md'), report);
  console.log('\n' + report);
  console.log(`\n非业务样本已抽取 ${sample.length} 条 -> eval/judge_sample.json（供 DeepSeek 评委打分）`);
}

function sampleN(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function buildReport(stats, sampleSize, nbTotal, elapsed) {
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '-');
  const lines = [];
  lines.push('# 智服 Agent 评测报告（1 万条）');
  lines.push('');
  lines.push(`- 用例总数：**${stats.total}**，总耗时 ${elapsed}s，异常 ${stats.errors}`);
  lines.push(`- 估算总成本：**¥${stats.totalCost.toFixed(4)}**（按模型计价）`);
  lines.push('');
  lines.push('## 分类通过率');
  lines.push('| 类别 | 数量 | 通过 | 通过率 |');
  lines.push('|---|---|---|---|');
  for (const cat of Object.keys(stats.byCat)) {
    lines.push(`| ${cat} | ${stats.byCat[cat]} | ${stats.passByCat[cat] || 0} | ${pct(stats.passByCat[cat] || 0, stats.byCat[cat])} |`);
  }
  lines.push('');
  lines.push('## 细分标签');
  for (const cat of Object.keys(stats.tagByCat)) {
    lines.push(`- **${cat}**: ` + Object.entries(stats.tagByCat[cat]).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  lines.push('');
  lines.push('## 模型路由分布');
  for (const [m, n] of Object.entries(stats.modelDist).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${m}: ${n}（${pct(n, stats.total)}）`);
  }
  lines.push('');
  lines.push('## 策略分布');
  for (const [s, n] of Object.entries(stats.strategyDist).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${s}: ${n}`);
  }
  lines.push('');
  lines.push(`## 非业务题（DeepSeek 评委）`);
  lines.push(`- 非业务总数 ${nbTotal}，已随机抽取 **${sampleSize}** 条待 DeepSeek 网页版打分（judge_sample.json）。`);
  return lines.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
