import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkinMeoo, fetchMeooQuota, fetchMeooPoints, fetchMeooIdentity, maskMeooUserId,
  MEOO_IDENTITY_URL, MEOO_POINTS_URL, resolveMeooProjectAk,
} from '../src/meooClient.js';
import { getSite } from '../src/cookieSites.js';
import { PROVIDERS, productOf } from '../src/constants.js';
import { productImpl } from '../src/providers.js';
import { TENROUTER_PROVIDER_MAP } from '../src/tenrouterAccounts.js';
import { buildExportPayload } from '../src/transfer.js';

const CP_HEADERS = { 'X-Meoo-Client': 'cli', 'X-Meoo-CLI-Version': '0.5.8' };
const TOKEN = 'meoo_ak_test123';

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });

const identityBody = { success: true, data: { user_id: '1234567890', username: 'Techysy' } };
const pointsBody = (granted, balance, extra = {}) => ({
  success: true,
  data: {
    account: { availableBalance: balance, totalGranted: granted, totalConsumed: 100, totalExpired: 0 },
    activeGrants: [
      { sourceTypeName: '每日赠送', totalInitialAmount: 2000, totalRemainingAmount: 1800,
        grantDetails: [{ expiresDate: '2026-11-20T00:00:00Z' }] },
      ...((extra.grants || [])),
    ],
  },
});

function mockFetch({ points = [], identity = res(200, identityBody) } = {}) {
  const calls = [];
  let i = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url).includes('/account/points')) return points[Math.min(i++, points.length - 1)];
    if (String(url).includes('/account/identity')) return identity;
    throw new Error('unexpected url: ' + url);
  };
  fn.calls = calls;
  return fn;
}

test('控制面身份：identity 取 uid/昵称，请求头带 cli 标记', async () => {
  const f = mockFetch();
  const r = await fetchMeooIdentity(TOKEN, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.uid, '1234567890');
  assert.equal(r.name, 'Techysy');
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].headers['X-Meoo-Client'], 'cli');
  assert.equal(f.calls[0].headers['X-Meoo-CLI-Version'], '0.5.8');
});

test('401 判凭据失效（auth=false）', async () => {
  const r = await fetchMeooIdentity('meoo_ak_dead', { fetchImpl: () => res(401, { errCode: 'UNAUTHORIZED' }) });
  assert.equal(r.auth, false);
});

test('积分账面：balance/totalGranted/grants 逐包（批次到期日取最近）', async () => {
  const f = mockFetch({ points: [res(200, pointsBody(5000, 4300, { grants: [
    { sourceTypeName: '订阅', totalInitialAmount: 3000, totalRemainingAmount: 2500, grantDetails: [{ expiresDate: '2026-12-10T00:00:00Z' }] },
  ] })) ] });
  const r = await fetchMeooPoints(TOKEN, { fetchImpl: f });
  assert.equal(r.balance, 4300);
  assert.equal(r.totalGranted, 5000);
  assert.equal(r.grants.length, 2);
  assert.equal(r.grants[0].remaining, 1800);
  assert.equal(r.grants[0].expiresAt, '2026-11-20T00:00:00.000Z');
  assert.equal(r.grants[1].recurring, true, '订阅来源 recurring');
});

test('额度（quota 口径）：total=累计发放 used=累计消耗 remaining=余额', async () => {
  const f = mockFetch({ points: [res(200, pointsBody(5000, 4300))] });
  const q = await fetchMeooQuota({ token: TOKEN }, { fetchImpl: f });
  assert.equal(q.unit, '积分');
  assert.equal(q.total, 5000);
  assert.equal(q.used, 100);
  assert.equal(q.remaining, 4300);
  assert.equal(q.parts.length, 1);
  assert.equal(q.parts[0].name, '每日赠送');
});

