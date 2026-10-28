// Agent 编排器：意图识别 → 工具 / RAG / 通用对话 → 智能模型路由 → 流式输出
// 以异步生成器产出事件，供 index.js 以 SSE 推送给前端

import { classifyComplexity } from '../router/complexity.js';
import { router } from '../router/modelRouter.js';
import { streamModel } from '../llm/index.js';
import { retrieve } from '../rag/knowledge.js';
import { getTool, matchToolByTrigger } from '../tools/registry.js';
import { extractArgs } from '../integrations/connectors.js';
import { emitEvent } from '../integrations/events.js';
import { getSession, addMessage, logCall } from '../store/sessions.js';
import { decideAnswerMode } from './answerPolicy.js';
import { buildMessages } from './prompts.js';
import { buildAction, buildConfirmAction } from './actions.js';
import { classifyMeta, stripSocial, META } from './metaIntent.js';
import { audit } from '../observability/audit.js';
import { logError } from '../observability/logger.js';
import { recordCost } from '../guard/quota.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 文本分块：按码点切，避免切断 emoji 等代理对
function* chunkText(text, size = 4) {
  const chars = Array.from(String(text));
  for (let i = 0; i < chars.length; i += size) yield chars.slice(i, i + size).join('');
}

// —— 意图识别（规则版，生产可换分类模型）——
// 政策咨询走 faq；明确办理动作走业务工具；完全不含业务领域词且没有订单号走 out_of_scope
const QUESTION = /吗|？|\?|哪里|多久|怎么|怎样|什么时候|几天|多少|为什么|为何|谁出|谁承担/;
const DOMAIN = /订单|物流|快递|发货|签收|包裹|退货|退款|退钱|退换|换货|退掉|退了|退回|售后|保修|三包|运费|邮费|质量|破损|损坏|维修|发票|优惠|价格|尺码|投诉|客服|人工|商品|下单|购买|支付|付款|地址|收货|店铺|到货|延迟|偏远|坏了|能修|修理|不想要|不要了|七天|无理由|状态|进度|退|换/;
// 写操作的"强动作"：即使带问号（"我要退货，能办吗？"）也要按办理处理；
// 而"退货运费谁出？"这类咨询不能被误当成办理
const RETURN_ACTION = /我要退|我想退|申请退|帮我退|给我退|办理退|直接退|退了吧|不想要了|不要了/;
// 退款的口语说法比书面语多："退款给我""帮我退钱""想退掉这笔钱"都是明确诉求，
// 而"退款多久到账""退款怎么还没到"是咨询——下面只收强动作，避免把咨询当办理
const REFUND_ACTION = /我要退款|我想退款|申请退款|帮我退款|帮我退钱|给我退款|给我退钱|退款给我|退钱给我|我要退钱|想退掉|要退掉|退掉.{0,10}钱|办理退款/;
// —— 多轮上下文 ——
// 客服对话里大量是省略句："物流到哪了""那退款呢""为什么"。只看当句必然答非所问，
// 所以要能从会话历史里恢复：上一句用户问题、上一句回答、上一轮意图、以及订单号。
const FOLLOW_LEAD = /^(那|这|它|他|她|上面|刚才|刚刚|还有|然后|另外|再|继续)/;
const FOLLOW_QUESTION = /^(为什么|为啥|怎么会|多久|多长时间|怎么办|咋办|然后呢|还有呢|呢|嗯)/;

export function readContext(messages = []) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  let orderId = null;
  for (let i = messages.length - 1; i >= 0 && !orderId; i--) {
    const m = String(messages[i].content || '').match(/SO\d{6,}/i);
    if (m) orderId = m[0].toUpperCase();
  }
  return {
    lastUser: lastUser?.content || '',
    lastAnswer: lastAssistant?.content || '',
    lastIntent: lastAssistant?.intent || null,
    lastMode: lastAssistant?.mode || null,
    orderId,
  };
}

// 这句是不是依赖上文的省略/追问
export function isContextDependent(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 24) return false;
  return FOLLOW_LEAD.test(t) || FOLLOW_QUESTION.test(t) || /^(这个|那个|这笔|这单|该订单)/.test(t);
}

