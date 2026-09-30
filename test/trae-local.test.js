/**
 * Trae 本机凭据解密与设备号口径的自证测试。
 * tc 信封没有公开样本，故测试内实现「加密侧」造信封，再断言 traeLocal 能还原——
 * 上游换 pepper 表或改派生时，这条会第一时间失败而不是静默解不出登录态。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tcDecrypt, uidFromJwt } from '../src/traeLocal.js';
import { traeDevice } from '../src/traeClient.js';

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

test('traeDevice：x-device-id 必须是纯数字（GUID 会触发风控 code 9074），且按 uid 稳定', () => {
  const a = traeDevice('7000000000000001', '9001000000000001');
  assert.equal(a.deviceId, '9001000000000001', 'storage.json 里客户端自报的设备号优先');
  assert.match(a.deviceId, /^\d{8,}$/);
  assert.match(a.marketUserId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.sessionId, traeDevice('7000000000000001', '9001000000000001').sessionId, '同一 uid 指纹恒定');
  assert.notEqual(a.sessionId, traeDevice('9999999999999999', '9001000000000001').sessionId, '不同 uid 指纹不同');
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
