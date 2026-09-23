import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.QODERDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qoderdaddy-test-'));

const { dayKey, msUntilNextTick } = await import('../src/checkin.js');
const store = await import('../src/store.js');
const { importAccounts, displayNameFrom } = await import('../src/accounts.js');
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

test('导出载荷不含 id', () => {
  const a = store.normalizeAccountInput({ provider: 'qoder', token: 'jt-tok' });
  const payload = JSON.parse(JSON.stringify(store.exportPayload([a])));
  assert.equal(payload.format, 'qoderdaddy-accounts');
  assert.equal(payload.accounts[0].id, undefined);
  assert.equal(payload.accounts[0].token, 'jt-tok');
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
  assert.deepEqual(r, { added: 2, skipped: 2 });
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
