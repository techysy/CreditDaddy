import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在导入被测模块前设好 ZCODE_HOME（凭据目录与派生密钥都基于它）
const ZHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-local-test-'));
process.env.ZCODE_HOME = ZHOME;
process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-zlocal-'));

const zc = await import('../src/zcrypto.js');
const zl = await import('../src/zcodeLocal.js');

const credsFile = () => path.join(ZHOME, '.zcode', 'v2', 'credentials.json');

function writeCreds(obj) {
  fs.mkdirSync(path.dirname(credsFile()), { recursive: true });
  fs.writeFileSync(credsFile(), JSON.stringify(obj, null, 2));
}

function encCreds(provider, userInfo) {
  const secret = zc.defaultSecret(ZHOME);
  const enc = (v) => zc.encryptWithSecret(v, secret);
  return {
    'oauth:active_provider': enc(provider),
    [`oauth:${provider}:access_token`]: enc('x'.repeat(64)),
    [`oauth:${provider}:user_info`]: enc(JSON.stringify(userInfo)),
    zcodejwttoken: enc('j'.repeat(64)),
  };
}

test('currentZcodeIdentity：从加密凭据读出 uid / email / username', () => {
  writeCreds(encCreds('bigmodel', { id: '3851788492835867', username: 'vepxa715', displayName: 'vepxa715' }));
  const id = zl.currentZcodeIdentity();
  assert.equal(String(id.uid), '3851788492835867');
  assert.equal(id.username, 'vepxa715');
  assert.equal(id.email, null);
  assert.equal(zl.currentZcodeUid(), '3851788492835867');

  writeCreds(encCreds('zai', { id: 11839208, email: 'i@example.com' }));
  const id2 = zl.currentZcodeIdentity();
  assert.equal(String(id2.uid), '11839208', '数字 uid 也要可读');
  assert.equal(id2.email, 'i@example.com');
});

test('currentZcodeIdentity：未登录 / 凭据文件缺失返回 null', () => {
  writeCreds({ 'oauth:active_provider': 'zai' });
  assert.equal(zl.currentZcodeIdentity(), null);
  fs.rmSync(path.join(ZHOME, '.zcode'), { recursive: true, force: true });
  assert.equal(zl.currentZcodeIdentity(), null);
  assert.equal(zl.currentZcodeUid(), null);
});

test('terminateZcode 存在（不在测试中调用，会真的结束本机 ZCode）', () => {
  assert.equal(typeof zl.terminateZcode, 'function');
});
