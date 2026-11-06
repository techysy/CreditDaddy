import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOMY_AUTH_CONFIG } from '../src/loomyAuth.js';
import { detectLoomy, readCredential } from '../src/loomyLocal.js';
import { productImpl } from '../src/providers.js';
import { TENROUTER_PROVIDER_MAP } from '../src/tenrouterAccounts.js';

test('Loomy 供应商产品线与同步配置', () => {
  assert.equal(typeof productImpl('loomy'), 'object');
  assert.equal(TENROUTER_PROVIDER_MAP.loomy, 'loomy');
});

test('Loomy 统一认证配置常量存在', () => {
  assert.equal(LOOMY_AUTH_CONFIG.baseUrl, 'https://account.xfinfr.com');
  assert.equal(LOOMY_AUTH_CONFIG.appId, 'GM3LOOMY');
  assert.ok(LOOMY_AUTH_CONFIG.accessKeyId);
  assert.ok(LOOMY_AUTH_CONFIG.accessKeySecret);
});

test('Loomy 本机探测（Windows 本地环境）', () => {
  const d = detectLoomy();
  assert.equal(typeof d.clientInstalled, 'boolean');
  assert.equal(typeof d.running, 'boolean');
  assert.equal(typeof d.signedIn, 'boolean');
});

test('Loomy 注册接口与身份校验已接入（新手机号一条龙）', async () => {
  const auth = await import('../src/loomyAuth.js');
  assert.equal(typeof auth.registerLoomyByPhone, 'function');
  assert.equal(typeof auth.fetchLoomyIdentity, 'function');
  // 参数校验先行：不合法手机号在出网前就拒绝
  await assert.rejects(() => auth.registerLoomyByPhone({ phone: '12345', code: '123456' }), /手机号格式/);
  await assert.rejects(() => auth.registerLoomyByPhone({ phone: '13100000000', code: '' }), /验证码/);
});

test('Loomy 积分口径：normalizePointsBalance 映射永久/每日赠送（records V1 真实字段）', async () => {
  const { normalizePointsBalance } = await import('../src/loomyClient.js');
  // 客户端 records 响应 data.data 实际字段：balance / dailyBalance / dailyLimitPoints / dailyConsumedPoints
  const q = normalizePointsBalance({ data: { balance: 10500, dailyBalance: 3506, dailyLimitPoints: 5000, dailyConsumedPoints: 1494, list: [], total: 0 } });
  assert.equal(q.unit, '积分');
  assert.equal(q.remaining, 14006);
  // 总额是容量口径（永久 + 每日上限），进度条才有 used 段；remaining 是余额口径
  assert.equal(q.total, 15500);
  assert.equal(q.used, 1494);
  const names = q.parts.map((p) => p.name);
  assert.ok(names.includes('永久积分'));
  assert.ok(names.includes('每日赠送积分'));
  const daily = q.parts.find((p) => p.name === '每日赠送积分');
  assert.equal(daily.remaining, 3506);
  assert.equal(daily.used, 1494);
  assert.equal(daily.recurring, true);
  // 旧字段别名仍兼容
  const legacy = normalizePointsBalance({ data: { permanentPoints: 100, dailyPoints: 40, dailyLimit: 500 } });
  assert.equal(legacy.remaining, 140);
  // 空数据 → empty 口径（绝不再拿模型数量冒充积分）
  const empty = normalizePointsBalance({ data: {} });
  assert.equal(empty.empty, true);
});

test('#42：dailyConsumedPoints=0 如实直读——不再倒推出幻影「已用」', async () => {
  const { normalizePointsBalance } = await import('../src/loomyClient.js');
  const q = normalizePointsBalance({ data: { balance: 100, dailyBalance: 3000, dailyConsumedPoints: 0, dailyLimitPoints: 5000 } });
  const daily = q.parts.find((p) => p.name === '每日赠送积分');
  assert.equal(daily.used, 0, '服务端如实上报 0 消耗，不得回退成 5000-3000=2000');
  assert.equal(daily.remaining, 3000);
  assert.equal(q.used, 0, '顶层已用同口径');
  assert.equal(q.remaining, 3100);
  // 缺字段时仍按 dailyLimit - daily 倒推（旧路径不变）
  const q2 = normalizePointsBalance({ data: { balance: 10500, dailyBalance: 3506, dailyLimitPoints: 5000 } });
  assert.equal(q2.parts.find((p) => p.name === '每日赠送积分').used, 1494);
});

