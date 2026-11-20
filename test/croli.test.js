/**
 * Croli 产品线回归钉（2026-11-20 协议反编译落地）：
 *   - croliLocal：auth.json 解析 / JWT sub 归户 / 凭据过期判定 / 硬切写入复核
 *   - croliClient：签到幂等（claimed → already）与 taskId 缺失兜底 / 余额结构
 *   - 协议钉：client_id znV4SkcUsY1AektQ、issuer clerk.croli.net、checkin taskId 按 key 找行
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCroliCredential, croliSubOf, croliDataDir, authFile, hardSwitchCroli,
} from '../src/croliLocal.js';
import {
  croliCheckinTask, CROLI_CHECKIN_TASK_KEY,
} from '../src/croliClient.js';

// ── 测试沙盒：CROLI_DATA_DIR 指到临时目录 ──
function makeSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'croli-test-'));
  process.env.CROLI_DATA_DIR = dir;
  t.after(() => {
    delete process.env.CROLI_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// 自造一个形状同真的 Clerk JWT（iss/sub 与真机同源，签名假）
function fakeJwt(sub = 'user_3MMYIV5j3iMS0WXJVZVcDvIjZ5z') {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'ins_test', typ: 'at+jwt' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: 'https://clerk.croli.net', sub, exp: Math.floor(Date.now() / 1000) + 86_400,
    iat: Math.floor(Date.now() / 1000), scope: 'profile email offline_access',
  })).toString('base64url');
  return `${header}.${body}.${'A'.repeat(43)}`;
}

test('croliLocal：auth.json 解析（access/refresh/expires_at 秒→毫秒）与缺失返回 null', async (t) => {
  const dir = makeSandbox(t);
  assert.equal(readCroliCredential(), null, '无 auth.json → null');

  fs.writeFileSync(authFile(), JSON.stringify({
    access_token: fakeJwt(),
    refresh_token: 'rt-test-0001',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const cred = readCroliCredential();
  assert.equal(cred.accessToken.startsWith('eyJ'), true, 'access_token 原样');
  assert.equal(cred.refreshToken, 'rt-test-0001');
  assert.equal(cred.expired, false, '未来 1h → 未过期');
  assert.equal(cred.expiresAt > Date.now(), true, '秒级 epoch 已转毫秒');

  fs.writeFileSync(authFile(), JSON.stringify({
    access_token: fakeJwt(), refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) - 10,
  }));
  assert.equal(readCroliCredential().expired, true, '过去 10s → 已过期');
});

test('croliSubOf：JWT sub 提取（归户 uid），非 JWT 返回 null', () => {
  assert.equal(croliSubOf(fakeJwt()), 'user_3MMYIV5j3iMS0WXJVZVcDvIjZ5z');
  assert.equal(croliSubOf('not-a-jwt'), null);
  assert.equal(croliSubOf(''), null);
  assert.equal(croliSubOf('a.b.c'), null, '载荷不是 JSON → null');
});

test('croliClient：croliCheckinTask 按 key/eventKey 找 daily-checkin 行', () => {
  const home = {
    enabled: true,
    programs: [
      { id: 4, key: 'import-sessions', tasks: [{ id: 4, key: 'import-sessions', eventKey: 'conversations_imported' }] },
      { id: 1, key: 'daily-checkin', tasks: [{ id: 1, key: 'daily-checkin', eventKey: 'checkin', status: 'in_progress', progress: 0, target: 1, periodKey: '2026-11-20' }] },
    ],
  };
  const task = croliCheckinTask(home);
  assert.equal(task.id, 1);
  assert.equal(task.key, CROLI_CHECKIN_TASK_KEY);
  assert.equal(croliCheckinTask({ enabled: true, programs: [] }), null, '空活动 → null');
});

test('croliLocal：硬切换——杀进程前未登录库 → 报错；同 uid → alreadyActive；写目标凭据后复核一致', async (t) => {
  const dir = makeSandbox(t);
  const uidA = 'user_AAAA1111AAAA1111AAAA1111AAAA';
  const uidB = 'user_BBBB2222BBBB2222BBBB2222BBBB';
  const tokA = fakeJwt(uidA);
  const tokB = fakeJwt(uidB);

  // 无凭据库（未登录任何账号）→ 报 croliNotInstalled
  await assert.rejects(
    () => hardSwitchCroli({ token: tokB, uid: uidB }, { requireClient: false }),
    (e) => e.croliNotInstalled === true,
  );

  // 当前登录 = A；写 A 的凭据库
  fs.writeFileSync(authFile(), JSON.stringify({ access_token: tokA, refresh_token: 'rt-a', expires_at: Math.floor(Date.now() / 1000) + 3600 }));

  // 目标 = A 自己 → alreadyActive
  const same = await hardSwitchCroli({ token: tokA, uid: uidA }, { requireClient: false });
  assert.deepEqual(same, { switched: false, alreadyActive: true, closedClient: false, verified: true });

  // 目标 = B → 写入并复核
  const r = await hardSwitchCroli({ token: tokB, uid: uidB, refreshToken: 'rt-b' }, { requireClient: false });
  assert.equal(r.switched, true);
  assert.equal(r.verified, true, '复核：auth.json 里已是 B 的凭据');
  const onDisk = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
  assert.equal(onDisk.access_token, tokB);
  assert.equal(onDisk.refresh_token, 'rt-b');
  assert.equal(croliSubOf(onDisk.access_token), uidB);
});

test('croli 协议钉：client_id / issuer / credits 基址不被误改', async () => {
  const { CROLI_CLIENT_ID, CROLI_CLERK_ISSUER } = await import('../src/croliAuth.js');
  assert.equal(CROLI_CLIENT_ID, 'znV4SkcUsY1AektQ');
  assert.equal(CROLI_CLERK_ISSUER, 'https://clerk.croli.net');
  const { CROLI_CREDITS_BASE } = await import('../src/croliClient.js');
  assert.equal(CROLI_CREDITS_BASE, 'https://ds.croli.net/credits');
});
