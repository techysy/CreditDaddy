import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDumateCookies,
  buildDumateCookieHeader,
  extractDumateCsrfToken,
  extractDumateUserId,
  maskDumateUserId,
  verifyDumateSession,
  checkinDumate,
  fetchDumateQuota,
  DUMATE_TOKEN_URL,
  DUMATE_LOGIN_BONUS_URL,
} from '../src/dumateClient.js';
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

test('DuMate 供应商登记与 10Router 映射一致性', () => {
  assert.ok(PROVIDERS.includes('dumate'));
  assert.equal(productOf('dumate'), 'dumate');
  assert.equal(TENROUTER_PROVIDER_MAP.dumate, 'dumate');

  const site = getSite('dumate');
  assert.ok(site);
  assert.equal(site.provider, 'dumate');
  assert.equal(site.verify, 'api');

  const impl = productImpl('dumate');
  assert.equal(typeof impl.checkin, 'function');
  assert.equal(typeof impl.quota, 'function');
});
