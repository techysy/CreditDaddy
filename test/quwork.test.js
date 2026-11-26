/**
 * QuWork 产品线回归钉（2026-11-26 协议落地，源自 10router open-sse/shared/quwork + 本机真机实测）：
 *   - quworkClient：网关解包 / 405 WAF / 401 失效归类；签到 status 门控三态（绝不盲打 claim）；
 *     accessToken 过期先 refresh 并经 ctx.onRefresh 回写；activate 码校验与 deviceId 自造回传；
 *     quota/verify 的统一结构（积分 unit）与抛错契约
 *   - quworkLocal：假 sqlite 收割全字段、命名脱敏（display_name 是手机号）、设备标识确定性、
 *     未装/未登录报错可操作；QUWORK_DATA_DIR 注入隔离真机凭据库（qwenwork 事故同款纪律）
 *   - 协议钉：网关 llm.rrzu.com、头 X-QurWork-Env/1.7.5、端点路径
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { QUWORK_AUTH_API, QUWORK_HEADERS, productOf, PROVIDERS, PROVIDER_LABEL } = await import('../src/constants.js');
const {
  quworkApiRequest, quworkDeviceIdentifier, quworkClaimDailyReward, checkinQuwork,
  fetchQuworkQuota, verifyQuworkAccount, fetchQuworkMyInviteCode, redeemQuworkCode,
  quworkPointsFromSelf, quworkIdentity,
} = await import('../src/quworkClient.js');

// ── fetch mock：按 URL 后缀路由响应；记录调用序列供断言 ──
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error('unrouted url: ' + url);
    const r = routes[key];
    if (typeof r === 'function') return r(url, init);
    return r;
  };
  impl.calls = calls;
  return impl;
}
const resp = (status, payload) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) });
const ok = (data, message) => resp(200, { success: true, data, message: message || '' });

test('协议钉：账号网关与公共头（10R registry/quwork 同源）', () => {
  assert.equal(QUWORK_AUTH_API, 'https://llm.rrzu.com');
  assert.equal(QUWORK_HEADERS['X-QurWork-Env'], 'prod');
  assert.equal(QUWORK_HEADERS['X-QurWork-Version'], '1.7.5', '/api/user/activate 拒绝 <1.6.5，头版本与桌面端对齐');
});

test('产品线注册：PROVIDERS / productOf / PROVIDER_LABEL 都认 quwork', () => {
  assert.equal(PROVIDERS.includes('quwork'), true);
  assert.equal(productOf('quwork'), 'quwork');
  assert.equal(PROVIDER_LABEL.quwork, 'QuWork');
});

test('quworkApiRequest：统一包解包 / 405 WAF / 401 失效 / success:false 错误码映射 / 网络异常', async () => {
  // 解包 data
  const a = await quworkApiRequest('/api/user/self', { accessToken: 'AT', fetchImpl: mockFetch({ '/api/user/self': ok({ id: 8491 }) }) });
  assert.equal(a.ok, true);
  assert.deepEqual(a.data, { id: 8491 });

  // 405 = 阿里云 WAF 拦非大陆 IP（文案必须指向代理）
  const b = await quworkApiRequest('/api/user/self', { accessToken: 'AT', fetchImpl: mockFetch({ '/api/user/self': resp(405, 'blocked') }) });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'waf_blocked');
  assert.match(b.message, /405/);
  assert.match(b.message, /代理/);

  // 401 = 凭据失效（auth=false，调用方决定续期）
  const c = await quworkApiRequest('/api/user/self', { accessToken: 'AT', fetchImpl: mockFetch({ '/api/user/self': resp(401, { message: 'token expired' }) }) });
  assert.equal(c.auth, false);
  assert.equal(c.message, 'token expired');

  // success:false + data.error_code → 人话映射（10R QUWORK_ERROR_HINTS 同口径）
  const d = await quworkApiRequest('/api/user/activate', {
    method: 'POST', accessToken: 'AT', json: {},
    fetchImpl: mockFetch({ '/api/user/activate': resp(200, { success: false, message: 'x', data: { error_code: 'wechat_bind_required' } }) }),
  });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'wechat_bind_required');
  assert.match(d.message, /绑定微信/);

  // fetch 抛错归 network，不炸栈
  const boom = mockFetch({});
  boom.throwOn = true;
  const e = await quworkApiRequest('/api/user/self', { accessToken: 'AT', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(e.ok, false);
  assert.equal(e.code, 'network');
  assert.match(e.message, /ECONNRESET/);
});

test('quworkDeviceIdentifier：sha256 命名空间派生（64-hex），同 seed 稳定', () => {
  const d1 = quworkDeviceIdentifier('seed-A');
  const d2 = quworkDeviceIdentifier('seed-A');
  const d3 = quworkDeviceIdentifier('seed-B');
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.equal(d1, d2);
  assert.notEqual(d1, d3);
  assert.match(quworkDeviceIdentifier(), /^[0-9a-f]{64}$/, '无 seed → 随机 64-hex');
});

test('签到 status 门控三态：can_claim → claimed / claimed=true|can_claim=false → done / wechat_required；status 失败绝不盲打 claim', async () => {
  // 可领 → POST claim，granted 计积分
  const f1 = mockFetch({
    '/daily-reward/status': ok({ claimed: false, can_claim: true }),
    '/daily-reward/claim': ok({ granted: true, points: 100 }),
  });
  const r1 = await quworkClaimDailyReward('AT', { fetchImpl: f1 });
  assert.equal(r1.outcome, 'claimed');
  assert.equal(r1.points, 100);
  assert.equal(r1.claimed, true);

  // 今日已领（claimed=true）→ 不打 claim
  const f2 = mockFetch({ '/daily-reward/status': ok({ claimed: true, can_claim: false }) });
  const r2 = await quworkClaimDailyReward('AT', { fetchImpl: f2 });
  assert.equal(r2.outcome, 'done');
  assert.equal(f2.calls.filter((c) => c.url.includes('/claim')).length, 0, '已领绝不盲打 claim');

  // 需绑微信 → wechat_required（10R 同款：不领、给指引）
  const f3 = mockFetch({ '/daily-reward/status': ok({ wechat_required: true, can_claim: true }) });
  const r3 = await quworkClaimDailyReward('AT', { fetchImpl: f3 });
  assert.equal(r3.outcome, 'wechat_required');
  assert.equal(f3.calls.filter((c) => c.url.includes('/claim')).length, 0);

  // claim 返回 granted=false → 如实 done，不虚报
  const f4 = mockFetch({
    '/daily-reward/status': ok({ claimed: false, can_claim: true }),
    '/daily-reward/claim': ok({ granted: false }),
  });
  assert.equal((await quworkClaimDailyReward('AT', { fetchImpl: f4 })).outcome, 'done');

  // status 查询失败 → failed（不猜）
  const f5 = mockFetch({ '/daily-reward/status': resp(500, { message: 'boom' }) });
  const r5 = await quworkClaimDailyReward('AT', { fetchImpl: f5 });
  assert.equal(r5.outcome, 'failed');
  assert.equal(f5.calls.filter((c) => c.url.includes('/claim')).length, 0);
});

test('checkinQuwork：checked-in 带 claimedAmount/balanceAfter；already；limited(微信)；过期先 refresh 并回写；失效 authExpired', async () => {
  // 正常领取：status→claim→self（余额快照）
  const ctx = { onRefresh: async () => { throw new Error('不该触发'); } };
  const f = mockFetch({
    '/daily-reward/status': ok({ claimed: false, can_claim: true }),
    '/daily-reward/claim': ok({ granted: true, points: 100 }),
    '/api/user/self': ok({ points_entitlement: { total_points: '1200.00' } }),
  });
  const r = await checkinQuwork({ token: 'AT', expiresAt: new Date(Date.now() + 86400_000).toISOString() }, { ...ctx, fetchImpl: f });
  assert.equal(r.status, 'checked-in');
  assert.equal(r.claimedAmount, 100);
  assert.equal(r.balanceAfter, 1200, '签到后 self 余额回写作 balanceAfter（meoo 同款落库链路）');

  // 今日已领
  const f2 = mockFetch({ '/daily-reward/status': ok({ claimed: true }) });
  assert.equal((await checkinQuwork({ token: 'AT' }, { fetchImpl: f2 })).status, 'already');

  // 微信门槛 → limited 单独文案
  const f3 = mockFetch({ '/daily-reward/status': ok({ wechat_required: true, can_claim: true }) });
  const r3 = await checkinQuwork({ token: 'AT' }, { fetchImpl: f3 });
  assert.equal(r3.status, 'limited');
  assert.match(r3.message, /微信/);

  // accessToken 已过期 → 先 /api/user/refresh 续期，onRefresh 回写，再用新 token 打
  let refreshed = null;
  const f4 = mockFetch({
    '/api/user/refresh': ok({ token: 'AT-NEW', expire: Math.floor(Date.now() / 1000) + 7200 }),
    '/daily-reward/status': (url) => {
      assert.match(String(url), /.*/, 'status 必达');
      return ok({ claimed: true });
    },
  });
  const acct4 = { token: 'AT-OLD', expiresAt: new Date(Date.now() - 60_000).toISOString() };
  await checkinQuwork(acct4, {
    fetchImpl: f4,
    onRefresh: async (c) => { refreshed = c; },
  });
  assert.ok(refreshed, '过期链路必须走 ctx.onRefresh 回写新 token');
  assert.equal(refreshed.token, 'AT-NEW');
  assert.equal(refreshed.refreshToken, null, 'QuWork 无独立 refresh token，回写只带 access');
  assert.equal(f4.calls[0].url.includes('/api/user/refresh'), true, '第一步就是续期');
  assert.equal(f4.calls[0].init.headers.Authorization, 'Bearer AT-OLD');

  // 网关判死（401）且续期也失败 → failed + authExpired（面板给重登指引）
  const f5 = mockFetch({
    '/daily-reward/status': resp(401, {}),
    '/api/user/refresh': resp(401, {}),
  });
  const r5 = await checkinQuwork({ token: 'AT' }, { fetchImpl: f5 });
  assert.equal(r5.status, 'failed');
  assert.equal(r5.authExpired, true);
});

