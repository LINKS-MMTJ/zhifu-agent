// 回答策略层：决定本条消息该用哪种方式作答
// 这是编排器的"决策大脑"，与具体模型无关，便于单测与替换

export const ANSWER_MODE = {
  HANDOFF: 'handoff', // 转人工
  TOOL: 'tool',       // 以工具执行结果作答
  RAG: 'rag',         // 基于知识库检索作答
  GENERAL: 'general', // 通用对话作答（非知识库问题也正常回答）
};

/**
 * 根据意图与检索结果选择作答模式
 *
 * 核心原则：
 *   - 有工具结果 → 以业务结果为准
 *   - 售后咨询且检索命中 → 基于知识库作答（有依据、可溯源）
 *   - 其余情况（闲聊、常识、检索未命中）→ 走通用对话，正常回答，不机械拒答
 *
 * @param {object} p
 * @param {string} p.intent          意图
 * @param {number} p.retrievedCount  检索命中条数
 * @param {boolean} p.hasToolResults 是否有工具执行结果
 * @returns {string} ANSWER_MODE 之一
 */
export function decideAnswerMode({ intent, retrievedCount = 0, hasToolResults = false }) {
  if (intent === 'human') return ANSWER_MODE.HANDOFF;
  if (hasToolResults) return ANSWER_MODE.TOOL;
  // 知识库是企业真实文档，不限定只有 faq 意图才能用；检索未命中再回落通用对话
  if (retrievedCount > 0) return ANSWER_MODE.RAG;
  return ANSWER_MODE.GENERAL;
}
