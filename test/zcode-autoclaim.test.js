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

function mockFetch({ plans = [PLAN], captchaCfg = { enabled: true, sceneId: 's', region: 'cn', prefix: 'p' } } = {}) {
  claimCalls = 0;
  claimBehaviors = [...(claimBehaviors || [])];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/billing/preview')) return jsonRes({ code: 0, data: { plans, server_time: 1 } });
    if (url.includes('/client/configs')) return jsonRes({ code: 0, data: { configs: { captcha: captchaCfg } } });
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

test('无可领活动：preview 为空返回 null', async () => {
  mockFetch({ plans: [] });
  try {
    assert.equal(await zcodeAutoClaim(account), null);
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
