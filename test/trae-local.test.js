/**
 * Trae 本机凭据解密与设备号口径的自证测试。
 * tc 信封没有公开样本，故测试内实现「加密侧」造信封，再断言 traeLocal 能还原——
 * 上游换 pepper 表或改派生时，这条会第一时间失败而不是静默解不出登录态。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tcDecrypt, uidFromJwt } from '../src/traeLocal.js';
import { traeDevice, traePrimaryIds } from '../src/traeClient.js';

const WOE = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37];
const VOE = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];
const s512 = (b) => crypto.createHash('sha512').update(b).digest();

/** 按 byteCrypto 口径加密：SHA512(random)||pepper → SHA512 → key/iv，明文前置 SHA512 校验值 */
function tcEncrypt(obj, { privateMode = false, random = crypto.randomBytes(32) } = {}) {
  const pepper = Buffer.from((privateMode ? [191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]
    : WOE).map((v, i) => v ^ (privateMode ? [246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170][i] : VOE[i])));
  const k = s512(Buffer.concat([s512(random), pepper]));
  const enc = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const plain = Buffer.concat([s512(body), body]);
  return Buffer.concat([Buffer.from([116, 99, 5, 16, 0, 0]), random, enc.update(plain), enc.final()]).toString('base64');
}

test('tc 信封：AES 模式加密的凭据能被解出，字段原样还原', () => {
  const auth = { token: 'a.b.c', refreshToken: 'rt-1', userId: '7000000000000001', expiredAt: '2026-10-14T11:10:03.630Z', host: 'https://api.trae.cn', account: { username: 'example-user' } };
  assert.deepEqual(tcDecrypt(tcEncrypt(auth)), auth);
});

test('tc 信封：AES_PRIVATE 模式同样支持（部分账号用这一模式）', () => {
  const auth = { token: 'x', userId: '1' };
  assert.deepEqual(tcDecrypt(tcEncrypt(auth, { privateMode: true })), auth);
});

test('tc 信封：magic 不符 / 完整性被破坏 / 非 base64 都返回 null 而不是抛错', () => {
  const good = tcEncrypt({ token: 't' });
  assert.equal(tcDecrypt(''), null);
  assert.equal(tcDecrypt('not base64 at all!!'), null);
  assert.equal(tcDecrypt(Buffer.from('ZZZZ' + good.slice(8, 200) + 'AAAA', 'base64').toString('base64')), null);
  // 篡改密文最后一个字节 → SHA512 校验值不匹配
  const raw = Buffer.from(good, 'base64');
  raw[raw.length - 1] ^= 0xff;
  assert.equal(tcDecrypt(raw.toString('base64')), null);
});

test('traeDevice：真机号优先（登录时注册的设备号）——attempt=0 用 meta.deviceId', () => {
  // 本机实测（2026-10-28）：导入首日派生号签到成功，之后每天 9074、换派生号重试 3 轮全拒——
  // 服务端把「号-设备」绑在登录时注册的那台上，陌生设备号打接口吃 9074。
  const a = traeDevice('7000000000000001', '9001000000000001');
  assert.equal(a.deviceId, '9001000000000001', '有真机号时必须原样使用');
  assert.match(a.marketUserId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.sessionId, traeDevice('7000000000000001', '9001000000000001').sessionId, '同一 uid 指纹恒定');
  assert.notEqual(a.sessionId, traeDevice('9999999999999999', '9001000000000001').sessionId, '不同 uid 指纹不同');
  // 无真机号（token 导入 /字段缺失）回落派生号
  const b = traeDevice('7000000000000001', null);
  assert.match(b.deviceId, /^\d{8,}$/);
  // 真机号格式不合规（非纯数字）也回落派生
  const c = traeDevice('7000000000000001', 'not-a-number');
  assert.match(c.deviceId, /^\d{8,}$/);
  assert.notEqual(c.deviceId, 'not-a-number');
});

