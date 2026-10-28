// 离线 Mock 适配器：无需 API Key 即可跑通全流程
// 按回答模式组装拟真回复，并以流式增量产出（与真实模型接口一致）
//
// 说明：离线模式没有真实世界知识，因此通用对话只做"自然回应 + 能力引导"，
// 不编造事实；接入真实模型后同一套流程会给出完整答案。

import { ANSWER_MODE } from '../agent/answerPolicy.js';
import { META, classifyMeta } from '../agent/metaIntent.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 通用对话：按问法给出自然回应（先正面回答，确实不知道才说明） ——
// 注意：离线模式下没有真实世界知识，因此只对自己"确实会"的内容作答，
// 不做编造；接入真实模型后同一入口会给出完整答案。

// 简易四则运算：真的算出来，而不是含糊带过
// 只识别中文运算符与 ×÷，避免把日期（2026-10-27）误当算式
function tryArithmetic(t) {
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*(乘以|乘|加上|加|减去|减|除以|除|×|÷)\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[3]);
  const op = m[2];
  let r;
  if (/乘以|乘|×/.test(op)) r = a * b;
  else if (/加上|加/.test(op)) r = a + b;
  else if (/减去|减/.test(op)) r = a - b;
  else {
    if (b === 0) return '除数不能是 0 哦。';
    r = a / b;
  }
  const value = Number.isInteger(r) ? r : Number(r.toFixed(6));
  return `${a} ${op} ${b} = ${value}`;
}

// 追问：拿上一轮的回答接着聊，而不是重新开一段
// 离线模式没有真实世界知识，所以只复述刚才的结论并给出下一步，不编新事实
function followUpReply(message, context) {
  const last = String(context?.lastAnswer || '').trim();
  if (!last || !context?.ctxDep) return null;
  const t = String(message || '').trim();
  const snippet = last.replace(/\n+/g, ' ').slice(0, 90);
  if (/为什么|为啥|怎么会/.test(t)) {
    if (context?.lastMode === 'tool') {
      return `刚才查到的是：${snippet}\n具体为什么这样，要看这一单的实际处理记录；需要的话我可以帮你转人工核实。`;
    }
    return `刚才那个结论是按平台规则和订单数据给的，不是我猜的：${snippet}\n你是对哪一步有疑问？我可以再拆开说。`;
  }
  if (/多久|多长时间/.test(t)) {
    return `跟刚才说的是同一件事：${snippet}\n具体时效要看处理环节，如果是订单进度，我可以直接帮你查。`;
  }
  if (/怎么办|咋办/.test(t)) {
    return `接着刚才说：${snippet}\n如果这个处理方式不合适，我可以帮你转人工确认。`;
  }
  return `接着刚才的事说：${snippet}\n还有哪一点想细问？`;
}

function generalReply(message, model, context) {
  const t = String(message || '').trim();
  const verbose = model.tier === 'pro';

  // 0) 否定退货：针对性回应，而不是走通用兜底
  if (/不退了|不要退货|不想退|不用退|先不退|不需要退|别退/.test(t)) {
    return '好的，这次就先不退了～如果商品确实有问题，可以先拍张照片给我看看，或者随时说一声我帮你处理。';
  }

  // 0.5) 省略式追问：先接上文，再走通用逻辑
  const followUp = followUpReply(t, context);
  if (followUp) return followUp;

  // 元问题（关于助手自身）：交给统一的语义分类器判断，避免字面匹配漏判
  const meta = classifyMeta(t);

  if (meta === META.CAPABILITY) {
    return '我能帮你处理这些售后事项：\n· 查询订单状态\n· 查询物流轨迹\n· 办理退货 / 退款\n· 解答退换货、保修等政策\n\n直接说需求就行，比如「查一下订单 SO20260001」。';
  }

  if (meta === META.IDENTITY) {
    // 按子类给出不同表述，而不是同一段话反复复用
    if (/什么模型|哪个模型|用什么模型|基于什么|谁做的|谁开发|哪家公司/i.test(t)) {
      return '我是「智服」售后客服助手，底层是接入的大语言模型。具体用哪个模型由系统按任务自动选，简单问题用轻量模型、复杂办理用更强的模型。';
    }
    if (/你叫什么|什么名字|怎么称呼|有名字吗/.test(t)) {
      return '我叫智服，是这里的售后客服助手。有什么售后问题我可以帮你处理。';
    }
    if (/机器人|真人|是不是人|你是\s*ai|人工智能/i.test(t)) {
      return '是的，我是 AI 客服助手，不是真人。不过售后的事我基本都能办——查订单、看物流、退换货都可以直接找我。';
    }
    const base = '我是智服，一个电商售后客服助手，基于大语言模型的 AI，不是真人。';
    const more = verbose
      ? '我的强项是售后：查订单、看物流、办退换货、解答退换货和保修政策。遇到我处理不了的事，可以帮你转人工。'
      : '我的强项是售后：查订单、看物流、办退换货、解答政策。';
    return base + more;
  }

  if (meta === META.DATETIME) {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (/几点|时间/.test(t)) return `现在是 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hh}:${mm}（星期${week}）。`;
    return `今天是 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日，星期${week}。`;
  }

  if (meta === META.GREETING) {
    return '在的～我是智服的售后客服助手。查订单、看物流、办退换货都可以找我，也可以直接说遇到的问题。';
  }
  if (meta === META.THANKS) return '不客气～还有售后问题随时找我。';
  if (meta === META.BYE) return '再见～有售后问题随时回来找我。';

  // 算术：真算
  const calc = tryArithmetic(t);
  if (calc) return calc;

  // 兜底：自然说明，不套"不在服务范围"的话术
  return '这个我一时答不上来，就不乱猜了。售后这边我随时能帮上忙——查订单、看物流、办退换货都可以。';
}

