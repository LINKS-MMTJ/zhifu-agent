// 白盒测试：RAG（向量化 / 相似度 / 检索）
// 使用显式的种子知识库，避免依赖运行目录下是否已生成真实索引
import test from 'node:test';
import assert from 'node:assert/strict';
import { embed, cosine } from '../../src/rag/embedding.js';
import { buildKnowledge, retrieveFrom, KNOWLEDGE_DOCS } from '../../src/rag/knowledge.js';

const kb = buildKnowledge(KNOWLEDGE_DOCS);
const retrieve = (q, k = 3) => retrieveFrom(kb, q, k);

test('向量化: 输出定长且已归一化', () => {
  const v = embed('退货运费谁出');
  assert.ok(v.length > 0);
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `应归一化，实际 ${norm}`);
});

test('相似度: 相同文本为 1', () => {
  const v = embed('退货运费');
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
});

test('相似度: 同领域文本高于跨领域文本', () => {
  const q = embed('退货运费谁出');
  const sameDomain = embed('退货运费由买家承担');
  const otherDomain = embed('今天天气怎么样');
  assert.ok(cosine(q, sameDomain) > cosine(q, otherDomain));
});

test('检索: 政策类问题命中退货政策', () => {
  const hits = retrieve('退货运费谁出？');
  assert.ok(hits.length > 0, '应检索到内容');
  assert.equal(hits[0].docId, 'return-policy');
});

test('检索: 保修问题命中保修政策', () => {
  const hits = retrieve('保修期多久？');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].docId, 'warranty');
});

test('检索: 无关问题的最高分低于阈值区间', () => {
  const hits = retrieve('今天天气怎么样');
  // 允许返回弱命中，但最高分应明显偏低（阈值 0.12，远低于业务问题的 ~0.3+）
  if (hits.length) assert.ok(hits[0].score < 0.25, `无关问题不应高分命中，实际 ${hits[0].score}`);
});

test('知识库: 切块完整且不为空', () => {
  assert.ok(kb.size() >= 6);
  for (const item of kb.items) {
    assert.ok(item.text.trim().length > 0, '切块不应为空');
    assert.ok(item.title, '切块应带来源标题');
  }
});

test('知识库: 切块不截断句子（每块以句末标点收尾或为末块）', () => {
  const broken = kb.items.filter(
    (it) => !/[。！？；]$/.test(it.text) && it.text.length > 60
  );
  assert.equal(broken.length, 0, `存在被拦腰截断的块：${broken.map((b) => b.id).join(',')}`);
});

test('检索: 可限定格式过滤（format 选项）', () => {
  const hits = retrieveFrom(kb, '退货', 3, { format: 'seed' });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.format === 'seed'));
});
