/**
 * AutoClaw（智谱澳龙 / AutoGLM）产品线回归测试。
 *
 * 覆盖：协议纯函数（region 判别 / 签名头 / JWT 到期）、签到三态、refresh 的 400002 退路与
 * 双 host 判定、wallets 额度形状、本机凭据收割（临时目录 + 注入 codec，绝不碰真机数据）、
 * 以及「注册挂点全套」——历史上 dumate / croli 两次漏注册事故定的清单。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 数据目录隔离必须在**任何 store 模块被 import 之前**设好——store.js 的 dataDir() 是
// 惰性读环境变量的，但账号落库的用例会把记录写进 process.env.CREDITDADDY_HOME，
// 不隔离就会污染用户真实账号库（本仓库最贵的事故类型）。
process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-ac-'));
// 本机 AutoClaw 数据目录也要挡：detect/收割用例绝不能读真机 %APPDATA%\autoclaw
process.env.AUTOCLAW_DATA_DIR = path.join(process.env.CREDITDADDY_HOME, 'no-autoclaw');

import {
  AUTOCLAW_DAILY_SIGNIN_TASK,
  AUTOCLAW_GLOBAL_HOST,
  AUTOCLAW_CN_HOST,
  AUTOCLAW_PATHS,
  autoclawRegionOfToken,
  autoclawRegionFor,
  autoclawHostOrder,
  autoclawSignHeaders,
  autoclawBizHeaders,
  autoclawTokenFields,
  autoclawExpiresAtMs,
  autoclawTokenUsable,
  autoclawDisplayName,
  maskAutoclawPhone,
  bareToken,
  jwtClaim,
  explainAutoclawCode,
  isAutoclawDeadLogin,
  refreshAutoclawCredentials,
  claimAutoclawDailySignin,
  fetchAutoclawWallets,
  fetchAutoclawTasks,
  fetchAutoclawSigninStatus,
  normalizeAutoclawQuota,
  checkinAutoclaw,
  resolveAutoclawAuth,
  autoclawLocalBelongsTo,
  AUTOCLAW_INVITE_ACTIVITY,
  AUTOCLAW_CN_PHONE_RE,
  fetchAutoclawInviteStatus,
  fetchAutoclawInviteActivities,
  bindAutoclawInviteCode,
  normalizeAutoclawInvite,
  autoclawSecToIso,
  autoclawSmsCodeValue,
  cleanAutoclawCnPhone,
  sendAutoclawCnSmsCode,
  loginAutoclawCnBySms,
} from '../src/autoclawClient.js';
import {
  autoclawCdDeviceId,
  autoclawCdSmsDeviceId,
  accountDeviceId,
  sendAutoclawSms,
  loginAutoclawSms,
  isAutoclawCdOwned,
  _setMachineGuidForTests,
} from '../src/autoclawAuth.js';
import {
  detectAutoclaw,
  decryptAutoclawAuth,
  liveToAccount,
  currentAutoclawUid,
  autoclawDataDir,
  authFile,
  AUTOCLAW_EXE,
  _setDetectForTests,
  _setCodecForTests,
  _resetAutoclawLocalCache,
} from '../src/autoclawLocal.js';
import { PROVIDERS, PROVIDER_LABEL, productOf } from '../src/constants.js';
import { productImpl } from '../src/providers.js';
import { dayKey } from '../src/checkin.js';

// ── 测试工具 ──

/** 造一枚只含指定 claim 的假 JWT（不验签） */
const mkJwt = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
};

const CN_CLAIMS = { user_id: 935428, source_id: 'agentaccess_token', device_id: 'a'.repeat(64), exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000) };
const INTL_CLAIMS = { user_id: 42, source_id: 'zai_oauth', device_id: 'b'.repeat(64), exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000) };

const okRes = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** 按 URL + path 分发的 mock fetch，记录调用 */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) {
        const r = typeof handler === 'function' ? handler({ url: String(url), init }) : handler;
        if (r) return r;
      }
    }
    return okRes({ code: 404, msg: 'no route' });
  };
  fn.calls = calls;
  return fn;
}

// ── 1. 协议纯函数 ──

