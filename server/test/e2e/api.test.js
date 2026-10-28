// 黑盒测试：HTTP 接口与 SSE 对话（不关心内部实现，只看对外行为）
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chat, first, textOf, sid } from '../helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const get = (p) => fetch(`http://127.0.0.1:${srv.port}${p}`);
const post = (p, body) => fetch(`http://127.0.0.1:${srv.port}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// —— 基础接口 ——
test('GET /api/health 返回健康状态', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.ok(d.models >= 1);
});

test('GET /api/knowledge 公开接口只给规模统计，不暴露文档清单', async () => {
  const d = await (await get('/api/knowledge')).json();
  assert.ok(d.docsCount >= 6);
  assert.ok(d.chunks >= 6);
  assert.equal(d.docs, undefined, '文档清单属于内部信息，不应出现在公开接口');
  assert.equal(d.vectorBackend.backend, 'memory', '默认使用内存向量后端');
});

test('身份: 未开启强制鉴权时签发接口返回空令牌（前端不需要带 Authorization）', async () => {
  const d = await (await post('/api/auth/guest', {})).json();
  assert.equal(d.enforced, false);
  assert.equal(d.token, '');
});

test('GET /api/knowledge 管理接口返回完整文档清单', async () => {
  const d = await (await get('/api/admin/knowledge')).json();
  assert.ok(d.docs.length >= 6);
  assert.ok(d.docs[0].content.length > 0);
});

test('未知 /api 路径返回 404', async () => {
  const r = await get('/api/not-exist');
  assert.equal(r.status, 404);
});

test('POST /api/admin/strategy 非法取值返回 400', async () => {
  const r = await post('/api/admin/strategy', { strategy: 'garbage' });
  assert.equal(r.status, 400);
});

test('POST /api/admin/strategy 合法取值生效', async () => {
  const r = await post('/api/admin/strategy', { strategy: 'price' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).strategy, 'price');
  await post('/api/admin/strategy', { strategy: 'auto' }); // 复原
});

// —— 对话：非业务问题 ——
test('对话: 非业务问题走通用对话并正常回答', async () => {
  const events = await chat(srv.port, { sessionId: sid('oos'), message: '你是谁' });
  const meta = first(events, 'meta');
  assert.equal(meta.mode, 'general');
  assert.equal(meta.intent, 'out_of_scope');
  assert.ok(textOf(events).length > 10, '应有实质回答');
  assert.ok(!textOf(events).includes('不在我的服务范围'), '不应出现硬拒话术');
  assert.ok(first(events, 'done'));
});

// —— 外部集成：工具目录 / 直接调用 / 事件 ——
test('GET /api/tools 列出内置与外部工具', async () => {
  const d = await (await get('/api/tools')).json();
  const names = d.tools.map((t) => t.name);
  assert.ok(names.includes('queryOrder'));
  assert.ok(names.includes('createReturn'));
  assert.ok(d.tools.every((t) => typeof t.readonly === 'boolean'));
});

test('POST /api/tools 未知工具返回 404', async () => {
  const r = await post('/api/tools/notARealTool', {});
  assert.equal(r.status, 404);
});

test('POST /api/tools 写操作未确认时拒绝', async () => {
  const r = await post('/api/tools/createReturn', { orderId: 'SO20260001' });
  assert.equal(r.status, 409);
  const d = await r.json();
  assert.equal(d.needConfirm, true);
});

test('POST /api/tools 确认后执行写操作', async () => {
  const r = await post('/api/tools/createReturn', { orderId: 'SO20260001', confirm: true });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.result.returnId, /^RT\d+/);
});

test('POST /api/tools 只读工具可直接调用', async () => {
  const r = await post('/api/tools/queryOrder', { orderId: 'SO20260002' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.result.found, true);
});

test('POST /api/integrations/events 接收外部事件并可在集成页看到', async () => {
  const r = await post('/api/integrations/events', {
    type: 'order.delayed', data: { orderId: 'SO20260001' }, sessionId: sid('evt'),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).type, 'order.delayed');

  const info = await (await get('/api/integrations')).json();
  assert.ok(Array.isArray(info.connectors));
  assert.ok(info.events.inbound.some((e) => e.type === 'order.delayed'));
});

// —— 管理接口鉴权 ——
test('管理接口: 配置 ADMIN_TOKEN 后需带令牌，webhook 例外', async () => {
  process.env.ADMIN_TOKEN = 'e2e-admin-token';
  try {
    const deny = await get('/api/admin/models');
    assert.equal(deny.status, 401);
    assert.equal((await deny.json()).needToken, true);

    const toolsDeny = await get('/api/tools');
    assert.equal(toolsDeny.status, 401);

    const allow = await fetch(`http://127.0.0.1:${srv.port}/api/admin/models`, {
      headers: { 'x-admin-token': 'e2e-admin-token' },
    });
    assert.equal(allow.status, 200);

    // 入站 webhook 用 HMAC 验签，不应被管理令牌拦住
    const evt = await post('/api/integrations/events', { type: 'ping' });
    assert.equal(evt.status, 200);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

