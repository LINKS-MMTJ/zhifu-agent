// 白盒测试：结构感知切块
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, detectHeading, chunkStats } from '../../src/rag/ingest/chunker.js';

const DOC = `# 退货退款总则

## 第一章 适用范围

本规则适用于平台自营及入驻商家销售的全部实物商品。虚拟商品、充值类服务、定制类商品不适用本规则。

## 第二章 七天无理由退货

自签收之日起 7 个自然日内，商品完好、不影响二次销售的，消费者可申请无理由退货。商品完好指商品本身、配件、赠品、说明书、包装完整，且未产生使用痕迹。无理由退货的退货运费由消费者承担。

## 第三章 退款时效

退款审核通过后，款项原路退回。余额支付 1-2 小时内到账。银行卡支付 1-7 个工作日到账。
`;

test('切块: 识别 Markdown 标题层级', () => {
  assert.deepEqual(detectHeading('## 第二章 七天无理由退货'), { level: 2, text: '第二章 七天无理由退货' });
  assert.deepEqual(detectHeading('# 退货退款总则'), { level: 1, text: '退货退款总则' });
  assert.equal(detectHeading('自签收之日起 7 个自然日内。'), null);
});

test('切块: 识别中文条款编号作为标题', () => {
  const h = detectHeading('第三章 退款时效');
  assert.ok(h && h.level === 2);
  assert.ok(detectHeading('1.2 运费承担'));
  assert.ok(!detectHeading('1. 先做这个，再做那个。'));
});

test('切块: 每块带标题路径，便于回溯出处', () => {
  const chunks = chunkText(DOC, { maxChars: 100, overlapChars: 0 });
  const withPath = chunks.filter((c) => c.headingPath.includes('第二章'));
  assert.ok(withPath.length > 0, '应保留第二章的标题路径');
  assert.ok(withPath[0].headingPath.startsWith('退货退款总则'), `实际：${withPath[0].headingPath}`);
});

test('切块: 不把句子拦腰截断', () => {
  const chunks = chunkText(DOC, { maxChars: 80, overlapChars: 0 });
  for (const c of chunks) {
    assert.ok(c.text.trim().length > 0);
    // 允许最末块无句末标点，其余块应为完整句
    if (c.text.length > 40) {
      assert.ok(/[。！？；\n]/.test(c.text.slice(-1)), `块结尾异常：${c.text.slice(-20)}`);
    }
  }
});

test('切块: 同一标题下相邻块有重叠', () => {
  const long = `# 政策\n\n${'这是第一句话。'.repeat(40)}`;
  const chunks = chunkText(long, { maxChars: 120, overlapChars: 40 });
  assert.ok(chunks.length >= 3);
  const second = chunks[1].text;
  const firstTail = chunks[0].text.slice(-20);
  assert.ok(second.includes(firstTail.slice(0, 10)), '第二块应包含第一块尾部内容');
});

test('切块: 标题路径不同的块之间不重叠', () => {
  const text = `## 甲\n\n${'甲部分内容。'.repeat(20)}\n\n## 乙\n\n乙部分内容。`;
  const chunks = chunkText(text, { maxChars: 80, overlapChars: 40 });
  const yi = chunks.find((c) => c.headingPath.includes('乙'));
  assert.ok(yi);
  assert.ok(!yi.text.includes('甲部分内容'), '不应把上一章内容带进下一章');
});

test('切块: 超长单句仍能切分且不丢内容', () => {
  const one = '这是一句非常长的政策描述'.repeat(60);
  const chunks = chunkText(one, { maxChars: 200, overlapChars: 0 });
  assert.ok(chunks.length > 1);
  const joined = chunks.map((c) => c.text).join('');
  assert.ok(joined.includes('这是一句非常长的政策描述'));
});

test('切块: 空文本返回空数组', () => {
  assert.deepEqual(chunkText('', {}), []);
  assert.deepEqual(chunkText('   \n\n ', {}), []);
});

test('切块: 统计信息合理', () => {
  const stats = chunkStats(chunkText(DOC, { maxChars: 120 }));
  assert.ok(stats.count > 0);
  assert.ok(stats.avgChars > 0 && stats.avgChars <= 120 * 1.4);
});
