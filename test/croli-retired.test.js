/**
 * Croli 恢复与旧账号数据兼容：入口、账号库、10Router 配置、面板。
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
const tr = await import('../src/tenrouter.js');
const us = await import('../src/usageSync.js');
const ta = await import('../src/tenrouterAccounts.js');
const { startDaemon } = await import('../src/daemon.js');
const { closeArchiveStream } = await import('../src/logger.js');

test('Croli 恢复入口，旧记录继续归入同一产品', () => {
  assert.equal(PROVIDERS.includes('croli'), true);
  assert.equal(productOf('croli'), 'croli');
  assert.equal(typeof productImpl('croli').quota, 'function');
  assert.equal(normalizeAccountInput({ provider: 'croli', token: 'tok' }).provider, 'croli');
});

test('向后兼容：accounts.json 中历史 croli 账号可正常加载与展示', async () => {
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
  assert.equal(pub.canSwitch, true);

  // 历史账号依然可以展示和更新；签到要走网络，不在无网络用例中触发。
});

test('向后兼容：tenrouter.json 历史 croli 来源/白名单仍有效', async () => {
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
  const emptySrc = await us.collectSource('croli', { paths: { croli: [] } });
  assert.deepEqual(emptySrc, { entries: [], notes: [], files: 0 });
  assert.equal(ta.mapProviderId('croli'), 'croli');
});

test('向后兼容：daemon 启动及旧 croli 账号继续展示', async (t) => {
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

});
