// 假的 CRM / 工单系统，用来验证连接器与 webhook 是真的走 HTTP，而不是本地函数调用
//
// 启动：node bench/mockCrm.js
// 接口：
//   GET  /customers/:phone   客户档案 + 历史工单
//   POST /tickets            创建工单（校验 Bearer Token）
//   POST /events            接收 Agent 的出站事件（打印并校验签名头是否存在）
//   GET  /health
import http from 'node:http';

const PORT = Number(process.env.MOCK_CRM_PORT || 4100);
const TOKEN = process.env.CRM_TOKEN || 'demo-token';

const CUSTOMERS = {
  13800001234: {
    phone: '13800001234',
    name: '张伟',
    level: '黄金会员',
    joinedAt: '2023-04-18',
    totalOrders: 37,
    historyTickets: [
      { id: 'T-20260812-01', type: '退货', status: '已完结', at: '2026-08-12' },
      { id: 'T-20260930-02', type: '物流延迟', status: '已完结', at: '2026-09-30' },
    ],
  },
  13900005678: {
    phone: '13900005678',
    name: '李娜',
    level: '普通会员',
    joinedAt: '2025-11-02',
    totalOrders: 4,
    historyTickets: [],
  },
};

let seq = 0;
const tickets = [];

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({ raw }); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/health') return json(res, 200, { ok: true, service: 'mock-crm' });

  if (pathname.startsWith('/customers/') && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(res, 401, { error: 'invalid token' });
    }
    const phone = decodeURIComponent(pathname.split('/').pop());
    const c = CUSTOMERS[phone];
    if (!c) return json(res, 404, { error: 'customer not found' });
    return json(res, 200, { ...c, openTickets: tickets.filter((t) => t.phone === phone) });
  }

  if (pathname === '/tickets' && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(res, 401, { error: 'invalid token' });
    }
    const body = await readBody(req);
    if (!body.phone) return json(res, 400, { error: 'phone required' });
    seq++;
    const ticket = {
      id: `T-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(2, '0')}`,
      phone: body.phone,
      orderId: body.orderId || '',
      subject: body.subject || '用户申请售后',
      status: '待处理',
      at: new Date().toISOString(),
    };
    tickets.push(ticket);
    return json(res, 201, ticket);
  }

  if (pathname === '/events' && req.method === 'POST') {
    const body = await readBody(req);
    console.log(`[mock-crm] 收到事件 ${body.type} 签名=${req.headers['x-zhifu-signature'] ? '有' : '无'}`);
    return json(res, 200, { received: true });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[mock-crm] 监听 http://127.0.0.1:${PORT}  token=${TOKEN}`);
});
