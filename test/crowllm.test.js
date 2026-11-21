import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crowllm-test-home-'));
after(() => { fs.rmSync(process.env.CREDITDADDY_HOME, { recursive: true, force: true }); });

const cs = await import('../src/cookieSites.js');
const cw = await import('../src/crowllmClient.js');

function mockFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: init.headers || {} });
    const r = await handler(String(url), init);
    return new Response(r.body === undefined ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)), { status: r.status || 200, headers: r.headers });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const NEW_API_OK = {
  success: true, message: '', data: {
    id: 7, username: 'techysy', display_name: 'Tech', email: 't@x.com',
    quota: 55000000, used_quota: 1000000,
  },
};
// $110 = 55000000/500000；used = 1000000/500000 = $2

test('crowllm 站点条目：邀请池 loginUrls + probe 判据 + verify api', () => {
  const site = cs.getSite('crowllm');
  assert.ok(site, '条目存在');
  assert.equal(site.verify, 'api');
  assert.ok(Array.isArray(site.loginUrls) && site.loginUrls.length >= 2, '邀请码池');
  assert.ok(site.loginUrls.every((u) => u.startsWith('https://crowllm.com/sign-up?aff=')));
  assert.equal(cs.siteForLoginUrl('https://crowllm.com/sign-up?aff=xGk0')?.id, 'crowllm', '带 aff 参数仍归户到 crowllm 条目');
  assert.equal(site.probe.url, 'https://crowllm.com/api/user/self');
});

test('crowllm 探测：登录态判据走 JSON success 标记，登录页壳判失效', async () => {
  const site = cs.getSite('crowllm');
  const m1 = mockFetch(() => ({ status: 200, body: NEW_API_OK }));
  try {
    const v = await cs.verifySiteCookie(site, 'session=abc');
    assert.equal(v.ok, true, 'success:true 判会话有效');
  } finally { m1.restore(); }
  const m2 = mockFetch(() => ({ status: 200, body: '<html><body>Sign in to continue</body></html>' }));
  try {
    const v = await cs.verifySiteCookie(site, 'stale');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'invalid', '无 success 标记且像登录页 → 会话失效');
  } finally { m2.restore(); }
  const m3 = mockFetch(() => ({ status: 401, body: { success: false } }));
  try {
    const v = await cs.verifySiteCookie(site, 'stale');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'invalid');
  } finally { m3.restore(); }
});

test('fetchCrowllmWallet：quota 换算美元 + 身份字段 + 未登录分类', async () => {
  const m = mockFetch((url, init) => {
    assert.equal(init.headers.Cookie, 'session=abc');
    return { status: 200, body: NEW_API_OK };
  });
  try {
    const w = await cw.fetchCrowllmWallet('session=abc');
    assert.equal(w.auth, true);
    assert.equal(w.ok, true);
    assert.equal(w.balanceUsd, 110, '55000000 / 500000 = $110');
    assert.equal(w.usedUsd, 2);
    assert.equal(w.username, 'Tech');
    assert.equal(w.email, 't@x.com');
  } finally { m.restore(); }

  const m2 = mockFetch(() => ({ status: 200, body: { success: true, data: { quota: 55000000, username: 'u', email: 'u@x', gift_quota: 44000000 } } }));
  try {
    const w = await cw.fetchCrowllmWallet('c');
    assert.equal(w.giftUsd, 88, '站点带 gift_quota 拆分时出赠送行');
  } finally { m2.restore(); }

  for (const [name, resp] of [
    ['401', { status: 401, body: { code: 'AUTH_UNAUTHORIZED' } }],
    ['登录页 HTML', { status: 200, body: '<html>login</html>' }],
    ['无 quota 的 JSON', { status: 200, body: { success: true, data: {} } }],
  ]) {
    const mm = mockFetch(() => resp);
    try {
      const w = await cw.fetchCrowllmWallet('stale');
      assert.equal(w.auth, false, name + ' 判会话失效');
    } finally { mm.restore(); }
  }
});

test('buildCrowllmQuotaPayload：live 总行 + 赠送行 + 失效 message 卡 + 快照兜底', () => {
  const acct = { provider: 'crowllm', uid: '7', name: 'CrowLLM (Tech)' };
  const live = { auth: true, ok: true, balanceUsd: 110, usedUsd: 2, giftUsd: 110 };
  const { source, payload } = cw.buildCrowllmQuotaPayload(acct, live);
  assert.equal(source, 'crowllm-7');
  assert.equal(payload.provider, 'crowllm');
  assert.equal(payload.label, 'CrowLLM (Tech)');
  assert.match(payload.plan, /钱包余额/);
  const bal = payload.quotas.Balance;
  assert.equal(bal.total, 112, 'total = balance + used');
  assert.equal(bal.used, 2);
  assert.equal(bal.isCreditBalance, true);
  assert.equal(payload.quotas.Gift.giftPack, true, '赠送额度拆分行');
  assert.equal(payload.quotas.Gift.total, 110);

  const dead = cw.buildCrowllmQuotaPayload(acct, { auth: false, code: 'NEED_LOGIN' });
  assert.match(dead.payload.message, /重新登录/);
  assert.equal(dead.payload.quotas, undefined, '失效卡无 quotas 数字');

  // 快照兜底（无 live）：giftUsd 从快照带出
  const snapAcct = { provider: 'crowllm', uid: '7', meta: { quotaSnapshot: { used: 0, total: 108, isCreditBalance: true, giftUsd: 110, at: new Date().toISOString() } } };
  const snap = cw.buildCrowllmQuotaPayload(snapAcct, null);
  assert.equal(snap.payload.quotas.Balance.total, 108);
  assert.equal(snap.payload.quotas.Gift.total, 110, '快照里的赠送拆分延续');
});

test('externalQuota：crowllm 段进推送循环（live 拉取 + persistLive + 推卡）', async () => {
  // 面级冒烟：直接 import externalQuota 并确认 crowllm 分支代码在位（函数体字符串探针）
  const src = fs.readFileSync(new URL('../src/externalQuota.js', import.meta.url), 'utf8');
  assert.ok(src.includes("fetchCrowllmWallet"), 'crowllm 段引用取数函数');
  assert.ok(src.includes("buildCrowllmQuotaPayload"), 'crowllm 段引用 payload 构建');
  assert.ok(src.indexOf("cwAccounts") < src.indexOf('// Meoo 快照保鲜'), 'crowllm 段位于 meoo 保鲜段之前');
});
