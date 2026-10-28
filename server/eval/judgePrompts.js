// DeepSeek 评委：把非业务样本组装成判分提示词
// 运行：node eval/judgePrompts.js  -> 生成 eval/judge_prompts.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildJudgePrompt({ question, answer }) {
  return [
    '你是一名电商客服质量评委。请评估下面这段客服回复的质量。',
    '',
    '【用户问题】',
    question,
    '',
    '【客服回复】',
    answer,
    '',
    '请从以下三个维度打分（每项 1-5 分，5 分最好）：',
    '1. 相关性：回复是否切题、与用户问题相关',
    '2. 得体性：是否礼貌、专业、不生硬',
    '3. 边界处理：对与售后业务无关的问题，是否恰当引导（而不是答非所问、硬套政策）',
    '',
    '只输出一个 JSON，不要输出任何其他内容，格式如下：',
    '{"相关性":0,"得体性":0,"边界处理":0,"总分":0,"理由":"一句话"}',
  ].join('\n');
}

// 直接运行时生成全部判分提示词
if (process.argv[1] && process.argv[1].endsWith('judgePrompts.js')) {
  const samples = JSON.parse(readFileSync(join(__dirname, 'judge_sample.json'), 'utf-8'));
  const prompts = samples.map((s) => ({
    id: s.id,
    question: s.question,
    answer: s.answer,
    prompt: buildJudgePrompt(s),
  }));
  writeFileSync(join(__dirname, 'judge_prompts.json'), JSON.stringify(prompts, null, 1));
  console.log(`已生成 ${prompts.length} 条评委提示词 -> eval/judge_prompts.json`);
  console.log('—— 示例 ——');
  console.log(prompts[0].prompt);
}
