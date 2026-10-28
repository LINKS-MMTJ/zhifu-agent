#!/usr/bin/env node
// 本地假 DeepSeek：OpenAI 兼容的流式接口，用于在没有真实 Key 时验证接入链路
//
// 它能验证的是"管道"：鉴权头、请求体字段（model / stream / stream_options / thinking）、
// SSE 增量解析、usage 统计、超时与失败降级。它不能验证模型本身答得好不好——
// 那必须用真实 Key 跑。
//
// 启动：node bench/mockDeepSeek.js [--port 4101] [--key demo-key]
// 配合：DEEPSEEK_API_KEY=demo-key DEEPSEEK_BASE_URL=http://127.0.0.1:4101/v1
import http from 'node:http';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const PORT = Number(arg('port', process.env.MOCK_DEEPSEEK_PORT || 4101));
const KEY = String(arg('key', process.env.MOCK_DEEPSEEK_KEY || 'demo-key'));
const SLOW_MS = Number(arg('slow', 8));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从提示词里还原出"资料 + 问题"，给出一个像样的回答，便于观察整条链路
function composeAnswer(body) {
  const messages = body.messages || [];
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const history = messages.filter((m) => m.role !== 'system');
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const turns = history.filter((m) => m.role === 'user').length;

  // 评委请求：真实模型会按 rubric 输出 JSON，假模型给固定分，仅用于验证评分链路
  if (lastUser.includes('请只输出一个 JSON 对象')) {
    return JSON.stringify({
      score: 4,
      dimensions: { 正确性: 4, 有据可依: 4, 工具使用: 4, 语气与合规: 4, 完整性: 3 },
      reason: '（假模型的占位评分，只验证评分链路，不代表真实质量）',
    });
  }

  const refs = system.split('\n').filter((l) => l.startsWith('- 《')).slice(0, 2);
  const refLine = refs.length ? refs[0].replace(/^- /, '') : '';
  const hasTool = system.includes('业务操作结果');

  if (hasTool) {
    return `（假 DeepSeek）已根据业务操作结果整理：${lastUser} 对应的办理结果见上方记录，金额与单号均以返回值为准。`;
  }
  if (refLine) {
    return `（假 DeepSeek）按资料回答：${refLine}。这是第 ${turns} 轮对话，已结合前文理解你说的指代。`;
  }
  return `（假 DeepSeek）收到：「${lastUser}」。当前没有命中知识片段，也没有调用工具，这是第 ${turns} 轮对话。`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'mock-deepseek' }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || auth.slice(7).trim() !== KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } }));
    return;
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json' } }));
      return;
    }

    const answer = composeAnswer(body);

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: Math.round(answer.length * 1.2) },
      }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 与真实 DeepSeek 一致：逐块 delta，最后一条 usage，再 [DONE]
    const chars = Array.from(answer);
    for (let i = 0; i < chars.length; i += 6) {
      const payload = {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { content: chars.slice(i, i + 6).join('') }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      await sleep(SLOW_MS);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: Math.round(answer.length * 1.2) } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-deepseek] 监听 http://127.0.0.1:${PORT}/v1  key=${KEY}`);
});