test('AutoClaw region 判别：source_id 以 agent 开头 = 国内短信号', () => {
  assert.equal(autoclawRegionOfToken(mkJwt(CN_CLAIMS)), 'cn');
  assert.equal(autoclawRegionOfToken(mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' })), 'cn');
  assert.equal(autoclawRegionOfToken(mkJwt(INTL_CLAIMS)), 'intl');
  assert.equal(autoclawRegionOfToken('not-a-jwt'), null);
  assert.equal(autoclawRegionOfToken(''), null);

  // provider 兜底：token 解不出时才看 provider id
  assert.equal(autoclawRegionFor('autoclaw-cn', {}), 'cn');
  assert.equal(autoclawRegionFor('autoclaw', {}), 'intl');
  // token claim 优先于 provider id（本机号误挂到国际线也能纠正）
  assert.equal(autoclawRegionFor('autoclaw', { accessToken: mkJwt(CN_CLAIMS) }), 'cn');

  assert.deepEqual(autoclawHostOrder('cn'), [AUTOCLAW_CN_HOST, AUTOCLAW_GLOBAL_HOST]);
  assert.deepEqual(autoclawHostOrder('intl'), [AUTOCLAW_GLOBAL_HOST, AUTOCLAW_CN_HOST]);
});

test('AutoClaw 签名头 = md5(appId&ts&appKey)，且时间戳来自传入时刻', () => {
  const nowMs = 1_764_000_000_000;
  const h = autoclawSignHeaders(nowMs);
  const ts = String(Math.floor(nowMs / 1000));
  assert.equal(h['X-Auth-Appid'], '100003');
  assert.equal(h['X-Auth-TimeStamp'], ts);
  assert.equal(h['X-Auth-Sign'], crypto.createHash('md5').update(`100003&${ts}&38d2391985e2369a5fb8227d8e6cd5e5`).digest('hex'));
});

test('AutoClaw 账号面头：显式 UA + 双线各自的 X-Channel/X-Version', () => {
  const cn = autoclawBizHeaders('cn', 'tok');
  assert.equal(cn['User-Agent'], 'AutoClaw/2.1.0');
  assert.equal(cn['X-Channel'], 'AutoClaw26');
  assert.equal(cn.Authorization, 'Bearer tok');
  const intl = autoclawBizHeaders('intl');
  assert.equal(intl['User-Agent'], 'AutoClaw/1.18.1');
  assert.equal(intl['X-Channel'], 'AutoClaw4');
  assert.equal(intl.Authorization, undefined);
});

test('AutoClaw token 工具：去 Bearer / JWT 到期 / 提前量判可用', () => {
  assert.equal(bareToken('Bearer Bearer abc'), 'abc');
  const now = Date.now();
  const fresh = mkJwt({ exp: Math.floor(now / 1000) + 3600 });
  const stale = mkJwt({ exp: Math.floor(now / 1000) + 60 });   // 60s < 10min 提前量
  assert.equal(jwtClaim(fresh, 'exp') > 0, true);
  assert.equal(autoclawTokenUsable(fresh, now), true);
  assert.equal(autoclawTokenUsable(stale, now), false);
  assert.equal(autoclawTokenUsable('garbage', now), false);
  assert.equal(autoclawExpiresAtMs('garbage'), null);

  const f = autoclawTokenFields({ access_token: `Bearer ${fresh}`, refresh_token: 'rt', user_id: 7 });
  assert.equal(f.accessToken, fresh);
  assert.equal(f.userId, '7');
  assert.ok(Date.parse(f.expiresAt) > now);
});

test('AutoClaw 显示名与手机号脱敏：绝不原样外显', () => {
  assert.equal(maskAutoclawPhone('13112343656'), '131****3656');
  assert.equal(maskAutoclawPhone('131****3656'), '131****3656');   // 已是脱敏形态原样返回
  assert.equal(maskAutoclawPhone(''), null);
  assert.equal(autoclawDisplayName({ user_name: '用户3656' }), '用户3656');
  assert.equal(autoclawDisplayName({ user_phone: '13112343656' }), '131****3656');
  assert.equal(autoclawDisplayName(null, 'fallback'), 'fallback');
});

test('AutoClaw 业务码：解释 + 死链判定', () => {
  assert.equal(explainAutoclawCode(400000), '登录已失效，请重新登录');
  assert.equal(explainAutoclawCode(999999), null);
  // 400000 是 /refresh 对死链（HTTP 200）的回答
  assert.equal(isAutoclawDeadLogin({ code: 400000 }), true);
  assert.equal(isAutoclawDeadLogin({ status: 401 }), true);
  assert.equal(isAutoclawDeadLogin({ code: 400002 }), false);   // 签名校验失败 ≠ 死链
  assert.equal(isAutoclawDeadLogin({ message: 'invalid_grant' }), true);
});

// ── 2. 签到三态 ──

test('AutoClaw 签到：成功 / 已签 / 失败三态', async () => {
  const at = mkJwt(CN_CLAIMS);

  const claimedFetch = mockFetch([[AUTOCLAW_PATHS.taskComplete, () => okRes({
    code: 0, data: { success: true, reward_points: 200, continuous_days: 3 },
  })]]);
  const c = await claimAutoclawDailySignin(at, { region: 'cn', deviceId: 'd'.repeat(64), fetchImpl: claimedFetch });
  assert.equal(c.claimed, true);
  assert.equal(c.points, 200);
  assert.equal(c.streak, 3);
  // 请求体必带 task_id + source_id + device_id（缺 device_id → 400001）
  const body = claimedFetch.calls[0].body;
  assert.equal(body.task_id, AUTOCLAW_DAILY_SIGNIN_TASK);
  assert.equal(body.task_id, 'daily_signin');
  assert.equal(body.source_id, 'autoclaw');
  assert.equal(body.device_id, 'd'.repeat(64));

  const alreadyFetch = mockFetch([[AUTOCLAW_PATHS.taskComplete, () => okRes({ code: 0, data: { already_completed: true } })]]);
  const a = await claimAutoclawDailySignin(at, { region: 'cn', deviceId: 'd', fetchImpl: alreadyFetch });
  assert.equal(a.claimed, false);
  assert.equal(a.already, true);

  const failFetch = mockFetch([[AUTOCLAW_PATHS.taskComplete, () => okRes({ code: 0, data: { success: false, message: '活动已结束' } })]]);
  const f = await claimAutoclawDailySignin(at, { region: 'cn', deviceId: 'd', fetchImpl: failFetch });
  assert.equal(f.claimed, false);
  assert.equal(f.already, false);
  assert.equal(f.message, '活动已结束');

  // 401 → 抛 auth 错误（供上层按「凭据失效」处理）
  const deadFetch = mockFetch([[AUTOCLAW_PATHS.taskComplete, () => okRes('', 401)]]);
  await assert.rejects(
    () => claimAutoclawDailySignin(at, { region: 'cn', deviceId: 'd', fetchImpl: deadFetch }),
    (e) => e.auth === true && e.signIn === 'expired',
  );
});

test('AutoClaw 签到：网络异常不抛，回 failed 让调度器下一轮重试', async () => {
  const boom = async () => { throw new Error('ECONNRESET'); };
  const r = await claimAutoclawDailySignin(mkJwt(CN_CLAIMS), { region: 'cn', deviceId: 'd', fetchImpl: boom });
  assert.equal(r.claimed, false);
  assert.match(r.message, /ECONNRESET/);
});

// ── 3. 刷新：400002 退路 + 双 host 判定 ──

test('AutoClaw 刷新：第一跳 400002 时退到 agent-refresh', async () => {
  const newAt = mkJwt({ ...CN_CLAIMS, iat: Math.floor(Date.now() / 1000) });
  // refresh(/userapi/v1/refresh) 与 refreshAlt(/userapi/v1/agent-refresh) 不是子串关系，
  // 路由按共同前缀命中、handler 内用精确尾判区分两跳
  const f = mockFetch([['/userapi/v1/', ({ url }) => (url.endsWith(AUTOCLAW_PATHS.refreshAlt)
    ? okRes({ code: 0, data: { access_token: newAt, refresh_token: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }) } })
    : okRes({ code: 400002, msg: '签名校验未通过' }))]]);
  const r = await refreshAutoclawCredentials(mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), {
    deviceId: 'd'.repeat(64), fetchImpl: f,
  });
  assert.equal(r.accessToken, newAt);
  assert.ok(r.refreshToken);
  const paths = f.calls.map((c) => new URL(c.url).pathname);
  assert.deepEqual(paths, [AUTOCLAW_PATHS.refresh, AUTOCLAW_PATHS.refreshAlt]);
  // 都打在自家域上（CN token → CN host 优先）
  assert.ok(f.calls.every((c) => c.url.startsWith(AUTOCLAW_CN_HOST)));
});

test('AutoClaw 刷新：400002 之外不试第二跳；自家域全败后再换对侧域', async () => {
  const f = mockFetch([
    // 自家域（CN）两跳都回 400001（参数缺失，不是 400002）→ 第一跳失败就该结束本域
    [AUTOCLAW_CN_HOST, () => okRes({ code: 400001, msg: '参数缺失' })],
    [AUTOCLAW_GLOBAL_HOST, () => okRes({ code: 0, data: { access_token: mkJwt(INTL_CLAIMS), refresh_token: 'rt2' } })],
  ]);
  const r = await refreshAutoclawCredentials(mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), { deviceId: 'd', fetchImpl: f });
  assert.ok(r && r.accessToken, 'CN 域被拒后应落到国际域并成功');
  const hosts = f.calls.map((c) => new URL(c.url).origin);
  // CN token 先打 CN 域（只一跳），再打国际域
  assert.deepEqual(hosts, [AUTOCLAW_CN_HOST, AUTOCLAW_GLOBAL_HOST]);
  assert.equal(f.calls[0].url, `${AUTOCLAW_CN_HOST}${AUTOCLAW_PATHS.refresh}`, '非 400002 不该退到 agent-refresh');
});

