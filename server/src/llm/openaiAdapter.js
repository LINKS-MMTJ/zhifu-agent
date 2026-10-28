// OpenAI 兼容流式适配器：逐 token 透传 + 超时保护
// 适用于 DeepSeek / 通义 / Kimi / 智谱 等提供 OpenAI 兼容接口的服务

const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60_000);

/**
 * 以异步生成器流式产出增量
 * yield { type: 'delta', text }   增量文本
 * yield { type: 'usage', usage }  token 用量（若上游返回）
 *
 * 超时策略：整体超时 + 空闲超时（每次收到数据重置）。
 * 没有超时保护时，上游卡住会把连接和事件循环一起拖死，7×24 运行必然出问题。
 */
export async function* openaiStream({ model, messages, apiKey, tools }) {
  const body = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length && model.supportsTools) body.tools = tools;
  // DeepSeek V4.1 Flash 的 thinking 默认开启，客服场景显式关闭以降低延迟与成本
  if (model.thinking === false) body.thinking = { type: 'disabled' };

  const controller = new AbortController();
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('上游空闲超时')), TIMEOUT_MS);
    if (idleTimer.unref) idleTimer.unref();
  };

  resetIdle();
  try {
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`模型接口 ${res.status}：${detail.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        const delta = json.choices?.[0]?.delta;
        if (delta?.content) yield { type: 'delta', text: delta.content };
        // function calling：工具调用是增量下发的（name 只有第一帧有，arguments 要拼接）
        if (Array.isArray(delta?.tool_calls)) {
          for (const part of delta.tool_calls) {
            yield {
              type: 'tool_call_delta',
              index: part.index ?? 0,
              id: part.id,
              name: part.function?.name,
              argsText: part.function?.arguments,
            };
          }
        }
        if (json.usage) yield { type: 'usage', usage: json.usage };
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error('上游模型响应超时');
    }
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}