test('Loomy 积分查询：records 直接成功时只打一次接口', async () => {
  const { fetchLoomyPoints } = await import('../src/loomyClient.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    if (String(url).includes('/api/v1/points/records')) {
      return new Response(JSON.stringify({ code: '000000', desc: '成功', data: { balance: 10500, dailyBalance: 3506, dailyLimitPoints: 5000, dailyConsumedPoints: 1494, list: [], total: 0 } }));
    }
    throw new Error('unexpected url ' + url);
  };
  try {
    const q = await fetchLoomyPoints({ token: 'sess-x', meta: {} });
    assert.equal(q.remaining, 14006);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/api/v1/points/records?pageNo=1&pageSize=1&recordType=all'));
    assert.equal(calls[0].method, 'GET');
  } finally { globalThis.fetch = realFetch; }
});

test('Loomy 积分查询：100002 时按客户端协议补 first-login 后重试', async () => {
  const { fetchLoomyPoints } = await import('../src/loomyClient.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  let recordsCount = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    if (u.includes('/api/v1/points/records')) {
      recordsCount++;
      if (recordsCount === 1) return new Response(JSON.stringify({ code: '100002', desc: '未登录或登录已失效' }));
      return new Response(JSON.stringify({ code: '000000', desc: '成功', data: { balance: 800, dailyBalance: 0, dailyLimitPoints: 5000, list: [], total: 0 } }));
    }
    if (u.includes('/api/v1/points/first-login')) {
      assert.equal(opts.method, 'POST');
      return new Response(JSON.stringify({ code: '000000', desc: '成功', data: {} }));
    }
    throw new Error('unexpected url ' + u);
  };
  try {
    const q = await fetchLoomyPoints({ token: 'sess-x', meta: {} });
    assert.equal(q.parts.find((p) => p.name === '永久积分').remaining, 800);
    assert.equal(q.parts.find((p) => p.name === '每日赠送积分').remaining, 0);
    assert.ok(calls.some((c) => c.url.includes('/api/v1/points/first-login')), '应补调 first-login 初始化');
  } finally { globalThis.fetch = realFetch; }
});

test('ZCode 不再依赖硬编码活动 ID——兜底清单必须为空', async () => {
  // 2026-11-04 定论：活动 ID 会换代（1102 → gb-1104），硬编码必然过期，
  // 正确来源是 marketing/touch 的 deliveries（见 fetchMarketingClaimPlans）。
  // 这条用例防止有人再把 planId 写回清单里。
  const { ZCODE_KNOWN_CLAIM_PLANS } = await import('../src/zcodeClient.js');
  assert.ok(Array.isArray(ZCODE_KNOWN_CLAIM_PLANS), '必须是数组');
  assert.equal(ZCODE_KNOWN_CLAIM_PLANS.length, 0, '不得再硬编码任何活动 ID');
});

