import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-test-'));
process.env.CREDITDADDY_HOME = MHOME;
process.env.MINIMAX_HOME = path.join(MHOME, '.minimax');

const store = await import('../src/store.js');
const client = await import('../src/minimaxClient.js');
const local = await import('../src/minimaxLocal.js');
const gw = await import('../src/minimaxGateway.js');
const auth = await import('../src/minimaxAuth.js');

/** 用可编程队列替换全局 fetch（device flow 测试）；返回 restore 函数 */
function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}
function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
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
    status: 0,
    body: '',
    headersSent: false,
    headers: null,
    writeHead(code, hdrs) {
      this.status = code;
      this.headers = hdrs;
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk) this.body += chunk.toString();
      return this;
    },
    write(chunk) {
      this.body += chunk.toString();
      return true;
    },
    once() {},
    on() {},
  };
  return res;
}

test('normalizeMiniMaxQuota: 正确解析并区分 free、purchased 与总计', () => {
  const raw = {
    total_remains_credit: 9500,
    op_credit_summary: {
      total_remaining_amount: 9500,
      free_remaining_amount: 1500,
      purchased_remaining_amount: 8000,
    },
    plan_name: 'Pro',
  };

  const q = client.normalizeMiniMaxQuota(raw);
  // 顶层不设 unit：与 Qoder / Trae 同为「积分」口径，计入剩余积分合计
  assert.equal(q.unit, undefined);
  assert.equal(q.total, 9500);
  assert.equal(q.remaining, 9500);
  assert.equal(q.plan, 'Pro');
  assert.equal(q.parts.length, 2);
  assert.equal(q.parts[0].name, '免费/活动积分');
  assert.equal(q.parts[0].remaining, 1500);
  assert.equal(q.parts[0].recurring, true);
  assert.equal(q.parts[1].name, '购买积分');
  assert.equal(q.parts[1].remaining, 8000);
  assert.equal(q.parts[1].recurring, false);
});

test('minimaxLocal: 本机凭据探测与读取', async () => {
  const authDir = path.join(process.env.MINIMAX_HOME, 'auth', 'prod', 'cn', 'mcode-public');
  fs.mkdirSync(authDir, { recursive: true });
  const authFile = path.join(authDir, 'auth.json');

  fs.writeFileSync(
    authFile,
    JSON.stringify({
      records: {
        'rec-1': {
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          expiresAtMs: Date.now() + 3600000,
          subject: 'user-minimax-123456',
          clientId: 'mcode-public',
        },
      },
    })
  );

  const detected = local.detectMiniMax();
  assert.equal(detected.installed, true);
  assert.equal(detected.signedIn, true);

  const acc = await local.liveToAccount();
  assert.ok(acc);
  assert.equal(acc.provider, 'minimax');
  assert.equal(acc.token, 'fake-access-token');
  assert.equal(acc.refreshToken, 'fake-refresh-token');
  assert.equal(acc.uid, 'user-minimax-123456');
  assert.equal(acc.name, 'MiniMax_123456');
});

test('minimaxGateway: 未开启时返回 503', async () => {
  gw.__resetForTests();
  await store.saveAccounts([]);
  await store.saveSettings({ minimaxGateway: false });

  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 503);
  assert.match(res.body, /MiniMax 本地网关未开启/);
});

test('minimaxGateway: 开启但无账号时返回 503 提示导入', async () => {
  gw.__resetForTests();
  await store.saveAccounts([]);
  await store.saveSettings({ minimaxGateway: true });

  const res = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}'), res);
  assert.equal(res.status, 503);
  assert.match(res.body, /没有 MiniMax 账号/);
});

test('minimaxGateway: 局域网访问限制与白名单拦截', async () => {
  gw.__resetForTests();
  await store.saveAccounts([{ id: 'm1', provider: 'minimax', token: 'tok-1', name: 'Test' }]);
  await store.saveSettings({ minimaxGateway: true, minimaxGatewayLan: false });

  // 非回环来源被拒
  const res1 = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}', '192.168.1.100'), res1);
  assert.equal(res1.status, 403);
  assert.match(res1.body, /未允许局域网访问/);

  // 开启局域网但未在白名单
  await store.saveSettings({ minimaxGateway: true, minimaxGatewayLan: true, minimaxGatewayAllow: ['192.168.1.50'] });
  const res2 = captureRes();
  await gw.handleGateway(fakeReq('POST', '{}', '192.168.1.100'), res2);
  assert.equal(res2.status, 403);
  assert.match(res2.body, /不在 MiniMax 网关 IP 白名单内/);
});

// ── 设备码浏览器登录（minimaxAuth）──

test('minimaxAuth.startMiniMaxLogin: 请求 S256 PKCE 并返回 verification_uri_complete', async () => {
  let sentBody = null;
  const restore = stubFetch(async (url, init) => {
    sentBody = init?.body || '';
    return jsonResponse(200, {
      device_code: 'dev-code-abc',
      user_code: 'ABCD-1234',
      verification_uri: 'https://account.minimax.cn/oauth-authorize',
      verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=ABCD-1234',
      expires_in: 300,
      interval: 3,
    });
  });
  try {
    const r = await auth.startMiniMaxLogin();
    assert.equal(r.url, 'https://account.minimax.cn/oauth-authorize?user_code=ABCD-1234');
    assert.ok(r.data.deviceCode === 'dev-code-abc');
    assert.ok(r.data.verifier && r.data.verifier.length >= 32);
    assert.equal(r.data.userCode, 'ABCD-1234');
    // 请求体携带 S256 PKCE 与正确 client 参数
    const params = new URLSearchParams(sentBody);
    assert.equal(params.get('client_id'), 'mcode-public');
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.ok(params.get('code_challenge'));
  } finally { restore(); }
});

