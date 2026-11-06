import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-zac-'));

const { zcodeAutoClaim, setZcodeCaptchaProvider } = await import('../src/zcodeAutoClaim.js');

const account = {
  id: 'acc-1',
  provider: 'zcode',
  name: '测试账号',
  meta: { credentials: { zcodejwttoken: 'x'.repeat(40) }, config: {}, deviceMid: 'mid-1' },
};

const PLAN = {
  plan_id: 'p1', name: 'ZCode Weekend Build', priority: 100,
  entitlements: [{ meter: 'model_usage', unit_type: 'token', show_name: 'GLM-5.3-Flash', grant_units: 300000000, period: 'one_time' }],
};

let claimCalls;
let claimBehaviors;
const realFetch = globalThis.fetch;

function mockFetch({ plans = [PLAN], captchaCfg = { enabled: true, sceneId: 's', region: 'cn', prefix: 'p' }, deliveries = [] } = {}) {
  claimCalls = 0;
  claimBehaviors = [...(claimBehaviors || [])];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/billing/preview')) return jsonRes({ code: 0, data: { plans, server_time: 1 } });
    if (url.includes('/client/configs')) return jsonRes({ code: 0, data: { configs: { captcha: captchaCfg } } });
    // 激活上报：永远成功（与本批用例关注点无关）
    if (url.includes('/event/report')) return jsonRes({ code: 0 });
    // 活动投放：默认空；需要时由用例传入 deliveries
    if (url.includes('/marketing/touch')) return jsonRes({ code: 0, data: { deliveries } });
    if (url.includes('/billing/claim')) {
      claimCalls++;
      const behavior = claimBehaviors.length ? claimBehaviors.shift() : { code: 0 };
      if (behavior.assertHeaders) behavior.assertHeaders(opts.headers);
      return jsonRes(behavior.response ?? { code: behavior.code, msg: behavior.msg || '', data: behavior.data });
    }
    throw new Error('unexpected url ' + url);
  };
}
const jsonRes = (v) => new Response(JSON.stringify(v));

beforeEach(() => {
  setZcodeCaptchaProvider(null);
});

test('无可领活动：preview 与投放都为空时返回 null（不再用硬编码 planId 去撞）', async () => {
  mockFetch({ plans: [], deliveries: [] });
  try {
    assert.equal(await zcodeAutoClaim(account), null);
    assert.equal(claimCalls, 0, '没有活动就不该发起任何 claim 请求');
  } finally { globalThis.fetch = realFetch; }
});

test('投放活动（隐藏活动）：从 marketing/touch 发现 plan_id 并领取', async () => {
  // 真机实测：GLOBAL BUILD 在 preview 里看不到，只在 marketing/touch 的 deliveries 里下发
  const deliveries = [{
    campaign_id: 'c1', resource_position: 'banner',
    banner: {
      buttons: [
        { action: { type: 'close' } },
        { action: { type: 'claim_zcode_plan', args: { plan_id: 'zcode-v3-start-plan-gb-1104' } } },
      ],
      // 真实投放里 plan 元数据挂在 background.args.zcode_plan 上（give 名称/权益/时间）
      background: { args: { zcode_plan: {
        plan_id: 'zcode-v3-start-plan-gb-1104', name: 'ZCODE GLOBAL BUILD', priority: 111,
        entitlements: [{ show_name: 'GLM-5.3-Flash', grant_units: 300000000, period: 'one_time' }],
      } } },
    },
  }];
  mockFetch({ plans: [], deliveries });
  claimBehaviors = [{ code: 0, data: { plan: { name: 'ZCODE GLOBAL BUILD' } } }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'checked-in');
    assert.match(r.message, /ZCODE GLOBAL BUILD/);
  } finally { globalThis.fetch = realFetch; }
});

test('投放活动已领过（1003）：按已领口径', async () => {
  const deliveries = [{
    campaign_id: 'c1', resource_position: 'banner',
    banner: { buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'p-gb' } } }] },
  }];
  mockFetch({ plans: [], deliveries });
  claimBehaviors = [{ code: 1003 }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'already');
  } finally { globalThis.fetch = realFetch; }
});

test('preview 列表里的真实活动返回 1002：如实记失败（静默跳过只限已知清单兜底）', async () => {
  mockFetch({ plans: [PLAN] });
  claimBehaviors = [{ code: 1002, msg: '活动已结束' }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'failed');
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].plan, PLAN.name);
    assert.equal(r.claims[0].ok, false);
  } finally { globalThis.fetch = realFetch; }
});

test('免验证码直接领取成功', async () => {
  mockFetch();
  claimBehaviors = [{ code: 0, data: { plan: { name: 'ZCode Weekend Build' } } }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'checked-in');
    assert.match(r.message, /已领取：ZCode Weekend Build/);
    assert.equal(r.claims[0].via, 'direct');
    assert.equal(claimCalls, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('需要验证码：无提供者时标记「需手动领取」', async () => {
  mockFetch();
  claimBehaviors = [{ code: 3007, msg: 'captcha verify failed' }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'failed');
    assert.match(r.message, /手动领取/);
    assert.equal(r.claims[0].needManual, true);
  } finally { globalThis.fetch = realFetch; }
});

test('需要验证码：提供者静默通过后重试成功（验证码头透传）', async () => {
  mockFetch();
  let seenCaptchaHeader = null;
  claimBehaviors = [
    { code: 3007 },
    { code: 0, data: { plan: { name: 'ZCode Weekend Build' } }, assertHeaders: (h) => { seenCaptchaHeader = h['X-Aliyun-Captcha-Verify-Param'] || null; } },
  ];
  let providerCfg = null;
  setZcodeCaptchaProvider(async (cfg) => { providerCfg = cfg; return { captchaParam: 'CAP-TOKEN', region: 'cn' }; });
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'checked-in');
    assert.equal(r.claims[0].via, 'captcha');
    assert.equal(claimCalls, 2);
    assert.equal(seenCaptchaHeader, 'CAP-TOKEN');
    assert.equal(providerCfg.sceneId, 's');
  } finally { globalThis.fetch = realFetch; }
});