test('AutoClaw 刷新：所有 host 都判死才返回 invalid_grant', async () => {
  const dead = mockFetch([[AUTOCLAW_CN_HOST, () => okRes({ code: 400000, msg: '用户未登录' })],
    [AUTOCLAW_GLOBAL_HOST, () => okRes({ code: 400000, msg: '用户未登录' })]]);
  const r = await refreshAutoclawCredentials(mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), { deviceId: 'd', fetchImpl: dead });
  assert.deepEqual(r, { error: 'invalid_grant' });

  // 一侧瞬时失败（非死链）→ 不判死，返回 null 让上层下一轮重试
  const flaky = mockFetch([
    [AUTOCLAW_CN_HOST, () => okRes('', 500)],
    [AUTOCLAW_GLOBAL_HOST, () => okRes({ code: 400000 })],
  ]);
  const r2 = await refreshAutoclawCredentials(mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), { deviceId: 'd', fetchImpl: flaky });
  assert.equal(r2, null);
});

test('AutoClaw 刷新：没有 device_id 时不打网络，直接判死', async () => {
  const f = mockFetch([]);
  // rt 里没有 device_id claim，调用方也不传 → 打不进账号面
  const r = await refreshAutoclawCredentials(mkJwt({ user_id: 1, source_id: 'agentrefresh_token' }), { fetchImpl: f });
  assert.deepEqual(r, { error: 'invalid_grant' });
  assert.equal(f.calls.length, 0);
});

// ── 4. 额度：wallets 形状 + task list ──

const WALLETS = {
  code: 0,
  data: {
    total_balance: 20150,
    wallets: [
      { public_wallet_type: 'reward', balance: 20000 },
      { public_wallet_type: 'daily', balance: 150 },
      { public_wallet_type: 'fuel_pack', balance: 0 },   // 零余额不列
      { public_wallet_type: 'other', balance: 12 },      // 已知类型走标签表「其他积分」
      { public_wallet_type: 'promotion', display_name: '活动积分', balance: 5 },   // 未知类型回落 display_name
    ],
  },
};

test('AutoClaw 额度：钱包总额作主行，非零分类作明细', async () => {
  const at = mkJwt(CN_CLAIMS);
  const f = mockFetch([
    [AUTOCLAW_PATHS.wallets, () => okRes(WALLETS)],
    [AUTOCLAW_PATHS.taskList, () => okRes({ data: [{ task_id: 'daily_signin', status: 'completed', reward_points: 200 }] })],
  ]);
  const wallets = await fetchAutoclawWallets(at, { region: 'cn', fetchImpl: f });
  const tasks = await fetchAutoclawTasks(at, { region: 'cn', fetchImpl: f });
  assert.equal(tasks.length, 1);
  const signin = await fetchAutoclawSigninStatus(at, { region: 'cn', fetchImpl: f });
  assert.equal(signin.done, true);

  const q = normalizeAutoclawQuota(wallets, signin);
  assert.equal(q.unit, '积分');
  assert.equal(q.total, 20150);
  assert.equal(q.remaining, 20150);
  assert.equal(q.used, 0);          // 纯积分账面：上游不提供已用口径
  assert.equal(q.empty, false);
  const names = q.parts.map((p) => p.name);
  assert.ok(names.includes('奖励积分'));
  assert.ok(names.includes('每日积分'));
  assert.ok(names.includes('活动积分'), '未知类型的 display_name 兜底生效');
  assert.ok(!names.includes('加油包积分'), '零余额钱包不列');
  assert.ok(names.includes('每日签到'));
});

test('AutoClaw 额度：task-list 裸 { data: [...] } 无 code 也算成功', async () => {
  const at = mkJwt(CN_CLAIMS);
  const f = mockFetch([[AUTOCLAW_PATHS.taskList, () => okRes({ data: [] })]]);
  const tasks = await fetchAutoclawTasks(at, { region: 'cn', fetchImpl: f });
  assert.deepEqual(tasks, []);
});

test('AutoClaw 额度：读不到要抛错，绝不报 0', async () => {
  const at = mkJwt(CN_CLAIMS);
  const f = mockFetch([[AUTOCLAW_PATHS.wallets, () => okRes({ code: 500000, msg: '资产服务异常' })]]);
  await assert.rejects(() => fetchAutoclawWallets(at, { region: 'cn', fetchImpl: f }), /资产服务异常/);

  // 401 = 登录失效，带 auth 标记给上层
  const dead = mockFetch([[AUTOCLAW_PATHS.wallets, () => okRes('', 401)]]);
  await assert.rejects(() => fetchAutoclawWallets(at, { region: 'cn', fetchImpl: dead }), (e) => e.signIn === 'expired' && e.auth === true);
});

// ── 5. 本机收割（临时目录 + 注入 codec，隔离真机） ──

/** 用真 AES-GCM 造一份 v10 密文，验真解密路径（不依赖 DPAPI） */
function makeTempAutoclawDir({ accessToken, refreshToken, deviceId = 'f'.repeat(64), userInfo }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-local-'));
  const key = crypto.randomBytes(32);
  const enc = (text) => {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return 'enc:' + Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()]).toString('base64');
  };
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    deviceId,
    updatedAt: Date.now(),
    token: enc(accessToken),
    refreshToken: enc(refreshToken),
    userInfo,
  }), 'utf8');
  const codec = {
    decrypt: (data) => {
      assert.equal(data.subarray(0, 3).toString(), 'v10');
      const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(3, 15));
      d.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([d.update(data.subarray(15, data.length - 16)), d.final()]).toString('utf8');
    },
    encrypt: () => { throw new Error('收割只读，不应调用 encrypt'); },
  };
  return { dir, codec };
}

const withTempAutoclaw = async (opts, fn) => {
  const { dir, codec } = makeTempAutoclawDir(opts);
  const prev = process.env.AUTOCLAW_DATA_DIR;
  process.env.AUTOCLAW_DATA_DIR = dir;
  _resetAutoclawLocalCache();
  _setCodecForTests(codec);
  try { return await fn(dir); } finally {
    _setCodecForTests(null);
    _setDetectForTests(null);
    _resetAutoclawLocalCache();
    if (prev === undefined) delete process.env.AUTOCLAW_DATA_DIR; else process.env.AUTOCLAW_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const USER_INFO = {
  user_id: 'de9420098da0caf886d022670e32c2e4',
  user_name: '用户3656',
  user_phone: '131****3656',
  id: 935428,
  account_type: 'personal',
  product: 'autoclaw',
  is_guest: false,
};

test('AutoClaw 本机收割：解出 JWT 并按 source_id 归到国内线', async () => {
  await withTempAutoclaw({
    accessToken: mkJwt(CN_CLAIMS),
    refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }),
    userInfo: USER_INFO,
  }, async () => {
    const cred = await decryptAutoclawAuth();
    assert.equal(cred.accessToken, mkJwt(CN_CLAIMS));
    assert.equal(cred.deviceId, 'f'.repeat(64));

    const acc = await liveToAccount();
    assert.equal(acc.provider, 'autoclaw-cn', 'source_id=agent* 必须归国内线');
    assert.equal(acc.uid, '935428');
    assert.equal(acc.name, '用户3656');
    assert.equal(acc.source, 'local-app');
    assert.equal(acc.meta.autoclawRegion, 'cn');
    assert.equal(acc.meta.phone, '131****3656', '手机号按掩码口径走');
    assert.equal(acc.meta.autoclawDeviceId, 'f'.repeat(64));
    assert.ok(acc.refreshToken);
    assert.ok(Date.parse(acc.expiresAt) > Date.now());
  });
});

