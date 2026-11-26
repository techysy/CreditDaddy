import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mirasim-test-'));
process.env.MIRASIM_HOME = MHOME;
process.env.MIRASIM_DESKTOP_DATA_DIR = MHOME;
// 在 Mirasim 里跑测试时客户端会注入真实 master key，隔离掉
delete process.env.MIRASIM_SECRET_KEY;
delete process.env.MIRASIM_APP_SECRET_KEY;

const ml = await import('../src/mirasimLocal.js');
const mc = await import('../src/mirasimClient.js');

test('mirasim 加密与解密互逆', () => {
  const key = crypto.randomBytes(32);
  const plain = 'jwt-token-sample-1234567890';
  const enc = ml.encryptWithKey(plain, key);
  assert.ok(enc.startsWith('mrs1:'), '密文应带 mrs1: 前缀');
  const dec = ml.decryptWithKey(enc, key);
  assert.equal(dec, plain);
});

// 现行「额度」口径（2026-11-25 对照 mirasim 设置 › 额度页实测）：
// 主数据源是 relay /v1/credits/activity 的 balance.lots（按笔有效期、先用最早到期的），
// 接口单位是「分」，UI ÷100；/v1/limits 的 5h/7d 平台额度窗口已不是现行发放方式。
const REAL_ACTIVITY = {
  period: { resetAt: null },
  balance: {
    remaining: 765.1752675,
    lots: [
      { id: '18931', credits: 500, remaining: 0, grantedAt: 1795450253066, expiresAt: 1803226253083, kind: 'payout', reward: { campaign: 'invite', kind: 'tier' } },
      { id: '19319', credits: 1000, remaining: 764.1752675, grantedAt: 1795532586814, expiresAt: 1803308586833, kind: 'payout', reward: { campaign: 'invite', kind: 'tier' } },
      { id: '4545', credits: 1, remaining: 1, grantedAt: 1792742443032, expiresAt: 1808495999000, kind: 'carry' },
    ],
  },
  items: [],
};
// 真机同批抓到的老接口响应：只剩一个 30d 池，reset_at 是 2126 年的占位值
const REAL_LIMITS = {
  subject: 'usr_test123', suspended: false, unmetered: false, degraded: false, paid: true,
  windows: [{ name: '30d', used: 735.8247325, budget: 1501, reset_at: 4948563644 }],
};
const REAL_PROFILE = { id: 'usr_test123', name: '测试用户', email: 't@example.com', plan: 'go', plan_exp: 1808495999 };

test('normalizeMirasimQuota：个人额度按笔 + 分→额度换算（与 mirasim 额度页逐位一致）', () => {
  const q = mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY, limits: REAL_LIMITS, profile: REAL_PROFILE });
  assert.equal(q.unit, '额度');
  assert.equal(q.plan, 'GO');
  assert.equal(q.planExpiresAt, new Date(1808495999 * 1000).toISOString());
  // 主数 7.65；总额取「还没用完的笔」之和（额度明细同口径，不是含已花完笔的 15.01）
  assert.equal(q.remaining, 7.65);
  assert.equal(q.total, 10.01);
  assert.equal(q.used, 2.36);
  assert.equal(q.remainingPercentage, 76.4);
  assert.equal(q.partial, false);
  assert.equal(q.empty, false);
  assert.equal(q.exceeded, false);
  assert.equal(q.bottleneck, null);
  // 逐笔：已花完的 5.00 笔仍在 lots 里（面板按「明细只列未用完」过滤），按到期先后排
  assert.equal(q.lots.length, 3);
  assert.deepEqual(q.lots.map((l) => l.name), ['邀请奖励', '邀请奖励', '原有余额']);
  assert.deepEqual(q.lots.map((l) => l.remaining), [0, 7.64, 0.01]);
  assert.deepEqual(q.lots.map((l) => l.total), [5, 10, 0.01]);
  assert.equal(q.lots[1].expiresAt, new Date(1803308586833).toISOString());
  // 最早一笔到期 = 第一笔还没用完的（2027-02-22），不是套餐到期
  assert.equal(q.earliestExpiresAt, new Date(1803308586833).toISOString());
});

