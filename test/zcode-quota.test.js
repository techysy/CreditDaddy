import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-zquota-'));

const zc = await import('../src/zcodeClient.js');

const CKEY = 'ckey-' + 'x'.repeat(30);      // coding-plan apiKey → 候选 #0，billing 链之外
const JWT = 'jwt-' + 'y'.repeat(40);        // zcodejwttoken → 候选 #1 / billing #0
const BIGO = 'bigoauth-' + 'z'.repeat(40);  // oauth:bigmodel:access_token → 候选 #2
const SKEY = 'skey-' + 'w'.repeat(30);      // start-plan apiKey → billing #1

function makeAccount() {
  return {
    provider: 'zcode', name: 'techysy',
    meta: {
      deviceMid: 'mid-test',
      credentials: { zcodejwttoken: JWT, 'oauth:bigmodel:access_token': BIGO },
      config: {
        provider: {
          'builtin:bigmodel-coding-plan': { enabled: true, options: { apiKey: CKEY } },
          'builtin:bigmodel-start-plan': { enabled: true, options: { apiKey: SKEY } },
        },
      },
    },
  };
}

const BALANCE_OK = {
  code: 0,
  data: {
    server_time: 1790000000,
    plans: [{ plan_id: 'start', name: 'ZCode Trust Build', status: 'active', starts_at: 1789000000, ends_at: 1791000000 }],
    balances: [{ show_name: 'GLM-5.3-Flash', unit_type: 'token', total_units: 100000000, used_units: 500000, remaining_units: 99500000, expire_at: 1791000000, period: 'monthly' }],
  },
};

const json = (v, status = 200) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status });

/** routes: [{ match(url, auth), resp() }]，首个命中生效；全不命中返回 404 */
function routeFetch(routes) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const auth = String(init.headers?.Authorization || '');
    calls.push({ u, auth });
    for (const r of routes) if (r.match(u, auth)) return r.resp();
    return json('{"code":404}', 404);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const onLimit = (fn) => ({ match: (u) => u.includes('quota/limit'), resp: fn });
const onSub = (fn) => ({ match: (u) => u.includes('subscription/list'), resp: fn });
const onBalance = (token, fn) => ({ match: (u, a) => u.includes('billing/balance') && a.includes(token), resp: fn });

beforeEach(() => { zc._resetAppVersionCache('2.0.0-test'); });

test('techysy 形态：quota/limit 对最后一个候选返回 HTTP 200 空 body，不得短路 balance 链路', async () => {
  // 精确复刻线上矩阵：CKEY→500 无套餐、JWT→401、BIGO→200 空 body（HTTP 200 无内容）
  const m = routeFetch([
    { match: (u, a) => u.includes('quota/limit') && a.includes(CKEY), resp: () => json('{"code":500,"msg":"当前用户不存在coding plan","success":false}') },
    { match: (u, a) => u.includes('quota/limit') && a.includes(JWT), resp: () => json('{"code":401,"msg":"令牌已过期或验证不正确","success":false}') },
    { match: (u, a) => u.includes('quota/limit') && a.includes(BIGO), resp: () => json('') },
    onBalance(JWT, () => json(BALANCE_OK)),
  ]);
  try {
    const res = await zc.fetchZcodeQuota(makeAccount());
    assert.equal(res.source, 'zcode.z.ai', '空 body 若伪装成 code:200，这里会拿到 bigmodel + empty 而到不了 balance');
    assert.equal(res.empty, false);
    assert.equal(res.remaining, 99500000);
    assert.equal(res.parts[0].name, 'GLM-5.3-Flash');
    assert.ok(m.calls.some((c) => c.u.includes('billing/balance') && c.auth.includes(JWT)), '应尝试过 balance');
  } finally { m.restore(); }
});

test('quota/limit 有效但零额度项：继续试 balance，不提前返回“无套餐”', async () => {
  const m = routeFetch([
    onLimit(() => json('{"code":0,"data":{"limits":[]}}')),
    onSub(() => json('{"code":0,"data":[]}')),
    onBalance(JWT, () => json('{"code":401,"msg":"unauthorized","success":false}')),
    onBalance(SKEY, () => json(BALANCE_OK)),
  ]);
  try {
    const res = await zc.fetchZcodeQuota(makeAccount());
    assert.equal(res.source, 'zcode.z.ai');
    assert.equal(res.remaining, 99500000);
  } finally { m.restore(); }
});

test('全链路真·无套餐：返回 empty 而不是报错', async () => {
  const m = routeFetch([
    onLimit(() => json('{"code":500,"msg":"当前用户不存在coding plan","success":false}')),
    onBalance(JWT, () => json('{"code":0,"data":{"plans":[],"balances":[]}}')),
  ]);
  try {
    const res = await zc.fetchZcodeQuota(makeAccount());
    assert.equal(res.empty, true);
    assert.equal(res.source, 'zcode.z.ai', 'balance 明确答复无套餐时应按 balance 口径返回');
  } finally { m.restore(); }
});

