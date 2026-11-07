/**
 * Qoder 切换的自证测试：过期快照拒绝写入（2026-11-07 用户实测——过期快照写进去
 * 客户端启动即登出）、临期警告、alreadyActive 短路、正常写入。codec 注入，无 DPAPI。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { switchTo, _setCodecForTests } from '../src/qoderApp.js';

let dir;

const fakeCodec = {
  encrypt: (t) => Buffer.from('enc:' + t, 'utf8'),
  decrypt: (b) => {
    const s = b.toString('utf8');
    if (!s.startsWith('enc:')) throw new Error('bad payload');
    return s.slice(4);
  },
};

const auth = (over = {}) => ({
  schemaVersion: 1,
  token: 'tok-' + Math.random().toString(36).slice(2),
  refreshToken: 'drt-x',
  expiresAt: new Date(Date.now() + 20 * 24 * 3600_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 300 * 24 * 3600_000).toISOString(),
  user: { id: 'u-1', name: '测试号' },
  ...over,
});

function account(meta) {
  return { id: 'a1', name: '测试号', provider: 'qoder', meta };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-switch-'));
  _setCodecForTests(fakeCodec);
});

test('过期快照拒绝写入：现有登录文件不被触碰，错误带 staleAuth 标记', async () => {
  const file = path.join(dir, 'auth.v1.dat');
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  const stale = auth({ expiresAt: new Date(Date.now() - 15 * 24 * 3600_000).toISOString() });
  const e = await switchTo(account({ qoderAuth: stale, qoderAuthFile: file }), { force: true }).catch((x) => x);
  assert.equal(e instanceof Error, true);
  assert.equal(e.staleAuth, true);
  assert.match(e.message, /过期/);
  assert.match(e.message, /本机导入/);
  // 现有登录文件原封未动（不会被死快照覆盖，客户端不会被登出）
  assert.equal(fakeCodec.decrypt(fs.readFileSync(file)), '{"token":"current-live"}');
  assert.ok(!fs.existsSync(file + '.creditdaddy.bak'), '拒绝写入就不该留备份');
});

test('有效快照正常写入：内容为目标账号，备份与原子写就位', async () => {
  const file = path.join(dir, 'auth.v1.dat');
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  const target = auth();
  const r = await switchTo(account({ qoderAuth: target, qoderAuthFile: file }), { force: true });
  assert.deepEqual({ switched: r.switched, alreadyActive: r.alreadyActive, warn: r.warn }, { switched: true, alreadyActive: false, warn: null });
  const written = JSON.parse(fakeCodec.decrypt(fs.readFileSync(file)));
  assert.equal(written.token, target.token);
  assert.ok(fs.existsSync(file + '.creditdaddy.bak'));
});

test('临期快照（<24h）：照常切换但返回 warn', async () => {
  const file = path.join(dir, 'auth.v1.dat');
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  const soon = auth({ expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString() });
  const r = await switchTo(account({ qoderAuth: soon, qoderAuthFile: file }), { force: true });
  assert.equal(r.switched, true);
  assert.match(r.warn, /过期/);
});

test('目标已是当前登录（token 相同）：alreadyActive 短路，不改文件', async () => {
  const file = path.join(dir, 'auth.v1.dat');
  const same = auth();
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify(same)), { mode: 0o600 });
  const before = fs.readFileSync(file);
  const r = await switchTo(account({ qoderAuth: same, qoderAuthFile: file }), { force: true });
  assert.equal(r.alreadyActive, true);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('无快照 / 文件不在：给重新导入的指引', async () => {
  const noSnap = await switchTo(account({}), { force: true }).catch((e) => e);
  assert.match(noSnap.message, /本机登录快照/);
  const gone = await switchTo(account({ qoderAuth: auth(), qoderAuthFile: path.join(dir, '不存在.dat') }), { force: true }).catch((e) => e);
  assert.match(gone.message, /登录文件不在了/);
});
