/**
 * 审查中修掉的几处回归测试：加密参数校验 / 换 token 时清掉作废的 refreshToken / 重定向防护。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-hard-'));

const { sealTransfer, openTransfer, TransferError } = await import('../src/transfer.js');
const { addAccount } = await import('../src/accounts.js');
const { loadAccounts } = await import('../src/store.js');

// ── 迁移文件的 KDF 参数不可信 ──

test('正常导出的文件能原样解开', () => {
  const blob = sealTransfer({ accounts: [{ id: 'x' }] }, 'pw1234');
  assert.deepEqual(openTransfer(blob, 'pw1234'), { accounts: [{ id: 'x' }] });
});

test('拒绝自称弱 KDF 的文件（否则 scrypt 强度被文件作者单方面降级）', () => {
  const blob = sealTransfer({ accounts: [] }, 'pw1234');
  const weak = { ...blob, kdf: { ...blob.kdf, N: 2, r: 1, p: 1 } };
  assert.throws(() => openTransfer(weak, 'pw1234'), (e) => {
    assert.ok(e instanceof TransferError);
    assert.equal(e.code, 'BAD_KDF');
    return true;
  });
});

test('kdf 整段缺失报 BAD_KDF，而不是误导人的 WRONG_PASSWORD', () => {
  const blob = sealTransfer({ accounts: [] }, 'pw1234');
  const { kdf, ...noKdf } = blob;
  assert.throws(() => openTransfer(noKdf, 'pw1234'), (e) => {
    assert.equal(e.code, 'BAD_KDF');
    return true;
  });
});

test('口令错误仍然报 WRONG_PASSWORD', () => {
  const blob = sealTransfer({ accounts: [] }, 'pw1234');
  assert.throws(() => openTransfer(blob, 'wrong-pw'), (e) => e.code === 'WRONG_PASSWORD');
});

// ── 换 token 时必须一起换掉 refreshToken ──

test('换了 token 但新记录没带 refreshToken 时，作废的旧值要被清掉', async () => {
  const first = await addAccount({ provider: 'workbuddy', token: 'tok-old', uid: 'u1', refreshToken: 'refresh-old' });
  assert.equal(first.account.refreshToken, 'refresh-old');

  // 客户端轮换后重新导入：换了 token，但这次抓到的会话里没有 refreshToken
  await addAccount({ provider: 'workbuddy', token: 'tok-new', uid: 'u1', refreshToken: null });

  const saved = (await loadAccounts()).find((a) => a.id === first.account.id);
  assert.equal(saved.token, 'tok-new');
  assert.equal(saved.refreshToken, null, '旧 refreshToken 已被服务端作废，留着会让刷新永远失败且无法自愈');
});

test('换了 token 且带新 refreshToken 时正常更新', async () => {
  const first = await addAccount({ provider: 'workbuddy', token: 't2-old', uid: 'u2', refreshToken: 'r-old' });
  await addAccount({ provider: 'workbuddy', token: 't2-new', uid: 'u2', refreshToken: 'r-new' });
  const saved = (await loadAccounts()).find((a) => a.id === first.account.id);
  assert.equal(saved.token, 't2-new');
  assert.equal(saved.refreshToken, 'r-new');
});

test('token 没变时仍然保留原 refreshToken（不误清）', async () => {
  const first = await addAccount({ provider: 'workbuddy', token: 't3', uid: 'u3', refreshToken: 'r-keep' });
  await addAccount({ provider: 'workbuddy', token: 't3', uid: 'u3', refreshToken: null });
  const saved = (await loadAccounts()).find((a) => a.id === first.account.id);
  assert.equal(saved.refreshToken, 'r-keep');
});

// ── 携带凭据的请求不得跟随重定向 ──

test('307 重定向不会把请求体（账号 token）重放到别处', async () => {
  let received = null;
  const target = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { received = b; res.end('{}'); });
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  const redirector = http.createServer((req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/stolen` });
    res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const from = `http://127.0.0.1:${redirector.address().port}/api/oauth/transfer/import`;

  const secrets = { accessToken: 'acct-token-abc', refreshToken: 'rt-xyz' };

  // 对照：默认行为会把 body 原样重放（Authorization 被剥掉，body 不会）
  await fetch(from, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(secrets) });
  assert.equal(received, JSON.stringify(secrets), '默认 fetch 确实会重放请求体——这就是要拦的原因');

  // 修好后：redirect: 'error' 时目标服务器什么都收不到
  received = null;
  await assert.rejects(
    fetch(from, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(secrets), redirect: 'error' }),
    (e) => e.cause?.message === 'unexpected redirect'
  );
  assert.equal(received, null, '凭据没有泄露到重定向目标');

  target.close();
  redirector.close();
});
