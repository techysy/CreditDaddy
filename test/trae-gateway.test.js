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
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(code, h = {}) {
      res.statusCode = code;
      Object.assign(res.headers, h);
    },
    write(chunk) {
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      res.ended = true;
      res.body = Buffer.concat(res.chunks).toString('utf8');
    },
  };
  return res;
}

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
