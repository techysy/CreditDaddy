import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ZHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-4.0-test-'));
process.env.ZCODE_HOME = ZHOME;
process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-z4-'));

const zc = await import('../src/zcrypto.js');
const zl = await import('../src/zcodeLocal.js');
const zauth = await import('../src/zcodeAuth.js');
const zclient = await import('../src/zcodeClient.js');

test('ZCode 4.0: enc:v1 与 enc:v2:os 编解码往返及格式识别', () => {
  const secret = zc.defaultSecret(ZHOME);
  const plainText = 'my-secret-access-token-98765';

  // 1. 旧版 enc:v1 格式
  const v1 = zc.encryptWithSecret(plainText, secret);
  assert.ok(v1.startsWith('enc:v1:'));
  assert.equal(zc.isEncrypted(v1), true);
  assert.equal(zc.decryptWithSecret(v1, secret), plainText);
  assert.equal(zc.safeDecrypt(v1, secret), plainText);

  // 2. 新版 enc:v2:os 格式（测试注入 OS Key）
  const testKey = crypto.randomBytes(32);
  const fp = zc.keyFingerprint(testKey);
  zc._setOsKeyForTest(fp, testKey);

  const v2 = zc.encryptWithSecret(plainText, secret, { format: 'v2:os', osKey: testKey });
  assert.ok(v2.startsWith(`enc:v2:os:${fp}:`), '应以 enc:v2:os:<fingerprint>: 开头');
  assert.equal(zc.isEncrypted(v2), true);
  assert.equal(zc.decryptWithSecret(v2, secret), plainText);
  assert.equal(zc.safeDecrypt(v2, secret), plainText);
});

test('ZCode 4.0: 兼容识别 zai_cn 渠道身份与 linked_bigmodel', () => {
  const secret = zc.defaultSecret(ZHOME);
  const testKey = crypto.randomBytes(32);
  const fp = zc.keyFingerprint(testKey);
  zc._setOsKeyForTest(fp, testKey);
  const enc = (v) => zc.encryptWithSecret(v, secret, { format: 'v2:os', osKey: testKey });

  // 模拟 ZCode 4.0 zai_cn 官方国内登录凭据
  const creds = {
    'oauth:active_provider': enc('zai_cn'),
    'oauth:zai_cn:access_token': enc('jwt.header.eyJ1c2VyX2lkIjoiOTk4ODEyMyJ9.sig'),
    'oauth:zai_cn:user_info': enc(JSON.stringify({
      id: '9988123',
      user_id: '9988123',
      username: '旅行者9988',
      displayName: '旅行者9988',
      email: 'traveler@z.ai',
    })),
    'oauth:linked_bigmodel': enc(JSON.stringify({
      userId: '9988123',
      customerId: '33841786516987046',
      accessToken: 'bm_access_token_12345678901234567890',
    })),
    zcodejwttoken: enc('zcode_jwt_token_sample_value_123456'),
  };

  assert.equal(zc.isLoggedIn(creds), true);
  const id = zc.identityWithSecret(creds, secret);
  assert.equal(id.provider, 'zai_cn');
  assert.equal(id.userId, '9988123');
  assert.equal(id.displayName, '旅行者9988');
  assert.equal(id.email, 'traveler@z.ai');
  assert.ok(id.linkedBigModel);
  assert.equal(id.linkedBigModel.customerId, '33841786516987046');
  assert.equal(id.linkedBigModel.accessToken, 'bm_access_token_12345678901234567890');
});

test('ZCode 4.0: candidateTokens 能提取 zai_cn 与 linked_bigmodel 的 token', () => {
  const secret = zc.defaultSecret(ZHOME);
  const enc = (v) => zc.encryptWithSecret(v, secret);
  const account = {
    provider: 'zcode',
    meta: {
      credentials: {
        'oauth:active_provider': enc('zai_cn'),
        'oauth:zai_cn:access_token': enc('zai_cn_access_token_token_1234567890'),
        'oauth:linked_bigmodel': enc(JSON.stringify({
          customerId: '33841786516987046',
          accessToken: 'linked_bm_token_value_1234567890',
        })),
        zcodejwttoken: enc('zcode_jwt_token_value_1234567890'),
      },
    },
  };

  const tokens = zclient.candidateTokens(account);
  assert.ok(tokens.includes('zai_cn_access_token_token_1234567890'));
  assert.ok(tokens.includes('linked_bm_token_value_1234567890'));
  assert.ok(tokens.includes('zcode_jwt_token_value_1234567890'));
});

