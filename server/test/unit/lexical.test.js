// 白盒测试：词面闸门（防止无关问题硬套知识库）
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryChars, hasLexicalSupport } from '../../src/rag/lexical.js';

const DOCS = [
  {
    title: '发票与开票规则',
    headingPath: '发票与开票规则 > 一、发票类型',
    text: '平台支持开具电子普通发票与增值税专用发票。电子普通发票在订单完成后 24 小时内推送。',
  },
  {
    title: '家电类售后规则',
    headingPath: '家电类售后规则 > 二、安装与调试',
    text: '大家电签收后需在 7 天内预约安装。空调高空作业费按楼层收取，4 层以上每层加收 30 元。',
  },
];

test('词面: 提取查询实字并过滤停用字', () => {
  const chars = queryChars('发票怎么开？');
  assert.ok(chars.includes('发'));
  assert.ok(chars.includes('票'));
  assert.ok(chars.includes('开'));
  assert.ok(!chars.includes('怎'));
  assert.ok(!chars.includes('么'));
});

test('词面: 相关问题通过闸门', () => {
  assert.equal(hasLexicalSupport('发票怎么开', DOCS), true);
  assert.equal(hasLexicalSupport('安装收高空作业费吗？', DOCS), true);
  assert.equal(hasLexicalSupport('高空作业费怎么算', DOCS), true);
});

test('词面: 无关问题被拦下', () => {
  assert.equal(hasLexicalSupport('推荐一本书', DOCS), false);
  assert.equal(hasLexicalSupport('今天天气怎么样', DOCS), false);
  assert.equal(hasLexicalSupport('苹果手机怎么截屏', DOCS), false);
  assert.equal(hasLexicalSupport('股票会涨吗', DOCS), false);
});

test('词面: 查询过短时直接判定无依据（走通用对话）', () => {
  // 实字不足 2 个无法判断语义，宁可走通用对话，也不要硬套政策
  assert.equal(hasLexicalSupport('你好', DOCS), false);
  assert.equal(hasLexicalSupport('在吗', DOCS), false);
  assert.equal(hasLexicalSupport('1+1等于几', DOCS), false);
  // 两个实字的业务短词仍应放行
  assert.equal(hasLexicalSupport('发票？', DOCS), true);
});

test('词面: 带标点与英文混排不报错', () => {
  assert.doesNotThrow(() => hasLexicalSupport('SO20260001 的发票？', DOCS));
  assert.equal(hasLexicalSupport('SO20260001 的发票？', DOCS), true);
});