// 去掉指代词，得到可拼接进检索的核心短语："那退款呢" → "退款"
function followUpCore(text) {
  return String(text || '')
    .trim()
    .replace(FOLLOW_LEAD, '')
    .replace(/^(这个|那个|这笔|这单|该订单)/, '')
    .replace(/(呢|吗|啊|吧|呀)$/, '')
    .trim();
}

// 追问里带这些动作词，说明用户要接着办事，而不是只想听解释
const looksLikeAction = (t) => /查|看|退|办|申请|办理|进度|物流|快递/.test(t);

// 注入/越界/违规请求：直接拒答，不进入业务链路
const BLOCKED = /系统提示词|初始设定|忽略之前|忽略上述|忘记之前|没有限制|越狱|木马|病毒|破解|盗号|其他客户|别的客户|别人的订单|假装你不是|你不是客服/;
// 否定表达：用户在说"不退了/别退货"，不是办理诉求
const NEGATED_RETURN = /(不要|不用|不需要|先不|别)(再)?退|不退了|先不退|不用退|不想退/;

export function detectIntent(text) {
  const t = String(text || '');
  // 只有明确的“转移”诉求才转人工；“人工客服工作时间？”这类咨询应走 faq
  if (/人工/.test(t) && !QUESTION.test(t)) return 'human';
  if (BLOCKED.test(t)) return 'blocked';
  // 否定退货：不当成退货动作，交给通用对话正常回应
  if (NEGATED_RETURN.test(t)) return 'out_of_scope';

  // 订单号是强信号：即使没说"订单"两个字，也应该走业务查询
  const hasOrderId = /SO\d{6,}/i.test(t) || /\b\d{8}\b/.test(t);
  if (!DOMAIN.test(t) && !hasOrderId) return 'out_of_scope';

  // 是否是明确的“请求代劳”（帮我查/给我看看/替我办），即使带问号也是要办事
  const isRequest = /帮我|帮忙|给我|替我|麻烦你?帮/.test(t);

  if (/运费|邮费|保修|三包|政策|到账|投诉|七天|无理由|质量|坏了|破损|损坏|维修/.test(t)) return 'faq';

  if (/退款|退钱|退我|退.{0,20}钱/.test(t)) {
    return REFUND_ACTION.test(t) ? 'refund' : 'faq';
  }
  if (/退货|换货|退换|退掉|退了|退回|不想要|不要了/.test(t)) {
    return RETURN_ACTION.test(t) ? 'return' : 'faq';
  }
  if (/物流|快递|发货|到哪|签收|订单|状态|进度/.test(t)) {
    if (hasOrderId || !QUESTION.test(t) || isRequest) {
      return /物流|快递|发货|到哪|签收/.test(t) ? 'logistics' : 'order';
    }
    return 'faq';
  }
  if (QUESTION.test(t)) return 'faq';
  return 'out_of_scope';
}

// —— 订单号抽取 ——
function extractOrderId(text) {
  const m = String(text || '').match(/SO\d{6,}/i) || String(text || '').match(/\b\d{8}\b/);
  return m ? m[0].toUpperCase().replace(/^SO0*/i, 'SO') : null;
}

function extractPhone(text) {
  const m = String(text || '').match(/1[3-9]\d{9}/);
  return m ? m[0] : null;
}

// —— 依据意图规划工具调用 ——
const PARAM_LABEL = {
  orderId: '订单号（一般以 SO 开头，可在订单详情页看到）',
  phone: '下单手机号（11 位）',
  reason: '退货原因',
  subject: '问题描述',
};

