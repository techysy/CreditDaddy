/**
 * River AI 网页会话余额抓取与 10Router 外部配额推送（联调：$25 免费额度）。
 * 覆盖：
 *  1. parseRiverSession 从 localStorage 快照解析 WorkOS 会话
 *  2. parseRiverBalance 提取 balance_usd
 *  3. fetchRiverBalance 正常读余额
 *  4. 401 自动刷新（WorkOS 单次轮换）——即使调用方未传回调也必须把新链原子落盘
 *  5. buildRiverQuotaPayload 储值余额卡（isCreditBalance / summarizeDetail / 标量）
 *  6. runQuotaPush river 推送链路
 * 全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'river-test-'));
process.env.CREDITDADDY_HOME = HOME;

const client = await import('../src/riverClient.js');
const store = await import('../src/store.js');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init || {});
  return () => { globalThis.fetch = orig; };
}

const STORAGE = {
  'workos:access-token': 'at-original',
  'workos:refresh-token': 'rt-original',
  'workos:expires-at': String(Date.now() + 60_000),
  'workos:user': JSON.stringify({ id: 'user_01RIVER', email: 'dev@example.com', firstName: 'Dev', lastName: 'River' }),
};

test('parseRiverSession：从 localStorage 快照解析 WorkOS 会话与身份', () => {
  const s = client.parseRiverSession(STORAGE);
  assert.equal(s.accessToken, 'at-original');
  assert.equal(s.refreshToken, 'rt-original');
  assert.equal(s.user.id, 'user_01RIVER');
  assert.equal(s.user.email, 'dev@example.com');
  assert.equal(s.user.name, 'Dev River');
  // 缺失容错：空快照不抛
  const empty = client.parseRiverSession({});
  assert.equal(empty.accessToken, null);
});

test('parseRiverBalance：提取 balance_usd（含兜底字段）', () => {
  assert.equal(client.parseRiverBalance({ balance_usd: 25 }), 25);
  assert.equal(client.parseRiverBalance({ data: { balance_usd: 24.5 } }), 24.5);
  assert.equal(client.parseRiverBalance({ balance: 3 }), 3);
  assert.equal(client.parseRiverBalance({}), null);
});

test('fetchRiverBalance：Bearer 读 /api/billing/account 得 balance_usd', async () => {
  const restore = stubFetch(async (url, init) => {
    assert.match(url, /\/api\/billing\/account$/);
    assert.equal(init.headers.Authorization, 'Bearer at-original');
    return jsonResponse(200, { balance_usd: 25, low_balance_threshold_usd: 5 });
  });
  try {
    const r = await client.fetchRiverBalance({ meta: { workosSession: client.parseRiverSession(STORAGE) } }, { fetchImpl: globalThis.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.balance, 25);
  } finally { restore(); }
});

test('fetchRiverBalance：会话 cookie 直连通道（SPA token 在内存、localStorage 空时的主通道）', async () => {
  const restore = stubFetch(async (url, init) => {
    assert.match(url, /\/api\/billing\/account$/);
    // cookie 通道不得混发 Authorization（失效 Bearer 会触发 invalid WorkOS access token）
    assert.equal(init.headers.Authorization, undefined);
    assert.match(init.headers.Cookie, /WORKOS_REFRESH_SESSION=rs-1/);
    return jsonResponse(200, { balance_usd: 25 });
  });
  try {
    const r = await client.fetchRiverBalance({
      meta: { cookieSiteSession: { cookie: 'workos-has-session=true; WORKOS_REFRESH_SESSION=rs-1' } },
    }, { fetchImpl: globalThis.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.channel, 'cookie');
    assert.equal(r.balance, 25);
  } finally { restore(); }
});

test('refreshRiverSession：cookie 授予兑换（useCookie 语义，body 不带 refresh_token）', async () => {
  const restore = stubFetch(async (url, init) => {
    if (String(url).includes('/api/auth/config')) return jsonResponse(200, { workos_client_id: 'client_01TEST', workos_api_hostname: 'auth.console.river.ai' });
    assert.match(String(url), /auth\.console\.river\.ai\/user_management\/authenticate/);
    const body = JSON.parse(init.body);
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, undefined, 'cookie 授予不得带 refresh_token 参数');
    assert.match(init.headers.Cookie, /WORKOS_REFRESH_SESSION=rs-9/);
    return jsonResponse(200, { access_token: 'at-from-cookie', refresh_token: 'rt-new', expires_in: 3600, user: { id: 'user_01RIVER', email: 'dev@example.com' } });
  });
  try {
    const creds = await client.refreshRiverSession({
      meta: { workosSession: { cookie: 'workos-has-session=true; WORKOS_REFRESH_SESSION=rs-9' } },
    }, { fetchImpl: globalThis.fetch });
    assert.equal(creds.accessToken, 'at-from-cookie');
    assert.equal(creds.refreshToken, 'rt-new');
    assert.equal(creds.user.email, 'dev@example.com');
  } finally { restore(); }
});

test('refreshRiverSession：单次轮换后无回调也必须把新链原子落盘（MiniMax 同款防护）', async () => {
  const acc = {
    id: 'river-persist-test',
    name: 'River AI (dev@example.com)',
    provider: 'river',
    token: 'at-original',
    meta: { cookieSiteId: 'river', workosSession: client.parseRiverSession(STORAGE) },
  };
  await store.saveAccounts([acc]);

  const calls = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (String(url).includes('/api/auth/config')) {
      return jsonResponse(200, { workos_client_id: 'client_01TEST', workos_api_hostname: 'auth.console.river.ai' });
    }
    if (String(url).includes('/user_management/authenticate')) {
      const body = JSON.parse(init.body);
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.refresh_token, 'rt-original');
      assert.equal(body.client_id, 'client_01TEST');
      return jsonResponse(200, { access_token: 'at-refreshed', refresh_token: 'rt-refreshed', expires_in: 3600 });
    }
    return jsonResponse(404, {});
  });
  try {
    // 故意不传任何回调，模拟后台额度卡推送的漏传场景
    const creds = await client.refreshRiverSession(acc, { fetchImpl: globalThis.fetch });
    assert.equal(creds.accessToken, 'at-refreshed');
    assert.equal(creds.refreshToken, 'rt-refreshed');

    const disk = (await store.loadAccounts()).find((a) => a.id === 'river-persist-test');
    assert.ok(disk, '账号应存在于磁盘');
    assert.equal(disk.token, 'at-refreshed', '新 access token 必须已落盘');
    assert.equal(disk.meta.workosSession.refreshToken, 'rt-refreshed', '单次轮换的新 refreshToken 必须已落盘');
  } finally { restore(); }
});

test('fetchRiverBalance：401 自动刷新并重试，刷新链落盘', async () => {
  const acc = {
    id: 'river-refresh-retry',
    name: 'River AI (dev@example.com)',
    provider: 'river',
    token: 'at-expired',
    meta: {
      cookieSiteId: 'river',
      workosSession: { accessToken: 'at-expired', refreshToken: 'rt-live', expiresAt: null, user: { id: 'user_01RIVER', email: 'dev@example.com' } },
    },
  };
  await store.saveAccounts([acc]);

  let billingHits = 0;
  const restore = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes('/api/billing/account')) {
      billingHits++;
      return init.headers.Authorization === 'Bearer at-fresh'
        ? jsonResponse(200, { balance_usd: 25 })
        : jsonResponse(401, { error: 'unauthorized' });
    }
    if (u.includes('/api/auth/config')) return jsonResponse(200, { workos_client_id: 'client_01TEST', workos_api_hostname: 'auth.console.river.ai' });
    if (u.includes('/user_management/authenticate')) {
      return jsonResponse(200, { access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600 });
    }
    return jsonResponse(404, {});
  });
  try {
    const r = await client.fetchRiverBalance(acc, { fetchImpl: globalThis.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.balance, 25);
    assert.equal(billingHits, 2, '应为 过期 401 + 刷新后重试 两跳');
    const disk = (await store.loadAccounts()).find((a) => a.id === 'river-refresh-retry');
    assert.equal(disk.token, 'at-fresh');
    assert.equal(disk.meta.workosSession.refreshToken, 'rt-fresh');
  } finally { restore(); }
});

test('jwtExpiresAt 与 isBearerExpired：容差与解析边界', () => {
  const futureExp = Math.floor(Date.now() / 1000) + 300;
  const validJwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64url') + '.sig';
  const iso = client.jwtExpiresAt(validJwt);
  assert.equal(iso, new Date(futureExp * 1000).toISOString());
  assert.equal(client.isBearerExpired(iso), false, '未来 300s 未过期');

  // 过期 25s：在 60s 容差内，不算过期（避免过早刷掉单次轮换的 refresh 链）
  const expired25s = new Date(Date.now() - 25_000).toISOString();
  assert.equal(client.isBearerExpired(expired25s), false, '过期 25s 在 60s 容差内应为 false');

  // 过期 65s：超出 60s 容差，判定为过期跳过
  const expired65s = new Date(Date.now() - 65_000).toISOString();
  assert.equal(client.isBearerExpired(expired65s), true, '过期 65s 超出容差应判定为 true');

  // 异常/非 JWT 输入容错
  assert.equal(client.jwtExpiresAt('not-a-jwt'), null);
  assert.equal(client.jwtExpiresAt(''), null);
  assert.equal(client.jwtExpiresAt(null), null);
  assert.equal(client.isBearerExpired(null), false);
  assert.equal(client.isBearerExpired('invalid-date'), false);
});

test('fetchRiverBalance：已知过期超 60s 时跳过 Bearer 直达刷新兑换，免白打一发必败请求', async () => {
  const expiredJwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 100 })).toString('base64url') + '.sig';
  const freshJwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url') + '.sig';
  const acc = {
    id: 'river-skip-expired-bearer',
    name: 'River AI (dev@example.com)',
    provider: 'river',
    token: expiredJwt,
    meta: {
      cookieSiteId: 'river',
      workosSession: {
        accessToken: expiredJwt,
        refreshToken: 'rt-active',
        expiresAt: new Date(Date.now() - 100_000).toISOString(),
      },
    },
  };
  await store.saveAccounts([acc]);

  const requestedUrls = [];
  const logMessages = [];
  const restore = stubFetch(async (url, init) => {
    requestedUrls.push(String(url));
    if (String(url).includes('/api/auth/config')) {
      return jsonResponse(200, { workos_client_id: 'client_01TEST', workos_api_hostname: 'auth.console.river.ai' });
    }
    if (String(url).includes('/user_management/authenticate')) {
      // 模拟刷新成功（WorkOS 响应不含 expires_in）
      return jsonResponse(200, { access_token: freshJwt, refresh_token: 'rt-next' });
    }
    if (String(url).includes('/api/billing/account')) {
      assert.equal(init.headers.Authorization, `Bearer ${freshJwt}`, '读余额请求必须直接使用刷新后的 freshJwt，不可有打向 expiredJwt 的请求');
      return jsonResponse(200, { balance_usd: 19.8 });
    }
    return jsonResponse(404, {});
  });

  try {
    const r = await client.fetchRiverBalance(acc, {
      fetchImpl: globalThis.fetch,
      log: (msg) => logMessages.push(msg),
    });
    assert.equal(r.ok, true);
    assert.equal(r.channel, 'refresh');
    assert.equal(r.balance, 19.8);
    // 验证日志中含有 "bearer:过期跳过" 标记
    assert.ok(logMessages.some((m) => m.includes('bearer:过期跳过')), '日志中应记录 bearer:过期跳过');
    // 验证新凭据中的 expiresAt 成功由 freshJwt 推导
    assert.ok(r.session?.expiresAt, '刷新得到的 session 必须带有由 JWT 推导出的 expiresAt');
    assert.equal(r.session?.expiresAt, client.jwtExpiresAt(freshJwt));
    // 账目库中的记录应已同步落盘
    const disk = (await store.loadAccounts()).find((a) => a.id === 'river-skip-expired-bearer');
    assert.equal(disk.meta.workosSession.expiresAt, client.jwtExpiresAt(freshJwt));
  } finally { restore(); }
});

test('buildRiverQuotaPayload：储值余额卡（isCreditBalance + summarizeDetail，标量载荷）', () => {
  const account = {
    id: 'acc-1',
    provider: 'river',
    uid: 'user_01RIVER',
    meta: { workosSession: { user: { id: 'user_01RIVER', email: 'dev@example.com' } } },
  };
  const { source, payload } = client.buildRiverQuotaPayload(account, { balance: 25 });
  assert.equal(source, 'river-user01river');
  assert.equal(payload.provider, 'river');
  assert.equal(payload.label, 'River AI (dev@example.com)');
  assert.ok(payload.quotas?.Balance);
  assert.equal(payload.quotas.Balance.name, 'Balance (USD)');
  assert.equal(payload.quotas.Balance.total, 25);
  assert.equal(payload.quotas.Balance.used, 0);
  assert.equal(payload.quotas.Balance.displayRemaining, true);
  assert.equal(payload.quotas.Balance.isCreditBalance, true);
  // 单值余额卡没有可折叠明细——汇总行标记 summarizeDetail，不进逐包明细
  assert.equal(payload.quotas.Balance.summarizesDetail, true);
  // 载荷只允许标量
  for (const [k, v] of Object.entries(payload.quotas.Balance)) {
    assert.notEqual(typeof v, 'object', `quotas.Balance.${k} 必须是标量`);
  }
  // 余额读取失败 → 降级 message 状态卡
  const degraded = client.buildRiverQuotaPayload(account, { error: '会话失效' });
  assert.ok(!degraded.payload.quotas && degraded.payload.message);

  // workos:user 缺邮箱时从账号名抽邮箱，不套成 River AI (River AI (…)) 双层壳
  const { payload: byName } = client.buildRiverQuotaPayload(
    { id: 'acc-2', provider: 'river', name: 'River AI (dev@example.com)', meta: {} },
    { balance: 25 },
  );
  assert.equal(byName.label, 'River AI (dev@example.com)');
  // 名字无邮箱也原样用名字，不空括号
  const { payload: bare } = client.buildRiverQuotaPayload(
    { id: 'acc-3', provider: 'river', name: 'River AI (会话)', meta: {} },
    { balance: 25 },
  );
  assert.equal(bare.label, 'River AI (会话)');
  // 账号别名 = 10R 同名认领的匹配键：改名后 label 跟随（与连接同名即挂卡）
  const { payload: renamed } = client.buildRiverQuotaPayload(
    { id: 'acc-4', provider: 'river', name: '谷歌#1', meta: { workosSession: { user: { email: 'dev@example.com' } } } },
    { balance: 25 },
  );
  assert.equal(renamed.label, '谷歌#1');
});

test('runQuotaPush：river 账号 live 查询并推送 source=river-*', async () => {
  const pushes = [];
  const restore = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes('/api/billing/account')) {
      return init.headers.Authorization === 'Bearer at-live'
        ? jsonResponse(200, { balance_usd: 25 })
        : jsonResponse(401, { error: 'unauthorized' });
    }
    if (u.includes('/api/external-quota/')) {
      pushes.push({ url: u, body: JSON.parse(init.body) });
      return jsonResponse(200, { ok: true, entries: 1 });
    }
    return jsonResponse(404, {});
  });
  try {
    const { runQuotaPush } = await import('../src/externalQuota.js');
    const accounts = [{
      id: 'r1',
      provider: 'river',
      token: 'at-live',
      uid: 'user_01RIVER',
      meta: { cookieSiteId: 'river', workosSession: { accessToken: 'at-live', user: { id: 'user_01RIVER', email: 'dev@example.com' } } },
    }];
    const r = await runQuotaPush({ endpoint: 'http://127.0.0.1:20128', key: 'sk-test', accounts, fetchImpl: globalThis.fetch });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].source, 'river-user01river');
    assert.equal(r.results[0].status, 'ok');
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].body.quotas.Balance.total, 25);
    assert.ok(!JSON.stringify(pushes[0].body).includes('at-live'), '载荷中绝不能出现会话 token');
  } finally { restore(); }
});
