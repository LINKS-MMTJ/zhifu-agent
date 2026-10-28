// 白盒测试：OpenAI 兼容适配器（DeepSeek 接入的实际传输层）
// 用本地假服务验证请求体、SSE 解析、usage 统计与错误处理，不依赖真实 Key。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function startFake(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function collect(stream) {
  const deltas = [];
  let usage = null;
  for await (const ev of stream) {
    if (ev.type === 'delta') deltas.push(ev.text);
    else if (ev.type === 'usage') usage = ev.usage;
  }
  return { text: deltas.join(''), deltas: deltas.length, usage };
}

const MODEL = (baseUrl) => ({
  id: 'deepseek-flash',
  baseUrl,
  supportsTools: true,
  thinking: false,
});

test('适配器: 请求体带 model / stream / usage 选项，并关闭 thinking', async () => {
  let captured = null;
  const fake = await startFake((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      captured = { auth: req.headers.authorization, body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  const { openaiStream } = await import('../../src/llm/openaiAdapter.js');
  await collect(openaiStream({
    model: MODEL(fake.baseUrl),
    messages: [{ role: 'user', content: '你好' }],
    apiKey: 'sk-test-123',
    tools: [{ type: 'function', function: { name: 'queryOrder' } }],
  }));

  assert.equal(captured.auth, 'Bearer sk-test-123');
  assert.equal(captured.body.model, 'deepseek-flash');
  assert.equal(captured.body.stream, true);
  assert.deepEqual(captured.body.stream_options, { include_usage: true });
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });
  assert.equal(captured.body.tools.length, 1);
  await fake.close();
});

test('适配器: 逐块增量正确拼接，usage 单独产出', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"退货"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"运费"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"由商家承担"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":33,"completion_tokens":11}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  const { openaiStream } = await import('../../src/llm/openaiAdapter.js');
  const out = await collect(openaiStream({
    model: MODEL(fake.baseUrl), messages: [], apiKey: 'k',
  }));

  assert.equal(out.text, '退货运费由商家承担');
  assert.equal(out.deltas, 3);
  assert.deepEqual(out.usage, { prompt_tokens: 33, completion_tokens: 11 });
  await fake.close();
});

test('适配器: 跨网络分片（半行 JSON）也能正确解析', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 故意把一行 SSE 拆成两段写，模拟 TCP 分包
      res.write('data: {"choices":[{"delta":{"con');
      setTimeout(() => {
        res.write('tent":"分包正常"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 20);
    });
  });

  const { openaiStream } = await import('../../src/llm/openaiAdapter.js');
  const out = await collect(openaiStream({
    model: MODEL(fake.baseUrl), messages: [], apiKey: 'k',
  }));
  assert.equal(out.text, '分包正常');
  await fake.close();
});

test('适配器: 鉴权失败时抛出带状态码的错误（便于上层降级）', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
    });
  });

  const { openaiStream } = await import('../../src/llm/openaiAdapter.js');
  await assert.rejects(
    collect(openaiStream({ model: MODEL(fake.baseUrl), messages: [], apiKey: 'bad' })),
    (err) => {
      assert.match(err.message, /401/);
      assert.match(err.message, /Authentication/);
      return true;
    },
  );
  await fake.close();
});

test('适配器: 上游长时间无响应时按超时中断', async () => {
  process.env.UPSTREAM_TIMEOUT_MS = '300';
  const fake = await startFake((req, res) => {
    req.resume();
    // 只发头不回数据，模拟上游卡住
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
  });

  const { openaiStream } = await import(`../../src/llm/openaiAdapter.js?timeout=${Date.now()}`);
  await assert.rejects(
    collect(openaiStream({ model: MODEL(fake.baseUrl), messages: [], apiKey: 'k' })),
    (err) => /超时/.test(err.message),
  );
  delete process.env.UPSTREAM_TIMEOUT_MS;
  await fake.close();
});