test('fetchQuworkQuota：积分余额统一结构（unit 积分、parts 明细、<=0 判 exceeded）；失效抛 e.auth', async () => {
  const q = await fetchQuworkQuota({ token: 'AT' }, {
    fetchImpl: mockFetch({ '/api/user/self': ok({
      points_entitlement: { total_points: '1100.00', limited_points: '100.00', permanent_points: '1000.00' },
    }) }),
  });
  assert.equal(q.unit, '积分');
  assert.equal(q.remaining, 1100);
  assert.equal(q.exceeded, false);
  assert.equal(q.parts[0].name, '积分余额');
  const names = q.parts.map((p) => p.name);
  assert.ok(names.some((n) => n.includes('限时')), 'limited/permanent 作明细行展示');

  const q0 = await fetchQuworkQuota({ token: 'AT' }, {
    fetchImpl: mockFetch({ '/api/user/self': ok({ points_entitlement: { total_points: '0.00' } }) }),
  });
  assert.equal(q0.exceeded, true);

  await assert.rejects(
    fetchQuworkQuota({ token: 'AT' }, { fetchImpl: mockFetch({ '/api/user/self': resp(401, {}) }) }),
    (e) => e.auth === true,
  );
});

test('verifyQuworkAccount：契约是抛错（addAccount 落 verified=false）；display_name 为手机号时不取名', async () => {
  // 真机形态：display_name 就是 11 位手机号（uid 8491 实测）——不能整串进账号名
  const v = await verifyQuworkAccount({ token: 'AT' }, {
    fetchImpl: mockFetch({ '/api/user/self': ok({ id: 8491, display_name: '13194973656', aff_code: '230548' }) }),
  });
  assert.equal(v.uid, '8491');
  assert.equal(v.name, null, '纯手机号 display_name 不当昵称');

  const v2 = await verifyQuworkAccount({ token: 'AT' }, {
    fetchImpl: mockFetch({ '/api/user/self': ok({ id: 99, display_name: '师洋' }) }),
  });
  assert.equal(v2.name, '师洋');

  await assert.rejects(
    verifyQuworkAccount({ token: 'AT' }, { fetchImpl: mockFetch({ '/api/user/self': resp(401, {}) }) }),
    (e) => e.auth === true,
  );
});