test('traeDevice：9074 重试（attempt>0）轮换派生号——不粘在真机号上重复撞', () => {
  // attempt>0 走派生：真机号已被服务端标记时，换号才有机会落在放行窗口
  const a0 = traeDevice('7000000000000001', '9001000000000001', 0);
  const a1 = traeDevice('7000000000000001', '9001000000000001', 1);
  assert.equal(a0.deviceId, '9001000000000001', 'attempt=0 用真机号');
  assert.notEqual(a1.deviceId, '9001000000000001', 'attempt=1 换派生号');
  assert.match(a1.deviceId, /^\d{8,}$/);
  assert.equal(traeDevice('7000000000000001', '9001000000000001', 1).deviceId, a1.deviceId, '同 attempt 重放一致');
});

test('traeDevice：多账号每号独立设备码（issue #28）——第二个账号起派生，不共用真机号', () => {
  // 本机导入的 N 个账号 meta.deviceId 全同（同一台物理客户端）：
  // 服务端按设备限每日一领，第二账号起用同真机号必吃 9074——
  // 首账号用真机号（attempt=0 优先 stored），其余账号签到时应传 attempt>0 派生，
  // 或无 stored 时各自按 uid 派生；同 uid 恒定不变。
  const stored = '9001000000000001';   // 同一台客户端自报的设备号
  // 无 stored 的多账号（token 导入形态）：各自按 uid 派生，互不相同
  const ids = ['7000000000000001', '7000000000000002', '7000000000000003'].map((uid) => traeDevice(uid, null).deviceId);
  assert.equal(new Set(ids).size, ids.length, '不同 uid 必须派生出不同 device-id');
  for (const id of ids) assert.match(id, /^\d{8,}$/);
  // 稳定性：同一 uid 反复取值恒定（服务端看到的是「每号一台固定设备」）
  assert.equal(traeDevice('7000000000000001', null).deviceId, ids[0]);
});

test('traeDevice：attempt 轮换（issue #31）——9074 重试换设备号，同 attempt 恒定', () => {
  // 报告者实测：派生号被服务端一律拒 9074、真机号同时刻可领 → 重试必须换号
  const uid = '7000000000000001';
  const d0 = traeDevice(uid, null, 0);
  const d1 = traeDevice(uid, null, 1);
  const d2 = traeDevice(uid, null, 2);
  assert.notEqual(d0.deviceId, d1.deviceId, 'attempt 递增必须换 device-id');
  assert.notEqual(d1.deviceId, d2.deviceId, 'attempt 2 与 1 也不同');
  assert.notEqual(d0.marketUserId, d1.marketUserId, 'market 指纹同步换');
  assert.equal(traeDevice(uid, null, 1).deviceId, d1.deviceId, '同 attempt 重放一致（确定性派生）');
  for (const d of [d0, d1, d2]) assert.match(d.deviceId, /^\d{8,}$/, '轮换号仍是纯数字（合规）');
});

test('traeDevice：本机没有数字设备号时回落 uid 派生值，仍为纯数字', () => {
  for (const stored of [null, undefined, '', 'aha-a2881affbb0d589bf24700e2458b9bc7', '1234']) {
    const d = traeDevice('7000000000000001', stored);
    assert.match(d.deviceId, /^\d+$/, `stored=${stored} 应派生出纯数字`);
    assert.ok(d.deviceId.length >= 8, `stored=${stored} 位数不足`);
  }
});

test('uidFromJwt：取 payload.data.id，非 JWT 输入返回 null', () => {
  const jwt = (id) => Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    + '.' + Buffer.from(JSON.stringify({ data: { id }, exp: 1 }).toString()).toString('base64url') + '.sig';
  assert.equal(uidFromJwt(jwt('7000000000000001')), '7000000000000001');
  assert.equal(uidFromJwt('Cloud-IDE-JWT garbage'), null);
  assert.equal(uidFromJwt(''), null);
});