// —— 工具结果转述 ——
function summarizeTool(tr, verbose) {
  const r = tr.result || {};
  switch (tr.name) {
    case 'queryOrder':
      if (r.found === false) return `没有直接找到该订单。${r.hint || ''}`;
      return `查到订单 ${r.orderId}：${r.product}，金额 ¥${r.amount}，当前状态【${r.status}】。${verbose ? `下单时间：${r.payTime || '—'}。` : ''}`;
    case 'trackLogistics':
      if (r.found === false) return '暂未查到该订单的物流信息。';
      return `订单 ${r.orderId} 的物流轨迹：\n${(r.traces || []).map((x) => `· ${x.time} ${x.desc}`).join('\n')}`;
    case 'createReturn':
      if (r.rejected) return `这笔订单暂时无法退货：${r.note}`;
      return `已为你发起退货申请，退货单号 ${r.returnId}，状态【${r.status}】。${r.note || ''}`;
    case 'applyRefund':
      return `已为你提交退款，金额 ¥${r.amount}，预计 ${r.eta} 原路退回。${r.note || ''}`;
    default:
      // 外部系统（CRM/工单等）返回结构不固定，做通用可读化处理
      if (r && r.ok === false) return `外部系统调用失败：${r.error || '未知错误'}，请稍后再试或转人工。`;
      if (r && r.ok && r.data && typeof r.data === 'object') {
        const d = r.data;
        if (d.name) {
          const tickets = (d.historyTickets || []).map((t) => `${t.type}（${t.status}）`).join('、');
          return `已从${r.source || '外部系统'}查到客户 ${d.name}（${d.level || '—'}），累计 ${d.totalOrders ?? 0} 单。${tickets ? `历史工单：${tickets}。` : '暂无历史工单。'}`;
        }
        if (d.id && d.status) return `已在${r.source || '外部系统'}创建工单 ${d.id}，状态【${d.status}】。`;
        return JSON.stringify(d).slice(0, 200);
      }
      return JSON.stringify(r);
  }
}

// 切块里保留了 Markdown 标题与列表符号（利于检索），转述成人话时要清掉；
// 首行若就是章节名，去掉——引用里已经写了，不必重复
function cleanChunk(text, section = '', title = '') {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  // 引用里已经写了文档标题与章节，正文开头的重复标题去掉
  while (lines.length > 1 && (lines[0] === section || lines[0] === title)) lines.shift();

  let out = '';
  for (const l of lines) {
    if (!out) out = l;
    else if (/[。！？；：]$/.test(out)) out += l;
    else out += `；${l}`;
  }
  return out;
}

function compose(plan, model) {
  const { mode, retrieved = [], toolResults = [], message, context } = plan;
  const verbose = model.tier === 'pro';
  const brief = model.tier === 'lite';

  if (mode === ANSWER_MODE.TOOL) {
    const text = toolResults.map((tr) => summarizeTool(tr, verbose)).filter(Boolean).join('\n');
    return brief ? text : `${text}\n\n还有其他需要帮忙的吗？`;
  }

  if (mode === ANSWER_MODE.RAG) {
    // 追问时优先引用"章节名就对上当前短语"的那一条：
    // "那退款呢"应引退款时效，而不是上一轮主题的退货运费
    const focus = String(context?.focus || '');
    const bySection = focus ? retrieved.find((r) => String(r.section || '').includes(focus)) : null;
    const byTitle = focus ? retrieved.find((r) => String(r.title || '').includes(focus)) : null;
    const top = bySection || byTitle || retrieved[0];
    const second = retrieved.find((r) => r !== top && r.title !== top.title);
    const cite = top.section ? `《${top.title}》「${top.section}」` : `《${top.title}》`;
    let text = `根据${cite}，${cleanChunk(top.text, top.section, top.title)}`;
    if (verbose && second) {
      text += `\n另外，《${second.title}》里也提到：${cleanChunk(second.text, second.section, second.title)}`;
    }
    if (!brief) text += '\n\n以上是平台政策，如遇特殊情况可以转人工确认。';
    // 追问时点明"接着刚才"，让用户知道上下文被接住了
    if (context?.ctxDep && context?.lastUser) text = `接着刚才的问题说，${text}`;
    return text;
  }

  return generalReply(message, model, context);
}

/**
 * 流式产出：与 openaiStream 保持一致的接口
 */
export async function* mockStream({ model, mockPlan }) {
  const text = compose(mockPlan || {}, model);
  const fast = process.env.EVAL_FAST === '1';

  if (!fast) await sleep(Math.min(model.latencyMs || 300, 500)); // 模拟首字延迟

  // 按码点切片，避免切断 emoji 等代理对
  const chars = Array.from(text);
  const SIZE = 4;
  for (let i = 0; i < chars.length; i += SIZE) {
    yield { type: 'delta', text: chars.slice(i, i + SIZE).join('') };
    if (!fast) await sleep(10);
  }

  const completion_tokens = Math.max(20, Math.round(text.length * 1.2));
  const prompt_tokens = mockPlan?.promptTokens || 90;
  yield { type: 'usage', usage: { prompt_tokens, completion_tokens } };
}
