// 智能模型路由：按 价格/质量/延迟/均衡 策略 + 任务复杂度 自主选择底层模型
// 并负责故障降级（fallback 链 + 熔断）与成本估算

import { MODELS } from '../config/models.js';

// 复杂度 -> 候选模型档位（复杂问题优先强模型，简单问题优先便宜模型）
const TIER_BY_COMPLEXITY = {
  simple: ['lite', 'standard'],
  medium: ['standard', 'pro'],
  complex: ['pro', 'standard'],
};

const MIN_QUALITY_FOR_PRICE = 55; // 价格优先时仍需满足的最低质量分
const FAILURE_COOLDOWN_MS = 30_000; // 熔断冷却时间
const FAILURE_THRESHOLD = 2; // 连续失败多少次触发熔断

export class ModelRouter {
  constructor(models = MODELS) {
    // 全部模型都保留在注册表里（管理页要能看到"已注册但未配置 Key"的模型），
    // 是否参与路由由 enabled 决定，见 candidates()
    this.models = models.map((m) => ({
      ...m,
      enabled: m.enabled !== false,
      state: { failures: 0, unhealthyUntil: 0 },
    }));
    this.strategy = 'auto'; // auto | price | quality | latency | balanced
  }

  setStrategy(s) { this.strategy = s; return this.strategy; }

  isHealthy(m, now = Date.now()) { return m.state.unhealthyUntil <= now; }
  reportSuccess(m) { m.state.failures = 0; m.state.unhealthyUntil = 0; }
  reportFailure(m) {
    m.state.failures += 1;
    if (m.state.failures >= FAILURE_THRESHOLD) {
      m.state.unhealthyUntil = Date.now() + FAILURE_COOLDOWN_MS;
      m.state.failures = 0;
    }
  }

  // 估算单次调用成本（元）
  estimateCost(model, inTok = 120, outTok = 160) {
    return (inTok / 1e6) * model.priceIn + (outTok / 1e6) * model.priceOut;
  }

  candidates(complexity, now = Date.now()) {
    const tiers = TIER_BY_COMPLEXITY[complexity] || ['standard'];
    return this.models.filter(
      (m) => m.enabled && tiers.includes(m.tier) && this.isHealthy(m, now)
    );
  }

  /**
   * 均衡评分：质量、成本、延迟三项归一化后加权
   * 旧实现把成本乘一个固定系数，但成本量级（1e-4）远小于质量量级（1e2），
   * 导致"均衡"退化成"质量优先"。现在按候选集内的相对值归一化再比较。
   */
  balancedScore(m, ctx) {
    const cost = this.estimateCost(m);
    const q = m.quality / 100;
    const c = ctx.maxCost > 0 ? cost / ctx.maxCost : 0;
    const l = ctx.maxLatency > 0 ? m.latencyMs / ctx.maxLatency : 0;
    return q * 0.5 - c * 0.3 - l * 0.2;
  }

  // auto 策略：简单问题省钱，复杂问题保质量，中间走均衡
  resolveStrategy(complexity) {
    if (this.strategy && this.strategy !== 'auto') return this.strategy;
    if (complexity === 'simple') return 'price';
    if (complexity === 'complex') return 'quality';
    return 'balanced';
  }

  explain(model, strategy) {
    const cost = this.estimateCost(model);
    switch (strategy) {
      case 'price': return `价格优先：单次约 ¥${cost.toFixed(5)}，且质量达标`;
      case 'quality': return `质量优先：质量分 ${model.quality}`;
      case 'latency': return `延迟优先：约 ${model.latencyMs}ms`;
      default: return `均衡：质量${model.quality}/成本/延迟加权`;
    }
  }

  /**
   * 选择模型
   * @returns { model, strategy, reason, fallbacks }
   */
  select(complexity, strategyOverride) {
    const strategy = strategyOverride && strategyOverride !== 'auto'
      ? strategyOverride
      : this.resolveStrategy(complexity);

    let cands = this.candidates(complexity);
    // 兜底链只在"启用"的模型里找：配了 DeepSeek 之后 Mock 已禁用，
    // 若这里不判 enabled，简单任务会退回到离线 Mock，出现"配了 Key 却没用模型"
    if (!cands.length) cands = this.models.filter((m) => m.enabled && this.isHealthy(m));
    if (!cands.length) cands = this.models.filter((m) => m.enabled);
    if (!cands.length) cands = [...this.models]; // 一个都没启用时兜底，避免抛错

    if (strategy === 'price') {
      const ok = cands.filter((m) => m.quality >= MIN_QUALITY_FOR_PRICE);
      if (ok.length) cands = ok;
      cands = [...cands].sort((a, b) => this.estimateCost(a) - this.estimateCost(b));
    } else if (strategy === 'quality') {
      cands = [...cands].sort((a, b) => b.quality - a.quality);
    } else if (strategy === 'latency') {
      cands = [...cands].sort((a, b) => a.latencyMs - b.latencyMs);
    } else {
      // 均衡：先算出候选集的成本/延迟上界，再做归一化打分
      const ctx = {
        maxCost: Math.max(...cands.map((m) => this.estimateCost(m))),
        maxLatency: Math.max(...cands.map((m) => m.latencyMs)),
      };
      cands = [...cands].sort((a, b) => this.balancedScore(b, ctx) - this.balancedScore(a, ctx));
    }

    const chosen = cands[0];
    return {
      model: chosen,
      strategy,
      reason: this.explain(chosen, strategy),
      fallbacks: cands.slice(1),
    };
  }

  // 对外展示（隐藏内部 state 结构）
  list() {
    return this.models.map((m) => {
      const { state, ...rest } = m;
      return {
        ...rest,
        // 未启用（没配 Key）不算健康，避免管理页显示"健康"却调不通
        healthy: m.enabled ? this.isHealthy(m) : false,
        failures: state.failures,
        estimatedCostPerCall: Number(this.estimateCost(m).toFixed(6)),
      };
    });
  }
}

// 单例，供编排器与管理接口共用
export const router = new ModelRouter();