test('fetchQuworkMyInviteCode：self.aff_code + invite/summary 进度组合；summary 失败不吞码', async () => {
  const r = await fetchQuworkMyInviteCode('AT', {
    fetchImpl: mockFetch({
      '/api/user/self': ok({ aff_code: '230548', per_invite_points: 1000 }),
      '/api/user/invite/summary': ok({ invited_count: 3, total_points: 3000, max_invite_count: 20 }),
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, '230548');
  assert.equal(r.count, 3);
  assert.equal(r.rewardPoints, 3000);
  assert.equal(r.perInvitePoints, 1000);
  assert.equal(r.maxInvite, 20);

  // summary 挂了：码照给，进度留 null（面板按缺省隐藏）
  const r2 = await fetchQuworkMyInviteCode('AT', {
    fetchImpl: mockFetch({
      '/api/user/self': ok({ aff_code: '230548' }),
      '/api/user/invite/summary': resp(500, {}),
    }),
  });
  assert.equal(r2.code, '230548');
  assert.equal(r2.count, null);
});

test('redeemQuworkCode：订单号/兑换码/邀请码同端点 /api/user/activate；deviceId 缺失自造并回传；weChat/版本错误码映射', async () => {
  let sent = null;
  const f = mockFetch({
    '/api/user/activate': (url, init) => {
      sent = JSON.parse(init.body);
      return ok(null, '兑换成功');
    },
  });
  const r = await redeemQuworkCode('AT', 'ORDER-123', { deviceId: 'a'.repeat(64), fetchImpl: f });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, { invite_code: 'ORDER-123', device_identifier: 'a'.repeat(64), device_uuid: '' });

  // 无 deviceId → 现场自造 64-hex 随结果回传（调用方负责落库复用）
  const r2 = await redeemQuworkCode('AT', '230549', { fetchImpl: mockFetch({ '/api/user/activate': ok(null, '激活成功') }) });
  assert.match(r2.deviceId, /^[0-9a-f]{64}$/);

  // 空码 / 非法码：不发请求
  const f3 = mockFetch({});
  assert.equal((await redeemQuworkCode('AT', '  ', { fetchImpl: f3 })).ok, false);
  assert.equal((await redeemQuworkCode('AT', '中文码!', { fetchImpl: f3 })).ok, false);
  assert.equal(f3.calls?.length, 0);

  // 业务失败（未绑微信）→ 人话 + code
  const r4 = await redeemQuworkCode('AT', '230549', {
    deviceId: 'b'.repeat(64),
    fetchImpl: mockFetch({ '/api/user/activate': resp(200, { success: false, message: 'no wechat', data: { error_code: 'wechat_bind_required' } }) }),
  });
  assert.equal(r4.ok, false);
  assert.match(r4.error, /绑定微信/);
});

test('quworkIdentity：uid 优先归户键', () => {
  assert.equal(quworkIdentity({ uid: 8491 }), 'quwork-user-8491');
  assert.match(quworkIdentity({ phone: '13194973656' }), /^quwork-phone-[0-9a-f]{16}$/);
});

test('quworkPointsFromSelf：字符串金额 → 数字（真机 total_points:"1100.00"）', () => {
  const p = quworkPointsFromSelf({ points_entitlement: { total_points: '1100.00', limited_points: '100.00' } });
  assert.equal(p.total, 1100);
  assert.equal(p.limited, 100);
  assert.equal(quworkPointsFromSelf({}).total, null);
});

// ── 收割线：QUWORK_DATA_DIR 注入沙盒，绝不碰真机凭据库 ──

async function makeSandboxDb(t, sessionJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quwork-test-'));
  process.env.QUWORK_DATA_DIR = dir;
  // 假 exe 让 installed=true（路径也走 env 注入）
  const installDir = path.join(dir, 'Programs', 'QuWork');
  fs.mkdirSync(installDir, { recursive: true });
  const exe = path.join(installDir, process.platform === 'win32' ? 'QuWork.exe' : 'QuWork');
  fs.writeFileSync(exe, 'MZ-fake');
  process.env.QUWORK_CLIENT_PATH = exe;
  t.after(() => {
    delete process.env.QUWORK_DATA_DIR;
    delete process.env.QUWORK_CLIENT_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (sessionJson !== undefined) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'qurwork-desktop.sqlite'));
    db.exec('CREATE TABLE auth_session (id INTEGER PRIMARY KEY, schema_version INTEGER, session_json TEXT, updated_at INTEGER)');
    if (sessionJson !== null) {
      db.prepare('INSERT INTO auth_session (schema_version, session_json, updated_at) VALUES (?,?,?)')
        .run(1, typeof sessionJson === 'string' ? sessionJson : JSON.stringify(sessionJson), Date.now());
    }
    db.close();
  }
  return dir;
}

const fakeJwt = (subId) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ uid: subId, exp: Math.floor(Date.now() / 1000) + 86_400 })).toString('base64url');
  return `${h}.${b}.sig`;
};