test('marketing/touch 投放解析：递归收集 claim_zcode_plan 的 plan_id 与权益', async () => {
  // 直接测解析器（网络层用 node:http，globalThis.fetch 的 mock 覆盖不到，故不做端到端 mock）
  const { collectClaimActions, collectPlanMeta } = await import('../src/zcodeClient.js');
  const delivery = {
    campaign_id: 'c1', resource_position: 'banner',
    banner: {
      buttons: [
        { action: { type: 'close' } },
        { action: { type: 'claim_zcode_plan', args: { plan_id: 'zcode-v3-start-plan-gb-1104' } } },
      ],
      background: { args: { zcode_plan: {
        plan_id: 'zcode-v3-start-plan-gb-1104', name: 'ZCODE GLOBAL BUILD', priority: 111,
        entitlements: [{ show_name: 'GLM-5.3-Flash', grant_units: 300000000, period: 'one_time' }],
      } } },
    },
    success_popup: {
      hero: { args: { zcode_plan: { plan_id: 'zcode-v3-start-plan-gb-1104', name: 'ZCODE GLOBAL BUILD' } } },
    },
  };
  const ids = new Set();
  const metas = new Map();
  collectClaimActions(delivery, ids);
  collectPlanMeta(delivery, metas);
  assert.deepEqual([...ids], ['zcode-v3-start-plan-gb-1104'], '应递归找到 claim_zcode_plan 的 plan_id');
  const meta = metas.get('zcode-v3-start-plan-gb-1104');
  assert.ok(meta, '应收集到 zcode_plan 元数据');
  assert.equal(meta.name, 'ZCODE GLOBAL BUILD');
  assert.ok(meta.grants.join('').includes('GLM-5.3-Flash'), '应带出权益名称');
  assert.ok(meta.grants.join('').includes('亿'), '应把 3 亿 token 格式化');
});

test('Loomy 邀请码：激活状态映射 + 绑定参数校验与成功路径', async () => {
  const { fetchLoomyActivation, bindLoomyInviteCode } = await import('../src/loomyClient.js');
  await assert.rejects(() => bindLoomyInviteCode({ token: 'x', meta: {} }, '   '), /缺少邀请码/);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, m: opts.method || 'GET', b: opts.body });
    if (u.includes('/api/v1/points/activation')) {
      if ((opts.method || 'GET') === 'GET') return new Response(JSON.stringify({ code: '000000', desc: '成功', data: { activated: false } }));
      return new Response(JSON.stringify({ code: '000000', desc: '成功', data: {} }));
    }
    throw new Error('unexpected ' + u);
  };
  try {
    const st = await fetchLoomyActivation({ token: 's', meta: {} });
    assert.deepEqual(st, { activated: false, appliedInvitationCode: null });
    const r = await bindLoomyInviteCode({ token: 's', meta: {} }, '  8yzch5 ');
    assert.equal(r.bound, true);
    const posted = calls.find((c) => c.m === 'POST');
    assert.equal(JSON.parse(posted.b).inviteCode, '8yzch5', 'trim 但不改大小写');
    globalThis.fetch = async () => new Response(JSON.stringify({ code: '000000', desc: '成功', data: { activated: true, appliedInvitationCode: '8YZCH5' } }));
    const st2 = await fetchLoomyActivation({ token: 's', meta: {} });
    assert.equal(st2.activated, true);
    assert.equal(st2.appliedInvitationCode, '8YZCH5');
  } finally { globalThis.fetch = realFetch; }
});

test('Loomy 账号支持切换（canSwitch）', async () => {
  const { publicAccount } = await import('../src/store.js');
  const view = publicAccount({ provider: 'loomy', token: 'x'.repeat(20), meta: { phone: '13100003656' } });
  assert.equal(view.canSwitch, true);
});

test('currentLoomyUid 读凭据 userid——面板「客户端当前」徽章按 uid 比对', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { currentLoomyUid } = await import('../src/loomyLocal.js');
  const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-uid-')), 'auth-session.json');
  fs.writeFileSync(fixture, JSON.stringify({ session: 's'.repeat(32), userid: '261030162018707426', phone: '13100003656', updatedAt: 1 }));
  const prev = process.env.LOOMY_CREDENTIAL_FILE;
  process.env.LOOMY_CREDENTIAL_FILE = fixture;
  try {
    assert.equal(currentLoomyUid(), '261030162018707426');
    fs.writeFileSync(fixture, JSON.stringify({ session: 's'.repeat(32) }));
    assert.equal(currentLoomyUid(), null, '缺 userid 时应返回 null（徽章退化为不亮而不是误亮）');
  } finally {
    if (prev === undefined) delete process.env.LOOMY_CREDENTIAL_FILE; else process.env.LOOMY_CREDENTIAL_FILE = prev;
    fs.rmSync(path.dirname(fixture), { recursive: true, force: true });
  }
});