test('minimaxAuth.pollMiniMaxLogin: authorization_pending 视为 pending', async () => {
  const restore = stubFetch(async () =>
    jsonResponse(400, { error: 'authorization_pending', error_description: 'not yet' }));
  try {
    const r = await auth.pollMiniMaxLogin({ deviceCode: 'dc', verifier: 'vv' });
    assert.equal(r.status, 'pending');
  } finally { restore(); }
});

test('minimaxAuth.pollMiniMaxLogin: 授权完成返回独立凭据链账号（source=browser，无 authRecordKey）', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('/oauth2/token')) {
      return jsonResponse(200, { access_token: 'mmoat_new', refresh_token: 'mmort_new', expires_in: 3600 });
    }
    // profile best-effort
    return jsonResponse(200, { base_resp: { status_code: 0 }, user_id: '999888', user_name: '测试用户' });
  });
  try {
    const r = await auth.pollMiniMaxLogin({ deviceCode: 'dc', verifier: 'vv', userCode: 'ABCD-1234' });
    assert.equal(r.status, 'ok');
    const inp = r.input;
    assert.equal(inp.provider, 'minimax');
    assert.equal(inp.token, 'mmoat_new');
    assert.equal(inp.refreshToken, 'mmort_new');
    assert.equal(inp.source, 'browser');
    assert.equal(inp.uid, '999888');
    assert.equal(inp.meta.loginVia, 'device-code');
    // 关键：device 登录账号不带 authRecordKey → writeMiniMaxAuth 对其 no-op，不与本机客户端互斥
    assert.equal(inp.meta.authRecordKey, undefined);
  } finally { restore(); }
});

test('minimaxAuth.pollMiniMaxLogin: expired_token / access_denied 抛终态错误', async () => {
  const restore1 = stubFetch(async () => jsonResponse(400, { error: 'expired_token' }));
  try { await assert.rejects(() => auth.pollMiniMaxLogin({ deviceCode: 'd', verifier: 'v' }), /超时/); }
  finally { restore1(); }
  const restore2 = stubFetch(async () => jsonResponse(400, { error: 'access_denied' }));
  try { await assert.rejects(() => auth.pollMiniMaxLogin({ deviceCode: 'd', verifier: 'v' }), /拒绝/); }
  finally { restore2(); }
});

// ── 刷新前对齐本机最新 refreshToken（治 invalid_grant 轮换互斥）──

function writeAuthJson(records) {
  const authDir = path.join(process.env.MINIMAX_HOME, 'auth', 'prod', 'cn', 'mcode-public');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({ records }, null, 2));
}

test('alignMiniMaxFromLocal: 本机客户端已轮换时用最新 refreshToken 覆盖账号库陈旧快照', () => {
  writeAuthJson({
    'rec-x': { accessToken: 'at_new', refreshToken: 'rt_rotated', expiresAtMs: Date.now() + 3600000, generation: 40 },
  });
  const account = {
    provider: 'minimax', token: 'at_old', refreshToken: 'rt_stale',
    meta: { authRecordKey: 'rec-x' },
  };
  const changed = local.alignMiniMaxFromLocal(account, () => {});
  assert.equal(changed, true);
  assert.equal(account.refreshToken, 'rt_rotated');
  assert.equal(account.token, 'at_new');
});

test('alignMiniMaxFromLocal: device 账号（无 authRecordKey）跳过，不动自持凭据链', () => {
  writeAuthJson({ 'rec-x': { accessToken: 'at_new', refreshToken: 'rt_rotated' } });
  const account = { provider: 'minimax', token: 'mmoat_dev', refreshToken: 'mmort_dev', meta: { loginVia: 'device-code' } };
  const changed = local.alignMiniMaxFromLocal(account, () => {});
  assert.equal(changed, false);
  assert.equal(account.refreshToken, 'mmort_dev');
});

test('writeMiniMaxAuth: device 账号（无 authRecordKey）不回写本机 auth.json', () => {
  writeAuthJson({ 'rec-x': { accessToken: 'at', refreshToken: 'rt', generation: 5 } });
  const synced = local.writeMiniMaxAuth({ provider: 'minimax', token: 'mmoat_dev', refreshToken: 'mmort_dev', meta: { loginVia: 'device-code' } });
  assert.equal(synced, false);
  // 本机文件保持不变
  const after = JSON.parse(fs.readFileSync(local.minimaxAuthPath(), 'utf8'));
  assert.equal(after.records['rec-x'].generation, 5);
});

test('writeMiniMaxAuth: 本机导入账号（客户端未运行）回写并 generation+1', () => {
  writeAuthJson({ 'rec-y': { accessToken: 'at_old', refreshToken: 'rt_old', expiresAtMs: Date.now(), generation: 7 } });
  const synced = local.writeMiniMaxAuth({
    provider: 'minimax', token: 'at_new', refreshToken: 'rt_new',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    meta: { authRecordKey: 'rec-y' },
  });
  // minimaxRunning() 在非 Windows / 无客户端时为 false，回写应成功
  if (synced) {
    const after = JSON.parse(fs.readFileSync(local.minimaxAuthPath(), 'utf8'));
    assert.equal(after.records['rec-y'].accessToken, 'at_new');
    assert.equal(after.records['rec-y'].refreshToken, 'rt_new');
    assert.equal(after.records['rec-y'].generation, 8);
  } else {
    // 客户端在跑（真实环境）时不回写属预期，文件不变
    const after = JSON.parse(fs.readFileSync(local.minimaxAuthPath(), 'utf8'));
    assert.equal(after.records['rec-y'].generation, 7);
  }
});
