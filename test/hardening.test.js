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

// ── 面板访问密码「关闭」必须真的关掉（panelKey 与 panelKeyHash 一起清） ──

test('PUT /api/settings {disable:true} 清除哈希后 panelKeyEnabled=false（回归：只清明文时关闭永不生效）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-hard-pk-'));
  const crypto = (await import('node:crypto')).default;
  const salt = crypto.randomBytes(8);
  const hash = crypto.scryptSync('testpw123', salt, 32).toString('hex');
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({
    panelKey: '',
    panelKeyHash: `scrypt:${salt.toString('hex')}:${hash}`,
  }));

  const saved = process.env.CREDITDADDY_HOME;
  process.env.CREDITDADDY_HOME = home;
  let daemon;
  try {
    daemon = await import('../src/daemon.js');
    const { server, port } = await daemon.startDaemon(0, '127.0.0.1');
    assert.ok(daemon.panelKeyRequired(), '前置：哈希存在时密码应当生效');
    try {
      const put = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/settings', method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-qd-key': 'testpw123' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ disable: true }));
      });
      assert.equal(put.status, 200);
      assert.equal(put.body.panelKeyEnabled, false, '关闭后不应再要求密码（此前漏清 panelKeyHash 会返回 true 并误报部署强制）');
      assert.equal(daemon.panelKeyRequired(), false);
      const s = JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8'));
      assert.ok(!s.panelKey && !s.panelKeyHash, 'settings 里两种形态的密码都应清掉');
      // 无密码状态下直接 GET 应可访问（fail-open 到未设密码的本机口径）
      const get = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/settings', method: 'GET' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(get, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env.CREDITDADDY_HOME = saved;
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ── #21 构建身份:loadBuildInfo 读盘容忍 与 isNewerRebuild 平局裁决矩阵 ──

test('loadBuildInfo:缺文件 / 损坏 / 缺 commit 一律 null(回退老行为)', async () => {
  const { loadBuildInfo } = await import('../src/buildInfo.js');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-hard-bi-'));
  try {
    assert.equal(loadBuildInfo(home), null);
    await fs.writeFile(path.join(home, 'build.json'), 'not-json');
    assert.equal(loadBuildInfo(home), null);
    await fs.writeFile(path.join(home, 'build.json'), JSON.stringify({ version: '1.4.0' }));
    assert.equal(loadBuildInfo(home), null);
    const info = { version: '1.4.0', commit: 'abc1234', builtAt: '2026-10-10T00:00:00Z', channel: 'release' };
    await fs.writeFile(path.join(home, 'build.json'), JSON.stringify(info));
    assert.deepEqual(loadBuildInfo(home), info);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('isNewerRebuild:仅 release 渠道 + commit 不同 + builtAt 更晚才算平局更新', async () => {
  const { isNewerRebuild } = await import('../src/buildInfo.js');
  const base = (over) => ({ version: '1.4.0', commit: 'aaa1111', builtAt: '2026-10-10T10:00:00Z', channel: 'release', ...over });
  // 典型「同 tag 重推修复包」:commit 不同且时间更晚 → 提醒
  assert.equal(isNewerRebuild(base({}), base({ commit: 'bbb2222', builtAt: '2026-10-10T12:00:00Z' })), true);
  // commit 相同(纯发布时间差)→ 不算
  assert.equal(isNewerRebuild(base({}), base({ builtAt: '2026-10-10T12:00:00Z' })), false);
  // 线上更旧(本地比线上新)→ 不算
  assert.equal(isNewerRebuild(base({ builtAt: '2026-10-10T12:00:00Z' }), base({ commit: 'bbb2222', builtAt: '2026-10-10T10:00:00Z' })), false);
  // 本机是 dev / local / dirty 渠道 → 永不提醒
  assert.equal(isNewerRebuild(base({ channel: 'local' }), base({ commit: 'bbb2222', builtAt: '2026-10-10T12:00:00Z' })), false);
  // 缺元数据任何一侧 → 不算
  assert.equal(isNewerRebuild(null, base({})), false);
  assert.equal(isNewerRebuild(base({}), null), false);
  assert.equal(isNewerRebuild(base({}), { commit: '', builtAt: '' }), false);
});
