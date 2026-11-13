import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseDumateCookies,
  buildDumateCookieHeader,
  extractDumateCsrfToken,
  extractDumateUserId,
  maskDumateUserId,
  verifyDumateSession,
  checkinDumate,
  fetchDumateQuota,
  fetchDumateIdentity,
  fetchDumateMyInviteCode,
  redeemDumateInviteCode,
  DUMATE_TOKEN_URL,
  DUMATE_LOGIN_BONUS_URL,
  DUMATE_USER_INFO_URL,
  DUMATE_INVITE_GET_URL,
  DUMATE_INVITE_REDEEM_URL,
} from '../src/dumateClient.js';
import { decryptDumateCookies, readDumateProfiles, liveToAccount } from '../src/dumateLocal.js';
import { getSite } from '../src/cookieSites.js';
import { PROVIDERS, productOf } from '../src/constants.js';
import { productImpl } from '../src/providers.js';
import { TENROUTER_PROVIDER_MAP } from '../src/tenrouterAccounts.js';

const COOKIE_HEADER = 'BDUSS=bduss-test-value; bce-user-info=%222026-11-13T05%3A16%3A00Z%7Cuser-1234567%22; bce-sessionid=sess-1';
const COOKIE_ARRAY = [
  { name: 'BDUSS', value: 'bduss-test-value', domain: '.baidu.com' },
  { name: 'bce-user-info', value: '%222026-11-13T05%3A16%3A00Z%7Cuser-1234567%22', domain: '.bce.baidu.com' },
  { name: 'bce-sessionid', value: 'sess-1', domain: 'console.bce.baidu.com' },
];

const res = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('DuMate Cookie 解析与 CSRF 提取', () => {
  const cookies = parseDumateCookies(COOKIE_HEADER);
  assert.equal(cookies.length, 3);
  assert.equal(cookies[0].name, 'BDUSS');

  const header = buildDumateCookieHeader(COOKIE_ARRAY);
  assert.ok(header.includes('BDUSS=bduss-test-value'));
  assert.ok(header.includes('bce-user-info='));

  const csrf = extractDumateCsrfToken(COOKIE_HEADER);
  assert.equal(csrf, '2026-11-13T05:16:00Z|user-1234567');

  const uid = extractDumateUserId(COOKIE_HEADER);
  assert.equal(uid, 'user-1234567');
  assert.equal(maskDumateUserId(uid), 'use****567');
});

test('DuMate 会话验证：成功换取 token', async () => {
  const mockFetch = async (url) => {
    if (url === DUMATE_TOKEN_URL) {
      return res(200, {
        code: 0,
        success: true,
        result: { token: 'gw-token-xyz', expired_at: '2026-11-14T05:16:00Z' },
      });
    }
    throw new Error('unexpected url');
  };

  const v = await verifyDumateSession(COOKIE_HEADER, { fetchImpl: mockFetch });
  assert.equal(v.auth, true);
  assert.equal(v.ok, true);
  assert.equal(v.token, 'gw-token-xyz');
});

test('DuMate 会话验证：重定向到登录页判定失效', async () => {
  const mockFetch = async () => res(302, '');
  const v = await verifyDumateSession(COOKIE_HEADER, { fetchImpl: mockFetch });
  assert.equal(v.auth, false);
  assert.equal(v.ok, false);
  assert.match(v.error, /登录态已失效/);
});

test('DuMate 每日登录积分签到：成功领取', async () => {
  const mockFetch = async (url, init) => {
    if (url === DUMATE_LOGIN_BONUS_URL) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.csrftoken, '2026-11-13T05:16:00Z|user-1234567');
      assert.ok(init.headers.Cookie.includes('BDUSS='));
      return res(200, { code: 0, success: true, result: true });
    }
    throw new Error('unexpected url');
  };

  const account = { meta: { cookieSiteSession: { cookie: COOKIE_HEADER } } };
  const r = await checkinDumate(account, { fetchImpl: mockFetch });
  assert.equal(r.status, 'checked-in');
  assert.match(r.message, /已领取今日登录/);
});

