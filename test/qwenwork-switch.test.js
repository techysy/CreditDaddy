/**
 * 千问办公切换的自证测试：access token 过期拒绝写入（staleAuth）、RT 过期只 warn 不拦
 * （千问办公 RT 每小时轮换，硬拦等于功能残废；客户端对过期 RT 引导重登而非删文件）、
 * 快照字段校验、alreadyActive 短路、正常写入、快照路径缺失时按本机安装探测解析写入目标
 * （浏览器登录账号可切进客户端；客户端不在则明确报错绝不盲写）。codec / 探测均注入，无 DPAPI。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { switchTo, buildAuthSnapshot, isValidAuthSnapshot, _setCodecForTests, _setDetectForTests } from '../src/qwenworkApp.js';

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
  schemaVersion: 3,
  authRealm: 'standard',
  token: 'tok-' + Math.random().toString(36).slice(2),
  refreshToken: 'ory_rt_x',
  expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  user: { id: 'u-1', name: '测试号' },
  identityVersion: 0,
  loginMethod: 'browser',
  refreshStrategy: 'oauth_web_identity',
  loginDeviceId: 'd-1',
  loginTimestamp: Date.now(),
  ...over,
});

function account(meta, provider = 'qwenwork-cn') {
  return { id: 'a1', name: '测试号', provider, meta };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenwork-switch-'));
  _setCodecForTests(fakeCodec);
  _setDetectForTests(null);
});

/** 注入一份「两个 variant 都未安装」的探测，让「客户端不在」的报错路径与真机安装状态无关 */
const detectNone = () => _setDetectForTests(() => [
  { provider: 'qwenwork-cn', installed: false, dataExists: false, dataDir: path.join(dir, 'nope-cn') },
  { provider: 'qwenwork', installed: false, dataExists: false, dataDir: path.join(dir, 'nope-intl') },
]);

test('access token 已过期的快照拒绝写入：现有登录文件不被触碰，错误带 staleAuth 标记', async () => {
  const file = path.join(dir, 'auth-v2.dat');
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  const stale = auth({ expiresAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() });
  const e = await switchTo(account({ qwenworkAuth: stale, qwenworkAuthFile: file }), { force: true }).catch((x) => x);
  assert.equal(e instanceof Error, true);
  assert.equal(e.staleAuth, true);
  assert.match(e.message, /过期/);
  assert.match(e.message, /重新导入|浏览器登录/);
  // 现有登录文件原封未动（不会被死快照覆盖）
  assert.equal(fakeCodec.decrypt(fs.readFileSync(file)), '{"token":"current-live"}');
  assert.ok(!fs.existsSync(file + '.creditdaddy.bak'), '拒绝写入就不该留备份');
});

