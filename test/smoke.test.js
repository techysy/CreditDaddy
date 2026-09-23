import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.QODERDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qoderdaddy-test-'));

const { dayKey, msUntilNextTick } = await import('../src/checkin.js');
const store = await import('../src/store.js');

test('dayKey 格式正确', () => {
  assert.match(dayKey(new Date('2026-09-23T10:00:00Z').getTime()), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dayKey(new Date('2026-01-05').getTime()), '2026-01-05');
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
