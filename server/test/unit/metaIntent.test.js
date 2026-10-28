// 白盒测试：元问题识别（能力 / 身份 / 时间 / 问候）
// 重点覆盖"同义改写"，这是早期字面匹配翻车的地方
import test from 'node:test';
import assert from 'node:assert/strict';
import { META, classifyMeta } from '../../src/agent/metaIntent.js';

// —— 能力询问：18 种自然说法都必须识别 ——
const CAPABILITY_CASES = [
  '你能帮我做什么？',
  '你能帮我做什么',
  '你能干什么',
  '你能干啥',
  '你都能帮我干嘛',
  '有什么可以帮我的',
  '能帮上什么忙',
  '你会做什么',
  '你有哪些功能',
  '介绍一下你的功能',
  '你能做什么呀',
  '我可以问你什么',
  '你有什么用',
  '帮我能做啥',
  '你能提供什么帮助',
  '我该怎么用你',
  '你能处理哪些问题',
  '你都支持什么',
];

for (const q of CAPABILITY_CASES) {
  test(`能力询问识别: ${q}`, () => {
    assert.equal(classifyMeta(q), META.CAPABILITY);
  });
}

// —— 身份询问 ——
const IDENTITY_CASES = [
  '你是谁', '你是谁？', '你叫什么名字', '你是机器人吗', '你是AI吗',
  '你是什么模型', '谁开发的你', '你是真人吗',
];
for (const q of IDENTITY_CASES) {
  test(`身份询问识别: ${q}`, () => {
    assert.equal(classifyMeta(q), META.IDENTITY);
  });
}

// —— 时间 / 问候 / 致谢 / 告别 ——
test('时间询问识别', () => {
  assert.equal(classifyMeta('今天是几号'), META.DATETIME);
  assert.equal(classifyMeta('现在几点'), META.DATETIME);
});
test('问候识别', () => {
  assert.equal(classifyMeta('你好'), META.GREETING);
  assert.equal(classifyMeta('在吗？'), META.GREETING);
});
test('致谢与告别识别', () => {
  assert.equal(classifyMeta('谢谢'), META.THANKS);
  assert.equal(classifyMeta('再见'), META.BYE);
});

// —— 负例：业务问题不能被误判成元问题 ——
const NEGATIVE_CASES = [
  '你能帮我查订单吗',   // 业务请求，不是问能力
  '我要退货',
  '退货运费谁出？',
  '这个优惠怎么用',     // 问优惠，不是问助手能力
  '你是什么时候发货',   // 问发货时间，不是问身份
  '今天天气怎么样',
  '保修期多久',
  '',
];
for (const q of NEGATIVE_CASES) {
  test(`负例不误判: ${q || '(空字符串)'}`, () => {
    assert.equal(classifyMeta(q), null);
  });
}