// —— 运行期指标与审计 ——
test('GET /api/admin/metrics 含配额与存储状态', async () => {
  const d = await (await get('/api/admin/metrics')).json();
  assert.ok(d.quota && typeof d.quota.spent === 'number');
  assert.ok(d.store && typeof d.store.sessions === 'number');
  assert.equal(typeof d.store.persisted, 'boolean');
});

test('GET /api/admin/audit 在未初始化时返回空列表而不是报错', async () => {
  const r = await get('/api/admin/audit?limit=5');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.enabled, false);
  assert.deepEqual(d.entries, []);
});

test('响应头带回 traceId，便于跨系统排障', async () => {
  const r = await get('/api/health');
  assert.ok(r.headers.get('x-request-id'));
});

// —— 对话：政策咨询走 RAG ——
test('对话: 政策咨询命中知识库并给出引用', async () => {
  const events = await chat(srv.port, { sessionId: sid('faq'), message: '退货运费谁出？' });
  const meta = first(events, 'meta');
  assert.equal(meta.mode, 'rag');
  assert.equal(meta.intent, 'faq');
  const ret = first(events, 'retrieval');
  assert.ok(ret && ret.snippets.length > 0, '应返回检索片段');
  // 语料里既有政策原文也有帮助中心导出页，只要命中内容与"退货运费"相关即可
  const top = ret.snippets[0];
  assert.ok(
    `${top.title}${top.section || ''}`.includes('退货') || top.text.includes('运费'),
    `引用应指向退货运费相关章节，实际：${top.title} / ${top.section} / ${top.text.slice(0, 40)}`
  );
});

// —— 对话：查订单返回工具结果与业务入口 ——
test('对话: 查订单返回工具结果 + 一键跳转入口', async () => {
  const events = await chat(srv.port, { sessionId: sid('ord'), message: '查一下订单 SO20260001' });
  const tool = first(events, 'tool');
  assert.equal(tool.name, 'queryOrder');
  assert.equal(tool.result.found, true);
  assert.equal(tool.action.type, 'order');
  assert.equal(tool.action.orderId, 'SO20260001');
  assert.equal(first(events, 'meta').mode, 'tool');
});

test('对话: 查物流返回物流业务入口', async () => {
  const events = await chat(srv.port, { sessionId: sid('log'), message: '看看 SO20260001 的物流' });
  const tool = first(events, 'tool');
  assert.equal(tool.name, 'trackLogistics');
  assert.equal(tool.action.type, 'logistics');
});

// —— 对话：写操作二次确认 ——
test('对话: 退货先请求确认，不直接执行', async () => {
  const sessionId = sid('ret');
  const events = await chat(srv.port, { sessionId, message: '我要退货，订单号 SO20260001' });
  const confirm = first(events, 'confirm_request');
  assert.ok(confirm, '应请求确认');
  assert.equal(confirm.tool, 'createReturn');
  assert.equal(confirm.action.type, 'return');
  assert.equal(first(events, 'tool'), undefined, '确认前不应执行工具');
});

test('对话: 确认后真正执行退货', async () => {
  const sessionId = sid('ret2');
  await chat(srv.port, { sessionId, message: '我要退货，订单号 SO20260001' });
  const events = await chat(srv.port, { sessionId, message: '确认', confirm: true });
  const tool = first(events, 'tool');
  assert.ok(tool, '确认后应执行');
  assert.equal(tool.name, 'createReturn');
  assert.match(tool.result.returnId, /^RT\d+/);
});

test('对话: 写操作缺订单号时先追问，不生成确认', async () => {
  const events = await chat(srv.port, { sessionId: sid('noord'), message: '我要退货' });
  assert.equal(first(events, 'confirm_request'), undefined, '缺订单号不应直接确认');
  const done = first(events, 'done');
  assert.equal(done.needOrderId, true);
  assert.match(textOf(events), /订单号/);
});