test('AutoClaw 本机收割：国际号归到国际线', async () => {
  await withTempAutoclaw({
    accessToken: mkJwt(INTL_CLAIMS),
    refreshToken: mkJwt({ ...INTL_CLAIMS, source_id: 'zai_refresh' }),
    userInfo: { ...USER_INFO, id: 42, user_name: 'IntlUser', user_phone: '' },
  }, async () => {
    const acc = await liveToAccount();
    assert.equal(acc.provider, 'autoclaw');
    assert.equal(acc.meta.autoclawRegion, 'intl');
    assert.equal(acc.name, 'IntlUser');
  });
});

test('AutoClaw 本机探测：未登录/解密失败一律回落「无凭据」，不抛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-empty-'));
  const prev = process.env.AUTOCLAW_DATA_DIR;
  process.env.AUTOCLAW_DATA_DIR = dir;
  _resetAutoclawLocalCache();
  try {
    assert.equal(await liveToAccount(), null);
    const det = detectAutoclaw();
    assert.equal(det.exists, false);
    assert.equal(det.signedIn, false);
    assert.equal(currentAutoclawUid(), null);
    assert.equal(autoclawDataDir(), dir);
    assert.equal(authFile(), path.join(dir, 'auth.json'));
  } finally {
    _resetAutoclawLocalCache();
    if (prev === undefined) delete process.env.AUTOCLAW_DATA_DIR; else process.env.AUTOCLAW_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AutoClaw 检测注入钩子：注入后不再读真机目录（qwenwork 事故同款护栏）', () => {
  const sentinel = { provider: 'autoclaw', exists: false, signedIn: false, injected: true };
  _setDetectForTests(() => sentinel);
  try {
    assert.equal(detectAutoclaw().injected, true);
  } finally { _setDetectForTests(null); }
});

// ── 6. 凭据编排：本机优先，CD 只兜底 ──

test('resolveAutoclawAuth：账号库 access 有效时直接用，不读本机不刷新', async () => {
  const at = mkJwt(CN_CLAIMS);
  await withTempAutoclaw({ accessToken: at, refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), userInfo: USER_INFO }, async () => {
    const f = mockFetch([]);
    const r = await resolveAutoclawAuth({ provider: 'autoclaw-cn', token: at, refreshToken: null }, { fetchImpl: f });
    assert.equal(r.from, 'account');
    assert.equal(f.calls.length, 0, '有效期内不该打任何网络');
  });
});

test('resolveAutoclawAuth：账号库过期时对齐本机最新登录（零副作用，不烧 rt）', async () => {
  const freshLocal = mkJwt({ ...CN_CLAIMS, exp: Math.floor(Date.now() / 1000) + 86400 });
  const staleAcct = mkJwt({ ...CN_CLAIMS, exp: Math.floor(Date.now() / 1000) + 60 });   // 已进提前量窗口
  await withTempAutoclaw({ accessToken: freshLocal, refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), userInfo: USER_INFO }, async () => {
    const f = mockFetch([]);
    const saved = [];
    // 真实形态：本机导入的账号一定带 uid 与 meta.autoclawDeviceId（归属校验靠它们）
    const r = await resolveAutoclawAuth(
      {
        provider: 'autoclaw-cn', token: staleAcct, refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }),
        uid: '935428', meta: { autoclawDeviceId: 'f'.repeat(64) },
      },
      { fetchImpl: f, onRefresh: async (c) => saved.push(c) },
    );
    assert.equal(r.from, 'local');
    assert.equal(r.accessToken, freshLocal);
    assert.equal(f.calls.length, 0, '对齐本机不消耗 refresh token');
    assert.equal(saved.length, 1, '要把客户端这一对回写账号库，否则下次只能拿死链去刷');
    assert.equal(saved[0].token, freshLocal);
  });
});

test('resolveAutoclawAuth：客户端换登了别的号时绝不串凭据', async () => {
  // 本机文件里是「另一个号」（deviceId / uid 都不同），账号行是原号
  const otherAt = mkJwt({ ...CN_CLAIMS, user_id: 111111 });
  const otherRt = mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token', user_id: 111111 });
  await withTempAutoclaw({ accessToken: otherAt, refreshToken: otherRt, deviceId: '9'.repeat(64), userInfo: { ...USER_INFO, id: 111111 } }, async () => {
    const myStale = mkJwt({ ...CN_CLAIMS, exp: Math.floor(Date.now() / 1000) + 60 });
    const myRt = mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' });
    const refreshed = mkJwt({ ...CN_CLAIMS, exp: Math.floor(Date.now() / 1000) + 86400 });
    const f = mockFetch([[AUTOCLAW_PATHS.refresh, () => okRes({ code: 0, data: { access_token: refreshed, refresh_token: myRt } })]]);
    const saved = [];
    const r = await resolveAutoclawAuth(
      {
        provider: 'autoclaw-cn', token: myStale, refreshToken: myRt, uid: '935428',
        // 原号的设备号（与自己 token 的 claim 一致），与本机文件的 '9'×64 对不上
        meta: { autoclawDeviceId: 'a'.repeat(64) },
      },
      { fetchImpl: f, onRefresh: async (c) => saved.push(c) },
    );
    assert.equal(r.from, 'refreshed', '不能借用别人的号，只能用自己的 rt 去刷');
    assert.equal(r.accessToken, refreshed);
    // 设备号取「这个账号自己的 token 绑定」（CN_CLAIMS.device_id = 'a'×64），
    // 绝不能是别人那个本机文件的 '9'×64——服务端拿它复核设备
    assert.equal(r.deviceId, 'a'.repeat(64));
    assert.equal(f.calls[0].body.device_id, 'a'.repeat(64));
    assert.equal(f.calls[0].body.refresh_token, myRt, '刷新只能用自己那条 rt');
  });
});

test('autoclawLocalBelongsTo：设备号优先，其次 uid，都对不上就不借用', () => {
  const local = { accessToken: mkJwt(CN_CLAIMS), refreshToken: mkJwt(CN_CLAIMS), deviceId: 'a'.repeat(64) };
  assert.equal(autoclawLocalBelongsTo(local, { uid: '935428', meta: { autoclawDeviceId: 'a'.repeat(64) } }), true);
  assert.equal(autoclawLocalBelongsTo(local, { uid: '935428', meta: {} }), true, '无设备号记录时按 uid');
  assert.equal(autoclawLocalBelongsTo(local, { uid: '999999', meta: {} }), false, 'uid 不同 = 换了号');
  assert.equal(autoclawLocalBelongsTo(local, { uid: '935428', meta: { autoclawDeviceId: 'b'.repeat(64) } }), false, '设备号不同优先判否');
  assert.equal(autoclawLocalBelongsTo(local, { uid: null, meta: {} }), false, '无从比对时宁可不借');
  assert.equal(autoclawLocalBelongsTo(null, { uid: '1' }), false);
});

