/**
 * Qoder 网页会话保活监视（startWebSessionWatch）：
 *  - probeWebSession 拒绝（返回 null）→ meta.qoderWebDead 落标记
 *  - 探测通过 → 清标记（复活）
 *  - 网络异常（抛错）→ 保守不动标记（下一轮再试）
 *  - 投影：store.toPanelAccount 回 qoderWebDead 时间戳（不回 Cookie）
 * 全部注入 fetch，无网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离代理：fetchJsonRace 的 viaProxy 路径走 node:http/tls 原生模块（不经
// globalThis.fetch），开发机 shell 里的 https_proxy / HTTPS_PROXY 会让它绕过
// fetch stub 发真网络请求（6-8s 耗时、探测结果被真实响应覆盖）。本文件
// 「全部注入 fetch，无网络」的承诺靠摘掉代理变量兑现。
for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'all_proxy']) delete process.env[k];

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-watch-test-'));
process.env.CREDITDADDY_HOME = HOME;

const store = await import('../src/store.js');
const checkin = await import('../src/checkin.js');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init || {});
  return () => { globalThis.fetch = orig; };
}

async function seedQoder(overrides = {}) {
  const acc = {
    // 必须带 id：产品代码与断言都按 id 精确寻址（withAccounts / find）。
    // 缺 id 时 find(x.id === acc.id) 退化成「第一个 undefined id 的账号」，
    // 多账号共存时永远命中第一个种子，断言到错的记录上。
    id: 'acc-' + Math.random().toString(36).slice(2),
    name: '测试号',
    provider: 'qoder',
    token: 'tok-' + Math.random().toString(36).slice(2),
    uid: 'uid-' + Math.random().toString(36).slice(2),
    meta: { qoderWebSession: { cookie: 'c=1', capturedAt: new Date().toISOString() } },
    ...overrides,
  };
  const accounts = await store.loadAccounts();
  accounts.push(acc);
  await store.saveAccounts(accounts);
  return acc;
}

test('保活监视：探测拒绝（401）→ 落 qoderWebDead 标记；探测通过 → 复活', async () => {
  const acc = await seedQoder();
  // 401 = probeWebSession 拿不到 user_id → null → 判死
  let restore = stubFetch(() => jsonResponse(401, { error: 'unauthorized' }));
  try { await checkin.runWebSessionWatchTick(); } finally { restore(); }
  let hit = (await store.loadAccounts()).find((x) => x.id === acc.id);
  assert.ok(hit.meta.qoderWebDead?.at, '判死后应落标记');

  // 换成有效响应 → 复活（清标记）
  restore = stubFetch(() => jsonResponse(200, { user_id: acc.uid }));
  try { await checkin.runWebSessionWatchTick(); } finally { restore(); }
  hit = (await store.loadAccounts()).find((x) => x.id === acc.id);
  assert.equal(hit.meta.qoderWebDead, undefined, '复活后应清标记');
});

test('保活监视：网络异常 → 保守不动标记（不误杀）', async () => {
  const acc = await seedQoder();
  const restore = stubFetch(() => { throw new Error('ECONNRESET'); });
  try { await checkin.runWebSessionWatchTick(); } finally { restore(); }
  const hit = (await store.loadAccounts()).find((x) => x.id === acc.id);
  assert.equal(hit.meta.qoderWebDead, undefined, '网络异常不应判死');
});

test('store 投影：qoderWebDead 只回时间戳，qoderWebSession.cookie 永不回显', async () => {
  // 按精确 id 找自己种入的账号：模糊 find（x.meta?.qoderWebDead）会被
  // 前面测试留下的死标记账号串位，断言到错的记录上
  const acc = await seedQoder({ meta: { qoderWebSession: { cookie: 'SECRET', capturedAt: '2026-10-15T00:00:00Z' }, qoderWebDead: { at: '2026-10-15T01:00:00Z' } } });
  const accounts = await store.loadAccounts();
  const hit = accounts.find((x) => x.id === acc.id);
  assert.ok(hit, '刚种入的账号必须能按 id 找到');
  const panel = store.publicAccount(hit);
  assert.equal(panel.qoderWebDead, '2026-10-15T01:00:00Z');
  assert.equal(panel.qoderWebCapturedAt, '2026-10-15T00:00:00Z');
  assert.equal(JSON.stringify(panel).includes('SECRET'), false);
});

test('store 投影：非 qoder 账号 qoderWebDead 恒 null', async () => {
  const accounts = await store.loadAccounts();
  const acc = { name: 'wb', provider: 'workbuddy', token: 't2' };
  accounts.push(acc);
  await store.saveAccounts(accounts);
  const hit = (await store.loadAccounts()).find((x) => x.provider === 'workbuddy');
  const panel = store.publicAccount(hit);
  assert.equal(panel.qoderWebDead, null);
});
