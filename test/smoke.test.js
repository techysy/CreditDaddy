import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.QODERDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qoderdaddy-test-'));

const { dayKey, msUntilNextTick } = await import('../src/checkin.js');
const store = await import('../src/store.js');
const { importAccounts, displayNameFrom } = await import('../src/accounts.js');
const transfer = await import('../src/transfer.js');
const qoderApp = await import('../src/qoderApp.js');
const { rejectForeignRequest } = await import('../src/daemon.js');
const { extractTokens } = await import('../src/localDetect.js');
const { APP_VERSION } = await import('../src/constants.js');

test('dayKey 以 10:00 (UTC+8) 为签到日界，与本机时区无关', () => {
  assert.match(dayKey(new Date('2026-09-23T10:00:00Z').getTime()), /^\d{4}-\d{2}-\d{2}$/);
  // 10:00 (UTC+8) = 02:00 UTC
  assert.equal(dayKey(new Date('2026-01-05T02:00:00Z').getTime()), '2026-01-05');
  assert.equal(dayKey(new Date('2026-01-05T01:59:59Z').getTime()), '2026-01-04');
  assert.equal(dayKey(new Date('2026-01-05T23:59:59Z').getTime()), '2026-01-05');
});

test('下次 tick 在 2h~2h10m 之间', () => {
  for (let i = 0; i < 20; i++) {
    const ms = msUntilNextTick(Date.now(), () => 0.5);
    assert.ok(ms >= 2 * 3600_000 && ms <= 2 * 3600_000 + 10 * 60_000);
  }
});

test('账号存储往返 + 去重 + 脱敏', async () => {
  const accounts = [];
  const a = store.normalizeAccountInput({ name: '测试', provider: 'qoder', token: 'jt-abcdef1234567890' });
  accounts.push(a);
  await store.saveAccounts(accounts);
  const loaded = await store.loadAccounts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].token, 'jt-abcdef1234567890');

  assert.ok(store.findDuplicate(loaded, 'qoder', 'jt-abcdef1234567890'));
  assert.ok(!store.findDuplicate(loaded, 'qoder-cn', 'jt-abcdef1234567890'));

  const pub = store.publicAccount(loaded[0]);
  assert.ok(pub.tokenMasked.includes('...'));
  assert.equal(pub.token, undefined, '脱敏视图不应泄露完整 token');
  assert.equal(pub.isPat, false);
});

test('normalize 拒绝非法输入', () => {
  assert.throws(() => store.normalizeAccountInput({ provider: 'qoder', token: '' }));
  assert.throws(() => store.normalizeAccountInput({ provider: 'bogus', token: 'x' }));
});

test('PAT 识别', () => {
  const a = store.normalizeAccountInput({ provider: 'qoder-cn', token: 'pt-xyz1234567890' });
  assert.equal(store.publicAccount(a).isPat, true);
});

test('明文导出不含 id，兼容新旧字段', () => {
  const a = store.normalizeAccountInput({ provider: 'qoder', token: 'jt-tok', uid: 'u-1', email: 'a@b.c' });
  const payload = JSON.parse(JSON.stringify(transfer.exportAccounts([a])));
  assert.equal(payload.format, 'qoderdaddy-accounts');
  assert.equal(payload.provider, 'qoder');
  assert.equal(payload.accounts[0].id, undefined);
  assert.equal(payload.accounts[0].token, 'jt-tok');
  assert.equal(payload.accounts[0].accessToken, 'jt-tok');
  assert.equal(payload.accounts[0].providerSpecificData.userId, 'u-1');
});

test('加密导出往返（10router-oauth-secure-v1）', () => {
  const a = store.normalizeAccountInput({ provider: 'qoder-cn', token: 'dt-secret-token-xyz', refreshToken: 'rt' });
  const blob = JSON.parse(JSON.stringify(transfer.exportAccounts([a], { password: 'pass1234' })));
  assert.equal(blob.format, '10router-oauth-secure-v1');
  assert.ok(!JSON.stringify(blob).includes('dt-secret'), '加密文件不应含明文 token');
  const parsed = transfer.parseImport(blob, { password: 'pass1234' });
  assert.equal(parsed.source, 'qoderdaddy');
  assert.equal(parsed.accounts[0].token, 'dt-secret-token-xyz');
  assert.equal(parsed.accounts[0].refreshToken, 'rt');
  assert.throws(() => transfer.parseImport(blob, { password: 'nope' }), (e) => e.code === 'WRONG_PASSWORD');
  assert.throws(() => transfer.parseImport(blob, {}), (e) => e.code === 'NEED_PASSWORD');
  assert.throws(() => transfer.exportAccounts([a], { password: '123' }), (e) => e.code === 'PASSPHRASE_TOO_SHORT');
});

