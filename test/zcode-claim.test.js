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
  // 2026-11-19 口径更新：one_time 权益的 plan.ends_at 已过 = 活动额度已失效，不再派生展示
  // （用户实测「过期资源包还挂在卡上」的根因）。fixture 的 Weekend Build ends_at 是过去时间，
  // 期望从「照常展示」改为「被过滤」——既有语义见下方「未过期活动才派生」用例。
  const q = normalizeBalance(WEEKEND_BALANCE);
  assert.equal(q.parts.length, 0, '过期 one_time 活动的权益不再派生（过期包不再挂卡）');
  assert.equal(q.empty, false, 'empty 语义是「上游无活动」——plans 非空只是被过滤时不算 empty（面板显示无可用额度而非空卡）');
});

test('normalizeBalance：未过期活动的权益派生 + effective_at pending 语义', () => {
  // ends_at 推到未来，让派生路径走通（过期过滤不拦截）
  const alive = structuredClone(WEEKEND_BALANCE);
  alive.data.plans[0].starts_at = Math.floor(Date.now() / 1000) - 3600;
  alive.data.plans[0].ends_at = Math.floor(Date.now() / 1000) + 86400;
  const future = structuredClone(alive);
  future.data.plans[0].entitlements[0].effective_at = Math.floor(Date.now() / 1000) + 86400;
  const q = normalizeBalance(future);
  assert.equal(q.parts[0].pending, true);
  assert.equal(q.remaining, 0);
  assert.equal(q.total, 300000000, '总额仍应显示');

  const past = structuredClone(alive);
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