test('resolveAutoclawAuth：两边都过期 → CD 代刷并回写', async () => {
  const stale = mkJwt({ ...CN_CLAIMS, exp: Math.floor(Date.now() / 1000) + 60 });
  const refreshedAt = mkJwt({ ...CN_CLAIMS, exp: Math.floor(Date.now() / 1000) + 86400 });
  const f = mockFetch([[AUTOCLAW_PATHS.refresh, () => okRes({ code: 0, data: { access_token: refreshedAt, refresh_token: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }) } })]]);
  await withTempAutoclaw({ accessToken: stale, refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), userInfo: USER_INFO }, async () => {
    const saved = [];
    const r = await resolveAutoclawAuth(
      { provider: 'autoclaw-cn', token: stale, refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }) },
      { fetchImpl: f, onRefresh: async (c) => saved.push(c) },
    );
    assert.equal(r.from, 'refreshed');
    assert.equal(r.accessToken, refreshedAt);
    assert.equal(saved.length, 1);
  });
});

test('resolveAutoclawAuth：没有任何凭据时抛 auth 错误（可操作指引）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-none-'));
  const prev = process.env.AUTOCLAW_DATA_DIR;
  process.env.AUTOCLAW_DATA_DIR = dir;
  _resetAutoclawLocalCache();
  try {
    await assert.rejects(
      () => resolveAutoclawAuth({ provider: 'autoclaw-cn', token: '', refreshToken: '' }, {}),
      (e) => e.auth === true && /本机导入/.test(e.message),
    );
  } finally {
    _resetAutoclawLocalCache();
    if (prev === undefined) delete process.env.AUTOCLAW_DATA_DIR; else process.env.AUTOCLAW_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7. checkinAutoclaw 整体：status 与 balanceAfter 落库字段 ──

test('checkinAutoclaw：成功回带 claimedAmount / streakDays / balanceAfter', async () => {
  const at = mkJwt(CN_CLAIMS);
  const f = mockFetch([
    [AUTOCLAW_PATHS.taskComplete, () => okRes({ code: 0, data: { success: true, reward_points: 200, continuous_days: 3 } })],
    [AUTOCLAW_PATHS.wallets, () => okRes(WALLETS)],
  ]);
  await withTempAutoclaw({ accessToken: at, refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), userInfo: USER_INFO }, async () => {
    const out = await checkinAutoclaw({ provider: 'autoclaw-cn', token: at }, { fetchImpl: f });
    assert.equal(out.status, 'checked-in');
    assert.equal(out.claimedAmount, 200);
    // 调度器对 checked-in 会再 +1 显示，所以这里回传 streak-1
    assert.equal(out.streakDays, 2);
    assert.equal(out.balanceAfter, 20150);
  });
});

test('checkinAutoclaw：已签到走 already（当天不再重打）', async () => {
  const at = mkJwt(CN_CLAIMS);
  const f = mockFetch([
    [AUTOCLAW_PATHS.taskComplete, () => okRes({ code: 0, data: { already_completed: true } })],
    [AUTOCLAW_PATHS.wallets, () => okRes(WALLETS)],
  ]);
  await withTempAutoclaw({ accessToken: at, refreshToken: mkJwt({ ...CN_CLAIMS, source_id: 'agentrefresh_token' }), userInfo: USER_INFO }, async () => {
    const out = await checkinAutoclaw({ provider: 'autoclaw-cn', token: at }, { fetchImpl: f });
    assert.equal(out.status, 'already');
    assert.equal(out.claimedAmount, undefined);
  });
});

// ── 8. 注册挂点全套（dumate / croli 两次漏注册事故定的清单） ──

test('AutoClaw 挂点：constants / productOf / PROVIDER_LABEL', () => {
  assert.ok(PROVIDERS.includes('autoclaw'), 'PROVIDERS 缺 autoclaw');
  assert.ok(PROVIDERS.includes('autoclaw-cn'), 'PROVIDERS 缺 autoclaw-cn');
  assert.equal(productOf('autoclaw'), 'autoclaw');
  assert.equal(productOf('autoclaw-cn'), 'autoclaw', '双线必须归一到同一个产品');
  assert.equal(PROVIDER_LABEL.autoclaw, 'AutoClaw 国际版');
  assert.equal(PROVIDER_LABEL['autoclaw-cn'], 'AutoClaw 国内版');
});

test('AutoClaw 挂点：providers.js 表里有 checkin / quota / verify', () => {
  const impl = productImpl('autoclaw');
  assert.ok(impl, 'productImpl(autoclaw) 未注册');
  assert.equal(typeof impl.checkin, 'function');
  assert.equal(typeof impl.quota, 'function');
  assert.equal(typeof impl.verify, 'function');
  // 双线共用一个实现
  assert.equal(productImpl('autoclaw-cn'), impl);
});

test('AutoClaw 挂点：签到业务日按北京时间 0 点翻日（与上游口径一致）', () => {
  // 2026-11-26T17:00:00Z = 北京时间 11-27 01:00 → 业务日应是 11-27
  const t = Date.parse('2026-11-26T17:00:00Z');
  assert.equal(dayKey(t, 'autoclaw'), '2026-11-27');
  assert.equal(dayKey(t, 'autoclaw-cn'), '2026-11-27');
  assert.equal(dayKey(t, 'autoclaw'), dayKey(t, 'workbuddy'), '同为 0 点翻日，能与既有保留窗口对齐');
});

// ⚠ 这条曾断言「映射表里刻意缺席」——2026-11-26 用户拍定口径 (a) 后语义改了：
// 映射表**有**这两行（10R 有同名原生渠道），但同步侧只放行 CD 短信登录的小号；
// 本机收割号仍被硬挡（三副本互杀那条理由不变）。所以断言从「缺席」改成
// 「在场 + 按来源拦截」，安全线的实质没变。
test('AutoClaw 挂点：映射表在场，但本机收割号绝不进同步（三副本互杀安全线）', async () => {
  const { TENROUTER_PROVIDER_MAP, mapProviderId, syncAccountsTo10r } = await import('../src/tenrouterAccounts.js');
  const { canSyncAutoclawAccount } = await import('../src/autoclawClient.js');
  assert.equal(TENROUTER_PROVIDER_MAP.autoclaw, 'autoclaw');
  assert.equal(TENROUTER_PROVIDER_MAP['autoclaw-cn'], 'autoclaw-cn');
  assert.equal(mapProviderId('autoclaw'), 'autoclaw');

  // 判据本身：本机收割（local-app）一律 false；CD 短信登录的号 true
  assert.equal(canSyncAutoclawAccount({ provider: 'autoclaw-cn', source: 'local-app' }), false);
  assert.equal(canSyncAutoclawAccount({ provider: 'autoclaw-cn', meta: {} }), false);
  assert.equal(canSyncAutoclawAccount({ provider: 'autoclaw-cn', source: 'sms-login' }), true);
  assert.equal(canSyncAutoclawAccount({ provider: 'autoclaw-cn', meta: { autoclawCdOwned: true } }), true);
  assert.equal(canSyncAutoclawAccount({ provider: 'qoder', source: 'sms-login' }), false, '别的产品不受本判据影响');

  // 行为断言（本机号）：即使映射在场，也必须被挡下来，且错误里点名原因
  await assert.rejects(
    () => syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:1', key: 'sk-test',
      accounts: [{ id: 'x1', provider: 'autoclaw-cn', token: 'tok', name: '用户3656', source: 'local-app', meta: {} }],
    }),
    /没有可同步的账号.*AutoClaw 本机账号/,
  );
});