test('DuMate 本机凭据：AES-256-GCM（iv||tag||ct）解密 + 个人版过滤 + 导入形状', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-local-'));
  const key = crypto.randomBytes(32);
  const cookies = [
    { name: 'BDUSS', value: 'bduss-x', domain: '.baidu.com', expirationDate: Math.floor(Date.now() / 1000) + 86400 },
    { name: 'bce-user-info', value: '%222026-11-13T05%3A16%3A00Z%7Cuser-1234567%22', domain: '.bce.baidu.com' },
    { name: 'expired', value: 'old', domain: '.baidu.com', expirationDate: 1 },
  ];
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(cookies), 'utf8'), c.final()]);
  const enc = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  fs.writeFileSync(path.join(dir, '.cookie-key'), key);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    cookies: enc,
    activeProviderType: 'bce',
    activeProfileId: 'p1',
    accountProfiles: [
      { profileId: 'p1', loginType: 'bce', bceUserId: 'uid-1', displayName: 'Techysy', encryptedCookies: enc },
      { profileId: 'p2', loginType: 'enterprise', bceUserId: 'ent-1', encryptedCookies: enc },
    ],
  }));
  process.env.DUMATE_DATA_DIR = dir;
  try {
    const dec = decryptDumateCookies(enc, key);
    assert.equal(dec.length, 3);
    const profiles = readDumateProfiles();
    assert.equal(profiles.length, 1, '企业版 profile 不导入');
    assert.equal(profiles[0].uid, 'uid-1');
    assert.equal(profiles[0].cookies.length, 2, '过期 cookie 被过滤');
    assert.ok(profiles[0].cookieHeader.includes('BDUSS=bduss-x'));
    const acc = await liveToAccount();
    assert.equal(acc.provider, 'dumate');
    assert.equal(acc.source, 'local-app');
    assert.equal(acc.uid, 'uid-1');
    assert.match(acc.name, /Techysy/);
    assert.ok(acc.token.includes('bce-user-info='));
  } finally {
    delete process.env.DUMATE_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DuMate 个人版身份 / 我的邀请码 / 兑换接口', async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url === DUMATE_USER_INFO_URL) return res(200, { code: 0, success: true, result: { bceUserId: 'uid-1', displayName: 'Techysy' } });
    if (url === DUMATE_INVITE_GET_URL) return res(200, { code: 0, success: true, result: { invitationCode: 'ZW5ABSJ', type: 'NORMAL', activityId: 'invite_bonus' } });
    if (url === DUMATE_INVITE_REDEEM_URL) return res(200, { code: 0, success: true, message: '兑换成功', result: { granted: true } });
    throw new Error('unexpected url ' + url);
  };
  const id = await fetchDumateIdentity(COOKIE_HEADER, { fetchImpl: mockFetch });
  assert.equal(id.ok, true);
  assert.equal(id.uid, 'uid-1');
  assert.equal(id.displayName, 'Techysy');

  const my = await fetchDumateMyInviteCode(COOKIE_HEADER, { fetchImpl: mockFetch });
  assert.equal(my.ok, true);
  assert.equal(my.code, 'ZW5ABSJ');

  const r = await redeemDumateInviteCode(COOKIE_HEADER, 'ZW5ABSJ', { fetchImpl: mockFetch });
  assert.equal(r.ok, true);
  const redeemCall = calls.find((c) => c.url === DUMATE_INVITE_REDEEM_URL);
  assert.equal(redeemCall.method, 'POST');
  const body = JSON.parse(redeemCall.body);
  assert.equal(body.invitationCode, 'ZW5ABSJ');
  assert.equal(body.source, 'pc');
  assert.ok(body.timezone);
  assert.ok(redeemCall.headers.csrftoken);

  const empty = await redeemDumateInviteCode(COOKIE_HEADER, '  ', { fetchImpl: mockFetch });
  assert.equal(empty.ok, false);
});

test('DuMate 供应商登记与 10Router 映射一致性', () => {
  assert.ok(PROVIDERS.includes('dumate'));
  assert.equal(productOf('dumate'), 'dumate');
  assert.equal(TENROUTER_PROVIDER_MAP.dumate, 'dumate');

  // 浏览器登录线（网页会话）与本机导入线并存：站点配置用个人版登录入口
  const site = getSite('dumate');
  assert.ok(site);
  assert.equal(site.provider, 'dumate');
  assert.equal(site.verify, 'api');
  assert.ok(site.loginUrl.includes('from=oa_dumate'), '登录页必须是个人版入口（from=oa_dumate）');

  const impl = productImpl('dumate');
  assert.equal(typeof impl.checkin, 'function');
  assert.equal(typeof impl.quota, 'function');
});

test('DuMate 积分明细 quota_overview 真实解析', async () => {
  const mockFetch = async () => res(200, {
    code: 0,
    success: true,
    result: {
      isSubscribed: true,
      usedPoints: '0.00',
      totalPoints: '5500.00',
      subscription: [
        {
          packageId: 'sub-1',
          usedPoints: '0.00',
          totalPoints: '5000.00',
          pointsExpireDate: 1795182589,
          packageType: 'plan_experience',
          source: 'event_bonus',
          status: 'active',
        },
      ],
      incremental: [
        {
          packageId: 'inc-1',
          usedPoints: '0.00',
          totalPoints: '500.00',
          pointsExpireDate: 1797091199,
          packageType: 'grant_point',
          source: 'login_bonus',
          status: 'active',
        },
      ],
    },
  });

  const account = { token: COOKIE_HEADER };
  const q = await fetchDumateQuota(account, { fetchImpl: mockFetch });
  assert.equal(q.unit, '积分');
  assert.equal(q.total, 5500);
  assert.equal(q.used, 0);
  assert.equal(q.remaining, 5500);
  assert.equal(q.parts.length, 2);
  assert.equal(q.parts[0].name, '体验版订阅积分');
  assert.equal(q.parts[0].total, 5000);
  assert.equal(q.parts[1].name, '登录赠送积分');
  assert.equal(q.parts[1].total, 500);
  assert.ok(q.expiresAt);
});
