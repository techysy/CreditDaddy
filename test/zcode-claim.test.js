import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-zclaim-'));

const { normalizeBalance, normalizePlans, claimPlan } = await import('../src/zcodeClient.js');

const WEEKEND_BALANCE = {
  code: 0,
  data: {
    server_time: 1790252439,
    plans: [
      {
        user_plan_id: 'upl_1',
        plan_id: 'zcode-v3-start-plan-0924-wk',
        name: 'ZCode Weekend Build',
        description: 'ZCode 周末活动',
        status: 'active',
        starts_at: 1790252018,
        ends_at: 1790557200,
        entitlements: [
          {
            entitlement_id: 'ent-1',
            show_name: 'GLM-5.3-Flash',
            meter: 'model_usage',
            unit_type: 'token',
            grant_units: 300000000,
            period: 'one_time',
            effective_at: 1790262000,
          },
          { entitlement_id: 'ent-2', show_name: '忽略-非 token', meter: 'model_usage', unit_type: 'requests', grant_units: 50 },
        ],
      },
      { plan_id: 'expired', name: '已过期', status: 'expired', entitlements: [{ show_name: 'x', unit_type: 'token', grant_units: 1 }] },
    ],
    balances: [],
  },
};

test('normalizeBalance：balances 为空时从生效套餐权益派生额度', () => {
  const q = normalizeBalance(WEEKEND_BALANCE);
  assert.equal(q.empty, false);
  assert.equal(q.plan, 'ZCode Weekend Build');
  assert.equal(q.unit, 'Token');
  assert.equal(q.parts.length, 1, '非 token 权益与过期套餐不应计入');
  const p = q.parts[0];
  assert.equal(p.name, 'GLM-5.3-Flash');
  assert.equal(p.total, 300000000);
  assert.ok(p.expiresAt);
  assert.ok(q.planEndsAt);
});

test('normalizeBalance：effective_at 在未来的权益标记 pending 且不计入剩余', () => {
  const future = structuredClone(WEEKEND_BALANCE);
  future.data.plans[0].entitlements[0].effective_at = Math.floor(Date.now() / 1000) + 86400;
  const q = normalizeBalance(future);
  assert.equal(q.parts[0].pending, true);
  assert.equal(q.remaining, 0);
  assert.equal(q.total, 300000000, '总额仍应显示');

  const past = structuredClone(WEEKEND_BALANCE);
  past.data.plans[0].entitlements[0].effective_at = Math.floor(Date.now() / 1000) - 3600;
  const q2 = normalizeBalance(past);
  assert.equal(q2.parts[0].pending, false);
  assert.equal(q2.remaining, 300000000);
});

test('normalizeBalance：balances 非空时优先用 balances（权益不重复计）', () => {
  const v = structuredClone(WEEKEND_BALANCE);
  v.data.balances = [{ show_name: 'GLM-5.3-Flash', unit_type: 'token', total_units: 300000000, used_units: 1000, remaining_units: 299999000 }];
  const q = normalizeBalance(v);
  assert.equal(q.parts.length, 1);
  assert.equal(q.remaining, 299999000);
  assert.equal(q.used, 1000);
});

test('normalizePlans：解析 preview 列表并排序', () => {
  const preview = {
    code: 0,
    data: {
      plans: [
        { plan_id: 'b', name: '次要活动', priority: 1, entitlements: [{ meter: 'model_usage', unit_type: 'token', show_name: 'GLM-5.3-Flash', grant_units: 100000000, period: 'daily' }] },
        { plan_id: 'a', name: '主活动', description: '周末', priority: 100, entitlements: [{ meter: 'model_usage', unit_type: 'token', show_name: 'GLM-5.3', grant_units: 30000, period: 'one_time' }] },
        { name: '没有 id，跳过', priority: 999 },
      ],
    },
  };
  const plans = normalizePlans(preview);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].planId, 'a');
  assert.equal(plans[0].grants[0], 'GLM-5.3 · 3万 Token（一次性）');
  assert.equal(plans[1].grants[0], 'GLM-5.3-Flash · 1亿 Token（每日）');
  assert.deepEqual(normalizePlans({ code: 0, data: { plans: [] } }), []);
});

test('claimPlan：失败码映射为中文提示，1005 带 nextAt', async () => {
  const account = { provider: 'zcode', meta: { credentials: { zcodejwttoken: 'x'.repeat(30) }, config: {}, deviceMid: 'm' } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 1005, msg: 'quota exhausted', data: { plan: { ends_at: 1790557200 } },
  }), { status: 200 });
  try {
    await assert.rejects(
      claimPlan(account, 'p1', { captchaParam: 'cap' }),
      (e) => {
        assert.match(e.message, /今日领取名额已用完/);
        assert.match(e.message, /quota exhausted/);
        assert.equal(e.code, 1005);
        assert.ok(e.nextAt);
        return true;
      },
    );

    const seen = {};
    globalThis.fetch = async (url, opts) => {
      seen.url = url; seen.headers = opts.headers; seen.body = JSON.parse(opts.body);
      return new Response(JSON.stringify({ code: 0, data: { plan: { name: 'ZCode Weekend Build', starts_at: 1, ends_at: 2 }, server_time: 3 } }), { status: 200 });
    };
    const r = await claimPlan(account, 'plan-x', { captchaParam: 'CAP', region: 'cn' });
    assert.equal(r.planName, 'ZCode Weekend Build');
    assert.equal(seen.body.plan_id, 'plan-x');
    assert.equal(seen.headers['X-Aliyun-Captcha-Verify-Param'], 'CAP');
    assert.equal(seen.headers['X-Aliyun-Captcha-Verify-Region'], 'cn');
    assert.ok(seen.url.includes('/billing/claim'));

    await assert.rejects(
      claimPlan({ provider: 'zcode', meta: { credentials: {}, config: {} } }, 'p', {}),
      /zcodejwttoken/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
