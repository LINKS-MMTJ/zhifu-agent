// 元问题识别：用户不是在问业务，而是在问"你是谁/你能干什么/现在几点"这类关于助手自身的问题
//
// 为什么单独抽出来：
// 早期版本用一串字面关键词（"能做什么|会做什么|…"）在回复模板里匹配，
// 用户换个说法（"你都能帮我干嘛""有什么可以帮我的""你能提供什么帮助"）就漏判，
// 结果掉进兜底话术，体验很差。
// 这里改为按"语义要素组合"判断（人称 + 能力词 + 疑问词），对同义改写更稳。

export const META = {
  IDENTITY: 'identity',     // 你是谁 / 你叫什么 / 你是不是 AI
  CAPABILITY: 'capability', // 你能干什么 / 有什么可以帮我的
  DATETIME: 'datetime',     // 今天几号 / 现在几点
  GREETING: 'greeting',     // 你好 / 在吗
  THANKS: 'thanks',         // 谢谢
  BYE: 'bye',               // 再见
};

// —— 语义要素 ——
const PRONOUN = /你|您|你们/;                       // 指向助手自身
const ABILITY = /能|会|可以|可不可以|支持|擅长|负责|提供|帮|处理|解决|办理|做|用/;
const WH = /什么|啥|哪些|哪方面|哪些方面|干嘛|怎么用|用法|功能|帮助|忙|问题|范围|本事|本领/;
const IDENTITY_CORE = /是谁|叫什么|什么名字|哪个模型|什么模型|真人|机器人|人工智能|是不是人|谁开发|谁做的|哪家公司|介绍一下你|介绍下你|你是什么(?!时候|时间|价位|价格|意思)/;

// 寒暄前缀/后缀：只用于"剥离"，剥离后若还有实质内容，就不算寒暄
const SOCIAL_PREFIX = /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不在|有人吗|请问|请教一下|打扰一下|麻烦(你)?(问|咨询|看)?(一下|下)?|问一下|问下)[\s，,。.!！~～、…]*/i;
// 口语填充词：对了、那个…、嘿，这类开头不影响真实意图
const LEAD_FILLER = /^(对了|那个|这个|话说|另外|还有|嗯+|呃+|嘿+|诶+|哎+|哦+|好的|行|ok)[\s，,。.!！~～、…]*/i;
const SOCIAL_SUFFIX = /[\s，,。.!！~～、…]*(谢谢|多谢|感谢|辛苦了?|thanks|thx|，?在线等|急)[\s，,。.!！~～、…]*/i;

export function stripSocial(text) {
  let out = String(text || '').trim();
  // 反复剥离，处理"对了，你好，你能做什么"这类叠加
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEAD_FILLER, '').replace(SOCIAL_PREFIX, '').trim();
    if (next === out) break;
    out = next;
  }
  return out.replace(SOCIAL_SUFFIX, '').trim();
}

// 纯寒暄/致谢/告别：即使剥离后还剩两个字，也不算"有实质内容"
const PURE_SOCIAL = /^(再见|拜拜|bye|回头聊|下次聊|谢谢|多谢|感谢|辛苦了?|你好|您好|在吗|在不在|嗨|哈喽|hi|hello|好的|好吧|嗯+|哦+|ok)[\s，,。.!！~～、]*$/i;

/**
 * @param {string} text
 * @returns {string|null} META 之一，未命中返回 null
 */
export function classifyMeta(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  // "你好，发货要多久？" 不是寒暄，而是一个带礼貌前缀的业务问题
  const core = stripSocial(t);
  const hasSubstance = core.length >= 2 && !PURE_SOCIAL.test(core);

  if (hasSubstance) {
    const hasPronoun = PRONOUN.test(core);
    const hasAbility = ABILITY.test(core);
    const hasWh = WH.test(core);

    // 能力类优先判定：三种等价形态
    const capabilityHit =
      (hasPronoun && hasAbility && hasWh) ||            // 你能帮我做什么 / 你都支持什么
      (hasAbility && hasWh && /帮|做|提供/.test(core)) || // 能帮上什么忙 / 有什么可以帮我的
      (hasPronoun && /功能|用法|怎么用|本事|本领|范围/.test(core)); // 介绍一下你的功能
    if (capabilityHit) return META.CAPABILITY;

    // 身份类
    if (IDENTITY_CORE.test(core) || /你是\s*(ai|a\.i\.)/i.test(core)) return META.IDENTITY;

    // 日期时间
    if (/今天.*(几号|几月|日期|星期几|周几)|现在.*(几点|时间)|当前(时间|日期)/.test(core)) return META.DATETIME;

    return null;
  }

  // 问候 / 致谢 / 告别：只在剥离寒暄后没有实质内容时成立
  // 这里用 contains 而不是开头匹配，兼容"嘿，在吗""对了，谢谢啊"这类口语前缀
  if (/谢谢|多谢|感谢|辛苦|thanks|thx/i.test(t)) return META.THANKS;
  if (/再见|拜拜|bye|回头聊|下次聊/i.test(t)) return META.BYE;
  if (/你好|您好|hi|hello|嗨|哈喽|在吗|在不在|有人吗/i.test(t)) return META.GREETING;

  return null;
}