test('AutoClaw 小号重推：只认 CD 独占账号，rt 剥空、access 变了才推', async () => {
  const { resyncAutoclawAccess, _resetAutoclawResyncForTests } = await import('../src/tenrouterAccounts.js');
  _resetAutoclawResyncForTests();
  const cfg = { endpoint: 'http://127.0.0.1:1', key: 'sk-test', accountSync: { enabled: true, providers: [] } };

  // 只有本机号 → 无事可推（绝不把它塞进同步集合）
  const localOnly = await resyncAutoclawAccess(cfg, [
    { id: 'h1', provider: 'autoclaw-cn', token: 'tok-local', source: 'local-app', meta: {} },
  ]);
  assert.equal(localOnly.pushed, false);
  assert.equal(localOnly.reason, 'no-cd-owned-account');

  // 总开关关掉 → 直接短路（连判据都不走）
  assert.equal(await resyncAutoclawAccess({ ...cfg, accountSync: { enabled: false, providers: [] } }, []), null);
  // 白名单只勾了别的渠道 → 短路
  assert.equal(await resyncAutoclawAccess({ ...cfg, accountSync: { enabled: true, providers: ['qoder'] } }, []), null);
  _resetAutoclawResyncForTests();
});

test('AutoClaw 挂点：不做换号（store.canSwitch 不该给这条线开）', async () => {
  const { publicAccount } = await import('../src/store.js');
  const pub = publicAccount({
    id: 'x1', provider: 'autoclaw-cn', name: '用户3656', token: 'tok', uid: '935428',
    meta: { autoclawRegion: 'cn' }, createdAt: new Date().toISOString(),
  });
  assert.equal(pub.canSwitch, false, 'AutoClaw 只读收割，面板不该出现切换按钮');
  assert.equal(pub.product, 'autoclaw');
});

test('AutoClaw 挂点：图标三处逐字节一致', () => {
  const root = ROOT;
  const png = fs.readFileSync(path.join(root, 'src/assets/providers/autoclaw.png'));
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  const panel = fs.readFileSync(path.join(root, 'src/panel.html'), 'utf8');
  // 导航内联 img
  const nav = panel.match(/data-view="autoclaw"[^>]*><img src="([^"]+)"/);
  assert.ok(nav, '导航按钮缺 autoclaw');
  assert.equal(nav[1], dataUrl);
  // PROD_ICONS 内联字面量
  const icons = panel.match(/const PROD_ICONS = (\{.*?\});/s);
  const parsed = JSON.parse(icons[1].replace(/,(?=\s*})/g, ''));
  assert.equal(parsed.autoclaw, dataUrl);
  // prodIcons.json
  const json = JSON.parse(fs.readFileSync(path.join(root, 'src/prodIcons.json'), 'utf8'));
  assert.equal(json.autoclaw, dataUrl);
  // 图标是 48×48 透明底 PNG（面板 22px 显示，够用）
  assert.equal(png.readUInt32BE(16), 48);
  assert.equal(png.readUInt32BE(20), 48);
});

