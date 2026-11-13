import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkinMeoo, fetchMeooQuota, fetchMeooEntitlement, fetchMeooIdentity, maskMeooUserId,
  MEOO_INIT_URL, MEOO_ENTITLEMENT_URL, MEOO_USER_URL,
} from '../src/meooClient.js';
import { getSite } from '../src/cookieSites.js';
import { PROVIDERS, productOf } from '../src/constants.js';
import { productImpl } from '../src/providers.js';

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const NEED_LOGIN = { success: false, errCode: 'NEED_LOGIN', errMsg: 'need login' };

const entBody = (balance = 4000, extra = {}) => ({
  success: true,
  data: {
    planCode: 'FREE',
    benefits: [{ typeCode: 'daily_login', quota: 2000 }, { typeCode: 'model_credits', quota: 0, used: 0 }],
    userPointInfo: { account: { availableBalance: balance, totalGranted: 6000, totalConsumed: 2000 }, ...extra },
  },
});

/** 按 URL 分发的假 fetch；init 支持按调用次序返回不同响应 */
function mockFetch({ init = [], ent = res(200, entBody()), user = res(200, { success: true, data: { user_id: '1234567890' } }) } = {}) {
  const calls = [];
  let i = 0;
  const fn = async (url, initOpts) => {
    calls.push({ url, headers: initOpts?.headers });
    if (url === MEOO_INIT_URL) { const r = init[Math.min(i, init.length - 1)]; i++; return r; }
    if (url === MEOO_ENTITLEMENT_URL) return ent;
    if (url === MEOO_USER_URL) return user;
    throw new Error(`unexpected url: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const account = { meta: { cookieSiteSession: { cookie: 'session=test' } } };
const noSleep = async () => {};

test('首登发放：dailyLoginGranted=true → checked-in +2000，并带回余额', async () => {
  const f = mockFetch({ init: [res(200, { success: true, data: { initialized: true, dailyLoginGranted: true, dailyLoginGrantAmount: 2000, inviteRewardArrivals: [] } })] });
  const r = await checkinMeoo(account, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 'checked-in');
  assert.equal(r.claimedAmount, 2000);
  assert.equal(r.balanceAfter, 4000);
  assert.match(r.message, /\+2000/);
  // 会话 cookie 原样带上，Referer/Origin 为 meoo.com
  assert.equal(f.calls[0].headers.Cookie, 'session=test');
  assert.equal(f.calls[0].headers.Origin, 'https://meoo.com');
});

test('当日已初始化且无发放 → already（不报虚假 +N）', async () => {
  const f = mockFetch({ init: [res(200, { success: true, data: { initialized: true, dailyLoginGranted: false, dailyLoginGrantAmount: 0 } })] });
  const r = await checkinMeoo(account, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 'already');
  assert.equal(r.claimedAmount, undefined);
});

test('initialized=false 按前端同款退避重查，就绪后发放', async () => {
  const f = mockFetch({ init: [
    res(200, { success: true, data: { initialized: false } }),
    res(200, { success: true, data: { initialized: true, dailyLoginGranted: true, dailyLoginGrantAmount: 2000 } }),
  ] });
  const r = await checkinMeoo(account, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 'checked-in');
  assert.equal(f.calls.filter((c) => c.url === MEOO_INIT_URL).length, 2);
});

test('initialized 一直 false → failed（下轮自动重试），重查次数有上限', async () => {
  const f = mockFetch({ init: [res(200, { success: true, data: { initialized: false } })] });
  const r = await checkinMeoo(account, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.ok(f.calls.filter((c) => c.url === MEOO_INIT_URL).length <= 4);
});

test('NEED_LOGIN（401）→ failed + authExpired，提示重新登录捕获，不抛异常', async () => {
  const f = mockFetch({ init: [res(401, NEED_LOGIN)] });
  const r = await checkinMeoo(account, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(r.authExpired, true);
  assert.match(r.message, /NEED_LOGIN/);
  assert.match(r.message, /重新登录/);
});

test('HTTP 200 但业务码 NEED_LOGIN 同样判会话失效', async () => {
  const f = mockFetch({ init: [res(200, NEED_LOGIN)] });
  const r = await checkinMeoo(account, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(r.authExpired, true);
});

test('无会话 cookie → failed，不发请求', async () => {
  const f = mockFetch({ init: [res(200, {})] });
  const r = await checkinMeoo({ meta: {} }, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(f.calls.length, 0);
});

test('权益接口：余额 / 套餐 / 每日首登额度 / 逐笔发放（带到期日）', async () => {
  const ent = res(200, entBody(4000, { activeGrants: [
    { sourceType: 'DAILY_LOGIN', grantDetails: [
      { remainingAmount: 2000, grantAmount: 2000, effectiveDate: '2026-11-12', expiresDate: '2026-11-19' },
      { remainingAmount: 0, grantAmount: 2000, effectiveDate: '2026-11-11', expiresDate: '2026-11-18' },
    ] },
    { sourceType: 'INVITE_REWARD', grantDetails: [{ remainingAmount: 2000, grantAmount: 2000, expiresDate: '2026-12-01' }] },
  ] }));
  const e = await fetchMeooEntitlement('session=test', { fetchImpl: mockFetch({ ent }) });
  assert.equal(e.auth, true);
  assert.equal(e.balance, 4000);
  assert.equal(e.planCode, 'free');
  assert.equal(e.dailyLoginQuota, 2000);
  assert.equal(e.grants.length, 3);
  assert.deepEqual(e.grants[0], { source: 'DAILY_LOGIN', remaining: 2000, total: 2000, effectiveAt: '2026-11-12', expireAt: '2026-11-19' });

  const q = await fetchMeooQuota(account, { fetchImpl: mockFetch({ ent }) });
  assert.equal(q.remaining, 4000);
  assert.equal(q.parts.length, 3);
  assert.equal(q.parts[1].used, 2000);
  assert.ok(q.parts[0].expiresAt.startsWith('2026-11-19'));
  assert.equal(q.parts[0].unit, '秒悟积分');
});

test('权益接口无逐笔明细时 quota 兜底单行余额', async () => {
  const q = await fetchMeooQuota(account, { fetchImpl: mockFetch() });
  assert.equal(q.total, 4000);
  assert.equal(q.parts.length, 1);
  assert.equal(q.empty, false);
});

test('quota 遇 NEED_LOGIN 抛 auth 错误', async () => {
  await assert.rejects(
    () => fetchMeooQuota(account, { fetchImpl: mockFetch({ ent: res(401, NEED_LOGIN) }) }),
    (e) => e.auth === true && /NEED_LOGIN/.test(e.message),
  );
});

test('身份：user/me 取 user_id；need_login=true 判失效；展示脱敏', async () => {
  const ok = await fetchMeooIdentity('session=test', { fetchImpl: mockFetch() });
  assert.equal(ok.userId, '1234567890');
  const dead = await fetchMeooIdentity('session=test', { fetchImpl: mockFetch({ user: res(200, { success: true, data: { need_login: true } }) }) });
  assert.equal(dead.auth, false);
  assert.equal(maskMeooUserId('1234567890'), '123****890');
  assert.equal(maskMeooUserId('12345'), '1****5');
  assert.equal(maskMeooUserId('12'), '****');
});

test('接线：站点表 / provider / 产品线 / 签到实现均已登记', () => {
  const site = getSite('meoo');
  assert.ok(site);
  assert.equal(site.provider, 'meoo');
  assert.equal(site.verify, 'api');
  assert.equal(site.no10rSync, true);
  assert.deepEqual(site.cookieUrls, ['https://meoo.com']);
  assert.ok(PROVIDERS.includes('meoo'));
  assert.equal(productOf('meoo'), 'meoo');
  assert.equal(typeof productImpl('meoo').checkin, 'function');
  assert.equal(typeof productImpl('meoo').quota, 'function');
});
