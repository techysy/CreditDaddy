/**
 * traeGateway 测试 — 拉黑、冷却、复活、SSE 增量提取、Anthropic 格式转换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const THOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-gw-test-'));
process.env.CREDITDADDY_HOME = THOME;

const store = await import('../src/store.js');
const gw = await import('../src/traeGateway.js');

let currentAccounts = [];
let fetchCalls = [];
let upstreamQueue = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, method: init.method, headers: init.headers, body: init.body });

  // 额度查询与支付状态独立应答
  if (u.includes('/ide_user_ent_usage') || u.includes('/ide_user_pay_status')) {
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '',
      json: async () => ({
        user_entitlement_pack_list: [
          {
            group_name: '通用积分',
            entitlement_base_info: { quota: { credits_limit: 100 } },
            usage: { credits_amount: 10 },
          },
        ],
      }),
      body: new ReadableStream({ start(c) { c.close(); } }),
    };
  }

  const next = upstreamQueue.shift();
  if (!next) throw new Error('no queued upstream response: ' + u);
  const ct = next.sse ? 'text/event-stream' : 'application/json';
  return {
    ok: (next.status || 200) < 400,
    status: next.status || 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (next.contentType || ct) : null) },
    text: async () => next.body ?? '',
    json: async () => JSON.parse(next.body ?? 'null'),
    body: new ReadableStream({ start(c) { if (next.body) c.enqueue(Buffer.from(next.body)); c.close(); } }),
  };
};

async function resetState({ settings = { traeGateway: true } } = {}) {
  currentAccounts = [];
  await store.saveAccounts([]);
  await store.saveSettings(settings);
  fetchCalls = [];
  upstreamQueue = [];
  gw.__resetForTests();
}

async function seedAccount(id, { name = id, token = `tok-${id}` } = {}) {
  const acc = { id, name, provider: 'trae', uid: id, token, expiresAt: null };
  currentAccounts.push(acc);
  await store.saveAccounts(currentAccounts);
  return acc;
}

function fakeReq(method, body, remoteAddress = '127.0.0.1') {
  const req = new EventEmitter();
  req.method = method;
  req.socket = { remoteAddress };
  req.headers = {};
  let started = false;
  req.on('newListener', (ev) => {
    if (ev === 'data' && !started) {
      started = true;
      process.nextTick(() => {
        if (body) req.emit('data', Buffer.from(body));
        req.emit('end');
      });
    }
  });
  return req;
}

function fakeRes() {
  // 真实 ServerResponse 是 EventEmitter（网关会挂 res 'close' 监听观察客户端断开）
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.chunks = [];
  res.ended = false;
  res.writableEnded = false;
  res.writeHead = (code, h = {}) => {
    res.statusCode = code;
    Object.assign(res.headers, h);
  };
  res.write = (chunk) => {
    res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    res.ended = true;
    res.writableEnded = true;
    res.body = Buffer.concat(res.chunks).toString('utf8');
    res.emit('close');   // 与真实响应一致：收尾后触发 close
  };
  return res;
}

// ── 双通道分流（同步 10Router 44b2bb27：直连非沙箱 vs SOLO 沙箱） ──

test('通道分流：普通模型走直连非沙箱（agent_type chat + env local），模型名规范化', () => {
  const p = gw.buildTraeSessionPayload('hello', 'doubao-seed-code');
  assert.equal(p.initial_message.agent_type, 'chat');
  assert.equal(p.env, 'local');
  assert.equal(p.initial_message.model_name, 'Doubao-Seed-Code', '服务端大小写敏感（4001 config empty 防线）');
  assert.equal(p.initial_message.model_selection_strategy, 'manual');
  assert.equal(p.mode, 'code');
  const cp = JSON.parse(p.initial_message.common_params);
  assert.equal(cp.solo_chat_mode, 'code');
});

test('通道分流：solo/work/agent- 字样走 SOLO 沙箱（solo_agent_remote + remote）', () => {
  for (const m of ['solo', 'solo-agent', 'work', 'SOLO-Work', 'agent-task']) {
    const p = gw.buildTraeSessionPayload('hi', m);
    assert.equal(p.initial_message.agent_type, 'solo_agent_remote', m + ' 必须是沙箱通道');
    assert.equal(p.env, 'remote', m + ' 必须 env remote');
  }
});

test('通道分流：work 族 mode=work + strategy=auto + 空模型名；auto/空同理（10Router resolveMode 口径）', () => {
  const w = gw.buildTraeSessionPayload('hi', 'work');
  assert.equal(w.mode, 'work');
  assert.equal(w.initial_message.model_selection_strategy, 'auto');
  assert.equal(w.initial_message.model_name, '');
  const a = gw.buildTraeSessionPayload('hi', 'auto');
  assert.equal(a.mode, 'code');
  assert.equal(a.initial_message.model_selection_strategy, 'auto');
  assert.equal(a.initial_message.model_name, '');
  const e = gw.buildTraeSessionPayload('hi', '');
  assert.equal(e.initial_message.model_selection_strategy, 'auto');
});

test('canonicalTraeModel：表内规范化、表外原样、空串回空', () => {
  assert.equal(gw.canonicalTraeModel('deepseek-v4.1-flash'), 'DeepSeek-V4-Flash');
  assert.equal(gw.canonicalTraeModel('Kimi-K3.1-Pro'), 'Kimi-K3.1-Pro');
  assert.equal(gw.canonicalTraeModel('unknown-model'), 'unknown-model');
  assert.equal(gw.canonicalTraeModel(''), '');
});

test('Trae 网关开关关闭时返回 503', async () => {
  await resetState({ settings: { traeGateway: false } });
  await seedAccount('t1');
  const req = fakeReq('POST', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
  const res = fakeRes();
  await gw.handleGateway(req, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /未开启/);
});

test('Trae 网关无账号时返回 503', async () => {
  await resetState();
  const req = fakeReq('POST', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
  const res = fakeRes();
  await gw.handleGateway(req, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /没有 Trae 账号/);
});

test('Trae 网关单轮流式补全输出 Anthropic 格式 SSE', async () => {
  await resetState();
  await seedAccount('t1');

  // 1. POST /chat_sessions 响应
  upstreamQueue.push({
    status: 200,
    body: JSON.stringify({ code: 0, data: { chat_session_id: 'cs_123', message_id: 'msg_abc' } }),
  });

  // 2. GET /chat_sessions/cs_123/events SSE 响应
  const events = [
    'data: {"reasoning_content": "正在思考"}',
    'data: {"reasoning_content": "正在思考如何回答"}',
    'data: {"thought": "你好！"}',
    'data: {"thought": "你好！很高兴为您服务。"}',
    'data: {"tool_call_info": {"name": "finish", "params": {"summary": "你好！很高兴为您服务。"}}, "prompt_tokens": 10, "completion_tokens": 15}',
  ].join('\n\n') + '\n\n';

  upstreamQueue.push({
    status: 200,
    sse: true,
    body: events,
  });

  // 3. DELETE /chat_sessions/cs_123 响应
  upstreamQueue.push({
    status: 200,
    body: JSON.stringify({ code: 0 }),
  });

  const req = fakeReq('POST', JSON.stringify({
    model: 'Doubao-Seed-Code',
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
  }));
  const res = fakeRes();

  await gw.handleGateway(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);

  // 验证 SSE 关键事件
  assert.match(res.body, /event: message_start/);
  assert.match(res.body, /event: content_block_start/);
  assert.match(res.body, /"type":"thinking_delta"/);
  assert.match(res.body, /"type":"text_delta"/);
  assert.match(res.body, /event: message_delta/);
  assert.match(res.body, /event: message_stop/);
});

test('Trae 网关 401 自动拉黑，开关重启清空黑名单', async () => {
  await resetState();
  const acc = await seedAccount('t1');

  upstreamQueue.push({ status: 401, body: JSON.stringify({ code: 1001, message: 'Unauthorized' }) });

  const req = fakeReq('POST', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
  const res = fakeRes();
  await gw.handleGateway(req, res);

  assert.equal(res.statusCode, 502);

  const st = await gw.gatewayStatus();
  assert.equal(st.dead.length, 1);
  assert.equal(st.dead[0], acc.id);

  // 重新打开开关
  await gw.setGatewayEnabled(true);
  const st2 = await gw.gatewayStatus();
  assert.equal(st2.dead.length, 0);
});

test('连续 429 → 退避阶梯递增（30s → 1min → 2min → 5min → 10min 封顶），成功一次即清零', async () => {
  await resetState();
  const acc = await seedAccount('t1');

  const rateLimit = async () => {
    gw.__setCoolingForTests('t1', 0);   // 拨回过去，模拟冷却已到期
    upstreamQueue.push({ status: 429, body: JSON.stringify({ code: 1002, message: 'Too Many Requests' }) });
    const req = fakeReq('POST', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    const res = fakeRes();
    await gw.handleGateway(req, res);
    assert.equal(res.statusCode, 502);
    return (await gw.gatewayStatus()).coolingDetail[0];
  };

  const expected = [
    [30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟'], [600, '10 分钟'],
  ];
  for (let i = 0; i < expected.length; i++) {
    const d = await rateLimit();
    assert.equal(d.remainSeconds, expected[i][0], `连续第 ${i + 1} 次 429 冷却 ${expected[i][1]}`);
    assert.equal(d.remainText, expected[i][1]);
    assert.equal(d.streak, i + 1);
  }

  // 第 6 次 → 停在 10 分钟封顶
  const d6 = await rateLimit();
  assert.equal(d6.remainSeconds, 600, '连续第 6 次仍是 10 分钟封顶');
  assert.equal(d6.streak, 6);

  // 成功一次 → 计数清零，下次 429 回到 30 秒
  gw.__setCoolingForTests('t1', 0);
  upstreamQueue.push({
    status: 200,
    body: JSON.stringify({ code: 0, data: { chat_session_id: 'cs_ok', message_id: 'msg_ok' } }),
  });
  upstreamQueue.push({ status: 200, sse: true, body: 'data: {"thought": "ok"}\n\n' });
  upstreamQueue.push({ status: 200, body: JSON.stringify({ code: 0 }) });
  const okReq = fakeReq('POST', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
  const okRes = fakeRes();
  await gw.handleGateway(okReq, okRes);
  assert.equal(okRes.statusCode, 200, okRes.body);
  let st = await gw.gatewayStatus();
  assert.equal(st.coolingDetail.length, 0, '成功后应解除冷却');

  const after = await rateLimit();
  assert.equal(after.remainSeconds, 30, '成功清零后，再次 429 回到 30 秒');
  assert.equal(after.streak, 1);
});

test('事件流阶段 429 同样进阶梯（会话建好、拉流被限流）', async () => {
  await resetState();
  const acc = await seedAccount('t2');

  // 会话创建成功，events 流被 429 拒
  upstreamQueue.push({
    status: 200,
    body: JSON.stringify({ code: 0, data: { chat_session_id: 'cs_ev', message_id: 'msg_ev' } }),
  });
  upstreamQueue.push({ status: 429, body: JSON.stringify({ code: 1002, message: 'Too Many Requests' }) });
  const req = fakeReq('POST', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
  const res = fakeRes();
  await gw.handleGateway(req, res);
  assert.equal(res.statusCode, 502);

  const d = (await gw.gatewayStatus()).coolingDetail[0];
  assert.ok(d, '事件流 429 应进冷却');
  assert.equal(d.remainSeconds, 30, '首次事件流 429 冷却 30 秒');
  assert.equal(d.streak, 1);
});

test('权重查询黑洞时补全不被拖死（2s 封顶，旧快照先顶上，刷新转后台）', async () => {
  await resetState();
  await seedAccount('t1');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    // 额度查询永远挂着（模拟上游黑洞）——旧实现在权重过期后的首个请求里完整等待它（15s/POST × 串行）
    if (u.includes('/ide_user_ent_usage') || u.includes('/ide_user_pay_status')) return new Promise(() => {});
    return realFetch(url, init);
  };
  try {
    upstreamQueue.push({ status: 200, body: JSON.stringify({ code: 0, data: { chat_session_id: 'cs_x', message_id: 'msg_x' } }) });
    upstreamQueue.push({ status: 200, sse: true, body: 'data: {"thought": "ok"}\n\n' });
    const t0 = Date.now();
    const req = fakeReq('POST', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    const res = fakeRes();
    await gw.handleGateway(req, res);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(Date.now() - t0 < 5000, `额度黑洞不得拖死补全（实测 ${Date.now() - t0}ms）`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