test('ZCode 4.0: startZcodeLogin 区分 zai_cn、bigmodel 与 zai', async () => {
  // 1. zai_cn 国内版初始化：请求官方后端，应返回基准域名为 zchat.z.ai 的黑白 Z 授权页面
  const cnFlow = await zauth.startZcodeLogin('zcode-zai-cn');
  assert.equal(cnFlow.data.provider, 'zai_cn');
  assert.ok(cnFlow.url.startsWith('https://zchat.z.ai/'), `授权地址必须指向 zchat.z.ai，当前为：${cnFlow.url}`);
  assert.ok(cnFlow.url.includes('callback/zai_cn') || cnFlow.url.includes('callback%2Fzai_cn'));

  // 2. bigmodel 国内旧版初始化：兼容老平台
  const bmFlow = await zauth.startZcodeLogin('zcode-bigmodel');
  assert.equal(bmFlow.data.provider, 'bigmodel');
  assert.ok(bmFlow.url.startsWith('https://bigmodel.cn/login'));

  // 3. zai 国际版初始化：兼容海外平台
  const zaiFlow = await zauth.startZcodeLogin('zcode-zai');
  assert.equal(zaiFlow.data.provider, 'zai');
  assert.ok(zaiFlow.url.startsWith('https://chat.z.ai/'));
});

test('ZCode 4.0: buildCredentials 组装包含 zai_cn 与 linkedBigModel 并预填 Coding Plan 身份', () => {
  const secret = zc.defaultSecret(ZHOME);
  const creds = zauth.buildCredentials({
    provider: 'zai_cn',
    jwt: 'jwt-token-12345',
    accessToken: 'access-token-12345',
    refreshToken: 'refresh-token-12345',
    user: { id: '9988123', name: '旅行者9988', email: 'traveler@z.ai' },
    userId: '9988123',
    linkedBigModel: { customerId: '33841786516987046', accessToken: 'bm-token-12345' },
  }, secret);

  assert.equal(zc.safeDecrypt(creds['oauth:active_provider'], secret), 'zai_cn');
  assert.equal(zc.safeDecrypt(creds['oauth:zai_cn:access_token'], secret), 'access-token-12345');
  assert.equal(zc.safeDecrypt(creds['account-provider:account:zai-individual-coding-plan:identity'], secret), '9988123');
  assert.equal(zc.safeDecrypt(creds['account-provider:account:bigmodel-individual-coding-plan:identity'], secret), '33841786516987046');
});

test('ZCode 4.0: switchTo 冷切换支持 zai_cn 账号', () => {
  const p = zl.zcodePaths();
  fs.mkdirSync(path.dirname(p.credentials), { recursive: true });
  fs.writeFileSync(p.credentials, JSON.stringify({ old: 'creds' }));
  fs.writeFileSync(p.config, JSON.stringify({ provider: { 'builtin:bigmodel': { enabled: true } } }));
  fs.writeFileSync(p.setting, JSON.stringify({ modelProviderFamilySelectedKeys: { zai: 'old-key' } }));
  fs.writeFileSync(p.providerConfig, JSON.stringify({ schemaVersion: 1, config: {} }));

  const secret = zc.defaultSecret(ZHOME);
  const enc = (v) => zc.encryptWithSecret(v, secret);

  const zaiCnAccount = {
    id: 'acc_zai_cn',
    provider: 'zcode',
    uid: '9988123',
    token: 'zcode-creds:9988123',
    meta: {
      loginProvider: 'zai_cn',
      credentials: {
        'oauth:active_provider': enc('zai_cn'),
        'oauth:zai_cn:access_token': enc('x'.repeat(64)),
        'oauth:zai_cn:user_info': enc(JSON.stringify({ id: '9988123', username: '旅行者9988' })),
        'oauth:linked_bigmodel': enc(JSON.stringify({ customerId: '33841786516987046', accessToken: 'bm_x'.repeat(32) })),
        zcodejwttoken: enc('j'.repeat(64)),
      },
    },
  };

  const r = zl.switchTo(zaiCnAccount, { force: true });
  assert.equal(r.switched, true);

  // 1. credentials.json 写入且补齐两套 Coding Plan identity
  const curCreds = JSON.parse(fs.readFileSync(p.credentials, 'utf8'));
  assert.equal(zc.safeDecrypt(curCreds['oauth:active_provider'], secret), 'zai_cn');
  assert.equal(zc.safeDecrypt(curCreds['account-provider:account:zai-individual-coding-plan:identity'], secret), '9988123');
  assert.equal(zc.safeDecrypt(curCreds['account-provider:account:bigmodel-individual-coding-plan:identity'], secret), '33841786516987046');

  // 2. setting.json 自动启用 zai 家族
  const curSetting = JSON.parse(fs.readFileSync(p.setting, 'utf8'));
  assert.equal(curSetting.providerFamilyDomain, 'zai');
  assert.equal(curSetting.modelProviderFamilySelectedKeys.zai, 'coding-plan:builtin:zai-start-plan');

  // 3. config.json 启用 builtin:zai 与 builtin:zai-start-plan
  const curConfig = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  assert.equal(curConfig.provider['builtin:zai'].enabled, true);
  assert.equal(curConfig.provider['builtin:zai-start-plan'].enabled, true);
  assert.equal(curConfig.provider['builtin:bigmodel'].enabled, false);

  // 4. provider_config.json 指向 zai-individual-coding-plan
  const curPcfg = JSON.parse(fs.readFileSync(p.providerConfig, 'utf8'));
  assert.equal(curPcfg.config.defaultModelSelection.providerId, 'account:zai-individual-coding-plan');
});