// 必填参数校验：require 的每个子数组是"任选其一"（orderId 或 phone）
// 只读查询也必须先补齐——"帮我查订单"却拿空单号去查，只会得到"没查到"，
// 既答非所问，也会把内部测试数据当成真实结果吐给用户
function missingParams(def, args) {
  const groups = def?.require;
  if (!Array.isArray(groups) || !groups.length) return [];
  const missing = [];
  for (const group of groups) {
    const filled = group.some((p) => {
      const v = args?.[p];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
    if (!filled) missing.push(group[0]);
  }
  return missing;
}

function planTools(intent, text, carriedOrderId = null) {
  // 外部系统的触发词是人工配置的明确指令（建工单 / 查客户档案），优先级高于通用意图
  const hit = matchToolByTrigger(text);
  if (hit) {
    const { args, missing } = extractArgs(hit.tool.paramSpec || {}, text);
    return [{ name: hit.name, args, missing }];
  }

  // 本句没写订单号时，沿用上文里最近一次出现的订单号（"物流到哪了"接"查订单 SO20260001"）
  const orderId = extractOrderId(text) || carriedOrderId;
  const phone = extractPhone(text);
  const internal = (() => {
    switch (intent) {
      case 'order': return [{ name: 'queryOrder', args: { orderId, phone } }];
      case 'logistics': return [{ name: 'trackLogistics', args: { orderId, phone } }];
      case 'return': return [{ name: 'createReturn', args: { orderId, reason: '用户申请退货' } }];
      case 'refund': return [{ name: 'applyRefund', args: { orderId } }];
      default: return [];
    }
  })();

  for (const t of internal) {
    t.missing = missingParams(getTool(t.name), t.args);
  }
  return internal;
}

/**
 * 运行一轮 Agent，产出事件流
 */
export async function* runAgent({ sessionId, message, confirm = false, strategy }) {
  const session = getSession(sessionId);
  if (strategy) session.strategy = strategy;

  // 取最近几轮作为上下文（当前消息尚未写入）
  // 超出窗口的旧消息不再直接丢弃，而是压成一段摘要带进系统提示，
  // 否则长对话里"我前面说过订单号""刚才说不要发票"这类信息会凭空消失
  const HISTORY_KEEP = 8;
  const recent = session.messages.slice(-HISTORY_KEEP);
  const older = session.messages.slice(0, -HISTORY_KEEP).slice(-16);
  const historySummary = older.length
    ? older
      .map((m) => `${m.role === 'user' ? '用户' : '客服'}：${String(m.content || '').replace(/\s+/g, ' ').slice(0, 50)}`)
      .join('；')
    : '';
  const history = recent.map((m) => ({ role: m.role, content: m.content }));
  // 上一轮在聊什么：省略句全靠它补齐
  const prior = readContext(session.messages);
  const ctxDep = isContextDependent(message);
  addMessage(sessionId, { role: 'user', content: message });

  // 先识别意图，再由「意图 + 文本」判定复杂度（复杂度依赖任务形态，不是业务关键词）
  let intent = detectIntent(message);

  // 上一轮追问过订单号/手机号，用户这轮只回了一串号码：
  // 不能当成新的无关问题，要接着上一轮的意图走（否则"SO20260001"会被回一句答不上来）
  const asked = session.pendingAsk;
  const answeredId = extractOrderId(message) || extractPhone(message);
  if (asked && answeredId && Date.now() - (asked.at || 0) < 10 * 60 * 1000) {
    intent = asked.intent || intent;
    session.pendingAsk = null;
  } else if (asked && (intent !== 'out_of_scope' || /算了|不用了|取消|先不查/.test(message))) {
    // 用户改聊别的或主动放弃，清掉待补参数，避免后面串味
    session.pendingAsk = null;
  }

  // 省略式追问（"那退款呢""这笔订单呢"）本身不含完整业务信息，沿用上一轮意图。
  // 但"那个，苹果手机怎么截屏"虽然也以指代词开头，却是完整的新问题——
  // 所以要求剥离后仍带业务领域词，才继承意图，否则会把无关问题硬拖回上一轮主题。
  if (intent === 'out_of_scope' && ctxDep && prior.lastIntent && DOMAIN.test(message)) {
    const business = ['order', 'logistics', 'return', 'refund', 'faq'];
    const priorIntent = business.includes(prior.lastIntent)
      ? prior.lastIntent
      : (prior.lastMode === 'rag' ? 'faq' : null);
    if (priorIntent) {
      intent = looksLikeAction(message) && ['order', 'logistics'].includes(priorIntent) ? priorIntent : 'faq';
    }
  }
  // 本句像咨询（"物流到哪了？"带问号被判 faq），但上文已有订单号且在问进度：
  // 有槽位就该按查询办理，而不是再讲一遍政策
  if (prior.orderId && !extractOrderId(message) && intent === 'faq') {
    if (/物流|快递|到哪|签收|发货/.test(message)) intent = 'logistics';
    else if (/订单|状态|进度/.test(message)) intent = 'order';
  }
  const complexity = classifyComplexity(message, intent);

  // 用户切换了话题：放弃上一轮待确认的写操作。
  // 否则模型会拿着"待退货"的历史继续追问退货原因，而用户其实已经在问别的事了。
  if (session.pendingAction && !confirm && !['return', 'refund'].includes(intent)) {
    session.pendingAction = null;
  }

  // —— 日期时间：用服务端时间直接回答 ——
  // 交给模型它会"猜"一个日期，而且猜错也没人知道；这个信息本地就有，没必要花 token 冒险
  if (classifyMeta(message) === META.DATETIME) {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const text = /几点|时间/.test(message)
      ? `现在是 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}（星期${week}）。`
      : `今天是 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日，星期${week}。`;
    addMessage(sessionId, { role: 'assistant', content: text, mode: 'general', intent });
    // 仍然发 meta：前端与模拟器都靠它拿模式，缺了会被当成"未知模式"
    yield {
      type: 'meta',
      intent,
      mode: 'general',
      complexity: 'simple',
      complexityReason: '系统时间本地作答，无需模型',
      model: { id: 'local', name: '本地应答', tier: 'lite' },
      strategy: 'local',
      reason: '日期时间由服务端直接给出，避免模型猜错',
    };
    for (const piece of chunkText(text, 4)) {
      yield { type: 'token', text: piece };
      if (!process.env.EVAL_FAST) await sleep(10);
    }
    yield { type: 'done', modelId: null, cost: 0, latencyMs: 0, mode: 'general' };
    return;
  }

  // —— 转人工 ——
  if (intent === 'human') {
    const text = '好的，正在为你转接人工客服，请稍候～（服务时间 9:00-21:00）';
    addMessage(sessionId, { role: 'assistant', content: text });
    emitEvent('handoff.requested', { sessionId, reason: 'user_requested' });
    yield { type: 'human_handoff', message: text };
    yield { type: 'done', modelId: null, cost: 0, latencyMs: 0 };
    return;
  }

  // —— 越界/注入：明确说明能做什么，不执行、不泄露内部设定 ——
  if (intent === 'blocked') {
    const text = '这个我没法照做。我是售后客服助手，能帮你查订单、看物流、办理退换货、解答售后政策；其他问题也可以正常聊。';
    addMessage(sessionId, { role: 'assistant', content: text });
    for (const piece of chunkText(text, 4)) {
      yield { type: 'token', text: piece };
      if (!process.env.EVAL_FAST) await sleep(10);
    }
    yield { type: 'done', modelId: null, cost: 0, latencyMs: 0, blocked: true };
    return;
  }

  // —— 工具规划 + 写操作二次确认 ——
  let toolResults = [];
  let awaitingConfirm = false;

  if (confirm && session.pendingAction) {
    const pa = session.pendingAction;
    session.pendingAction = null;
    const def = getTool(pa.tool);
    try {
      const result = await def.handler(pa.args);
      toolResults.push({ name: pa.tool, args: pa.args, result });
      emitEvent('tool.executed', { tool: pa.tool, readonly: def.readonly, source: def.source || 'builtin', ok: result?.ok !== false });
      yield {
        type: 'tool', name: pa.tool, args: pa.args, result,
        action: buildAction(pa.tool, pa.args, result) || null,
      };
    } catch (err) {
      const result = { ok: false, error: `外部系统调用失败：${err.message}` };
      toolResults.push({ name: pa.tool, args: pa.args, result });
      emitEvent('tool.failed', { tool: pa.tool, error: err.message });
      yield { type: 'tool', name: pa.tool, args: pa.args, result, action: null };
    }
  } else {
    for (const tc of planTools(intent, message, extractOrderId(message) ? null : prior.orderId)) {
      const def = getTool(tc.name);
      if (!def) continue;

      // 参数不全（内置的订单号、外部的手机号等）：先追问，不带着空参数去调用
      if (tc.missing?.length) {
        const need = tc.missing.map((p) => PARAM_LABEL[p] || p).join('、');
        // 查询和办理的话术要区分：查询不需要"确认后办理"，那是写操作的说法
        const ask = def.readonly
          ? `好的，我来帮你${def.desc}。请提供${need}，我马上查。`
          : `好的，我来帮你${def.desc}。请提供${need}，我确认后为你办理。`;
        addMessage(sessionId, { role: 'assistant', content: ask });
        // 记下"正在等哪个参数"，下一轮用户只回订单号时才能接上
        session.pendingAsk = { intent, tool: tc.name, at: Date.now() };
        for (const piece of chunkText(ask, 4)) {
          yield { type: 'token', text: piece };
          if (!process.env.EVAL_FAST) await sleep(10);
        }
        yield {
          type: 'done', modelId: null, cost: 0, latencyMs: 0,
          needParams: tc.missing,
          needOrderId: tc.missing.includes('orderId'),
        };
        return;
      }

      if (!def.readonly) {
        session.pendingAction = { tool: tc.name, args: tc.args };
        awaitingConfirm = true;
        const summary = `即将执行【${def.desc}】${tc.args.orderId ? `，订单号 ${tc.args.orderId}` : ''}，是否确认？`;
        // 把确认请求也写进会话：否则下一轮模型只看到用户单方面说"我要退货"，
        // 接不上"系统已经问过是否确认"这件事
        addMessage(sessionId, { role: 'assistant', content: summary, mode: 'tool', intent });
        yield {
          type: 'confirm_request',
          tool: tc.name,
          args: tc.args,
          summary,
          action: buildConfirmAction(tc.name, tc.args) || null,
        };
      } else {
        try {
          const result = await def.handler(tc.args);
          toolResults.push({ name: tc.name, args: tc.args, result });
          emitEvent('tool.executed', {
            tool: tc.name, readonly: def.readonly, source: def.source || 'builtin',
            ok: result?.ok !== false,
          });
          yield {
            type: 'tool', name: tc.name, args: tc.args, result,
            action: buildAction(tc.name, tc.args, result) || null,
          };
        } catch (err) {
          const result = { ok: false, error: `外部系统调用失败：${err.message}` };
          toolResults.push({ name: tc.name, args: tc.args, result });
          emitEvent('tool.failed', { tool: tc.name, error: err.message });
          yield { type: 'tool', name: tc.name, args: tc.args, result, action: null };
        }
      }
    }
  }
  if (awaitingConfirm) {
    yield { type: 'done', modelId: null, cost: 0, latencyMs: 0, awaitingConfirm: true };
    return;
  }

  // —— RAG 检索 ——
  // 知识库是企业上传的真实文档，领域词表不可能覆盖全部说法（安装费、开票、价保…）。
  // 因此除工具动作外都先检索；未命中业务词表时加一道词面闸门，避免无关问题硬套政策。
  let retrieved = [];
  if (!toolResults.length && intent !== 'human' && intent !== 'blocked' && !classifyMeta(message)) {
    // 检索前剥离"你好/麻烦问下/在线等"这类寒暄：它们会稀释向量，也会让词面闸门误判为无依据
    const core = stripSocial(message) || message;
    const followCore = ctxDep ? followUpCore(core) : '';
    // "为什么/怎么会"这类追问要的是解释，不是再查一遍政策：
    // 硬拼上文去检索会把"为什么这么慢"匹配到发票文档，答非所问
    const explainOnly = ctxDep && /^(为什么|为啥|怎么会|然后呢|还有呢|嗯)/.test(core) && !looksLikeAction(core);

    if (!explainOnly) {
      // 省略式追问先按当前短语检索（"那退款呢"→"退款"），
      // 命中不了再把上一句拼进来，避免上文主题盖过这一句
      const direct = ctxDep && followCore ? followCore : core;
      retrieved = retrieve(direct, 3, { requireEvidence: intent !== 'faq' });
      if (!retrieved.length && ctxDep && prior.lastUser && followCore) {
        retrieved = retrieve(`${prior.lastUser} ${followCore}`, 3, { requireEvidence: intent !== 'faq' });
      }
      if (retrieved.length) yield { type: 'retrieval', snippets: retrieved };
    }
  }

  // —— 决定作答方式 ——
  const mode = decideAnswerMode({
    intent,
    retrievedCount: retrieved.length,
    hasToolResults: toolResults.length > 0,
  });

  // —— 智能模型路由 ——
  const { model, strategy: usedStrategy, reason, fallbacks } = router.select(complexity.level, session.strategy);
  yield {
    type: 'meta',
    intent,
    mode,
    complexity: complexity.level,
    complexityReason: complexity.reason,
    model: { id: model.id, name: model.name, tier: model.tier },
    strategy: usedStrategy,
    reason,
  };

  // —— 调用（带降级；已吐出内容后不再重试，避免重复输出）——
  const mockPlan = {
    mode,
    retrieved,
    toolResults,
    message,
    // 离线 Mock 也要能回答追问：把上一轮的问题与结论一起带下去
    context: {
      ...prior,
      ctxDep,
      focus: ctxDep ? followUpCore(stripSocial(message) || message) : '',
      carriedOrderId: extractOrderId(message) ? null : prior.orderId,
    },
    promptTokens: 90 + retrieved.length * 30,
  };
  const messages = buildMessages({ mode, message, retrieved, toolResults, history, historySummary });

  let usedModel = model;
  let usage = null;
  let emitted = false;
  let firstTokenMs = null;
  let answerText = '';
  const t0 = Date.now();

  const consume = async function* (m) {
    for await (const ev of streamModel({ model: m, messages, mockPlan })) {
      if (ev.type === 'delta') {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        emitted = true;
        answerText += ev.text;
        yield { type: 'token', text: ev.text };
      } else if (ev.type === 'usage') {
        usage = ev.usage;
      }
    }
  };

  try {
    yield* consume(model);
    router.reportSuccess(model);
  } catch (err) {
    router.reportFailure(model);
    // 记下最后一次失败原因：鉴权错与网络错给用户的提示必须不同，
    // 否则配错 Key 时会一直提示"稍后重试"，永远等不到结果
    let lastError = err;
    if (emitted) {
      // 已经输出部分内容，不能换模型重来，只能提示中断
      yield { type: 'error', message: '回答在中途中断了，请重试' };
      return;
    }
    let ok = false;
    for (const fb of fallbacks) {
      try {
        yield* consume(fb);
        usedModel = fb;
        router.reportSuccess(fb);
        yield { type: 'fallback', from: model.id, to: fb.id };
        ok = true;
        break;
      } catch (e) {
        lastError = e;
        router.reportFailure(fb);
      }
    }
    if (!ok) {
      const detail = String(lastError?.message || '');
      const authFail = /401|403|Authentication|invalid.*api.?key|鉴权|unauthorized/i.test(detail);
      logError('model.call_failed', { model: model.id, error: detail.slice(0, 300), authFail });
      yield {
        type: 'error',
        message: authFail
          ? '模型服务鉴权失败：请检查服务端配置的模型 API Key 是否有效'
          : '所有模型暂不可用，请稍后重试',
      };
      return;
    }
  }

  const latencyMs = Date.now() - t0;
  const prompt_tokens = usage?.prompt_tokens || mockPlan.promptTokens;
  const completion_tokens = usage?.completion_tokens || 120;
  const cost = router.estimateCost(usedModel, prompt_tokens, completion_tokens);

  logCall({
    sessionId, modelId: usedModel.id, modelName: usedModel.name,
    strategy: usedStrategy, complexity: complexity.level, mode,
    latencyMs, firstTokenMs, cost, tokens: prompt_tokens + completion_tokens,
  });

  // 成本计入当日额度，供 /api/chat 的护栏判断
  recordCost(cost);

  // 审计：一次对话的完整去向（模式、模型、成本、耗时）
  audit({
    action: 'chat.completed',
    target: sessionId,
    result: 'ok',
    meta: {
      mode, intent, model: usedModel.id, strategy: usedStrategy,
      cost, latencyMs, firstTokenMs,
      tools: toolResults.map((t) => t.name),
      retrieved: retrieved.length,
    },
  });

  // 会话完成事件：外部系统可据此做质检、埋点或工单回填
  emitEvent('answer.completed', {
    sessionId, mode, intent, model: usedModel.id,
    latencyMs, firstTokenMs, cost,
  });

  addMessage(sessionId, {
    role: 'assistant', content: answerText,
    modelId: usedModel.id, cost, mode, intent,
  });

  yield {
    type: 'done',
    modelId: usedModel.id,
    mode,
    cost: Number(cost.toFixed(6)),
    latencyMs,
    firstTokenMs,
    tokens: prompt_tokens + completion_tokens,
  };
}