test('quworkLocal：真机形状 sqlite 收割——token/uid/aff/微信态/积分/设备标识/路径全字段', async (t) => {
  const { detectQuwork, quworkLiveAccount, _setQuworkPathsForTests } = await import('../src/quworkLocal.js');
  const session = {
    accessToken: fakeJwt(8491),
    expiresAt: Date.now() + 30 * 86400_000,
    llmToken: 'sk-fake-llm-token',
    user: {
      id: 8491, aff_code: '230548', inviter_id: 1, wechat_bound: true, phone: '13194973656',
      display_name: '13194973656', username: 'q13194973656',
      points_entitlement: { total_points: '1100.00', limited_points: '100.00', permanent_points: '1000.00' },
    },
    createdAt: 1, updatedAt: 2,
  };
  await makeSandboxDb(t, session);
  _setQuworkPathsForTests(null);   // 走 env 注入路径

  const det = detectQuwork();
  assert.equal(det.installed, true);
  assert.equal(det.dbExists, true);

  const acc = await quworkLiveAccount();
  assert.equal(acc.provider, 'quwork');
  assert.equal(acc.uid, '8491');
  assert.equal(acc.token, session.accessToken);
  assert.equal(acc.refreshToken, null, 'QuWork 没有独立 refresh token——收割必须留 null');
  assert.equal(acc.source, 'local-app');
  assert.equal(acc.meta.quworkAffCode, '230548');
  assert.equal(acc.meta.quworkWechatBound, true);
  assert.equal(acc.meta.quworkPoints, 1100);
  assert.equal(acc.meta.quworkLlmToken, 'sk-fake-llm-token');
  assert.match(acc.meta.quworkDeviceId, /^[0-9a-f]{64}$/);
  // 设备标识确定性：重导同 uid 得同值（跨沙盒目录不变，只认 uid/seed）
  const acc2 = await quworkLiveAccount();
  assert.equal(acc2.meta.quworkDeviceId, acc.meta.quworkDeviceId);
  // 命名脱敏：display_name=手机号 → 名字里必须是 131****656 而非整串
  assert.ok(acc.name.includes('131****3656'), '手机号进名字必须掩码：' + acc.name);
  assert.ok(!acc.name.includes('13194973656'), '账号名不得含完整手机号');
});

