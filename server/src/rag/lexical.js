// 词面支持度：给向量检索加一道"证据闸门"
//
// 背景：轻量哈希向量对中文短句的区分度有限，无关问题也可能拿到 0.2~0.3 的相似度，
// 单靠余弦阈值会把"推荐一本书"错判成知识库问题。这里用"查询实字在命中块中的覆盖率"
// 做二次确认——真正相关的块通常覆盖大部分实字，无关块只能蹭到个别常用字。
//
// 注意：只在意图未命中业务词表时才启用，避免对"东西坏了怎么办"这类同义改写过严。

const STOP_CHARS = new Set(
  Array.from('的了吗呢吧啊呀哦嗯么样啥呗啦嘛是我你您他她它们这那哪个什怎如何几多少能可会要就都也还很太有没有在和与及或请帮给让把被对从到为以于之其而且但不过如果因为所以先再又只更最')
);

function isCjk(ch) {
  return /[\u4e00-\u9fa5]/.test(ch);
}

// 取查询中的"实字"：汉字去掉停用字；订单号/英文型号不参与覆盖率计算（噪声过大）
export function queryChars(text) {
  const raw = String(text || '');
  const out = new Set();
  for (const ch of raw) {
    if (isCjk(ch) && !STOP_CHARS.has(ch)) out.add(ch);
  }
  return [...out];
}

// 文档集合中是否存在"实字覆盖足够"的块
// 阈值取 0.75：真正相关的块通常覆盖绝大多数实字（"安装收高空作业费吗" 8/8），
// 无关问题只能蹭到个别常用字（"一年有多少天" 只命中"年/天"）
// 实字少于 2 个时信息量太低，直接判定为"无依据"——否则"1+1等于几"会靠"等于"误命中；
// 但"发票""退货"这类两字短查询是有效业务词，仍需放行
export function hasLexicalSupport(query, docs, threshold = 0.75) {
  const chars = queryChars(query);
  if (chars.length < 2) return false;

  for (const d of docs) {
    const text = `${d.title || ''}${d.headingPath || ''}${d.text || ''}`;
    let hit = 0;
    for (const ch of chars) {
      if (text.includes(ch)) hit++;
    }
    if (hit / chars.length >= threshold) return true;
  }
  return false;
}