test('导入 10router 迁移文件：只取 qoder 账号、丢弃合成邮箱', () => {
  const blob = transfer.sealTransfer({
    provider: 'qoder-cn',
    accounts: [
      { accessToken: 'dt-cn-1', email: 'qoder-cn-user-42', name: '小号', providerSpecificData: { userId: '42' }, expiresAt: 1790000000 },
      { provider: 'cursor', accessToken: 'x' },
      { refreshToken: 'only-refresh' },
    ],
  }, 'pw-10router');
  const r = transfer.parseImport(blob, { password: 'pw-10router' });
  assert.equal(r.source, '10router');
  assert.equal(r.accounts.length, 1);
  assert.equal(r.skipped, 2);
  assert.deepEqual(
    { p: r.accounts[0].provider, e: r.accounts[0].email, u: r.accounts[0].uid, n: r.accounts[0].name },
    { p: 'qoder-cn', e: null, u: '42', n: '小号' });
  assert.equal(store.normalizeAccountInput(r.accounts[0]).expiresAt, new Date(1790000000 * 1000).toISOString());
});

test('同一 uid 的新 token 视为续期而不是新增', async () => {
  await store.saveAccounts([]);
  await importAccounts([{ provider: 'qoder', token: 'dt-old', uid: 'same-user', name: '原名' }]);
  const r = await importAccounts([{ provider: 'qoder', token: 'dt-new', uid: 'same-user', name: '新名', expiresAt: '2030-01-01T00:00:00Z' }]);
  assert.deepEqual(r, { added: 0, updated: 1, skipped: 0 });
  const list = await store.loadAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].token, 'dt-new');
  assert.equal(list[0].name, '原名', '续期保留原备注名');
  assert.equal(list[0].expiresAt, '2030-01-01T00:00:00.000Z');
});

test('Qoder 客户端身份字段格式', () => {
  assert.match(qoderApp.machineOs(), /^[a-z0-9_]+_(win32|darwin|linux)$/);
  assert.equal(qoderApp.machineHostname('MX-PC'), 'MX-PC');
  assert.match(qoderApp.machineHostname('我的电脑'), /^unknown-[0-9a-f]{8}$/);
  assert.equal(qoderApp.machineHostname('x'.repeat(200)).length, 96);
  assert.match(qoderApp.machineId('qoder'), /^[0-9a-f-]{36}$/);
});

test('withAccounts 并发修改不丢数据', async () => {
  await store.saveAccounts([]);
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    store.withAccounts((list) => {
      list.push(store.normalizeAccountInput({ provider: 'qoder', token: `jt-concurrent-${i}` }));
    })));
  assert.equal((await store.loadAccounts()).length, 20);
});

test('批量导入去重并跳过非法项', async () => {
  await store.saveAccounts([]);
  const r = await importAccounts([
    { provider: 'qoder', token: 'jt-a' },
    { provider: 'qoder', token: 'jt-a' },
    { provider: 'qoder-cn', token: 'jt-a' },
    { provider: 'bogus', token: 'jt-b' },
  ]);
  assert.deepEqual(r, { added: 2, updated: 0, skipped: 2 });
});

test('displayNameFrom 选取首个非空字段', () => {
  assert.equal(displayNameFrom({ nickname: ' ', name: '小明', email: 'a@b.c' }), '小明');
  assert.equal(displayNameFrom({ email: 'a@b.c' }), 'a@b.c');
  assert.equal(displayNameFrom(null), null);
});

test('本机模式拒绝 DNS 重绑定与跨站请求', () => {
  const bind = '127.0.0.1';
  assert.equal(rejectForeignRequest({ host: '127.0.0.1:47860' }, bind), null);
  assert.equal(rejectForeignRequest({ host: 'localhost:47860', origin: 'http://localhost:47860' }, bind), null);
  assert.equal(rejectForeignRequest({ host: '[::1]:47860' }, bind), null);
  assert.ok(rejectForeignRequest({ host: 'evil.example.com' }, bind), '陌生 Host 应被拒绝');
  assert.ok(rejectForeignRequest({ host: '127.0.0.1:47860', origin: 'https://evil.example.com' }, bind), '跨站 Origin 应被拒绝');
  // NAS 模式（0.0.0.0）允许任意 Host（靠访问密钥保护），但仍拒绝跨站
  assert.equal(rejectForeignRequest({ host: '192.168.1.10:47860' }, '0.0.0.0'), null);
  assert.ok(rejectForeignRequest({ host: '192.168.1.10:47860', origin: 'http://evil.lan' }, '0.0.0.0'));
});

test('extractTokens 提取并去重 dt-/pt- token', () => {
  const text = 'a dt-AAAAAAAAAAAAAAAAAAAA b pt-BBBBBBBBBBBBBBBBBBBB dt-AAAAAAAAAAAAAAAAAAAA dt-short';
  assert.deepEqual(extractTokens(text).sort(), ['dt-AAAAAAAAAAAAAAAAAAAA', 'pt-BBBBBBBBBBBBBBBBBBBB']);
});

test('APP_VERSION 与 package.json 一致', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});
