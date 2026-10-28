// LLM 适配器工厂：按模型 adapter 类型分发，统一为流式接口
import { mockStream } from './mockAdapter.js';
import { openaiStream } from './openaiAdapter.js';

/**
 * 统一的流式调用入口
 * @returns AsyncGenerator<{type:'delta',text}|{type:'usage',usage}>
 */
export async function* streamModel({ model, messages, tools, mockPlan }) {
  if (model.adapter === 'openai') {
    const apiKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : null;
    if (!apiKey) throw new Error(`缺少环境变量 ${model.apiKeyEnv}，无法调用真实模型`);
    yield* openaiStream({ model, messages, apiKey, tools });
    return;
  }
  yield* mockStream({ model, mockPlan });
}