test('traePrimaryIds：同 deviceId 只认首个账号（保留兼容签名，不再用于强制派生）', () => {
  const DEV = '9001000000000001';
  const accounts = [
    { id: 'a1', provider: 'trae', meta: { deviceId: DEV } },
    { id: 'a2', provider: 'trae', meta: { deviceId: DEV } },
    { id: 'a3', provider: 'trae', meta: {} },
    { id: 't1', provider: 'trae', meta: { deviceId: '8888000000000002' } },
    { id: 'q1', provider: 'qoder', meta: { deviceId: DEV } },   // 非 trae 不参选
  ];
  const primary = traePrimaryIds(accounts);
  assert.equal(primary.has('a1'), true, '该设备首账号');
  assert.equal(primary.has('a2'), false, '同设备第二账号不在 primary 集合');
  assert.equal(primary.has('a3'), false, '无 deviceId 无真机号可优先');
  assert.equal(primary.has('t1'), true, '另一设备自己的首账号');
  assert.equal(primary.has('q1'), false);
  // 所有账号 attempt=0 都可用真机号（#31 修正：不再强制派生）
  const first = traeDevice('uid-1', DEV, 0);
  assert.equal(first.deviceId, DEV);
  const second = traeDevice('uid-2', DEV, 0);
  assert.equal(second.deviceId, DEV, '同设备第二账号也用真机号（服务端按设备限一领归 already）');
  // 无真机号时走稳定派生
  const derived = traeDevice('uid-3', null, 0);
  assert.match(derived.deviceId, /^\d{8,}$/, '无真机号走稳定派生号');
});

test('candidateClientPaths：国内/国际分开探测，双版本同装时面板才能选开哪个', { skip: process.platform !== 'win32' }, async () => {
  const { candidateClientPath, candidateClientPaths } = await import('../src/traeLocal.js');
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const pth = await import('node:path');
  const tmp = fsp.mkdtempSync(pth.join(os.tmpdir(), 'trae-detect-'));
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmp;
  try {
    // 什么都没装：两边都 null
    assert.deepEqual(candidateClientPaths(), { cn: null, intl: null });
    assert.equal(candidateClientPath(), null);
    // 只装国际版
    fsp.mkdirSync(pth.join(tmp, 'Programs', 'Trae'), { recursive: true });
    fsp.writeFileSync(pth.join(tmp, 'Programs', 'Trae', 'Trae.exe'), 'x');
    let r = candidateClientPaths();
    assert.equal(r.intl, pth.join(tmp, 'Programs', 'Trae', 'Trae.exe'));
    assert.equal(r.cn, null);
    assert.equal(candidateClientPath(), r.intl, '单版本时总探针回落到它');
    // 再装国内版：两路各自命中，总探针国内版优先
    fsp.mkdirSync(pth.join(tmp, 'Programs', 'Trae CN'), { recursive: true });
    fsp.writeFileSync(pth.join(tmp, 'Programs', 'Trae CN', 'Trae CN.exe'), 'x');
    r = candidateClientPaths();
    assert.equal(r.cn, pth.join(tmp, 'Programs', 'Trae CN', 'Trae CN.exe'));
    assert.equal(r.intl, pth.join(tmp, 'Programs', 'Trae', 'Trae.exe'));
    assert.equal(candidateClientPath(), r.cn);
    // SOLO 变体兜底：删掉 Trae CN 后国内路回落到 TRAE SOLO CN
    fsp.rmSync(pth.join(tmp, 'Programs', 'Trae CN'), { recursive: true, force: true });
    fsp.mkdirSync(pth.join(tmp, 'Programs', 'TRAE SOLO CN'), { recursive: true });
    fsp.writeFileSync(pth.join(tmp, 'Programs', 'TRAE SOLO CN', 'TRAE SOLO CN.exe'), 'x');
    r = candidateClientPaths();
    assert.equal(r.cn, pth.join(tmp, 'Programs', 'TRAE SOLO CN', 'TRAE SOLO CN.exe'));
  } finally {
    if (prev === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev;
    fsp.rmSync(tmp, { recursive: true, force: true });
  }
});
