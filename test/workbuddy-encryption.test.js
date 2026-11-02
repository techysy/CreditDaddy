import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isWbEncrypted,
  buildEnvelopeAAD,
  openEnvelope,
  sealEnvelope,
  resetMasterKeyCacheForTest,
  decryptSessionJson,
  sessionToAccount,
  writeWorkbuddySession,
} from '../src/workbuddyLocal.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function makeFakeJwt({ sub = 'u-test-1', iss = 'https://www.codebuddy.cn/auth', exp = Math.floor(Date.now() / 1000) + 3600, phone = '13800138000' } = {}) {
  return [
    b64({ alg: 'none', typ: 'JWT' }),
    b64({ sub, iss, exp, preferred_username: phone, name: '测试用户' }),
    'sig',
  ].join('.');
}

test('isWbEncrypted：正确识别 $wbEncrypted 信封格式', () => {
  assert.equal(isWbEncrypted(null), false);
  assert.equal(isWbEncrypted('plain text token'), false);
  assert.equal(isWbEncrypted({}), false);
  assert.equal(isWbEncrypted({ $wbEncrypted: 1, envelope: 'abc' }), true);
  assert.equal(isWbEncrypted({ $wbEncrypted: 0, envelope: 'abc' }), false);
});

test('buildEnvelopeAAD & sealEnvelope / openEnvelope：加解密往返保持内容一致', () => {
  const dummyKey = crypto.createHash('sha256').update('test-secret-key-32', 'utf8').digest();
  const plaintext = 'eyJhbGciOiJSUzI1NiJ9.test.jwt';
  const sealed = sealEnvelope(plaintext, dummyKey, { suite: 1, keyId: 'k1' });

  assert.equal(isWbEncrypted(sealed), true);
  const decrypted = openEnvelope(sealed, dummyKey);
  assert.equal(decrypted, plaintext);
});

test('decryptSessionJson：递归解密 session 中的加密字段，不影响明文字段', () => {
  const dummyKey = crypto.createHash('sha256').update('test-secret-key-32', 'utf8').digest();
  resetMasterKeyCacheForTest(dummyKey);

  const sealedToken = sealEnvelope('my-access-token', dummyKey);
  const sealedPhone = sealEnvelope('13912345678', dummyKey);

  const rawSession = {
    account: {
      uid: 'acc-1',
      nickname: '测试昵称',
      phoneNumber: sealedPhone,
    },
    auth: {
      accessToken: sealedToken,
      refreshToken: 'plain-refresh-token',
    },
  };

  const decrypted = decryptSessionJson(rawSession);
  assert.equal(decrypted.account.phoneNumber, '13912345678');
  assert.equal(decrypted.auth.accessToken, 'my-access-token');
  assert.equal(decrypted.auth.refreshToken, 'plain-refresh-token');

  resetMasterKeyCacheForTest(null);
});

test('sessionToAccount：支持 $wbEncrypted 格式，且手机号脱敏时从 JWT payload 恢复真实手机号', () => {
  const dummyKey = crypto.createHash('sha256').update('test-secret-key-32', 'utf8').digest();
  resetMasterKeyCacheForTest(dummyKey);

  const jwt = makeFakeJwt({ sub: 'user-wb-1', phone: '13900139000' });
  const sealedToken = sealEnvelope(jwt, dummyKey);

  const rawSession = {
    account: {
      uid: 'user-wb-1',
      nickname: 'WorkBuddy5.8用户',
      phoneNumber: '139****9000', // 客户端已脱敏
    },
    auth: {
      accessToken: sealedToken,
      refreshToken: 'refresh-123',
      domain: 'www.codebuddy.cn',
    },
  };

  const acc = sessionToAccount(rawSession, 'WorkBuddy 当前登录');
  assert.ok(acc, '应成功解析出账号');
  assert.equal(acc.uid, 'user-wb-1');
  assert.equal(acc.token, jwt);
  assert.equal(acc.provider, 'workbuddy');
  assert.equal(acc.meta.phone, '13900139000', '应从 JWT 恢复未脱敏的真实手机号');

  resetMasterKeyCacheForTest(null);
});

test('writeWorkbuddySession：原模板为 $wbEncrypted 时写回重新封包为加密信封', () => {
  const dummyKey = crypto.createHash('sha256').update('test-secret-key-32', 'utf8').digest();
  resetMasterKeyCacheForTest(dummyKey);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-local-test-'));
  const authDir = path.join(tmpDir, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const sealedOrigToken = sealEnvelope('orig-token', dummyKey, { suite: 1 });
  const targetAccount = {
    uid: 'target-u',
    name: '目标账号',
    token: 'new-plain-access-token',
    refreshToken: 'new-plain-refresh-token',
    meta: {
      session: {
        account: { uid: 'target-u', nickname: '目标账号' },
        auth: {
          accessToken: sealedOrigToken,
          refreshToken: sealedOrigToken,
        },
      },
    },
  };

  const oldEnv = process.env.LOCALAPPDATA;
  // 覆盖 auth 目录为临时目录
  const origAuthDir = path.join(tmpDir, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  process.env.LOCALAPPDATA = tmpDir;

  try {
    const res = writeWorkbuddySession(targetAccount);
    assert.ok(fs.existsSync(res.file));
    const written = JSON.parse(fs.readFileSync(res.file, 'utf8'));
    assert.equal(isWbEncrypted(written.auth.accessToken), true, '写回的文件中 accessToken 应保持为加密信封');
    const decryptedWrittenToken = openEnvelope(written.auth.accessToken, dummyKey);
    assert.equal(decryptedWrittenToken, 'new-plain-access-token');
  } finally {
    process.env.LOCALAPPDATA = oldEnv;
    resetMasterKeyCacheForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
