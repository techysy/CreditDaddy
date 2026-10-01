/**
 * zcodeGateway — 开关门 / 验证码缓存与失效 / 账号轮换与失败分类。
 * fetch 与验证码提供者全部注入，无网络；每个用例前重置全部模块态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-gw-test-'));
process.env.CREDITDADDY_HOME = MHOME;

const store = await import('../src/store.js');
const zauto = await import('../src/zcodeAutoClaim.js');
const zc = await import('../src/zcrypto.js');
const zclient = await import('../src/zcodeClient.js');
const gw = await import('../src/zcodeGateway.js');
zclient._resetAppVersionCache('3.14.0');

const secret = zc.defaultSecret(os.homedir());
const encForStore = (plain) => zc.encryptWithSecret(plain, secret);

let currentAccounts = [];
let fetchCalls = [];
let captchaSolves = 0;
let upstreamQueue = [];

const providerOk = () => {
  zauto.setZcodeCaptchaProvider(async () => {
    captchaSolves += 1;
    return { captchaParam: `{"sceneId":"11xygtvd","certifyId":"cert-${captchaSolves}","deviceToken":"dt"}`, region: 'cn' };
  });
};

globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), method: init.method, headers: init.headers });
  const next = upstreamQueue.shift();
  if (!next) throw new Error('no queued upstream response');
  return {
    ok: (next.status || 200) < 400,
    status: next.status || 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (next.sse ? 'text/event-stream' : 'application/json') : k.toLowerCase() === 'content-encoding' ? (next.gz ? 'gzip' : null) : null) },
    text: async () => next.body ?? '',
    body: new ReadableStream({ start(c) { if (next.body) c.enqueue(Buffer.from(next.body)); c.close(); } }),
  };
};

async function resetState({ settings = { zcodeGateway: true } } = {}) {
  currentAccounts = [];
  await store.saveAccounts([]);
  await store.saveSettings(settings);
  fetchCalls = [];
  upstreamQueue = [];
  captchaSolves = 0;
  gw.__resetForTests();
}

async function seedAccount(id, name, withJwt = true) {
  const acc = {
    id, name, provider: 'zcode', uid: id,
    meta: { credentials: withJwt ? { zcodejwttoken: encForStore(`jwt-${id}-` + 'x'.repeat(200)) } : {} },
  };
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
  const res = {
    status: 0, body: '', headersSent: false, headers: null,
    writeHead(code, hdrs) { this.status = code; this.headers = hdrs; this.headersSent = true; return this; },
    end(chunk) { if (chunk) this.body += chunk.toString(); return this; },
    write(chunk) { this.body += chunk.toString(); return true; },
    once() {}, on() {},
  };
  return res;
}

const capCfg = () => ({ status: 200, body: JSON.stringify({ code: 0, data: { configs: { captcha: { enabled: true, region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' } } } }) });
const sseBody = () => 'event: message_start\ndata: {"type":"message_start"}\n\n';
const completions = () => fetchCalls.filter((c) => c.url.includes('/zcode-plan/anthropic/v1/messages'));

test('网关未开启时返回 503', async () => {
  await resetState({ settings: { zcodeGateway: false } });
  await seedAccount('a1', '账号一');
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 503);
  assert.match(res.body, /网关未开启/);
});

test('无验证码提供者（NAS/CLI）：首过直成功；被 3007 拒才 502', async () => {
  await resetState();
  zauto.setZcodeCaptchaProvider(null);
  await seedAccount('a1', '账号一');
  upstreamQueue.push({ status: 200, sse: true, body: sseBody() });
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 200, res.body);
  upstreamQueue.push({ status: 400, body: '{"code":3007,"msg":"captcha verify failed"}' });
  const res2 = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res2);
  assert.equal(res2.status, 502);
  assert.match(res2.body, /验证码/);
});

test('无可用账号（快照里没有 zcodejwttoken）返回 503', async () => {
  await resetState();
  await seedAccount('a1', '账号一', false);
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{"model":"glm-5.3-flash"}'), res);
  assert.equal(res.status, 503);
  assert.match(res.body, /没有可用的 ZCode 账号/);
});

test('首发不带验证码头，SSE 透传', async () => {
  await resetState();
  providerOk();
  await seedAccount('a1', '账号一');
  upstreamQueue.push({ status: 200, sse: true, body: sseBody() });
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{"model":"glm-5.3-flash","stream":true}'), res);
  assert.equal(res.status, 200, res.body);
  assert.equal(res.body, sseBody());
  assert.equal(completions().length, 1);
  assert.equal(completions()[0].headers['X-Aliyun-Captcha-Verify-Param'], undefined);
  assert.match(completions()[0].headers.Authorization, /^Bearer jwt-a1-/);
  assert.equal(captchaSolves, 0);
});

test('3007 被拒 → 重解新 token 挂上重试，全败 502 汇总', async () => {
  await resetState();
  providerOk();
  await seedAccount('a1', '账号一');
  await seedAccount('a2', '账号二');
  upstreamQueue.push(
    { status: 400, body: '{"code":3007,"msg":"captcha verify failed"}' },
    capCfg(),
    { status: 400, body: '{"code":3007,"msg":"captcha verify failed"}' },
    capCfg(),
    { status: 400, body: '{"code":3007,"msg":"captcha verify failed"}' },
  );
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 502, res.body);
  const parsed = JSON.parse(res.body);
  assert.ok(parsed.attempts.length >= 2);
  assert.ok(parsed.attempts.some((a) => /验证码被拒/.test(a.error)));
  const withCaptcha = completions().filter((c) => c.headers['X-Aliyun-Captcha-Verify-Param']);
  const params = withCaptcha.map((c) => JSON.parse(c.headers['X-Aliyun-Captcha-Verify-Param']).certifyId);
  assert.ok(withCaptcha.length >= 2, '被拒后应有带验证码的重试');
  assert.equal(new Set(params).size, params.length, '每次重试都应有新验证码 token');
});

test('200 包裹的 1005：探得 0 额度 → 打标持久化、不再轮换', async () => {
  await resetState();
  providerOk();
  await seedAccount('busy', '占用号');
  await seedAccount('weird', '怪码号');
  upstreamQueue.push(
    { status: 200, body: '{"code":1005,"msg":"exceed quota limit"}' },
    { status: 200, body: "{\"code\":0,\"data\":{\"limits\":[{\"type\":\"TOKENS_LIMIT\",\"usage\":100000000,\"currentValue\":100000000,\"remaining\":0}]}}" },
    { status: 200, body: '{"code":4242,"msg":"未知业务错误"}' },
  );
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  const st = await gw.gatewayStatus();
  assert.ok((st.exhausted || []).some((e) => e.name === '占用号'), '1005 应打标为额度耗尽');
  const persisted = JSON.parse(fs.readFileSync(path.join(MHOME, 'state.json'), 'utf8'));
  assert.ok(persisted.zcodeGatewayExhausted && persisted.zcodeGatewayExhausted.busy, '打标应持久化到 state.json');
});

test('1005 后额度查询失败：不误标耗尽，只短冷却', async () => {
  await resetState();
  providerOk();
  await seedAccount('uncertain', '查询失败号');
  upstreamQueue.push({ status: 200, body: '{"code":1005,"msg":"exceed quota limit"}' });
  // 额度探测时 mock 队列已空 → fetch 抛错 → probeQuota 返回 null
  await gw.handleGateway(fakeReq('POST', '{}'), captureRes());
  const st = await gw.gatewayStatus();
  assert.equal(st.exhausted.length, 0, '探不到额度不能当作确认耗尽');
  assert.ok(st.cooling.includes('查询失败号'), '应短冷却');
  const persisted = JSON.parse(fs.readFileSync(path.join(MHOME, 'state.json'), 'utf8'));
  assert.ok(!persisted.zcodeGatewayExhausted?.uncertain, '不应持久化耗尽标记');
});

test('全部额度耗尽 → 503 说明额度耗尽，不提示重新登录', async () => {
  await resetState();
  await seedAccount('busy', '占用号');
  upstreamQueue.push(
    { status: 200, body: '{"code":1005,"msg":"exceed quota limit"}' },
    { status: 200, body: "{\"code\":0,\"data\":{\"limits\":[{\"type\":\"TOKENS_LIMIT\",\"usage\":100000000,\"currentValue\":100000000,\"remaining\":0}]}}" },
  );
  await gw.handleGateway(fakeReq('POST', '{}'), captureRes());
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 503);
  const { error } = JSON.parse(res.body);
  assert.match(error, /1 个额度耗尽/);
  assert.match(error, /无需重新登录/);
  assert.doesNotMatch(error, /zcodejwttoken/);
});

test('耗尽 / 冷却 / 拉黑 / 无 JWT 混合 → 503 分类计数', async () => {
  await resetState();
  await seedAccount('empty', '耗尽号');
  await seedAccount('dead', '失效号');
  await seedAccount('cool', '冷却号');
  await seedAccount('nojwt', '无凭据号', false);
  const state = JSON.parse(fs.readFileSync(path.join(MHOME, 'state.json'), 'utf8'));
  state.zcodeGatewayExhausted = { empty: { remaining: 0, at: Date.now() } };
  fs.writeFileSync(path.join(MHOME, 'state.json'), JSON.stringify(state));
  upstreamQueue.push(
    { status: 401, body: '{"code":401,"msg":"令牌已过期"}' },
    { status: 429, body: '{"error":{"code":"429"}}' },
  );
  await gw.handleGateway(fakeReq('POST', '{}'), captureRes());
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 503);
  const { error } = JSON.parse(res.body);
  assert.match(error, /1 个额度耗尽/);
  assert.match(error, /1 个临时冷却中/);
  assert.match(error, /1 个 JWT 已失效/);
  assert.match(error, /1 个缺少 zcodejwttoken/);
});

test('200 包裹的 1005 但仍有额度 → 瞬时短冷却继续用', async () => {
  await resetState();
  providerOk();
  await seedAccount('busy', '瞬时号');
  await seedAccount('good', '好号');
  upstreamQueue.push(
    { status: 200, body: '{"code":1005,"msg":"exceed quota limit"}' },
    { status: 200, body: "{\"code\":0,\"data\":{\"limits\":[{\"type\":\"TOKENS_LIMIT\",\"usage\":100000000,\"currentValue\":99500000,\"remaining\":500000}]}}" },
    { status: 200, body: '{"code":0,"data":[]}' },
    { status: 200, sse: true, body: sseBody() },
  );
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 200, res.body);
  const rows = completions();
  assert.match(rows[0].headers.Authorization, /^Bearer jwt-busy-/);
  assert.match(rows[1].headers.Authorization, /^Bearer jwt-good-/);
  const st = await gw.gatewayStatus();
  assert.equal((st.exhausted || []).length, 0, '有额度的瞬时拒绝不应打标');
});

test('401 拉黑 / 额度与 429 跳过 / 最终成功', async () => {
  await resetState();
  providerOk();
  await seedAccount('dead', '失效号');
  await seedAccount('poor', '没额度号');
  await seedAccount('good', '好号');
  upstreamQueue.push(
    { status: 401, body: '{"code":401,"msg":"令牌已过期"}' },
    { status: 429, body: '{"error":{"code":"429"}}' },
    { status: 200, sse: true, body: sseBody() },
  );
  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 200, res.body);
  const rows = completions();
  assert.equal(rows.length, 3);
  assert.match(rows[0].headers.Authorization, /^Bearer jwt-dead-/);
  assert.match(rows[1].headers.Authorization, /^Bearer jwt-poor-/);
  assert.match(rows[2].headers.Authorization, /^Bearer jwt-good-/);
});

test('局域网：未开开关 403；key 不匹配 401；匹配放行', async () => {
  await resetState();
  providerOk();
  await store.saveSettings({ zcodeGateway: true, zcodeGatewayLan: false });
  await seedAccount('a1', '账号一');
  const denied = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}', '192.168.31.5'), denied);
  assert.equal(denied.status, 403);

  const tr = await import('../src/tenrouter.js');
  tr.updateConfig({ endpoint: 'http://127.0.0.1:20127', key: 'sk-lan-test-key-123456' });
  await store.saveSettings({ zcodeGateway: true, zcodeGatewayLan: true });

  const bad = captureRes();
  const badReq = fakeReq('POST', '{}', '192.168.31.5');
  badReq.headers = { 'x-api-key': 'sk-wrong' };
  await gw.handleGateway(badReq, bad);
  assert.equal(bad.status, 401);

  upstreamQueue.push({ status: 200, sse: true, body: sseBody() });
  const good = captureRes();
  const goodReq = fakeReq('POST', '{}', '192.168.31.5');
  goodReq.headers = { 'x-api-key': 'sk-lan-test-key-123456' };
  await gw.handleGateway(goodReq, good);
  assert.equal(good.status, 200);
  tr.updateConfig({ endpoint: '' });
});

test('GET 请求提示用法', async () => {
  const res = captureRes();
  await gw.handleGateway(fakeReq('GET', ''), res);
  assert.equal(res.status, 405);
});

test('领取成功后 clearQuotaMark：耗尽打标立即清除、账号回到轮换', async () => {
  await resetState();
  await seedAccount('refill', '补额度号');
  const state = JSON.parse(fs.readFileSync(path.join(MHOME, 'state.json'), 'utf8'));
  state.zcodeGatewayExhausted = { refill: { remaining: 0, at: Date.now() } };
  fs.writeFileSync(path.join(MHOME, 'state.json'), JSON.stringify(state));
  const before = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), before);
  assert.equal(before.status, 503, '打标中不应轮换');

  await gw.clearQuotaMark('refill');
  const persisted = JSON.parse(fs.readFileSync(path.join(MHOME, 'state.json'), 'utf8'));
  assert.ok(!persisted.zcodeGatewayExhausted?.refill, '持久化打标应一并清除');
  upstreamQueue.push({ status: 200, sse: true, body: sseBody() });
  const after = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), after);
  assert.equal(after.status, 200, after.body);
});

test('remoteAllowed：精确 IP、::ffff: 前缀剥离与 * 通配', async () => {
  const { remoteAllowed, remoteHost } = await import('../src/zcodeGateway.js');
  const allow = ['192.168.31.101', '10.0.0.*'];
  assert.equal(remoteAllowed('192.168.31.101', allow), true);
  assert.equal(remoteAllowed('::ffff:192.168.31.101', allow), true, 'IPv4-mapped IPv6 应剥前缀后匹配');
  assert.equal(remoteAllowed('192.168.31.102', allow), false, '未加白的 IP 不放行');
  assert.equal(remoteAllowed('10.0.0.7', allow), true, '前缀通配放行');
  assert.equal(remoteAllowed('10.0.1.7', allow), false);
  assert.equal(remoteAllowed('', allow), false, '空远端不放行');
  assert.equal(remoteAllowed('192.168.31.101', []), false, '空白名单不放行');
  assert.equal(remoteHost('::ffff:192.168.31.101'), '192.168.31.101');
});
