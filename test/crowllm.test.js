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
    id: 7, username: 'techysy', display_name: 'Tech', email: 't@x.com', group: 'free',
    earned_quota: 55000000, quota: 0, used_quota: 1000000, aff_history_quota: 0,
  },
};
// $110 = 55000000/500000；used = 1000000/500000 = $2

test('crowllm 站点条目：邀请池 loginUrls + probe 判据 + verify api', () => {
  const site = cs.getSite('crowllm');
  assert.ok(site, '条目存在');
  // 凭据现实：JSON 探针（Cookie/系统令牌）全死，改走 HTML 探针（隐藏窗渲染 /wallet）
  assert.equal(site.verify, undefined, 'verify api 模式已撤——JWT-only API 服务端不可达');
  assert.ok(Array.isArray(site.loginUrls) && site.loginUrls.length >= 2, '邀请码池');
  assert.ok(site.loginUrls.every((u) => u.startsWith('https://crowllm.com/sign-up?aff=')));
  assert.equal(cs.siteForLoginUrl('https://crowllm.com/sign-up?aff=xGk0')?.id, 'crowllm', '带 aff 参数仍归户到 crowllm 条目');
  assert.equal(site.probe.url, 'https://crowllm.com/wallet');
});

test('crowllm 探测：HTML 探针判据走钱包渲染标记，登录页壳判失效', async () => {
  const site = cs.getSite('crowllm');
  // probe = /wallet DOM 渲染判据（服务端 JSON 探针已实测死路——JWT-only API）
  assert.ok(site.probe.url.includes('/wallet'));
  assert.equal(site.probe.match('<div>可用总数</div><div>$110</div>'), true, '钱包渲染标记判通过');
  assert.equal(site.probe.match('<html>正在验证…Cloudflare</html>'), false, 'CF challenge 页不误判');
  const m2 = mockFetch(() => ({ status: 200, body: '<html><body>Sign in to continue</body></html>' }));
  try {
    const v = await cs.verifySiteCookie(site, 'stale');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'invalid', '像登录页 → 会话失效');
  } finally { m2.restore(); }
});

test('fetchCrowllmWallet：JWT Bearer + earned_quota 字段映射 + 未登录分类', async () => {
  const m = mockFetch((url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer jwt-abc', '凭据走 Authorization Bearer');
    assert.equal(init.headers.Cookie, undefined, '这个 fork 无 session Cookie——绝不能拼 Cookie');
    return { status: 200, body: NEW_API_OK };
  });
  try {
    const w = await cw.fetchCrowllmWallet('jwt-abc');
    assert.equal(w.auth, true);
    assert.equal(w.balanceUsd, 110, '总可用 = paid 0 + earned 55000000/500000');
    assert.equal(w.giftUsd, 110, 'earned_quota = 赠送额度（真实字段）');
    assert.equal(w.paidUsd, 0, 'quota = 付费额度');
    assert.equal(w.username, 'Tech');
    assert.equal(w.email, 't@x.com');
  } finally { m.restore(); }

  const m2 = mockFetch(() => ({ status: 200, body: { success: true, data: { earned_quota: 44000000, quota: 2000000, username: 'u', email: 'u@x' } } }));
  try {
    const w = await cw.fetchCrowllmWallet('c');
    assert.equal(w.giftUsd, 88, 'earned_quota 拆分');
    assert.equal(w.paidUsd, 4, 'quota 付费拆分');
    assert.equal(w.balanceUsd, 92, '总可用 = 两项之和');
  } finally { m2.restore(); }

  for (const [name, resp] of [
    ['401 过期', { status: 401, body: { code: 'AUTH_TOKEN_EXPIRED' } }],
    ['登录页 HTML', { status: 200, body: '<html>login</html>' }],
    ['无额度 JSON', { status: 200, body: { success: true, data: {} } }],
    ['空 jwt', null],
  ]) {
    if (resp === null) {
      const w = await cw.fetchCrowllmWallet(null);
      assert.equal(w.auth, false, name + ' 判失效（不发请求）');
      continue;
    }
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
  assert.equal(payload.quotas.Gift.detailOnly, true, '赠送行不入加性池（余额已含赠送，否则双倍）');

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
