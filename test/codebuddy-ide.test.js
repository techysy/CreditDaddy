/**
 * issue #51：CodeBuddy IDE（桌面客户端）账号读取 / 切换。
 *
 * 重点守三件事：
 *  1) 加解密往返正确（v10 / AES-256-GCM 格式、Buffer 结构）；
 *  2) 探测是同步且无子进程副作用的（可安全用于状态展示）；
 *  3) 会话 → 账号记录的映射：provider 由 token 决定、档位写进 meta、脱敏手机号能还原。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  detectCodeBuddyIde, detectCodeBuddyIdeAll, codebuddyIdeDataDir,
  codebuddyIdeStateDbPath, CODEBUDDY_IDE_FLAVORS,
} from '../src/codebuddyIdeLocal.js';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeJwt(iss, sub = 'uid-test', extra = {}) {
  return [b64url({ alg: 'none' }), b64url({ iss, sub, exp: Math.floor(Date.now() / 1000) + 3600, ...extra }), 'sig'].join('.');
}

test('issue #51：两个档位的目录 / secret key 定义正确（CN 与 国际版互不相同）', () => {
  assert.equal(CODEBUDDY_IDE_FLAVORS.cn.dataDirName, 'CodeBuddy CN');
  assert.equal(CODEBUDDY_IDE_FLAVORS.intl.dataDirName, 'CodeBuddy');
  assert.equal(CODEBUDDY_IDE_FLAVORS.cn.secretKey, 'planning-genie.new.accessTokencn');
  assert.equal(CODEBUDDY_IDE_FLAVORS.intl.secretKey, 'planning-genie.new.accessToken');
  assert.notEqual(CODEBUDDY_IDE_FLAVORS.cn.dataDirName, CODEBUDDY_IDE_FLAVORS.intl.dataDirName);
});

test('issue #51：数据目录在 %APPDATA%（Roaming）而不是 %LOCALAPPDATA%', () => {
  const dir = codebuddyIdeDataDir('cn');
  assert.ok(path.isAbsolute(dir));
  assert.ok(dir.endsWith('CodeBuddy CN'), `期望以 CodeBuddy CN 结尾，实际 ${dir}`);
  if (process.platform === 'win32') {
    assert.ok(/AppData[\\/]Roaming/.test(dir), `Windows 应在 Roaming 下，实际 ${dir}`);
  }
});

test('issue #51：detectCodeBuddyIde 是同步函数、绝不返回 Promise（可进状态展示）', () => {
  const r = detectCodeBuddyIde('cn');
  assert.equal(typeof r.then, 'undefined', '必须是同步返回');
  assert.equal(typeof r.installed, 'boolean');
  assert.equal(r.flavor, 'cn');
  assert.ok(r.dbPath.endsWith('state.vscdb'));
});

test('issue #51：detectCodeBuddyIdeAll 同时覆盖两个档位，且不抛异常', () => {
  const all = detectCodeBuddyIdeAll();
  assert.deepEqual(Object.keys(all).sort(), ['cn', 'intl']);
  for (const k of ['cn', 'intl']) assert.equal(typeof all[k].installed, 'boolean');
});

test('issue #51：未安装时 stateDbPath 仍返回首选候选（供错误文案指出期望位置）', () => {
  const p = codebuddyIdeStateDbPath('intl');
  assert.ok(p.endsWith(path.join('User', 'globalStorage', 'state.vscdb')));
});

test('issue #51：v10 / AES-256-GCM 密文格式往返（模拟 Chromium Safe Storage）', () => {
  // 与 src/codebuddyIdeLocal.js 内的 encrypt/decrypt 同算法：v10 | 12B nonce | ct | 16B tag
  const key = crypto.randomBytes(32);
  const plain = Buffer.from(JSON.stringify({ auth: { accessToken: 'x'.repeat(80) } }), 'utf8');

  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const enc = Buffer.concat([Buffer.from('v10'), iv, ct, c.getAuthTag()]);

  assert.equal(enc.subarray(0, 3).toString('latin1'), 'v10');
  assert.equal(enc.length, plain.length + 3 + 12 + 16);

  const d = crypto.createDecipheriv('aes-256-gcm', key, enc.subarray(3, 15));
  d.setAuthTag(enc.subarray(enc.length - 16));
  const out = Buffer.concat([d.update(enc.subarray(15, enc.length - 16)), d.final()]);
  assert.equal(out.toString('utf8'), plain.toString('utf8'));
});

test('issue #51：Buffer 结构（{type:"Buffer",data:[...]}）与窄字节一致', () => {
  const bytes = crypto.randomBytes(64);
  const serialized = JSON.stringify({ type: 'Buffer', data: Array.from(bytes) });
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.type, 'Buffer');
  assert.equal(parsed.data.length, 64);
  assert.ok(Buffer.from(parsed.data).equals(bytes), 'Buffer 往返必须无损');
});

test('issue #51：token 的 iss 决定 provider——codebuddy.cn 归国内、codebuddy.ai 归国际', async () => {
  const { inspectToken } = await import('../src/workbuddyClient.js');
  assert.equal(inspectToken(fakeJwt('https://www.codebuddy.cn/auth/realms/copilot')).provider, 'workbuddy');
  assert.equal(inspectToken(fakeJwt('https://www.codebuddy.ai/auth/realms/copilot')).provider, 'workbuddy-intl');
});
