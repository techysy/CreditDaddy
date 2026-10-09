/**
 * minimaxGateway — 粘性主力选型、拉黑与复活：凭据指纹黑名单、刷新成功自动复活、重新授权自动复活、开关清理。
 * 回归场景：设备码重新授权后面板显示「凭据有效」，但进程内旧黑名单仍把账号挡在
 * 轮转队列外，网关 503「凭据已失效」，且开关重开也无效（1.3.0 用户报告）。
 * fetch 全部注入，无网络；每个用例前重置全部模块态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-gw-test-'));
process.env.CREDITDADDY_HOME = MHOME;

const store = await import('../src/store.js');
const gw = await import('../src/minimaxGateway.js');

let currentAccounts = [];
let fetchCalls = [];
let upstreamQueue = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, method: init.method, headers: init.headers, body: init.body });
  // 额度查询（get_membership_info）独立应答，不消费上游消息队列：默认返回 2000 积分
  if (u.includes('/commerce/get_membership_info')) {
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '',
      json: async () => ({ base_resp: { status_code: 0 }, op_credit_summary: { total_remaining_amount: 2000, free_remaining_amount: 2000, purchased_remaining_amount: 0 } }),
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

async function resetState({ settings = { minimaxGateway: true } } = {}) {
  currentAccounts = [];
  await store.saveAccounts([]);
  await store.saveSettings(settings);
  fetchCalls = [];
  upstreamQueue = [];
  gw.__resetForTests();
}

async function seedAccount(id, { name = id, token = `tok-${id}`, refreshToken = `rt-${id}` } = {}) {
  const acc = { id, name, provider: 'minimax', uid: id, token, refreshToken, expiresAt: null };
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

function captureRes() {
  return {
    status: 0, body: '', headersSent: false, headers: null,
    writeHead(code, hdrs) { this.status = code; this.headers = hdrs; this.headersSent = true; return this; },
    end(chunk) { if (chunk) this.body += chunk.toString(); return this; },
    write(chunk) { this.body += chunk.toString(); return true; },
    once() {}, on() {},
  };
}

const sseBody = () => 'event: message_start\ndata: {"type":"message_start"}\n\n';
const msg401 = () => ({ status: 401, body: '{"error":{"type":"unauthorized"}}' });
const msgOk = () => ({ status: 200, sse: true, body: sseBody() });
const completions = () => fetchCalls.filter((c) => c.url.includes('/mavis/api/v1/llm/v1/messages'));
const refreshCalls = () => fetchCalls.filter((c) => c.url.includes('/oauth2/token'));
// 本次请求实际用的账号（从 Authorization 头解析），过滤掉额度/刷新等非消息请求
const lastCompletionAccount = (tokenOf) => {
  const rows = completions();
  if (!rows.length) return null;
  const auth = rows[rows.length - 1].headers.Authorization || '';
  const tok = auth.replace(/^Bearer /, '');
  return tokenOf(tok) || null;
};

test('粘性主力：积分接近不换号，差距超过阈值才切换', async () => {
  await resetState();
  await seedAccount('a1', { name: '一号', token: 'tok-a1' });
  await seedAccount('a2', { name: '二号', token: 'tok-a2' });
  const quota = { 'tok-a1': 2000, 'tok-a2': 2000 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/commerce/get_membership_info')) {
      const auth = (init.headers && init.headers.Authorization) || '';
      const remaining = quota[auth.replace(/^Bearer /, '')] ?? 0;
      return {
        ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '',
        json: async () => ({ base_resp: { status_code: 0 }, op_credit_summary: { total_remaining_amount: remaining, free_remaining_amount: remaining, purchased_remaining_amount: 0 } }),
        body: new ReadableStream({ start(c) { c.close(); } }),
      };
    }
    return realFetch(url, init);
  };

  const tokenOf = (tok) => (tok === 'tok-a1' ? '一号' : tok === 'tok-a2' ? '二号' : null);
  const fire = async () => {
    upstreamQueue.push(msgOk());
    const res = captureRes();
    await gw.handleGateway(fakeReq('POST', '{}'), res);
    assert.equal(res.status, 200, res.body);
    return lastCompletionAccount(tokenOf);
  };

  // 积分相同：首号（按种入顺序）成为主力，连续 6 个请求不再换号
  const first = await fire();
  assert.equal(first, '一号');
  for (let i = 0; i < 5; i++) {
    assert.equal(await fire(), '一号', '积分接近时主力应保持不变');
  };

  // 二号积分大幅领先（5000 vs 2000，差 3000 > 500 阈值）→ 切换主力
  quota['tok-a2'] = 5000;
  gw.__expireWeightsForTests();
  assert.equal(await fire(), '二号', '差距超过阈值应切换主力');

  // 一号追近（5400 vs 5000，差 400 < 540 阈值）→ 不换
  quota['tok-a1'] = 5400;
  gw.__expireWeightsForTests();
  assert.equal(await fire(), '二号', '差距未超过阈值应保持粘性');

  // 一号大幅反超（6500 vs 5000，差 1500 > 650 阈值）→ 切换
  quota['tok-a1'] = 6500;
  gw.__expireWeightsForTests();
  assert.equal(await fire(), '一号', '大幅反超应切换主力');
});

test('401 且刷新失败 → 拉黑；下一请求 503「凭据已失效」', async () => {
  await resetState();
  await seedAccount('a1', { name: '失效号' });
  upstreamQueue.push(
    msg401(),
    { status: 400, body: '{"error":"invalid_grant","error_description":"refresh token rotated"}' },
  );
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 502, res.body);

  const st = await gw.gatewayStatus();
  assert.deepEqual(st.dead, ['失效号'], '拉黑列表应按名字展示');

  const res2 = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res2);
  assert.equal(res2.status, 503, res2.body);
  assert.match(res2.body, /1 个凭据已失效/);
});

test('刷新成功 → 自动复活并回写账号库', async () => {
  await resetState();
  await seedAccount('a1', { name: '一号' });
  upstreamQueue.push(
    msg401(),
    { status: 200, body: JSON.stringify({ access_token: 'tok-new', refresh_token: 'rt-new', expires_in: 3600 }) },
    msgOk(),
  );
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 200, res.body);
  assert.equal(refreshCalls().length, 1);

  const st = await gw.gatewayStatus();
  assert.deepEqual(st.dead, [], '刷新成功不应残留拉黑');
  const accs = await store.loadAccounts();
  assert.equal(accs[0].token, 'tok-new', '新 accessToken 应回写账号库');
  assert.equal(accs[0].refreshToken, 'rt-new', '新 refreshToken 应回写账号库');
});

test('拉黑后重新授权（凭据变化）→ 自动复活，网关恢复', async () => {
  await resetState();
  await seedAccount('a1', { name: '一号', token: 'tok-old', refreshToken: 'rt-old' });
  upstreamQueue.push(
    msg401(),
    { status: 400, body: '{"error":"invalid_grant"}' },
  );
  await gw.handleGateway(fakeReq('POST', '{}'), captureRes());
  let st = await gw.gatewayStatus();
  assert.deepEqual(st.dead, ['一号']);

  // 模拟设备码重新授权：addAccount 命中重复账号 → 同 id 换新 token/refreshToken
  currentAccounts = [{ ...currentAccounts[0], token: 'tok-reauth', refreshToken: 'rt-reauth', verified: true }];
  await store.saveAccounts(currentAccounts);

  st = await gw.gatewayStatus();
  assert.deepEqual(st.dead, [], '指纹变化应立即解除拉黑');
  assert.deepEqual(st.cooling, [], '解除拉黑时冷却也应清除');

  upstreamQueue.push(msgOk());
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 200, res.body);
  assert.match(completions().at(-1).headers.Authorization, /^Bearer tok-reauth$/);
});

test('凭据不变时拉黑保持有效，不会反复打上游', async () => {
  await resetState();
  await seedAccount('a1', { name: '一号' });
  upstreamQueue.push(
    msg401(),
    { status: 400, body: '{"error":"invalid_grant"}' },
  );
  await gw.handleGateway(fakeReq('POST', '{}'), captureRes());
  const before = completions().length;

  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 503, '同指纹仍应被拦在队列外');
  assert.equal(completions().length, before, '拉黑期间不应再打上游');
});

test('setGatewayEnabled(true) → 清空黑名单与冷却', async () => {
  await resetState();
  await seedAccount('a1', { name: '一号' });
  upstreamQueue.push(
    msg401(),
    { status: 400, body: '{"error":"invalid_grant"}' },
  );
  await gw.handleGateway(fakeReq('POST', '{}'), captureRes());
  assert.deepEqual((await gw.gatewayStatus()).dead, ['一号']);

  await gw.setGatewayEnabled(false);
  await gw.setGatewayEnabled(true);
  const st = await gw.gatewayStatus();
  assert.equal(st.enabled, true);
  assert.deepEqual(st.dead, [], '重开网关应清空旧黑名单');

  upstreamQueue.push(msgOk());
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 200, res.body);
});

test('网关未开启时 503 提示开启', async () => {
  await resetState({ settings: { minimaxGateway: false } });
  await seedAccount('a1');
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 503);
  assert.match(res.body, /未开启/);
});
