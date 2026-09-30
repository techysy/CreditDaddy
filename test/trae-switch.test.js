/**
 * Trae 登录态快照与切换的自证测试。
 * 用 TRAE_HOME / CREDITDADDY_HOME 把两边目录都指到临时目录，不碰本机真实 Trae。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-trae-'));
process.env.CREDITDADDY_HOME = path.join(tmp, 'cd');
process.env.TRAE_HOME = path.join(tmp, 'trae');
fs.mkdirSync(process.env.CREDITDADDY_HOME, { recursive: true });

const { snapshotLive, switchTo, hasSlot, tcDecrypt,  _setRunningForTests } = await import('../src/traeLocal.js');

const WOE = [82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37];
const VOE = [31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125];
const s512 = (b) => crypto.createHash('sha512').update(b).digest();

/** 按 byteCrypto 口径加密，写进临时 Trae 目录，模拟「当前登录着某个账号」 */
function loginAs(uid, deviceId) {
  const random = crypto.randomBytes(32);
  const pepper = Buffer.from(WOE.map((v, i) => v ^ VOE[i]));
  const k = s512(Buffer.concat([s512(random), pepper]));
  const enc = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
  const body = Buffer.from(JSON.stringify({ token: 'jwt-' + uid, userId: uid, expiredAt: '2099-01-01T00:00:00.000Z', account: { username: 'u' + uid } }));
  const plain = Buffer.concat([s512(body), body]);
  const env = Buffer.concat([Buffer.from([116,99,5,16,0,0]), random, enc.update(plain), enc.final()]).toString('base64');
  const gs = path.join(process.env.TRAE_HOME, 'User', 'globalStorage');
  fs.mkdirSync(gs, { recursive: true });
  fs.writeFileSync(path.join(gs, 'storage.json'), JSON.stringify({ [`iCubeAuthInfo://icube-dc:${deviceId}`]: {}, 'iCubeAuthInfo://icube.cloudide': env }));
}

const liveUid = () => {
  const raw = Buffer.from(JSON.parse(fs.readFileSync(path.join(process.env.TRAE_HOME, 'User', 'globalStorage', 'storage.json'), 'utf8'))['iCubeAuthInfo://icube.cloudide'], 'base64');
  const k = s512(Buffer.concat([s512(raw.subarray(6, 38)), Buffer.from(WOE.map((v, i) => v ^ VOE[i]))]));
  const d = crypto.createDecipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(38)), d.final()]).subarray(64).toString()).userId;
};

test('Trae 切换：A→B→A 能把登录态完整换回来，且换走前 A 已自动快照', async () => {
  _setRunningForTests(false);
  loginAs('1111111111111111', '9000000000000001');
  assert.equal(snapshotLive(), 1, 'A 首次快照应拷到 storage.json 一项');
  assert.ok(hasSlot('1111111111111111'));

  loginAs('2222222222222222', '9000000000000002');
  assert.equal(liveUid(), '2222222222222222');

  const r = await switchTo({ uid: '1111111111111111', name: 'A' });
  assert.equal(r.switched, true);
  assert.equal(liveUid(), '1111111111111111', '切回 A 后本机登录态应是 A');
  assert.ok(hasSlot('2222222222222222'), '被换走的 B 也要留下快照，否则丢号');

  await switchTo({ uid: '2222222222222222', name: 'B' });
  assert.equal(liveUid(), '2222222222222222', '再切回 B');
});

test('Trae 切换：目标账号没有快照时报错并给出可执行指引，不动本机文件', async () => {
  _setRunningForTests(false);
  const before = liveUid();
  await assert.rejects(
    () => switchTo({ uid: '3333333333333333', name: '没快照的账号' }),
    (e) => /还没有登录态快照/.test(e.message) && /本机导入/.test(e.message),
  );
  assert.equal(liveUid(), before, '失败必须是原子的，不能把本机登录态改坏');
});

test('Trae 切换：目标已是当前登录时不重复写盘', async () => {
  _setRunningForTests(false);
  const uid = liveUid();
  assert.ok(hasSlot(uid));
  const r = await switchTo({ uid, name: '当前' });
  assert.deepEqual(r, { switched: false, alreadyActive: true });
});

test('Trae 切换：客户端在跑且未 force 时拒绝（否则 Trae 会把旧登录写回文件）', async () => {
  _setRunningForTests(true);
  const other = liveUid() === '1111111111111111' ? '2222222222222222' : '1111111111111111';
  await assert.rejects(() => switchTo({ uid: other }), (e) => e.traeRunning === true);
  _setRunningForTests(false);
});

test('Trae 切换：没快照时先报错、绝不先关进程（曾出现白关一次 Trae）', async () => {
  _setRunningForTests(true);
  const before = liveUid();
  await assert.rejects(
    () => switchTo({ uid: '5555555555555555', name: '没快照' }, { force: true }),
    (e) => /还没有登录态快照/.test(e.message) && e.traeRunning === undefined,
  );
  assert.equal(liveUid(), before, '本机登录态不能被改动');
  _setRunningForTests(false);
});

test('快照跳过 Chromium 缓存目录（本机实测缓存占 91/106 MB）', async () => {
  _setRunningForTests(false);
  const cache = path.join(process.env.TRAE_HOME, 'Partitions', 'trae-webview', 'Cache', 'f');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, 'x'.repeat(4096));
  fs.writeFileSync(path.join(process.env.TRAE_HOME, 'Partitions', 'trae-webview', 'WebStorage'), 'keep');
  loginAs('4444444444444444', '9000000000000004');
  snapshotLive();
  const slot = path.join(process.env.CREDITDADDY_HOME, 'trae-slots', '4444444444444444', 'Partitions', 'trae-webview');
  assert.ok(fs.existsSync(path.join(slot, 'WebStorage')), '登录数据要拷');
  assert.ok(!fs.existsSync(path.join(slot, 'Cache')), 'Cache 不该拷');
});