test('对话: 追问订单号后，用户只回订单号也能接着查', async () => {
  const sessionId = sid('ask-flow');
  const firstRound = await chat(srv.port, { sessionId, message: '帮我查一下订单' });
  assert.equal(first(firstRound, 'tool'), undefined);
  assert.equal(first(firstRound, 'done').needOrderId, true);

  const secondRound = await chat(srv.port, { sessionId, message: 'SO20260001' });
  const tool = first(secondRound, 'tool');
  assert.ok(tool, '补上订单号后应执行查询');
  assert.equal(tool.name, 'queryOrder');
  assert.equal(tool.args.orderId, 'SO20260001');
  assert.match(textOf(secondRound), /已签收/);
});

test('对话: 追问订单号后，用户回手机号也能查到单', async () => {
  const sessionId = sid('ask-phone');
  await chat(srv.port, { sessionId, message: '帮我查下物流' });
  const secondRound = await chat(srv.port, { sessionId, message: '13800001234' });
  const tool = first(secondRound, 'tool');
  assert.ok(tool, '手机号应能作为查询条件');
  assert.equal(tool.args.phone, '13800001234');
});

test('对话: 查询类缺订单号同样先追问，不空参调用工具', async () => {
  const events = await chat(srv.port, { sessionId: sid('noord-q'), message: '你好我需要你帮我进行查询订单' });
  assert.equal(first(events, 'tool'), undefined, '缺订单号不应调用工具');
  const done = first(events, 'done');
  assert.equal(done.needOrderId, true);
  const text = textOf(events);
  assert.match(text, /请提供订单号/);
  assert.match(text, /我马上查/);
  // 追问话术不应出现"确认后办理"这类写操作说法
  assert.ok(!/确认后为你办理/.test(text));
  // 更不能把内部演示订单号回给用户
  assert.ok(!/SO2026000[123]/.test(text), '不得泄露演示订单号');
});

test('对话: 日期问题用服务端时间回答，不交给模型猜', async () => {
  const events = await chat(srv.port, { sessionId: sid('dt'), message: '今天几号' });
  const text = textOf(events);
  const now = new Date();
  assert.match(text, new RegExp(`${now.getFullYear()} 年`), '应给出当前年份');
  const meta = first(events, 'meta');
  assert.equal(meta.mode, 'general');
  assert.equal(meta.model.id, 'local', '应由本地直接作答，不调用模型');
});

test('对话: 入参校验（空消息 / 超长消息 / 非法 sessionId）', async () => {
  const empty = await post('/api/chat', { sessionId: sid('v'), message: '   ' });
  assert.equal(empty.status, 400);

  const tooLong = await post('/api/chat', { sessionId: sid('v'), message: '退'.repeat(4001) });
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).error, /过长/);

  const badSid = await post('/api/chat', { sessionId: '../../etc/passwd', message: '你好' });
  assert.equal(badSid.status, 400);
  assert.match((await badSid.json()).error, /sessionId/);
});

test('接口: 基础安全响应头存在', async () => {
  const r = await get('/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-powered-by'), null);
});

// —— 业务页面接口 ——
test('GET /api/biz/orders/:id 返回订单详情', async () => {
  const r = await get('/api/biz/orders/SO20260001');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.orderId, 'SO20260001');
  assert.ok(d.traces.length >= 1);
});

test('GET /api/biz/orders/:id 不存在时 404', async () => {
  assert.equal((await get('/api/biz/orders/NOPE')).status, 404);
});

test('POST /api/biz/orders/:id/return 可办理订单成功', async () => {
  const r = await post('/api/biz/orders/SO20260001/return', { reason: '质量问题' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.returnId, /^RT\d+/);
});

test('POST /api/biz/orders/:id/return 不可退订单返回 409', async () => {
  const r = await post('/api/biz/orders/SO20260002/return', {});
  assert.equal(r.status, 409);
});

test('POST /api/biz/orders/:id/refund 返回退款信息', async () => {
  const r = await post('/api/biz/orders/SO20260003/refund', {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).amount, 89);
});

// —— 管理接口 ——
test('GET /api/admin/cost 返回聚合结构', async () => {
  const d = await (await get('/api/admin/cost')).json();
  assert.ok(typeof d.totalCalls === 'number');
  assert.ok(Array.isArray(d.byModel));
});

test('GET /api/admin/models 返回策略与模型列表', async () => {
  const d = await (await get('/api/admin/models')).json();
  assert.ok(Array.isArray(d.models));
  assert.ok(d.models.length >= 1);
  assert.ok(d.models[0].estimatedCostPerCall >= 0);
});