test('hardSwitchLoomy：写入凭据并复核落定；已活跃时不动文件', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { hardSwitchLoomy, readCredential } = await import('../src/loomyLocal.js');
  const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-sw-')), 'auth-session.json');
  fs.writeFileSync(fixture, JSON.stringify({ session: 'a'.repeat(32), userid: 'uid-a', phone: '13100003656', updatedAt: 1 }));
  const prev = process.env.LOOMY_CREDENTIAL_FILE;
  process.env.LOOMY_CREDENTIAL_FILE = fixture;
  try {
    const r = await hardSwitchLoomy({ token: 'b'.repeat(32), uid: 'uid-b', meta: { phone: '18700009058' } }, { requireClient: false });
    assert.equal(r.switched, true);
    assert.equal(r.verified, true, '写入后延时复核应落定（无回写者时一次通过）');
    assert.equal(readCredential().session, 'b'.repeat(32));
    assert.equal(readCredential().userid, 'uid-b');
    const again = await hardSwitchLoomy({ token: 'b'.repeat(32), uid: 'uid-b' }, { requireClient: false });
    assert.equal(again.alreadyActive, true);
    assert.equal(again.switched, false);
  } finally {
    if (prev === undefined) delete process.env.LOOMY_CREDENTIAL_FILE; else process.env.LOOMY_CREDENTIAL_FILE = prev;
    fs.rmSync(path.dirname(fixture), { recursive: true, force: true });
  }
});

test('hardSwitchLoomy：凭据文件缺失（客户端内退出登录清空）也能直接写入目标账号', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { hardSwitchLoomy, readCredential } = await import('../src/loomyLocal.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-sw-empty-'));
  const fixture = path.join(dir, 'auth-session.json');   // 故意不存在
  const prev = process.env.LOOMY_CREDENTIAL_FILE;
  process.env.LOOMY_CREDENTIAL_FILE = fixture;
  try {
    const r = await hardSwitchLoomy({ token: 'c'.repeat(32), uid: 'uid-c', meta: { phone: '18700009058' } }, { requireClient: false });
    assert.equal(r.switched, true);
    assert.equal(r.verified, true);
    assert.equal(readCredential().session, 'c'.repeat(32));
    assert.equal(readCredential().userid, 'uid-c');
    assert.equal(readCredential().phone, '18700009058');
  } finally {
    if (prev === undefined) delete process.env.LOOMY_CREDENTIAL_FILE; else process.env.LOOMY_CREDENTIAL_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hardSwitchLoomy：目标无 uid 拒绝切换——绝不借用旧凭据的 userid 配新 session', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { hardSwitchLoomy, readCredential } = await import('../src/loomyLocal.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-sw-nouid-'));
  const fixture = path.join(dir, 'auth-session.json');
  fs.writeFileSync(fixture, JSON.stringify({ session: 'a'.repeat(32), userid: 'uid-a', phone: '13100003656', updatedAt: 1 }));
  const prev = process.env.LOOMY_CREDENTIAL_FILE;
  process.env.LOOMY_CREDENTIAL_FILE = fixture;
  try {
    await assert.rejects(
      () => hardSwitchLoomy({ token: 'd'.repeat(32), meta: {} }, { requireClient: false }),
      /缺少 userid/);
    // 复核失败路径不得留下半写凭据：旧身份必须原样
    assert.equal(readCredential().session, 'a'.repeat(32));
    assert.equal(readCredential().userid, 'uid-a');
  } finally {
    if (prev === undefined) delete process.env.LOOMY_CREDENTIAL_FILE; else process.env.LOOMY_CREDENTIAL_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hardSwitchLoomy：未装客户端时报 LOOMY_NOT_INSTALLED 而非假成功', async () => {
  const { hardSwitchLoomy, candidateClientPath } = await import('../src/loomyLocal.js');
  if (candidateClientPath()) return;   // 本机真有客户端（开发机常态）：守卫不触发，跳过本用例
  await assert.rejects(
    () => hardSwitchLoomy({ token: 'e'.repeat(32), uid: 'uid-e' }, { requireClient: true }),
    (e) => e.loomyNotInstalled === true);
});