test('签到：账面涨了 → checked-in +delta；没涨 → already（绝不假装成功）', async () => {
  // 第一次：before=5000 → 动作 → after=7000（+2000）
  const f1 = mockFetch({ points: [res(200, pointsBody(5000, 4300)), res(200, pointsBody(7000, 6300))] });
  const r1 = await checkinMeoo({ token: TOKEN }, { fetchImpl: f1, sleep: async () => {} });
  assert.equal(r1.status, 'checked-in');
  assert.equal(r1.claimedAmount, 2000);
  assert.equal(r1.balanceAfter, 6300);
  // 触发动作 = 身份读在 before 之后
  assert.ok(f1.calls[1].url.includes('/account/identity'));

  // 第二次：账面不动 → already（10R 同口径：今日可能已领取也算闭环）
  const f2 = mockFetch({ points: [res(200, pointsBody(7000, 6300)), res(200, pointsBody(7000, 6300)), res(200, pointsBody(7000, 6300)), res(200, pointsBody(7000, 6300))] });
  const r2 = await checkinMeoo({ token: TOKEN }, { fetchImpl: f2, sleep: async () => {} });
  assert.equal(r2.status, 'already');
});

test('签到：基线 401 → failed + authExpired', async () => {
  const f = mockFetch({ points: [res(401, { errCode: 'UNAUTHORIZED' })] });
  const r = await checkinMeoo({ token: TOKEN }, { fetchImpl: f, sleep: async () => {} });
  assert.equal(r.status, 'failed');
  assert.equal(r.authExpired, true);
});

test('项目 AK 预解析：projects → cloud/environment', async () => {
  const f = async (url) => {
    if (String(url).includes('/projects?')) return res(200, { success: true, data: { projects: [{ urlId: 'proj-1', name: 'demo' }] } });
    if (String(url).includes('/projects/proj-1/cloud/environment')) return res(200, { success: true, data: { meooProjectApiKey: { enabled: true, apiKey: 'mk-ak-xyz' } } });
    throw new Error('unexpected url ' + url);
  };
  const r = await resolveMeooProjectAk(TOKEN, { fetchImpl: f });
  assert.equal(r.urlId, 'proj-1');
  assert.equal(r.apiKey, 'mk-ak-xyz');
  assert.equal(r.akStatus, 'active');
});

test('Meoo 独立产品线登记：不走网页会话 + 10R 映射 + blob Key 行不放 accessToken', () => {
  assert.ok(PROVIDERS.includes('meoo'));
  assert.equal(productOf('meoo'), 'meoo');
  assert.equal(TENROUTER_PROVIDER_MAP.meoo, 'meoo');
  assert.equal(getSite('meoo'), null, '网页会话条目已移除');

  const impl = productImpl('meoo');
  assert.equal(typeof impl.checkin, 'function');
  assert.equal(typeof impl.quota, 'function');
  assert.equal(typeof impl.verify, 'function');

  // Key 行：blob 不带 accessToken，凭证在 psd.meooControlKey（10R 00cde6b7 接收口径）
  const keyAcc = { provider: 'meoo', token: 'meoo_ak_abc', uid: 'u1', name: 'Meoo (Techysy)', meta: { meooProject: { urlId: 'p1', apiKey: 'mk-1', akStatus: 'active' } } };
  const payload = buildExportPayload([keyAcc]);
  const row = payload.accounts[0];
  assert.equal(row.accessToken, undefined);
  assert.equal(row.providerSpecificData.meooControlKey, 'meoo_ak_abc');
  assert.equal(row.providerSpecificData.projectUrlId, 'p1');
  assert.equal(row.providerSpecificData.projectApiKey, 'mk-1');
  assert.equal(row.providerSpecificData.creditDaddySync, true);
  assert.equal(maskMeooUserId('1234567890'), '123****890');

  // OAuth 行：token 照常进 accessToken
  const oauthAcc = { provider: 'meoo', token: 'oauth-tok', refreshToken: 'rf', uid: 'u2', name: 'Meoo' };
  const row2 = buildExportPayload([oauthAcc]).accounts[0];
  assert.equal(row2.accessToken, 'oauth-tok');
  assert.equal(row2.refreshToken, 'rf');
});

test('脱敏：maskMeooUserId 同灵犀口径', () => {
  assert.equal(maskMeooUserId('1234567'), '123****567');
  assert.equal(maskMeooUserId('12345'), '1****5');
  assert.equal(maskMeooUserId('12'), '****');
});
