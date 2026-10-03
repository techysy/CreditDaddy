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
  assert.equal(q.unit, '算力币');
  assert.equal(q.total, 9500);
  assert.equal(q.remaining, 9500);
  assert.equal(q.plan, 'Pro');
  assert.equal(q.parts.length, 2);
  assert.equal(q.parts[0].name, '免费/活动算力币');
  assert.equal(q.parts[0].remaining, 1500);
  assert.equal(q.parts[0].recurring, true);
  assert.equal(q.parts[1].name, '购买算力币');
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