test('normalizeMirasimQuota：30d 池窗口的占位 reset_at 不再算成「N 天后重置」', () => {
  const q = mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY, limits: REAL_LIMITS, profile: REAL_PROFILE });
  assert.equal(q.windows.length, 1);
  assert.equal(q.windows[0].name, '30d');
  assert.equal(q.windows[0].resetAt, null, '非 5h/7d 的窗口不给周期重置时间');
  assert.equal(q.windows[0].expiresAt, null);
  // 真窗口（5h/7d）仍保留重置时间
  const w = mc.normalizeMirasimWindows({ windows: [{ name: '5h', used: 10, budget: 100, reset_at: 1790500000 }, { name: '7d_claude', used: 1, budget: 10, reset_at: 1790600000 }] });
  assert.equal(w[0].name, '5小时窗口');
  assert.equal(w[0].resetAt, new Date(1790500000 * 1000).toISOString());
  assert.equal(w[1].name, '7天 Claude 上限');
});

test('normalizeMirasimQuota：空间额度按成员分配（me.remaining 为 null 表示不限，退空间余额）', () => {
  const capped = mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY, spaceCredit: { balance: 500000, me: { remaining: 123400, payer: 'space' } } });
  assert.equal(capped.space.remaining, 1234);
  assert.equal(capped.space.payer, 'space');
  const uncapped = mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY, spaceCredit: { balance: 300000, me: { remaining: null } } });
  assert.equal(uncapped.space.remaining, 3000);
  const none = mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY });
  assert.equal(none.space, null);
});

test('normalizeMirasimQuota：个人额度接口不可用时按老 30d 池降级，多窗口时不编余额', () => {
  const degraded = mc.normalizeMirasimQuota({ limits: REAL_LIMITS, profile: REAL_PROFILE });
  assert.equal(degraded.partial, true);
  assert.equal(degraded.empty, false);
  assert.equal(degraded.remaining, 7.65, '单池窗口 budget-used 与 balance.remaining 同源');
  assert.equal(degraded.total, 15.01);
  // 多个并行窗口（老 5h/7d 发放方式）没有「余额」可言
  const multi = mc.normalizeMirasimQuota({ limits: { windows: [{ name: '5h', used: 10, budget: 100, reset_at: 1 }, { name: '7d', used: 50, budget: 100, reset_at: 2 }] } });
  assert.equal(multi.partial, true);
  assert.equal(multi.remaining, 0);
  assert.equal(multi.windows.length, 2);
  const nothing = mc.normalizeMirasimQuota({});
  assert.equal(nothing.empty, true);
});

test('normalizeMirasimQuota：额度用尽与 suspended 熔断', () => {
  const spent = { balance: { remaining: 0, lots: [{ id: '1', credits: 100, remaining: 0, grantedAt: 1, expiresAt: 1803226253083, kind: 'token_pack' }] }, items: [] };
  const q = mc.normalizeMirasimQuota({ activity: spent, profile: { plan: 'go' } });
  assert.equal(q.remaining, 0);
  assert.equal(q.exceeded, true);
  assert.deepEqual(q.bottleneck, { name: '个人额度' });
  assert.equal(q.earliestExpiresAt, null, '没有可用笔时不给「最早一笔」');
  // 个人额度见底但空间额度还有：不算用尽
  const q2 = mc.normalizeMirasimQuota({ activity: spent, spaceCredit: { balance: 100000, me: { remaining: 100000 } } });
  assert.equal(q2.exceeded, false);
  // suspended 一律熔断
  assert.equal(mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY, limits: { suspended: true, windows: [] } }).exceeded, true);
  // 末笔扣穿后服务端余额为负（真机 2026-11-26：balance.remaining = -2.27 分、各笔 remaining 归零）：
  // 显示口径钳到 0，绝不把 -0.02 端上面板
  const over = { balance: { remaining: -2.2665525, lots: [
    { id: '1', credits: 1000, remaining: 0, grantedAt: 1, expiresAt: 1803308586833, kind: 'payout', reward: { campaign: 'invite' } },
  ] }, items: [] };
  const q3 = mc.normalizeMirasimQuota({ activity: over, limits: { windows: [{ name: '30d', used: 1503.27, budget: 1501, reset_at: 4948563644 }] } });
  assert.equal(q3.remaining, 0, '负余额钳到 0');
  assert.equal(q3.exceeded, true);
  assert.ok(q3.lots.length === 1 && q3.lots[0].remaining === 0, '笔仍逐条给出（remaining 0），面板据此不退回老窗口行');
});