test('快照字段不完整（缺 refreshStrategy 等客户端必读字段）：拒绝写入', async () => {
  const file = path.join(dir, 'auth-v2.dat');
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  const bad = { token: 'tok', refreshToken: 'rt', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  const e = await switchTo(account({ qwenworkAuth: bad, qwenworkAuthFile: file }), { force: true }).catch((x) => x);
  assert.match(e.message, /字段不完整/);
});

test('RT 已过期但 access token 有效：照常切换，带 warn（不硬拦）', async () => {
  const file = path.join(dir, 'auth-v2.dat');
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  const staleRt = auth({ refreshTokenExpiresAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
  const r = await switchTo(account({ qwenworkAuth: staleRt, qwenworkAuthFile: file }), { force: true });
  assert.equal(r.switched, true);
  assert.match(r.warn, /刷新凭据已过期/);
  const written = JSON.parse(fakeCodec.decrypt(fs.readFileSync(file)));
  assert.equal(written.token, staleRt.token);
});

test('有效快照正常写入：内容为目标账号，备份与原子写就位', async () => {
  const file = path.join(dir, 'auth-v2.dat');
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  const target = auth();
  const r = await switchTo(account({ qwenworkAuth: target, qwenworkAuthFile: file }), { force: true });
  assert.deepEqual({ switched: r.switched, alreadyActive: r.alreadyActive, warn: r.warn }, { switched: true, alreadyActive: false, warn: null });
  const written = JSON.parse(fakeCodec.decrypt(fs.readFileSync(file)));
  assert.equal(written.token, target.token);
  assert.ok(fs.existsSync(file + '.creditdaddy.bak'));
});

test('目标已是当前登录（token 相同）：alreadyActive 短路，不改文件', async () => {
  const file = path.join(dir, 'auth-v2.dat');
  const same = auth();
  fs.writeFileSync(file, fakeCodec.encrypt(JSON.stringify(same)), { mode: 0o600 });
  const before = fs.readFileSync(file);
  const r = await switchTo(account({ qwenworkAuth: same, qwenworkAuthFile: file }), { force: true });
  assert.equal(r.alreadyActive, true);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('无快照 / 登录文件不在：给出可操作的指引，绝不盲写其他位置', async () => {
  detectNone();
  const noSnap = await switchTo(account({}), { force: true }).catch((e) => e);
  assert.match(noSnap.message, /登录快照/);
  const gone = await switchTo(account({ qwenworkAuth: auth(), qwenworkAuthFile: path.join(dir, '不存在.dat') }), { force: true }).catch((e) => e);
  assert.match(gone.message, /登录文件不在了/);
  assert.match(gone.message, /本机导入/);
  // 浏览器登录账号（有快照、无路径）+ 客户端不在：明确报错，不写任何文件
  const browser = await switchTo(account({ qwenworkAuth: auth() }), { force: true }).catch((e) => e);
  assert.match(browser.message, /浏览器登录/);
  assert.match(browser.message, /未安装|从未运行/);
});

test('浏览器登录账号（快照在、无路径）：客户端已安装时解析真实数据目录写入', async () => {
  const dataDir = path.join(dir, 'QwenWorkCN');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'auth-v2.dat'), fakeCodec.encrypt(JSON.stringify({ token: 'current-live' })), { mode: 0o600 });
  _setDetectForTests(() => [
    { provider: 'qwenwork-cn', installed: true, dataExists: true, dataDir },
    { provider: 'qwenwork', installed: false, dataExists: false, dataDir: path.join(dir, 'nope-intl') },
  ]);
  const target = auth();
  const r = await switchTo(account({ qwenworkAuth: target }), { force: true });
  assert.equal(r.switched, true);
  assert.equal(r.file, path.join(dataDir, 'auth-v2.dat'));
  const written = JSON.parse(fakeCodec.decrypt(fs.readFileSync(r.file)));
  assert.equal(written.token, target.token);
  assert.ok(fs.existsSync(r.file + '.creditdaddy.bak'), '覆盖前应有备份');
});

test('浏览器登录账号 + 客户端从未运行过（数据目录不在）：明确报错，不盲写', async () => {
  const emptyDir = path.join(dir, 'QwenWorkCN-not-created');
  _setDetectForTests(() => [
    { provider: 'qwenwork-cn', installed: true, dataExists: false, dataDir: emptyDir },
    { provider: 'qwenwork', installed: false, dataExists: false, dataDir: path.join(dir, 'nope-intl') },
  ]);
  const e = await switchTo(account({ qwenworkAuth: auth() }), { force: true }).catch((x) => x);
  assert.match(e.message, /浏览器登录/);
  assert.match(e.message, /未安装|从未运行/);
  assert.ok(!fs.existsSync(emptyDir), '未初始化的数据目录不该被创建');
});

test('客户端已安装但从未初始化（数据目录无 Local State）：加密密钥报错可操作，不裸抛', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = path.join(dir, 'QwenWorkCN');
  fs.mkdirSync(dataDir, { recursive: true });
  _setDetectForTests(() => [
    { provider: 'qwenwork-cn', installed: true, dataExists: true, dataDir },
    { provider: 'qwenwork', installed: false, dataExists: false, dataDir: path.join(dir, 'nope-intl') },
  ]);
  _setCodecForTests(null);   // 走真实 safeStorageCodec：读不到 Local State 应得到可操作的报错
  const e = await switchTo(account({ qwenworkAuth: auth() }), { force: true }).catch((x) => x);
  assert.match(e.message, /加密密钥/);
  assert.match(e.message, /启动一次/);
});

test('buildAuthSnapshot 补全字段 → isValidAuthSnapshot 通过；缺字段不通过', () => {
  const snap = buildAuthSnapshot('qwenwork-cn', {
    token: 'tok', refreshToken: 'ory_rt_x',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshTokenExpiresAt: null,
    user: { id: 'u', name: 'n', email: 'e' },
    loginDeviceId: 'd',
  });
  assert.equal(isValidAuthSnapshot(snap), true);
  assert.equal(snap.authRealm, 'standard');
  assert.equal(snap.endpoints.apiOrigin, 'https://gateway.qwenwork.cn');
  assert.equal(snap.endpoints.webIdentityApiOrigin, 'https://qwenwork.cn');
  const intl = buildAuthSnapshot('qwenwork', { token: 't', refreshToken: 'r', expiresAt: new Date().toISOString() });
  assert.equal(intl.endpoints.apiOrigin, 'https://gateway.qwenwork.ai');
  assert.equal(isValidAuthSnapshot({ ...snap, refreshStrategy: 'device' }), false);
  assert.equal(isValidAuthSnapshot({ ...snap, loginDeviceId: '' }), false);
});