test('balance 也返回 HTTP 200 空 body：不得判成功，最终按“无套餐/查询失败”收敛', async () => {
  const m = routeFetch([
    onLimit(() => json('{"code":500,"msg":"当前用户不存在coding plan","success":false}')),
    onBalance(JWT, () => json('')),
    onBalance(SKEY, () => json('')),
  ]);
  try {
    const res = await zc.fetchZcodeQuota(makeAccount());
    assert.equal(res.empty, true, '空 body 不是有效额度答复，但“不存在coding plan”口径成立');
    assert.equal(res.source, undefined);
  } finally { m.restore(); }
});

test('鉴权全军覆没：抛登录过期而不是空套餐', async () => {
  const m = routeFetch([
    onLimit(() => json('{"code":401,"msg":"令牌已过期或验证不正确","success":false}')),
    onBalance(JWT, () => json('{"code":401,"msg":"unauthorized","success":false}')),
    onBalance(SKEY, () => json('{"code":401,"msg":"unauthorized","success":false}')),
  ]);
  try {
    await assert.rejects(() => zc.fetchZcodeQuota(makeAccount()), /鉴权失败/);
  } finally { m.restore(); }
});

// ── 过期资源包过滤（2026-11-19 用户实测：已过期包还挂在卡上、有时还配「已领取」徽章）──

test('normalizeBalance 过期 one_time 包过滤：过期丢弃、未过期保留、周期包重置点已过不过滤', () => {
  const now = Date.now();
  const sec = (offset) => Math.floor((now + offset) / 1000);
  const q = zc.normalizeBalance({ data: {
    balances: [
      { show_name: '过期包', unit_type: 'token', total_units: 3e8, used_units: 0, remaining_units: 3e8, expire_at: sec(-3600e3), period: 'one_time' },
      { show_name: '周期包', unit_type: 'token', total_units: 100, used_units: 10, remaining_units: 90, period_end: sec(-3600e3), period: 'monthly' },
      { show_name: '有效包', unit_type: 'token', total_units: 500, used_units: 0, remaining_units: 500, expire_at: sec(3600e3), period: 'one_time' },
    ],
    plans: [],
  }});
  const names = q.parts.map((p) => p.name);
  assert.ok(!names.includes('过期包'), '过期 one_time 包必须被过滤（服务端不清理过期行，remaining 照旧返回）');
  assert.ok(names.includes('有效包'));
  assert.ok(names.includes('周期包'), '周期包的 period_end 是重置点不是到期点，不过滤');
  assert.equal(q.total, 600, 'total 只计未过期包（周期 100 + 有效 500，按 grant 口径）');
  assert.equal(q.remaining, 590, 'remaining 只计未过期包（周期 90 + 有效 500）');
});

test('normalizeBalance：balances 全空但 plans 有过期 one_time 活动 → 派生路径同样过滤', () => {
  const now = Date.now();
  const sec = (offset) => Math.floor((now + offset) / 1000);
  const q = zc.normalizeBalance({ data: {
    balances: [],
    plans: [
      { name: '过期活动', status: 'active', ends_at: sec(-3600e3), entitlements: [{ unit_type: 'token', grant_units: 7e8, show_name: '过期派生' }] },
      { name: '有效活动', status: 'active', starts_at: sec(-60), ends_at: sec(3600e3), entitlements: [{ unit_type: 'token', grant_units: 3e8, show_name: '有效派生', effective_at: sec(-60) }] },
    ],
  }});
  const names = q.parts.map((p) => p.name);
  assert.ok(!names.includes('过期派生'), 'ends_at 已过的 one_time 权益不再派生展示');
  assert.ok(names.includes('有效派生'));
});


// ── 领取后余额即时落库（2026-11-20 用户问「实际完成了吗」——快照停领取前与「今日已领 +N」同框打架）──

test('checkin 轮为返回 balanceAfter 的产品即时落余额快照（meoo：+2000 领取后快照应为 1990）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const saved = process.env.CREDITDADDY_HOME;
  process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-mebal-'));
  try {
    const store = await import('../src/store.js');
    await store.saveAccounts([{ id: 'm1', provider: 'meoo', name: 'Meoo', meta: { cookieSiteId: 'meoo', cookieSiteSession: { cookie: 'a=b' }, quotaSnapshot: { used: 0, total: 100, at: '2026-11-19T00:00:00.000Z' } } }]);
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('entitlement/init')) return new Response(JSON.stringify({ success: true, data: { initialized: true, dailyLoginGranted: true, dailyLoginGrantAmount: 2000 } }), { status: 200 });
      if (u.includes('entitlement/get')) return new Response(JSON.stringify({ success: true, data: { userPointInfo: { account: { availableBalance: 1990 }, activeGrants: [] } } }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const { runCheckinTick } = await import('../src/checkin.js');
    const r = await runCheckinTick({ skipIfCheckedToday: true, includeZcode: false });
    globalThis.fetch = real;
    assert.equal(r.results[0]?.status, 'checked-in');
    assert.equal(r.results[0]?.claimedAmount, 2000);
    const acc = (await store.loadAccounts())[0];
    assert.equal(acc.meta.quotaSnapshot.total, 1990, '快照随领取落为 balanceAfter（不再是领取前的 100）');
    assert.equal(acc.lastResult?.status, 'checked-in');
  } finally { process.env.CREDITDADDY_HOME = saved; }
});