test('mirasim switchTo：保留其他配置，原子替换 auth', async () => {
  const p = ml.mirasimPaths();
  fs.mkdirSync(path.dirname(p.setting), { recursive: true });
  fs.writeFileSync(p.setting, JSON.stringify({
    version: 1,
    workspaces: ['/repo/a', '/repo/b'],
    models: { default: 'claude' },
    auth: { userId: 'usr_old', name: '旧用户', token: 'old-token' },
  }, null, 2));

  const targetAccount = {
    id: 'acc_new',
    provider: 'mirasim',
    uid: 'usr_new',
    name: '新用户',
    token: 'new-token-123',
    refreshToken: 'new-rt-456',
    expiresAt: '2026-10-01T00:00:00.000Z',
  };

  const r = await ml.switchTo(targetAccount, { force: true });
  assert.equal(r.switched, true);
  assert.equal(r.alreadyActive, false);

  const updated = JSON.parse(fs.readFileSync(p.setting, 'utf8'));
  assert.equal(updated.version, 1);
  assert.deepEqual(updated.workspaces, ['/repo/a', '/repo/b'], '工作区配置不能丢');
  assert.equal(updated.models.default, 'claude');
  assert.equal(updated.auth.userId, 'usr_new');
  assert.equal(updated.auth.name, '新用户');

  // 再次切同一账号判定为 alreadyActive
  const r2 = await ml.switchTo(targetAccount, { force: true });
  assert.equal(r2.switched, false);
  assert.equal(r2.alreadyActive, true);
});

