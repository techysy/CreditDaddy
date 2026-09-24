import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-ztick-'));

const { runCheckinTick } = await import('../src/checkin.js');
const { saveAccounts } = await import('../src/store.js');
const { setAutoClaimEnabled } = await import('../src/zcodeClient.js');

const ZACC = {
  id: 'za-1', provider: 'zcode', name: 'Z测试',
  meta: { credentials: { zcodejwttoken: 'x'.repeat(40) }, config: {} },
};
const PLAN = {
  plan_id: 'p1', name: 'Weekend', priority: 100,
  entitlements: [{ meter: 'model_usage', unit_type: 'token', show_name: 'GLM', grant_units: 1000, period: 'one_time' }],
};

const realFetch = globalThis.fetch;
let previewCalls = 0;
function mockZs(okClaim = true) {
  globalThis.fetch = async (url) => {
    if (url.includes('/billing/preview')) { previewCalls++; return new Response(JSON.stringify({ code: 0, data: { plans: [PLAN], server_time: 1 } })); }
    if (url.includes('/billing/claim')) return new Response(JSON.stringify(okClaim ? { code: 0, data: { plan: { name: 'Weekend' } } } : { code: 3007 }));
    throw new Error('unexpected ' + url);
  };
}

beforeEach(async () => {
  previewCalls = 0;
  setAutoClaimEnabled(false);
  await saveAccounts([{ ...ZACC }]);
});

test('开关关闭（默认）：只有 ZCode 账号时不做轮询，也不会请求 preview', async () => {
  mockZs();
  try {
    const r = await runCheckinTick({});
    assert.equal(previewCalls, 0, '关闭时不应有任何 ZCode 请求');
    assert.equal(r.summary, '没有匹配的账号');
  } finally { globalThis.fetch = realFetch; }
});

test('开关打开：没有每日签到账号时，ZCode 领取轮询仍会执行', async () => {
  mockZs(true);
  setAutoClaimEnabled(true);
  try {
    const r = await runCheckinTick({});
    assert.ok(previewCalls > 0, '开启后应轮询 preview');
    const z = r.results.find((x) => x.provider === 'zcode');
    assert.ok(z, '结果里应有 ZCode 条目');
    assert.equal(z.status, 'checked-in');
    setAutoClaimEnabled(false);
  } finally { globalThis.fetch = realFetch; setAutoClaimEnabled(false); }
});
