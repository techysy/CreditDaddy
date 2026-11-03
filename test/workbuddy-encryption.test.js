import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  isWbEncrypted,
  buildEnvelopeAAD,
  openEnvelope,
  sealEnvelope,
  resetMasterKeyCacheForTest,
  getWorkbuddyMasterKey,
  detectWorkbuddy,
  resolveWorkbuddyClientPath,
  resolveWorkbuddySpawnExecutable,
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

test('无客户端 + 加密会话冷缓存：detect/read/currentUid/直接解密不会递归挂起（子进程超时回归）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-recursion-home-'));
  const child = `
    import fs from 'node:fs';
    import path from 'node:path';
    import crypto from 'node:crypto';
    const wb = await import(process.env.WB_MODULE_URL);
    // 本机即使装了 WorkBuddy，也在子进程里强制「无 exe」——复现纯凭据目录 + 加密会话的机器。
    const realExists = fs.existsSync;
    fs.existsSync = (p) => {
      const s = String(p);
      if (/\\.app($|[\\\\/])/i.test(s) || /\\.exe$/i.test(s)) return false;
      return realExists(p);
    };
    wb.resetMasterKeyCacheForTest(null);
    const authDir = wb.workbuddyAuthDir();
    fs.mkdirSync(authDir, { recursive: true });
    const key = crypto.createHash('sha256').update('no-client-key', 'utf8').digest();
    const jwt = ['e30', Buffer.from(JSON.stringify({ iss: 'https://www.codebuddy.cn/auth', sub: 'u-cold', exp: 9999999999 })).toString('base64url'), 'sig'].join('.');
    const session = {
      account: { uid: 'u-cold', nickname: '冷缓存' },
      auth: { accessToken: wb.sealEnvelope(jwt, key), refreshToken: wb.sealEnvelope('refresh-cold', key) },
    };
    fs.writeFileSync(path.join(authDir, 'workbuddy-desktop.info'), JSON.stringify(session));
    const detect = wb.detectWorkbuddy();
    const read = wb.readWorkbuddySessions();
    const uid = wb.currentWorkbuddyUid();
    const direct = wb.decryptSessionJson(session, null);
    process.stdout.write(JSON.stringify({
      detect: { installed: detect.installed, signedIn: detect.signedIn, clientPath: detect.clientPath },
      readAccounts: read.accounts.length,
      readErrors: read.errors.length,
      uid,
      envelopeIntact: wb.isWbEncrypted(direct.auth.accessToken)
        && direct.auth.accessToken.envelope === session.auth.accessToken.envelope
        && direct.auth.refreshToken.envelope === session.auth.refreshToken.envelope,
      originalIntact: wb.isWbEncrypted(session.auth.accessToken),
    }));
  `;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        WB_MODULE_URL: new URL('../src/workbuddyLocal.js', import.meta.url).href,
      },
    });
    assert.equal(r.error, undefined, `detect/read/currentUid/decrypt 应正常返回，实际超时或异常：${r.error?.code || ''} ${r.stderr || ''}`);
    assert.equal(r.status, 0, `子进程应退出 0：${r.stderr || ''}`);
    const result = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(result.detect, { installed: false, signedIn: false, clientPath: null });
    assert.equal(result.readAccounts, 0);
    assert.equal(result.readErrors, 0);
    assert.equal(result.uid, null);
    assert.equal(result.envelopeIntact, true, '无密钥时应原样保留加密信封');
    assert.equal(result.originalIntact, true, '直接解密不得破坏调用方传入的对象');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveWorkbuddyClientPath：显式 null = 无客户端，显式路径原样返回', () => {
  assert.equal(resolveWorkbuddyClientPath(null), null);
  assert.equal(resolveWorkbuddyClientPath('/custom/WorkBuddy'), '/custom/WorkBuddy');
  const discovered = resolveWorkbuddyClientPath();
  assert.equal(discovered === null || typeof discovered === 'string', true);
});

test('resolveWorkbuddySpawnExecutable：macOS .app 包定位到 Contents/MacOS 可执行文件', () => {
  const bundle = '/Applications/WorkBuddy.app';
  assert.equal(resolveWorkbuddySpawnExecutable(bundle), path.join(bundle, 'Contents', 'MacOS', 'WorkBuddy'));
  assert.equal(
    resolveWorkbuddySpawnExecutable('/Applications/WorkBuddy AI.app'),
    path.join('/Applications/WorkBuddy AI.app', 'Contents', 'MacOS', 'WorkBuddy AI'),
  );
  const plain = '/usr/local/bin/workbuddy';
  assert.equal(resolveWorkbuddySpawnExecutable(plain), plain, '非 .app 路径不应被改写');
  assert.equal(resolveWorkbuddySpawnExecutable(null), null);
});

test('macOS：探测公开 clientPath 保持 .app bundle，spawn 才解析到 Contents/MacOS 可执行文件', async () => {
  if (process.platform !== 'darwin') return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-app-mock-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const realExists = fs.existsSync;
  const cpDefault = (await import('node:child_process')).default;
  const origSpawn = cpDefault.spawnSync;
  let spawned = null;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.existsSync = (p) => {
    const s = String(p);
    if (s === '/Applications/WorkBuddy.app') return true;
    if (/\.app($|[\\/])/i.test(s)) return false;
    return realExists(p);
  };
  cpDefault.spawnSync = (exe, args, opts) => {
    spawned = { exe, args, opts };
    return { status: 0, stdout: 'k'.repeat(20), stderr: '' };
  };
  resetMasterKeyCacheForTest(null);
  try {
    const detected = detectWorkbuddy();
    assert.equal(detected.clientPath, '/Applications/WorkBuddy.app', '公开探测结果应保留 bundle 路径');
    assert.equal(getWorkbuddyMasterKey(null), null, '显式 null 表示无客户端，不得触发探测');
    assert.equal(spawned, null);
    const key = getWorkbuddyMasterKey(detected.clientPath);
    assert.ok(key, '模拟 spawn 成功时应返回缓存密钥');
    assert.equal(spawned.exe, path.join('/Applications/WorkBuddy.app', 'Contents', 'MacOS', 'WorkBuddy'));
    assert.equal(spawned.args[0], '-e');
    assert.equal(spawned.opts.env.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    fs.existsSync = realExists;
    cpDefault.spawnSync = origSpawn;
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    resetMasterKeyCacheForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
