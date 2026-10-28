// 白盒测试：外部系统集成（连接器 / 参数抽取 / 签名 / 事件）
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sign, verify } from '../../src/integrations/signature.js';
import { extractArgs, loadConnectors, buildTools, callConnector } from '../../src/integrations/connectors.js';
import { registerTool, getTool, matchToolByTrigger, listTools } from '../../src/tools/registry.js';

let server;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers.authorization || '';

      if (url.pathname === '/customers/13800001234') {
        if (auth !== 'Bearer test-token') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'unauthorized' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ phone: '13800001234', name: '张伟' }));
      }
      if (url.pathname === '/tickets' && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'T-1', status: '待处理', echo: JSON.parse(body || '{}') }));
      }
      if (url.pathname === '/flaky') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'boom' }));
      }
      if (url.pathname === '/slow') {
        return setTimeout(() => { res.writeHead(200); res.end('{}'); }, 300);
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => { await new Promise((r) => server.close(r)); });

const makeConnector = (over = {}) => ({
  id: 'test',
  name: '测试系统',
  baseUrl: `http://127.0.0.1:${port}`,
  auth: { type: 'bearer', token: 'test-token' },
  timeoutMs: 2000,
  retries: 1,
  tools: [],
  _stat: { ok: 0, fail: 0, lastAt: null, lastStatus: null, lastError: '' },
  ...over,
});

test('签名: 生成与校验一致，篡改后失败', () => {
  const s = sign('secret', '{"a":1}');
  assert.equal(s.length, 64);
  assert.equal(verify('secret', '{"a":1}', s), true);
  assert.equal(verify('secret', '{"a":2}', s), false);
  assert.equal(verify('wrong', '{"a":1}', s), false);
  assert.equal(verify('secret', '{"a":1}', ''), false);
  assert.equal(verify('secret', '{"a":1}', `sha256=${s}`), true);
});

test('参数抽取: 从自然语言里取手机号', () => {
  const { args, missing } = extractArgs(
    { phone: { in: 'path', required: true, extract: '1[3-9]\\d{9}' } },
    '帮我查一下 13800001234 的客户档案'
  );
  assert.equal(args.phone, '13800001234');
  assert.equal(missing.length, 0);
});

test('参数抽取: 缺必填参数时返回 missing', () => {
  const { missing } = extractArgs(
    { phone: { in: 'path', required: true, extract: '1[3-9]\\d{9}' } },
    '帮我查一下客户档案'
  );
  assert.deepEqual(missing, ['phone']);
});

test('参数抽取: 可选参数用默认值', () => {
  const { args } = extractArgs(
    { subject: { in: 'body', default: '用户申请售后' } },
    '提个工单'
  );
  assert.equal(args.subject, '用户申请售后');
});

test('连接器: GET 请求带鉴权头与路径参数', async () => {
  const c = makeConnector();
  const tool = {
    name: 'getCustomer', desc: '查客户', readonly: true, method: 'GET', path: '/customers/{phone}',
    params: { phone: { in: 'path', required: true } },
  };
  const res = await callConnector(c, tool, { phone: '13800001234' });
  assert.equal(res.ok, true);
  assert.equal(res.data.name, '张伟');
});

test('连接器: 401 不重试（重试无意义）', async () => {
  const c = makeConnector({ auth: { type: 'bearer', token: 'bad' } });
  const tool = { name: 'getCustomer', method: 'GET', path: '/customers/{phone}', params: { phone: { in: 'path' } } };
  const res = await callConnector(c, tool, { phone: '13800001234' });
  assert.equal(res.status, 401);
  assert.equal(res.attempts, 1);
});

test('连接器: 5xx 会重试', async () => {
  const c = makeConnector();
  const tool = { name: 'flaky', method: 'GET', path: '/flaky', params: {} };
  const res = await callConnector(c, tool, {});
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 2);
  assert.equal(c._stat.fail, 1);
});

test('连接器: 超时被中断', async () => {
  const c = makeConnector({ timeoutMs: 50, retries: 0 });
  const tool = { name: 'slow', method: 'GET', path: '/slow', params: {} };
  const res = await callConnector(c, tool, {});
  assert.equal(res.ok, false);
  assert.match(res.error, /超时|abort/i);
});

test('连接器: POST 把参数放进 JSON body', async () => {
  const c = makeConnector();
  const tool = {
    name: 'createTicket', method: 'POST', path: '/tickets', readonly: false,
    params: { phone: { in: 'body' }, orderId: { in: 'body' }, subject: { in: 'body' } },
  };
  const res = await callConnector(c, tool, { phone: '13800001234', orderId: 'SO20260001', subject: '退货' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.echo, { phone: '13800001234', orderId: 'SO20260001', subject: '退货' });
});

test('连接器: 配置里的 ${ENV} 会被展开，缺 baseUrl 时禁用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intg-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
    id: 'a', name: 'A', baseUrl: '${TEST_BASE_URL}', tools: [],
  }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({
    id: 'b', name: 'B', baseUrl: '${NOT_SET_BASE_URL}', tools: [],
  }));
  process.env.TEST_BASE_URL = 'https://example.com';
  const list = loadConnectors(dir);
  assert.equal(list.find((x) => x.id === 'a').enabled, true);
  assert.equal(list.find((x) => x.id === 'a').baseUrl, 'https://example.com');
  assert.equal(list.find((x) => x.id === 'b').enabled, false);
  delete process.env.TEST_BASE_URL;
});

test('工具注册: 外部工具可注册并按触发词命中', () => {
  const defs = buildTools([makeConnector({
    tools: [{
      name: 'crmPing', desc: '查客户档案', readonly: true,
      triggers: ['客户档案'], method: 'GET', path: '/customers/{phone}',
      params: { phone: { in: 'path', required: true, extract: '1[3-9]\\d{9}' } },
    }],
  })]);
  assert.equal(defs.length, 1);
  registerTool(defs[0]);

  assert.ok(getTool('crmPing'));
  assert.equal(getTool('crmPing').source, 'integration:test');
  assert.equal(matchToolByTrigger('帮我查一下客户档案')?.name, 'crmPing');
  assert.equal(matchToolByTrigger('我要退货'), null);
  assert.ok(listTools().some((t) => t.name === 'crmPing'));
});

test('工具注册: 非法定义直接拒绝', () => {
  assert.throws(() => registerTool({ name: 'x' }), /name 与 handler/);
  assert.throws(() => registerTool(null), /name 与 handler/);
});
