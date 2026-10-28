#!/usr/bin/env node
// DeepSeek 评委：给模拟对话打分
//
// 关键点：不能只把"问题 + 回答"丢给模型——那样它不知道业务规则、也不知道回答依据，
// 只能凭常识瞎评。所以每条样本都会打包：
//   评分标准 + 产品规则摘要 + 本轮命中的知识片段 + 工具调用与结果 + Agent 回答
//
// 用法：
//   set DEEPSEEK_API_KEY=sk-xxx
//   npm run judge -- --in data/soak/run-2026-10-28.jsonl --sample 60
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.JUDGE_MODEL || 'deepseek-flash';

export const RUBRIC = `【评分标准】（每项 1-5 分，5 最好）
1. 正确性：是否回答了用户问题，且与提供的知识片段/工具结果一致
2. 有据可依：结论是否来自提供的资料，不编造政策、不臆造订单状态
3. 工具使用：需要查询或办理时是否调用了正确工具，并把结果准确转述
4. 语气与合规：礼貌、不硬拒、不泄露他人信息、不承诺无法保证的时效
5. 完整性：是否给出可执行的下一步（怎么退、去哪办、还缺什么信息）

【产品规则摘要】
- 回答分三种模式：知识库（有引用）、业务工具（有工具结果）、通用对话
- 与知识库无关的问题应自然回答；禁止"不在我的服务范围"这类生硬话术
- 退货/退款属于写操作，必须先让用户确认才能执行
- 不得承诺具体到账时刻，只能给区间；不得编造政策条款`;

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// 打包一份完整上下文，让评委知道"问题是什么、依据是什么、做了什么"
export function buildJudgePrompt(item) {
  const tools = (item.tools || []).map((t) => `${t.name} → ${t.ok ? '成功' : '失败'}`).join('；') || '无';
  const citations = (item.citations || [])
    .map((c, i) => `${i + 1}. 《${c.title}》${c.section ? `「${c.section}」` : ''}：${clip(c.text, 160)}`)
    .join('\n') || '（本轮没有检索到知识片段）';

  const toolDetail = (item.tools || [])
    .map((t) => `- ${t.name}：${clip(JSON.stringify(t.result || {}), 300)}`)
    .join('\n') || '（本轮没有调用工具）';

  return `${RUBRIC}

【本轮上下文】
- 用户问题：${item.question}
- 场景标签：${item.scenario}
- 回答模式：${item.mode || '未知'}（意图 ${item.intent || '未知'}）
- 调用工具：${tools}

【命中的知识片段】
${citations}

【工具返回】
${toolDetail}

【Agent 回答】
${clip(item.answer, 800)}

请只输出一个 JSON 对象，不要额外文字：
{"score":1-5,"dimensions":{"正确性":1-5,"有据可依":1-5,"工具使用":1-5,"语气与合规":1-5,"完整性":1-5},"reason":"不超过 60 字的原因"}`;
}

async function callJudge(prompt, apiKey) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是严格的电商售后客服质检员，只依据给定上下文评分，不补充外部知识。' },
        { role: 'user', content: prompt },
      ],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`评委接口 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';

  // 模型偶尔会包一层 markdown，做一次宽松提取
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`评委输出无法解析：${text.slice(0, 120)}`);
  const parsed = JSON.parse(m[0]);
  const score = Number(parsed.score);
  if (!Number.isFinite(score)) throw new Error('评委输出缺少 score');
  return parsed;
}

function sampleN(arr, n, seed = 42) {
  let a = seed >>> 0;
  const rand = () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('[judge] 未配置 DEEPSEEK_API_KEY，无法调用 DeepSeek 评分');
    console.error('[judge] 可先用 npm run soak:report 生成不含评审的指标报告');
    process.exit(2);
  }

  const get = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
  };

  const input = path.resolve(ROOT, String(get('in', 'data/soak/run-latest.jsonl')));
  const sampleSize = Number(get('sample', 50));
  const outDir = path.dirname(input);

  if (!fs.existsSync(input)) {
    console.error(`[judge] 找不到明细：${input}`);
    process.exit(1);
  }

  const all = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const items = sampleN(all, Math.min(sampleSize, all.length));
  console.log(`[judge] 共 ${all.length} 条，抽样 ${items.length} 条交 DeepSeek 评分（模型 ${MODEL}）`);

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let verdict = null;
    for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
      try {
        verdict = await callJudge(buildJudgePrompt(item), apiKey);
      } catch (err) {
        if (attempt === 1) console.warn(`[judge] 第 ${i + 1} 条评分失败：${err.message}`);
      }
    }
    if (verdict) {
      results.push({
        question: item.question,
        scenario: item.scenario,
        score: Number(verdict.score),
        dimensions: verdict.dimensions || {},
        reason: verdict.reason || '',
      });
    }
    if ((i + 1) % 10 === 0) console.log(`[judge] 进度 ${i + 1}/${items.length}`);
  }

  if (!results.length) {
    console.error('[judge] 所有样本评分失败');
    process.exit(1);
  }

  const dimKeys = ['正确性', '有据可依', '工具使用', '语气与合规', '完整性'];
  const dimensions = {};
  for (const k of dimKeys) {
    const vals = results.map((r) => Number(r.dimensions[k])).filter((v) => Number.isFinite(v));
    dimensions[k] = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;
  }

  const payload = {
    judgedAt: new Date().toISOString(),
    model: MODEL,
    sampled: results.length,
    source: path.relative(ROOT, input).split(path.sep).join('/'),
    average: Number((results.reduce((a, r) => a + r.score, 0) / results.length).toFixed(2)),
    dimensions,
    items: results,
  };

  const outFile = path.join(outDir, `judge-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[judge] 平均分 ${payload.average}/5，结果：${outFile}`);
  console.log(`[judge] 维度：${Object.entries(dimensions).map(([k, v]) => `${k} ${v}`).join('，')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[judge] 失败：', err.message);
    process.exit(1);
  });
}
