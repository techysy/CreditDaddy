/**
 * Croli 下架向后兼容回归测试：
 *   - 移出主动入口（PROVIDERS / productImpl / SOURCES / TENROUTER_PROVIDER_MAP）
 *   - 老账号库 accounts.json 与老 tenrouter.json 中残留 croli 记录不崩、不落入兜底 qoder、
 *     自动签到与面板额度拉取均安全跳过，HTTP 额度端点返回 410。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-croli-ret-'));

const { PROVIDERS, productOf } = await import('../src/constants.js');
const { productImpl } = await import('../src/providers.js');
const { loadAccounts, saveAccounts, normalizeAccountInput, publicAccount } = await import('../src/store.js');
const { runCheckinTick } = await import('../src/checkin.js');
const tr = await import('../src/tenrouter.js');
const us = await import('../src/usageSync.js');
const ta = await import('../src/tenrouterAccounts.js');
const { startDaemon } = await import('../src/daemon.js');
const { closeArchiveStream } = await import('../src/logger.js');

test('Croli 已从主动列表移出，但 productOf 保留映射以免历史记录落入 qoder', () => {
  assert.equal(PROVIDERS.includes('croli'), false);
  assert.equal(productOf('croli'), 'croli');
  assert.equal(productImpl('croli'), undefined);
  assert.throws(() => normalizeAccountInput({ provider: 'croli', token: 'tok' }), /provider 必须是/);
});

test('向后兼容：accounts.json 中残留历史 croli 账号可正常加载、序列化且签到跳过', async () => {
  const legacy = {
    id: 'legacy-croli-1',
    name: 'Old Croli User',
    provider: 'croli',
    token: 'legacy-jwt',
    uid: 'user_legacy_1',
    refreshToken: 'legacy-rt',
    expiresAt: null,
    source: 'local-app',
    meta: {},
    createdAt: '2026-11-20T00:00:00.000Z',
    lastCheckin: null,
    lastResult: { status: 'checked-in', amount: 100, at: new Date().toISOString() },
  };
  await saveAccounts([legacy]);
  const loaded = await loadAccounts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].provider, 'croli');

  const pub = publicAccount(loaded[0]);
  assert.equal(pub.product, 'croli');
  assert.equal(pub.canSwitch, false);

  const tick = await runCheckinTick({ includeZcode: false });
  assert.equal(tick.results.length, 0, '已下架产品不参与自动签到也不抛错');
});

test('向后兼容：tenrouter.json 残留 croli 来源/白名单与 syncAccountsTo10r 安全跳过', async () => {
  const f = path.join(process.env.CREDITDADDY_HOME, 'tenrouter.json');
  fss.mkdirSync(process.env.CREDITDADDY_HOME, { recursive: true });
  fss.writeFileSync(f, JSON.stringify({
    endpoint: 'http://127.0.0.1:20127',
    key: 'sk-x',
    sync: { enabled: false, sources: ['croli', 'zcode'], sourcesVersion: 4 },
    accountSync: { enabled: true, providers: ['croli', 'qoder'], providersVersion: 1 },
  }));

  const cfg = tr.loadConfig();
  assert.ok(Array.isArray(cfg.sync.sources));
  const emptySrc = await us.collectSource('croli');
  assert.deepEqual(emptySrc, { entries: [], notes: [], files: 0 });
  assert.equal(ta.mapProviderId('croli'), null);

  await assert.rejects(
    ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127',
      key: 'sk-x',
      accounts: [{ id: 'legacy-croli-1', provider: 'croli', token: 'legacy-jwt' }],
    }),
    /没有可同步的账号/,
  );
});

test('向后兼容：daemon 启动及 GET /api/accounts/:id/quota 对残留 croli 返回 410 而非崩溃', async (t) => {
  const { server, port } = await startDaemon(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((r) => server.close(r));
    closeArchiveStream();
  });
  const base = `http://127.0.0.1:${port}`;
  const resAcc = await fetch(`${base}/api/accounts`);
  assert.equal(resAcc.status, 200);
  const { accounts } = await resAcc.json();
  assert.equal(accounts.some((a) => a.id === 'legacy-croli-1' && a.product === 'croli'), true);

  const resQuota = await fetch(`${base}/api/accounts/legacy-croli-1/quota`);
  assert.equal(resQuota.status, 410);
  const body = await resQuota.json();
  assert.equal(body.error, '该产品线已下架');
});
