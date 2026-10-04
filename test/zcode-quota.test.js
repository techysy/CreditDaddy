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