test('AutoClaw 挂点：面板 VIEWS / PROV / CHECKIN_PRODUCTS / cnt 计数器齐全', () => {
  const root = ROOT;
  const panel = fs.readFileSync(path.join(root, 'src/panel.html'), 'utf8');
  const views = panel.match(/const VIEWS = \[([^\]]*)\]/);
  assert.ok(views && views[1].includes("'autoclaw'"), 'VIEWS 缺 autoclaw → 点导航没反应且不报错');
  assert.ok(/<span class="cnt" id="cnt-autoclaw">/.test(panel), 'cnt-autoclaw 计数器缺失 → render 直接抛 TypeError');
  assert.ok(/const PRODUCTS = \[[\s\S]*?\{ id: 'autoclaw'/.test(panel), 'PRODUCTS 缺 autoclaw');
  assert.ok(/const COMPONENTS = \[[\s\S]*?\{ id: 'autoclaw'/.test(panel), 'COMPONENTS 缺 autoclaw（设置里关不掉）');
  assert.ok(/autoclaw: \{ prod: 'autoclaw', prodLabel: 'AutoClaw'/.test(panel), 'PROV 缺 autoclaw');
  assert.ok(/'autoclaw-cn': \{ prod: 'autoclaw', prodLabel: 'AutoClaw'/.test(panel), 'PROV 缺 autoclaw-cn（双线徽章少一半）');
  assert.ok(/'autoclaw'\]/.test(panel) || panel.includes("'croli', 'autoclaw']"), 'CHECKIN_PRODUCTS 缺 autoclaw');
  assert.ok(/EMPTY_TIP = \{[\s\S]*?autoclaw:/.test(panel), 'EMPTY_TIP 缺 autoclaw → 空态渲染 undefined');
  assert.ok(/LOCAL_HINT = \{[\s\S]*?autoclaw:/.test(panel), 'LOCAL_HINT 缺 autoclaw');
  // 渠道同步表：口径 (a) 后**要列** autoclaw 双线（10R 有同名原生渠道），但 pushable:false
  //（额度卡由 10R 连接自身出卡，CD 再推纯属重复）。可同步性本身在同步侧按来源拦截，
  // 不靠这张表——这张表只管「渠道卡片长什么样」。
  const amBlock = panel.match(/const AM_CHANNELS = \[[\s\S]*?\n\];/);
  assert.ok(amBlock, 'AM_CHANNELS 未找到');
  assert.ok(/provider: 'autoclaw', label: 'AutoClaw 国际版', syncable: true, pushable: false/.test(amBlock[0]), 'AM_CHANNELS 该列 autoclaw（syncable+pushable:false）');
  assert.ok(/provider: 'autoclaw-cn', label: 'AutoClaw 国内版', syncable: true, pushable: false/.test(amBlock[0]), 'AM_CHANNELS 该列 autoclaw-cn');
  assert.ok(/openAutoclawClient/.test(panel), '面板缺「打开客户端」按钮链路');
  assert.ok(/act-open/.test(panel) && /ac-actions/.test(panel), '产品页头部动作区未挂 autoclaw');
  // 邀请码两个按钮 + 短信直登页签（本轮新增，漏挂 = 有后端没入口，croli/dumate 同款事故）
  assert.ok(/data-act="invite"[^>]*填写好友邀请码/.test(panel), '账号卡缺「填写邀请码」按钮');
  assert.ok(/data-act="my-invite"[^>]*我的邀请码（查看本账号的专属邀请码/.test(panel), '账号卡缺「我的邀请码」按钮');
  assert.ok(/a\.product === 'autoclaw' \? autoclawInvite/.test(panel) && /a\.product === 'autoclaw' \? autoclawMyInvite/.test(panel), 'invite/my-invite 分发缺 autoclaw 分支');
  assert.ok(/data-pane="ac-sms"/.test(panel) && /btn-ac-sms/.test(panel) && /btn-ac-login/.test(panel), '缺 AutoClaw 短信直登页签');
  assert.ok(/'ac-sms': product === 'autoclaw'/.test(panel), 'openAdd 没按产品放开 ac-sms 页签');
});

test('AutoClaw 挂点：daemon 短信直登 + 邀请码路由都在', async () => {
  const daemon = fs.readFileSync(path.join(ROOT, 'src/daemon.js'), 'utf8');
  assert.ok(/\/api\/autoclaw-cn\/sms\/send/.test(daemon), '缺短信发码路由');
  assert.ok(/\/api\/autoclaw-cn\/sms\/login/.test(daemon), '缺短信登录路由');
  // 路由写在源码里是转义过的正则（`\/autoclaw\/invite$`），用 includes 比再套一层正则清楚
  assert.ok(daemon.includes('autoclaw\\/my-invite-code'), '缺「我的邀请码」路由');
  assert.ok(daemon.includes('autoclaw\\/invite'), '缺「填写邀请码」路由');
});

test('AutoClaw 挂点：桌面壳 IPC 与 preload 桥接都在', () => {
  const root = ROOT;
  const main = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'desktop/preload.js'), 'utf8');
  assert.ok(/ipcMain\.handle\('open-autoclaw-client'/.test(main));
  assert.ok(/AutoClaw\.exe/.test(main), 'IPC 里该带安装路径候选');
  assert.ok(/openAutoclawClient: \(\) => ipcRenderer\.invoke\('open-autoclaw-client'\)/.test(preload));
});

test('AutoClaw 挂点：可执行文件名与数据目录约定', () => {
  assert.equal(AUTOCLAW_EXE, 'AutoClaw.exe');
  // 数据目录 env 钩子存在（测试与自定义安装用）
  const prev = process.env.AUTOCLAW_DATA_DIR;
  process.env.AUTOCLAW_DATA_DIR = 'C:\\tmp\\autoclaw-test';
  try { assert.equal(autoclawDataDir(), 'C:\\tmp\\autoclaw-test'); } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_DATA_DIR; else process.env.AUTOCLAW_DATA_DIR = prev;
  }
});

// ── 邀请码（fission-v2）：端点反解自客户端 app.asar，10Router 全无实现 ──

test('邀请码：status 打 cn 账号域，参数带 activity_id + business，头仍要签名那套', async () => {
  const fetchImpl = mockFetch([['/fission-v2/status', okRes({ code: 0, data: { activity: {}, share: {}, bind: {}, stats: {} } })]]);
  await fetchAutoclawInviteStatus('tok', { region: 'cn', deviceId: 'd'.repeat(64), fetchImpl });
  const call = fetchImpl.calls[0];
  assert.ok(call.url.startsWith(AUTOCLAW_CN_HOST), '应打 cn 账号域');
  assert.ok(call.url.includes('activity_id=' + AUTOCLAW_INVITE_ACTIVITY));
  assert.ok(call.url.includes('business=autoclaw'));
  assert.equal(call.method, 'GET');
  assert.equal(call.headers['User-Agent'], 'AutoClaw/2.1.0');
  assert.equal(call.headers.Authorization, 'Bearer tok');
});

test('邀请码：bind 带 activity_id/invite_code/source_id/device_id，空码不打上游，业务失败抛人话', async () => {
  const fetchImpl = mockFetch([['/fission-v2/bind', okRes({ code: 0, data: { success: true } })]]);
  await bindAutoclawInviteCode('tok', '  CN5RTLJH  ', { region: 'cn', deviceId: 'e'.repeat(64), fetchImpl });
  const body = fetchImpl.calls[0].body;
  assert.equal(body.invite_code, 'CN5RTLJH', '两端空白应被裁掉');
  assert.equal(body.activity_id, AUTOCLAW_INVITE_ACTIVITY);
  assert.equal(body.business, 'autoclaw');
  assert.equal(body.source_id, 'autoclaw');
  assert.equal(body.device_id, 'e'.repeat(64));

  await assert.rejects(
    () => bindAutoclawInviteCode('tok', '   ', { region: 'cn', deviceId: 'e'.repeat(64), fetchImpl }),
    /邀请码不能为空/,
  );
  assert.equal(fetchImpl.calls.length, 1, '空码不该打上游');

  const bad = mockFetch([['/fission-v2/bind', okRes({ code: 400000, msg: '登录已失效' })]]);
  await assert.rejects(
    () => bindAutoclawInviteCode('tok', 'ABC', { region: 'cn', deviceId: 'e'.repeat(64), fetchImpl: bad }),
    /登录已失效/,
  );
});

test('邀请码：normalize 摊平真实 status 形状，缺字段一律 null（读不到 ≠ 是 0）', () => {
  const real = {
    activity: {
      activity_id: 'autoclaw_fission', enabled: true, status: 'active',
      starts_at: 1785235200, ends_at: 1797004800,
      bind_inviter_reward_amount: 1000, bind_inviter_reward_limit: 15,
      bind_inviter_reward_valid_days: 30, bind_invitee_reward_amount: 0,
    },
    share: { invite_code: 'CN5RTLJH', can_share: true, expires_at: 1882010209 },
    bind: { status: 'unbound', can_bind: true },
    stats: { invited_count: 0, rewarded_bind_count: 0, bind_reward_limit: 15, remaining_bind_reward_count: 15 },
  };
  const n = normalizeAutoclawInvite(real);
  assert.equal(n.myCode, 'CN5RTLJH');
  assert.equal(n.bindStatus, 'unbound');
  assert.equal(n.canBind, true);
  assert.equal(n.inviterReward, 1000);
  assert.equal(n.rewardLimit, 15);
  assert.equal(n.remainingRewards, 15);
  assert.equal(n.rewardValidDays, 30);
  assert.equal(n.inviteeReward, 0, '上游当前给被邀请方配 0，文案不能照抄 Loomy 的双方各 +5000');
  assert.equal(n.activityEnabled, true);
  assert.equal(n.activityEndsAt, new Date(1797004800 * 1000).toISOString());

  const empty = normalizeAutoclawInvite(null);
  assert.equal(empty.myCode, null);
  assert.equal(empty.inviterReward, null);
  assert.equal(empty.remainingRewards, null);
  assert.equal(empty.activityEnabled, false);

  assert.equal(autoclawSecToIso(0), null);
  assert.equal(autoclawSecToIso('x'), null);
  assert.equal(autoclawSecToIso(null), null);
});

test('邀请码：online-activity-info 只回活动数组，形状不对回空数组', async () => {
  const fetchImpl = mockFetch([['/online-activity-info', okRes({ code: 0, data: { activities: [{ activity_id: 'autoclaw_fission' }] } })]]);
  assert.equal((await fetchAutoclawInviteActivities('tok', { region: 'cn', fetchImpl })).length, 1);
  const bad = mockFetch([['/online-activity-info', okRes({ code: 0, data: {} })]]);
  assert.deepEqual(await fetchAutoclawInviteActivities('tok', { region: 'cn', fetchImpl: bad }), []);
});

// ── 国内版（+86）短信直登：CD 独占的小号 ──

test('短信直登：code 按数字发、登录端点带尾斜杠、手机号去 +86', async () => {
  assert.equal(autoclawSmsCodeValue('123456'), 123456, 'code 必须是数字（字符串上游 400001）');
  assert.equal(autoclawSmsCodeValue(' 123456 '), 123456);
  assert.equal(autoclawSmsCodeValue('12a'), '12a', '非纯数字原样交上游判错，不擅自改');
  assert.equal(autoclawSmsCodeValue('0'), 0);

  assert.equal(cleanAutoclawCnPhone('13112345678'), '13112345678');
  assert.equal(cleanAutoclawCnPhone('+8613112345678'), '13112345678');
  assert.throws(() => cleanAutoclawCnPhone('1311234567'), /手机号格式不正确/);
  assert.throws(() => cleanAutoclawCnPhone('25112345678'), /手机号格式不正确/);
  assert.ok(AUTOCLAW_CN_PHONE_RE.test('13112345678'));

  const fetchImpl = mockFetch([
    ['/agent-send-code', okRes({ code: 0, data: {} })],
    ['/agent-login/', okRes({ code: 0, data: {
      access_token: mkJwt({ ...CN_CLAIMS, user_id: 777 }),
      refresh_token: mkJwt(CN_CLAIMS),
      user_id: 777, user_name: '小号',
    } })],
  ]);
  await sendAutoclawCnSmsCode('+8613112345678', { deviceId: 'f'.repeat(64), fetchImpl });
  assert.ok(fetchImpl.calls[0].url.endsWith('/userapi/v1/agent-send-code'));
  assert.equal(fetchImpl.calls[0].body.phone, '13112345678', '必须去掉 +86');

  const r = await loginAutoclawCnBySms({ phone: '13112345678', code: '123456' }, { deviceId: 'f'.repeat(64), fetchImpl });
  const loginCall = fetchImpl.calls[1];
  assert.ok(loginCall.url.endsWith('/userapi/v1/agent-login/'), '尾斜杠是端点形状的一部分');
  assert.strictEqual(loginCall.body.code, 123456, 'code 必须是 JSON 数字');
  assert.equal(loginCall.body.device_id, 'f'.repeat(64));
  assert.equal(r.userId, '777');
  assert.equal(r.phone, '13112345678');
});

test('短信直登：device_id 按机器码 + 固定命名空间派生，同机稳定、异种子相异', () => {
  _setMachineGuidForTests('11111111-2222-3333-4444-555555555555');
  try {
    const a = autoclawCdSmsDeviceId();
    assert.equal(autoclawCdSmsDeviceId(), a, '发码与登录必须同一条 → 同机同命名空间要稳定');
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(autoclawCdDeviceId('acct-1'), autoclawCdDeviceId('acct-2'));
    _setMachineGuidForTests('99999999-8888-7777-6666-555555555555');
    assert.notEqual(autoclawCdSmsDeviceId(), a, '派生确实吃机器码（落库值才是权威）');
  } finally { _setMachineGuidForTests(null); }
});

// ⚠ 安全线：本机收割号若被当成 CD 登录号合并改写，source 会变 sms-login → 它就"可同步"了，
// 而桌面客户端正登录着同一个号 —— 三副本互杀会被我们自己的判据放行。
test('短信直登：同一号已有本机收割账号时拒绝合并，原行一字不动', async () => {
  const { saveAccounts, loadAccounts } = await import('../src/store.js');
  await saveAccounts([{
    id: 'harvested-1', provider: 'autoclaw-cn', token: 'old', uid: '888888', name: '用户8888',
    refreshToken: 'old-rt', source: 'local-app', meta: { autoclawRegion: 'cn' },
    createdAt: new Date().toISOString(),
  }]);
  const fetchImpl = mockFetch([['/agent-login/', okRes({ code: 0, data: {
    access_token: mkJwt({ ...CN_CLAIMS, user_id: 888888 }),
    refresh_token: mkJwt(CN_CLAIMS),
    user_id: 888888,
  } })]]);
  await assert.rejects(
    () => loginAutoclawSms({ phone: '13112345678', code: '123456' }, { fetchImpl }),
    /这个号已经由本机 AutoClaw 客户端管理/,
  );
  const after = (await loadAccounts()).find((a) => a.uid === '888888');
  assert.equal(after.source, 'local-app', '被拒后 source 不能被改写');
  assert.equal(after.token, 'old', '被拒后凭据不能被覆盖');
});

test('短信直登：新号落库 sms-login + autoclawCdOwned，device_id 记的是登录实际用的那条', async () => {
  const { saveAccounts, loadAccounts } = await import('../src/store.js');
  const { canSyncAutoclawAccount } = await import('../src/autoclawClient.js');
  await saveAccounts([]);
  const fetchImpl = mockFetch([['/agent-login/', okRes({ code: 0, data: {
    access_token: mkJwt({ ...CN_CLAIMS, user_id: 999001 }),
    refresh_token: mkJwt(CN_CLAIMS),
    user_id: 999001, user_name: 'CD 小号',
  } })]]);
  const r = await loginAutoclawSms({ phone: '13900001111', code: '654321' }, { fetchImpl });
  assert.equal(r.duplicate, false);
  assert.match(r.deviceId, /^[0-9a-f]{64}$/);
  const row = (await loadAccounts()).find((a) => a.uid === '999001');
  assert.equal(row.source, 'sms-login');
  assert.equal(row.meta.autoclawCdOwned, true);
  assert.equal(row.meta.autoclawDeviceId, r.deviceId, '落库 device_id 必须与 JWT 里那条一致');
  assert.equal(row.meta.autoclawRegion, 'cn');
  assert.ok(row.refreshToken, 'rt 留在 CD（同步侧剥空，10R 只拿 access）');
  assert.equal(isAutoclawCdOwned(row), true);
  assert.equal(canSyncAutoclawAccount(row), true);

  // 同号再登录：沿用落库那条，不让上游看到「换设备」
  const again = await loginAutoclawSms({ phone: '13900001111', code: '654321' }, { fetchImpl });
  assert.equal(again.deviceId, r.deviceId);
});

test('accountDeviceId：只认 64 hex，脏值回 null 不猜', () => {
  assert.equal(accountDeviceId({ meta: { autoclawDeviceId: 'a'.repeat(64) } }), 'a'.repeat(64));
  assert.equal(accountDeviceId({ meta: { autoclawDeviceId: 'short' } }), null);
  assert.equal(accountDeviceId({ meta: {} }), null);
  assert.equal(accountDeviceId(null), null);
});

test('换号仍然不做：switchTo 固定报错（只读收割，绝不写回客户端）', async () => {
  const { switchTo } = await import('../src/autoclawLocal.js');
  await assert.rejects(() => switchTo(), /不支持从 CreditDaddy 换号/);
});