test('writeMirasimAuth：刷新后凭据回写 setting.json，其余字段保留', async () => {
  const p = ml.mirasimPaths();
  fs.mkdirSync(path.dirname(p.setting), { recursive: true });
  fs.writeFileSync(p.setting, JSON.stringify({
    version: 1,
    workspaces: ['/repo/x'],
    auth: { userId: 'usr_sync', name: '同步测试', token: 'old-token', refreshToken: 'old-rt', exp: 1000 },
  }, null, 2));

  const synced = await ml.writeMirasimAuth({
    uid: 'usr_sync',
    token: 'new-token',
    refreshToken: 'new-rt',
    expiresAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(synced, true);
  const s = JSON.parse(fs.readFileSync(p.setting, 'utf8'));
  assert.equal(s.auth.token, 'new-token');
  assert.equal(s.auth.refreshToken, 'new-rt');
  assert.equal(s.auth.exp, Math.floor(new Date('2026-10-01T00:00:00.000Z').getTime() / 1000));
  assert.deepEqual(s.workspaces, ['/repo/x'], '其余字段不能丢');

  // uid 不匹配（不是客户端当前登录）时不写回
  const skipped = await ml.writeMirasimAuth({ uid: 'usr_other', token: 'x', refreshToken: 'y', expiresAt: null });
  assert.equal(skipped, false);
});

test('fetchMirasimQuota：401 后自动刷新并重试，经 ctx.onRefresh 回写凭据', async () => {
  const realFetch = globalThis.fetch;
  const zcNet = await import('../src/zcodeClient.js');
  let calls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const auth = String(opts.headers?.Authorization || '');
    calls++;
    if (String(url).includes('/auth/refresh')) {
      return new Response(JSON.stringify({ access_token: 'fresh-token', refresh_token: 'fresh-rt' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (auth.endsWith('stale-token')) return new Response('unauthorized', { status: 401 });
    const body = String(url).includes('/v1/credits/activity')
      ? REAL_ACTIVITY
      : String(url).includes('/v1/limits')
        ? { subject: 'usr_x', windows: [{ name: '30d', used: 1000, budget: 2000, reset_at: 4948563644 }] }
        : String(url).includes('/auth/me')
          ? REAL_PROFILE
          : null;   // 空间额度等其它路径一律 404：本机没连空间
    if (!body) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    zcNet._setViaProxyForTests(() => { throw new Error('no proxy in test'); });
    const account = { token: 'stale-token', refreshToken: 'rt-1' };
    const refreshed = [];
    const quota = await mc.fetchMirasimQuota(account, { onRefresh: async (c) => refreshed.push(c) });
    assert.equal(quota.remaining, 7.65, '现行口径主数取个人额度余额');
    assert.equal(quota.partial, false);
    assert.equal(account.token, 'fresh-token', '内存中的 token 应已换新');
    assert.equal(account.refreshToken, 'fresh-rt', '轮换后的 refreshToken 应已保存');
    assert.equal(refreshed.length, 1, 'onRefresh 应收到新凭据');
  } finally {
    globalThis.fetch = realFetch;
    zcNet._setViaProxyForTests(null);
  }
});

test('fetchMirasimQuota：现行 credits/activity 读不到时不报错，按老窗口降级并标 partial', async () => {
  const realFetch = globalThis.fetch;
  const zcNet = await import('../src/zcodeClient.js');
  globalThis.fetch = async (url) => {
    if (String(url).includes('/v1/credits/activity')) return new Response('rate limited', { status: 429 });
    if (String(url).includes('/auth/me')) return new Response(JSON.stringify(REAL_PROFILE), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('/v1/limits')) return new Response(JSON.stringify(REAL_LIMITS), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  try {
    zcNet._setViaProxyForTests(() => { throw new Error('no proxy in test'); });
    const quota = await mc.fetchMirasimQuota({ token: 'tk' });
    assert.equal(quota.partial, true);
    assert.equal(quota.remaining, 7.65, '老 30d 池 budget-used 与余额同源，可当降级余量');
    assert.equal(quota.lots.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    zcNet._setViaProxyForTests(null);
  }
});

test('currentSpaceNodeId：从客户端 setting.json 的 cloudAttachState 读空间 nodeId', () => {
  const p = ml.mirasimPaths();
  fs.mkdirSync(path.dirname(p.setting), { recursive: true });
  fs.writeFileSync(p.setting, JSON.stringify({ auth: { userId: 'usr_a' }, cloudAttachState: { nodeId: 'pc-abc' } }, null, 2));
  assert.equal(ml.currentSpaceNodeId(), 'pc-abc');
  fs.writeFileSync(p.setting, JSON.stringify({ auth: { userId: 'usr_a' } }, null, 2));
  assert.equal(ml.currentSpaceNodeId(), null, '未连接云端时返回 null');
});

test('agentCreditSources：读本机 collab/person-agent-routes.json 的各智能体额度来源', () => {
  const p = ml.mirasimPaths();
  fs.mkdirSync(path.dirname(p.personAgentRoutes), { recursive: true });
  // 真机结构（宿主 collab/person-agent-routes.ts）：routes[uid][agent] = 'local' | 'cloud'
  fs.writeFileSync(p.personAgentRoutes, JSON.stringify({
    version: 2,
    routes: {
      usr_me: { antigravity: 'local', claude: 'local', pi: 'local', qwen: 'local', zcode: 'local' },
      usr_other: { claude: 'cloud' },
    },
    pinned: {},
  }));
  const mine = ml.agentCreditSources('usr_me');
  assert.equal(mine.length, 5, '应列出 5 个单独设了来源的智能体');
  assert.deepEqual(mine.map((x) => x.id), ['antigravity', 'claude', 'pi', 'qwen', 'zcode'], '按 id 排序稳定');
  assert.equal(mine.find((x) => x.id === 'claude').label, 'Claude Code', 'id 映射 mirasim 界面显示名');
  assert.equal(mine[0].source, 'local');
  // 别人的条目不算在自己头上
  assert.equal(ml.agentCreditSources('usr_other').length, 1);
  // 未知 id 保留原样（mirasim 后续新增智能体不至于显示成空）
  fs.writeFileSync(p.personAgentRoutes, JSON.stringify({ version: 2, routes: { usr_me: { newagent: 'cloud' } } }));
  assert.deepEqual(ml.agentCreditSources('usr_me'), [{ id: 'newagent', label: 'newagent', source: 'cloud' }]);
  assert.deepEqual(ml.agentCreditSources('usr_none'), [], '该 uid 没有条目 = 全部跟随全局默认');
  assert.deepEqual(ml.agentCreditSources(null), [], '无 uid 直接空');
  fs.writeFileSync(p.personAgentRoutes, JSON.stringify({ version: 2, routes: { usr_me: { claude: 'bogus', codex: 'local' } } }));
  assert.deepEqual(ml.agentCreditSources('usr_me'), [{ id: 'codex', label: 'Codex', source: 'local' }], '非法取值按宿主校验口径丢弃');
  fs.rmSync(p.personAgentRoutes);
  assert.deepEqual(ml.agentCreditSources('usr_me'), [], '文件缺失不抛');
});

test('normalizeMirasimQuota：透传 agentSources 供面板提示', () => {
  const q = mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY, limits: REAL_LIMITS, profile: REAL_PROFILE, agentSources: [{ id: 'claude', label: 'Claude Code', source: 'local' }] });
  assert.equal(q.agentSources.length, 1);
  assert.equal(q.agentSources[0].label, 'Claude Code');
  const q2 = mc.normalizeMirasimQuota({ activity: REAL_ACTIVITY });
  assert.deepEqual(q2.agentSources, [], '缺省为空数组，面板据此不渲染提示行');
});

test('新版桌面端 secret-key.enc（safeStorage v10）：无 secret.key 也能解出 master key', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mirasim-v10-'));
  const prev = { h: process.env.MIRASIM_HOME, d: process.env.MIRASIM_DESKTOP_DATA_DIR };
  process.env.MIRASIM_HOME = home;
  process.env.MIRASIM_DESKTOP_DATA_DIR = home;
  try {
    // 构造 Chromium os_crypt：Local State 里存 "DPAPI" + DPAPI(aesKey)
    const aesKey = crypto.randomBytes(32);
    const script = 'Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());'
      + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
    const protectedKey = Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: aesKey.toString('base64'), encoding: 'utf8', windowsHide: true }).trim(), 'base64');
    fs.writeFileSync(path.join(home, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), protectedKey]).toString('base64') } }));
    // secret-key.enc = "v10" + nonce + AES-GCM(64 字符 hex master key) + tag
    const master = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
    const ct = Buffer.concat([c.update(master.toString('hex'), 'utf8'), c.final()]);
    fs.writeFileSync(path.join(home, 'secret-key.enc'), Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()]));
    fs.writeFileSync(path.join(home, 'setting.json'), JSON.stringify({ auth: { userId: 'usr_v10', token: ml.encryptWithKey('a.b.c', master), refreshToken: ml.encryptWithKey('rt', master) } }));

    const ml2 = await import('../src/mirasimLocal.js?v10');
    const acc = await ml2.liveToAccount();
    assert.equal(acc.token, 'a.b.c');
    assert.equal(acc.refreshToken, 'rt');
    assert.ok(!fs.existsSync(path.join(home, 'secret.key')), '不应往 mirasim 目录写旧版 secret.key');
  } finally {
    process.env.MIRASIM_HOME = prev.h;
    process.env.MIRASIM_DESKTOP_DATA_DIR = prev.d;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
