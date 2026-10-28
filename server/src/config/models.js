// 模型注册表：智能模型路由的元数据来源
// 价格单位：元 / 1M tokens（输入 / 输出）
// adapter: 'mock' 离线模拟（开箱即用，无需 API Key）；'openai' 真实 OpenAI 兼容接口
//
// 真实模型的 enabled 由环境变量自动决定：检测到对应 API Key 才会启用，
// 避免无 Key 时报错拖累路由。设置 DEEPSEEK_API_KEY 后重启即可自动接入。

const hasDeepSeekKey = Boolean(process.env.DEEPSEEK_API_KEY);
// 阿里云百炼（DashScope）提供 OpenAI 兼容模式，可直接复用同一个适配器
const hasDashScopeKey = Boolean(process.env.DASHSCOPE_API_KEY);
const DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
// 私有网关/代理（企业内网常见）可覆盖默认地址；也用于本地联调假模型
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

// 只要配了任意一个真实模型，离线 Mock 就不再参与路由：
// 否则 Mock 的价格与延迟都是"自己填的数字"，均衡策略会永远选中 Mock，
// 结果就是"配了 Key 却从没真正调用过模型"。Mock 只作为无 Key 时的开箱兜底。
const hasRealModel = hasDeepSeekKey || hasDashScopeKey;

export const MODELS = [
  {
    id: 'lite-1', name: '轻量模型 · 省', tier: 'lite', adapter: 'mock',
    priceIn: 0.3, priceOut: 0.6, quality: 60, latencyMs: 300, ctx: 32768,
    supportsTools: true, enabled: !hasRealModel,
    desc: hasRealModel ? '离线兜底模型：已接入真实模型，本模型不参与路由' : '便宜快速，适合简单 FAQ / 闲聊',
  },
  {
    id: 'std-1', name: '标准模型 · 均衡', tier: 'standard', adapter: 'mock',
    priceIn: 1.2, priceOut: 2.4, quality: 78, latencyMs: 550, ctx: 65536,
    supportsTools: true, enabled: !hasRealModel,
    desc: hasRealModel ? '离线兜底模型：已接入真实模型，本模型不参与路由' : '性价比均衡，适合单工具业务办理',
  },
  {
    id: 'pro-1', name: '旗舰模型 · 强', tier: 'pro', adapter: 'mock',
    priceIn: 4.0, priceOut: 12.0, quality: 92, latencyMs: 850, ctx: 131072,
    supportsTools: true, enabled: !hasRealModel,
    desc: hasRealModel ? '离线兜底模型：已接入真实模型，本模型不参与路由' : '最强推理，适合复杂办理 / 投诉安抚',
  },

  // —— 真实模型：DeepSeek V4.1-Flash ——
  // 官方模型名 deepseek-flash（代表 DeepSeek-V4.1-Flash-1017，旧名 deepseek-v4-flash 兼容）
  // 官方价（美元/1M tokens，off-peak / peak）：输入 $0.15/$0.30，输出 $0.60/$1.20
  // 此处按 peak 价 × 7.2 汇率折算为人民币，属保守估算（实际多数时段为 off-peak 半价）
  {
    id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', tier: 'standard', adapter: 'openai',
    baseUrl: DEEPSEEK_BASE_URL, apiKeyEnv: 'DEEPSEEK_API_KEY',
    priceIn: 2.16, priceOut: 8.64, quality: 88, latencyMs: 900, ctx: 1000000,
    supportsTools: true, thinking: false, enabled: hasDeepSeekKey,
    desc: hasDeepSeekKey ? '已接入：中文强、支持工具调用与视觉，上下文 1M' : '设置 DEEPSEEK_API_KEY 后自动启用',
  },

  // —— 阿里云百炼 / 通义千问（DashScope OpenAI 兼容模式）——
  // 价格按百炼官方（元 / 1M tokens，输入 / 输出）折算，属保守估算
  {
    id: 'qwen-turbo', name: '通义千问 Turbo', tier: 'lite', adapter: 'openai',
    baseUrl: DASHSCOPE_BASE_URL, apiKeyEnv: 'DASHSCOPE_API_KEY',
    priceIn: 0.3, priceOut: 0.6, quality: 70, latencyMs: 420, ctx: 131072,
    supportsTools: true, enabled: hasDashScopeKey,
    desc: hasDashScopeKey ? '已接入：最便宜、响应快，适合简单 FAQ' : '设置 DASHSCOPE_API_KEY 后自动启用',
  },
  {
    id: 'qwen-plus', name: '通义千问 Plus', tier: 'standard', adapter: 'openai',
    baseUrl: DASHSCOPE_BASE_URL, apiKeyEnv: 'DASHSCOPE_API_KEY',
    priceIn: 0.8, priceOut: 2.0, quality: 85, latencyMs: 700, ctx: 131072,
    supportsTools: true, enabled: hasDashScopeKey,
    desc: hasDashScopeKey ? '已接入：性价比均衡，适合单工具办理' : '设置 DASHSCOPE_API_KEY 后自动启用',
  },
  {
    id: 'qwen-max', name: '通义千问 Max', tier: 'pro', adapter: 'openai',
    baseUrl: DASHSCOPE_BASE_URL, apiKeyEnv: 'DASHSCOPE_API_KEY',
    priceIn: 2.4, priceOut: 9.6, quality: 93, latencyMs: 1100, ctx: 32768,
    supportsTools: true, enabled: hasDashScopeKey,
    desc: hasDashScopeKey ? '已接入：复杂纠纷与长上下文场景' : '设置 DASHSCOPE_API_KEY 后自动启用',
  },
];

export const TIERS = ['lite', 'standard', 'pro'];
