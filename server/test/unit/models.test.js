// 白盒测试：模型注册表与启用条件
// 关键点：未配置 Key 的模型必须仍然可见（管理页要能看到），只是不参与路由
import test from 'node:test';
import assert from 'node:assert/strict';

test('模型注册表: 未配置 Key 时 DeepSeek 仍注册但禁用', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const { MODELS } = await import(`../../src/config/models.js?noKey=${Date.now()}`);
  const ds = MODELS.find((m) => m.id === 'deepseek-flash');
  assert.ok(ds, 'DeepSeek 必须出现在注册表中');
  assert.equal(ds.adapter, 'openai');
  assert.equal(ds.enabled, false);
});

test('模型注册表: 配置 Key 后自动启用，并进入路由候选', async () => {
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  const { MODELS } = await import(`../../src/config/models.js?withKey=${Date.now()}`);
  const { ModelRouter } = await import(`../../src/router/modelRouter.js?withKey=${Date.now()}`);

  const ds = MODELS.find((m) => m.id === 'deepseek-flash');
  assert.equal(ds.enabled, true);

  const r = new ModelRouter(MODELS);
  const ids = r.candidates('medium').map((m) => m.id);
  assert.ok(ids.includes('deepseek-flash'), `medium 档候选应包含 DeepSeek，实际：${ids.join(',')}`);
  // 只配了 DeepSeek 的 Key，通义仍应保持禁用
  assert.equal(r.list().find((m) => m.id === 'qwen-plus').enabled, false);

  delete process.env.DEEPSEEK_API_KEY;
});

test('模型注册表: 未配 Key 时离线 Mock 参与路由（开箱可用）', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  const { MODELS } = await import(`../../src/config/models.js?mockOn=${Date.now()}`);
  const mocks = MODELS.filter((m) => m.adapter === 'mock');
  assert.equal(mocks.length, 3);
  for (const m of mocks) assert.equal(m.enabled, true);
});

test('模型注册表: 配了真实模型后离线 Mock 退出路由（避免"配了 Key 却没用模型"）', async () => {
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  const { MODELS } = await import(`../../src/config/models.js?realOn=${Date.now()}`);
  const { ModelRouter } = await import(`../../src/router/modelRouter.js?realOn=${Date.now()}`);

  const mocks = MODELS.filter((m) => m.adapter === 'mock');
  for (const m of mocks) assert.equal(m.enabled, false, `${m.id} 应停用`);

  const r = new ModelRouter(MODELS);
  // 三档复杂度都必须真落到 DeepSeek：lite 档没有真实模型时会退到唯一启用的模型
  for (const level of ['simple', 'medium', 'complex']) {
    assert.equal(r.select(level).model.id, 'deepseek-flash', `${level} 档应选 DeepSeek`);
  }
  // 降级链里也不能出现离线 Mock
  assert.ok(!r.select('medium').fallbacks.some((f) => f.adapter === 'mock'));

  delete process.env.DEEPSEEK_API_KEY;
});

test('模型注册表: 支持 DEEPSEEK_BASE_URL 覆盖（私有网关/本地联调）', async () => {
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:4101/v1';
  const { MODELS } = await import(`../../src/config/models.js?base=${Date.now()}`);
  const ds = MODELS.find((m) => m.id === 'deepseek-flash');
  assert.equal(ds.baseUrl, 'http://127.0.0.1:4101/v1');
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
});

test('模型注册表: 通义千问三档均已注册，未配 Key 时禁用', async () => {
  delete process.env.DASHSCOPE_API_KEY;
  const { MODELS } = await import(`../../src/config/models.js?qwenNoKey=${Date.now()}`);
  const qwen = MODELS.filter((m) => m.id.startsWith('qwen-'));
  assert.equal(qwen.length, 3);
  assert.deepEqual(qwen.map((m) => m.tier).sort(), ['lite', 'pro', 'standard']);
  for (const m of qwen) {
    assert.equal(m.adapter, 'openai');
    assert.equal(m.apiKeyEnv, 'DASHSCOPE_API_KEY');
    assert.match(m.baseUrl, /dashscope\.aliyuncs\.com/);
    assert.equal(m.enabled, false);
  }
});

test('模型注册表: 配置 DASHSCOPE_API_KEY 后，通义三档进入对应复杂度候选', async () => {
  process.env.DASHSCOPE_API_KEY = 'sk-qwen-test';
  const { MODELS } = await import(`../../src/config/models.js?qwenKey=${Date.now()}`);
  const { ModelRouter } = await import(`../../src/router/modelRouter.js?qwenKey=${Date.now()}`);

  const router = new ModelRouter(MODELS);
  // 简单任务只从 lite/standard 里选，复杂任务优先 pro
  assert.ok(router.candidates('simple').some((m) => m.id === 'qwen-turbo'));
  assert.ok(router.candidates('medium').some((m) => m.id === 'qwen-plus'));
  assert.ok(router.candidates('complex').some((m) => m.id === 'qwen-max'));

  // 显式指定质量优先时，复杂任务应落到质量最高的通义 Max
  const picked = router.select('complex', 'quality');
  assert.equal(picked.model.id, 'qwen-max');

  delete process.env.DASHSCOPE_API_KEY;
});
