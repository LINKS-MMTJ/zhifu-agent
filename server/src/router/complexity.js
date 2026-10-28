// 任务复杂度判定：决定路由到哪一档模型
//
// 设计要点：复杂度应由「任务形态」决定，而不是由业务敏感词决定。
// 早期版本把"退货/退款"当复杂词，导致「退货运费谁出？」这种一句话政策咨询
// 被判为 complex、走去最贵的旗舰模型，既慢又贵。现在改为：
//   - 投诉/纠纷等情绪诉求      → complex（需要更强的理解与安抚能力）
//   - 写操作办理（退货/退款）    → medium（单工具 + 二次确认）
//   - 查询类（订单/物流）       → medium
//   - 其余（政策咨询、闲聊等）   → simple

const DISPUTE = /投诉|维权|赔偿|差评|曝光|起诉|律师|媒体|315|主管|态度|欺诈|欺骗|不给退|拒不/;
const LONG_TEXT = 120;

/**
 * @param {string} text   用户消息
 * @param {string} [intent] 已识别意图；不传时退化为纯文本规则
 */
export function classifyComplexity(text, intent) {
  const t = String(text || '');

  if (DISPUTE.test(t)) return { level: 'complex', reason: '涉及投诉/纠纷等敏感诉求' };
  if (intent === 'return' || intent === 'refund') return { level: 'medium', reason: '单工具写操作，需确认后执行' };
  if (intent === 'order' || intent === 'logistics') return { level: 'medium', reason: '单工具查询' };
  if (intent) {
    if (t.length > LONG_TEXT) return { level: 'complex', reason: '长文本，可能包含多个诉求' };
    return { level: 'simple', reason: '单轮咨询或闲聊' };
  }

  // 未传 intent 时的退化判断（供单测/外部调用）
  if (/退货|退款|换货|订单|物流|快递/.test(t) && !/[？?]|吗|多久|怎么/.test(t)) {
    return { level: 'medium', reason: '疑似业务办理' };
  }
  return { level: 'simple', reason: '单轮咨询或闲聊' };
}