test('3007 后换新验证码重试成功：param 一次性，每次 claim 前重新过验证（防 F008 重复判定）', async () => {
  mockFetch();
  const seenParams = [];
  claimBehaviors = [
    { code: 3007, assertHeaders: (h) => seenParams.push(h['X-Aliyun-Captcha-Verify-Param']) },
    { code: 3007, assertHeaders: (h) => seenParams.push(h['X-Aliyun-Captcha-Verify-Param']) },
    { code: 0, data: { plan: { name: 'ZCode Weekend Build' } }, assertHeaders: (h) => seenParams.push(h['X-Aliyun-Captcha-Verify-Param']) },
  ];
  let call = 0;
  setZcodeCaptchaProvider(async () => ({ captchaParam: 'CAP-' + (++call), region: 'cn' }));
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'checked-in');
    assert.equal(claimCalls, 3, '3007 两次后第三次成功');
    // 第 1 次 claim 是不带验证码的直试（无验证码头），第 2/3 次各用一份全新 param
    assert.equal(seenParams[0], undefined, '首轮直试不带验证码头');
    assert.equal(seenParams[1], 'CAP-1');
    assert.equal(seenParams[2], 'CAP-2', '重试必须换新 param，不能复用被拒的那份');
  } finally { globalThis.fetch = realFetch; }
});

test('换新验证码重试后仍 3007：如实记需手动（投放可能只在官方客户端生效）', async () => {
  mockFetch();
  claimBehaviors = [{ code: 3007 }, { code: 3007 }, { code: 3007 }];
  let call = 0;
  setZcodeCaptchaProvider(async () => ({ captchaParam: 'CAP-' + (++call), region: 'cn' }));
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'failed');
    assert.equal(r.claims[0].needManual, true);
    assert.match(r.message, /手动领取/);
    assert.equal(claimCalls, 3, '自动重试封顶两轮验证码，不无限撞');
  } finally { globalThis.fetch = realFetch; }
});

test('部分成功（一个活动成功、另一个需要验证码）：status=partial 并计入已领取', async () => {
  mockFetch({ plans: [{ ...PLAN, plan_id: 'p1' }, { ...PLAN, plan_id: 'p2', name: 'P2 活动' }] });
  claimBehaviors = [
    { code: 0, data: { plan: { name: 'ZCode Weekend Build' } } },   // p1 直试成功
    { code: 3007 }, { code: 3007 }, { code: 3007 },                 // p2：直试 + 验证码两轮全拒
  ];
  setZcodeCaptchaProvider(async () => ({ captchaParam: 'CAP-X', region: 'cn' }));
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'partial', '有成功有需手动时不再整体记失败');
    assert.match(r.message, /已领取：ZCode Weekend Build/);
    assert.match(r.message, /1 个活动需要验证码/);
  } finally { globalThis.fetch = realFetch; }
});

test('已领取过（1003）按已领口径处理', async () => {
  mockFetch();
  claimBehaviors = [{ code: 1003 }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'already');
  } finally { globalThis.fetch = realFetch; }
});

test('验证码提供者失败 → 标记需手动', async () => {
  mockFetch();
  claimBehaviors = [{ code: 3007 }];
  setZcodeCaptchaProvider(async () => { throw new Error('等待验证码超时'); });
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'failed');
    assert.match(r.message, /手动领取/);
  } finally { globalThis.fetch = realFetch; }
});

test('领取成功且活动当天稍晚到账：消息带「HH:MM 到账」', async () => {
  mockFetch();
  // 服务端返回 starts_at（秒级时间戳）= 今天 23:00
  const at = new Date();
  at.setHours(23, 0, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);   // 已过 23 点则推到明天
  claimBehaviors = [{ code: 0, data: { plan: { name: 'ZCODE GLOBAL BUILD', starts_at: Math.floor(at.getTime() / 1000) } } }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'checked-in');
    assert.match(r.message, /到账/, '领取成功但尚未到账时，消息应说明到账时间');
    assert.equal(r.claims[0].startsAt, at.toISOString());
  } finally { globalThis.fetch = realFetch; }
});

test('领取成功且立即生效：消息不带到账后缀', async () => {
  mockFetch();
  claimBehaviors = [{ code: 0, data: { plan: { name: '即效活动', starts_at: Math.floor(Date.now() / 1000) - 60 } } }];
  try {
    const r = await zcodeAutoClaim(account);
    assert.equal(r.status, 'checked-in');
    assert.doesNotMatch(r.message, /到账/, '已生效的活动不该再提示到账时间');
  } finally { globalThis.fetch = realFetch; }
});
