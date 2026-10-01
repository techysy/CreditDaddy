/**
 * Qoder safeStorage 加密往返测试（Windows / DPAPI）。
 * 切换账号会往 auth.v1.dat 写东西，格式猜错就等于写坏本机 Qoder 登录，
 * 所以用自造的 DPAPI 密钥验证 encrypt 的输出能被 decrypt 原样读回。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { safeStorageCodec } = await import('../src/qoderApp.js');

function dpapiProtect(buf) {
  const script = 'Add-Type -AssemblyName System.Security;'
    + '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());'
    + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, input: buf.toString('base64'), timeout: 20_000, encoding: 'utf8' }).trim();
}

test('encrypt/decrypt 往返：写回的 auth.v1.dat 能被原样解出', { skip: process.platform !== 'win32' && '非 Windows 无 DPAPI' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-qoder-'));
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(dpapiProtect(key), 'base64')]).toString('base64') },
  }));
  const codec = await safeStorageCodec(dir, ['Qoder App', 'Qoder']);

  const auth = { token: 'dt-fake', refreshToken: 'rt-fake', expiresAt: '2099-01-01T00:00:00.000Z', user: { id: 'u1', name: '张三', email: 'z@example.com' } };
  const text = JSON.stringify(auth);
  const buf = codec.encrypt(text);

  assert.equal(buf.subarray(0, 3).toString(), 'v10', '前缀必须是 v10（Electron safeStorage 约定）');
  assert.deepEqual(JSON.parse(codec.decrypt(buf)), auth, '自己加密的要能解回同一对象');
  assert.notDeepEqual(codec.encrypt(text), buf, '每次加密要用不同 nonce，不能产出相同密文');
  // 布局自证：3 前缀 + 12 nonce + 明文 + 16 GCM tag
  assert.equal(buf.length, 3 + 12 + Buffer.byteLength(text) + 16);
});
