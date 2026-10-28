// 评测门禁：每个分类必须达到阈值，否则以非 0 退出，让 CI 失败
//
// 为什么需要：准确率是慢慢掉下去的，没有人会盯着报告看。
// 把阈值写进流水线，掉 2% 就阻断合并，比事后复盘有用。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const THRESHOLDS = {
  faq: 0.98,
  order: 0.99,
  logistics: 0.99,
  return: 0.99,
  refund: 0.99,
  nonbusiness: 0.98,
};

const file = join(dirname(fileURLToPath(import.meta.url)), 'results.json');
if (!existsSync(file)) {
  console.error('[gate] 未找到 eval/results.json，请先执行 npm run eval');
  process.exit(1);
}

const { stats } = JSON.parse(readFileSync(file, 'utf8'));
const failures = [];

console.log('[gate] 分类通过率：');
for (const [cat, min] of Object.entries(THRESHOLDS)) {
  const total = stats.byCat?.[cat] || 0;
  const pass = stats.passByCat?.[cat] || 0;
  const rate = total ? pass / total : 0;
  const ok = rate >= min;
  console.log(`  ${cat.padEnd(12)} ${pass}/${total}  ${(rate * 100).toFixed(1)}%  阈值 ${(min * 100).toFixed(0)}%  ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failures.push(`${cat} ${(rate * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%`);
}

if (stats.errors > 0) failures.push(`执行异常 ${stats.errors} 条`);

// 成本不能失控：单条平均成本超过 0.01 元（离线 Mock 只有 0.0002）通常意味着路由跑偏
const avgCost = stats.totalCost / Math.max(1, stats.total);
if (avgCost > 0.01) failures.push(`单条平均成本 ¥${avgCost.toFixed(5)} 超过 ¥0.01`);

if (failures.length) {
  console.error(`\n[gate] 未通过：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\n[gate] 通过（单条平均成本 ¥${avgCost.toFixed(5)}）`);