test('quworkLocal：库缺/表空/无凭据 → 可操作报错（未装指引安装、已装指引登录）', async (t) => {
  const { quworkLiveAccount, _setQuworkPathsForTests } = await import('../src/quworkLocal.js');
  _setQuworkPathsForTests(null);

  // 场景 1：装了但库文件不存在
  await makeSandboxDb(t, undefined);
  await assert.rejects(quworkLiveAccount(), /登录库还不存在|启动客户端登录/);

  // 场景 2：库在但 auth_session 空表
  await makeSandboxDb(t, null);
  await assert.rejects(quworkLiveAccount(), /没有凭据|登录库/);

  // 场景 3：session_json 缺 accessToken
  await makeSandboxDb(t, JSON.stringify({ llmToken: 'sk-x', user: { id: 1 } }));
  await assert.rejects(quworkLiveAccount(), /没有凭据/);
});

test('quworkLocal：未安装客户端（无 exe 无库）→ 报错含安装指引', async (t) => {
  const { quworkLiveAccount, _setQuworkPathsForTests } = await import('../src/quworkLocal.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quwork-none-'));
  process.env.QUWORK_DATA_DIR = dir;
  process.env.QUWORK_CLIENT_PATH = path.join(dir, 'missing', 'QuWork.exe');
  t.after(() => {
    delete process.env.QUWORK_DATA_DIR;
    delete process.env.QUWORK_CLIENT_PATH;
    _setQuworkPathsForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  _setQuworkPathsForTests(null);
  await assert.rejects(quworkLiveAccount(), /未检测到 QuWork 客户端/);
});

test('providers.js：quwork 线挂上 checkin/quota/verify 三实现', async () => {
  const { productImpl } = await import('../src/providers.js');
  const impl = productImpl('quwork');
  assert.equal(typeof impl?.checkin, 'function');
  assert.equal(typeof impl?.quota, 'function');
  assert.equal(typeof impl?.verify, 'function');
  assert.equal(impl.label, 'QuWork');
});
