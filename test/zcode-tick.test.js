import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-ztick-'));

const { runCheckinTick, pollZcodeNow, enableZcodeAutoClaimWindow, refreshZcodeScheduler, stopScheduler, zcodeMsUntilNextTick } = await import('../src/checkin.js');
const { saveAccounts } = await import('../src/store.js');
const { setAutoClaimEnabled, enableAutoClaimFor, autoClaimUntil, autoClaimEnabled, claimIntervalMin, setClaimIntervalMin, setClaimWindowMin } = await import('../src/zcodeClient.js');

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
  refreshZcodeScheduler();   // 关掉上一条测试留下的定时器
  await saveAccounts([{ ...ZACC }]);
});

test('开关关闭（默认）：定时签到不轮询 ZCode，也不请求 preview', async () => {
  mockZs();
  try {
    const r = await runCheckinTick({});
    assert.equal(previewCalls, 0, '关闭时不应有任何 ZCode 请求');
    assert.equal(r.summary, '没有匹配的账号');
  } finally { globalThis.fetch = realFetch; }
});

test('开关打开：定时签到仍会顺带轮询 ZCode（兼容面板「全部领取」）', async () => {
  mockZs(true);
  enableAutoClaimFor(60 * 60 * 1000);
  try {
    const r = await runCheckinTick({});
    assert.ok(previewCalls > 0, '开启后应轮询 preview');
    const z = r.results.find((x) => x.provider === 'zcode');
    assert.ok(z, '结果里应有 ZCode 条目');
    assert.equal(z.status, 'checked-in');
  } finally { globalThis.fetch = realFetch; setAutoClaimEnabled(false); }
});

test('pollZcodeNow：手动轮询不受开关限制，可真实领取', async () => {
  mockZs(true);
  try {
    const r = await pollZcodeNow();
    assert.ok(previewCalls > 0);
    assert.equal(r.results[0].status, 'checked-in');
    assert.match(r.summary, /ZCode 资格轮询/);
  } finally { globalThis.fetch = realFetch; setAutoClaimEnabled(false); }
});

test('开启时段（默认运行 60 分钟）：落盘到期时间，可随时手动关闭', async () => {
  const until = enableZcodeAutoClaimWindow();
  assert.ok(autoClaimUntil() > Date.now() + 55 * 60 * 1000, '应是一小时内的未来时刻');
  assert.equal(autoClaimUntil(), until);
  const onDisk = JSON.parse(await fs.readFile(path.join(process.env.CREDITDADDY_HOME, 'zcode-net.json'), 'utf8'));
  assert.equal(onDisk.autoClaim, true);
  assert.ok(onDisk.autoClaimUntil > Date.now());

  setAutoClaimEnabled(false);
  refreshZcodeScheduler();
  assert.equal(autoClaimUntil(), null, '手动关闭应清掉到期时间');
});

test('运行时长 0 = 不自动关闭：开关保持开启且无到期时间', async () => {
  setClaimWindowMin(0);
  try {
    const until = enableZcodeAutoClaimWindow();
    assert.equal(until, null, '不自动关闭时不应有到期时间');
    assert.equal(autoClaimEnabled(), true);
    const onDisk = JSON.parse(await fs.readFile(path.join(process.env.CREDITDADDY_HOME, 'zcode-net.json'), 'utf8'));
    assert.equal(onDisk.autoClaim, true);
    assert.equal(onDisk.autoClaimUntil, null);
  } finally { setAutoClaimEnabled(false); setClaimWindowMin(60); refreshZcodeScheduler(); }
});

test('资格轮询周期可配置：默认 ~2 分钟，改配置后按新周期 + 15 秒内抖动', () => {
  for (let i = 0; i < 20; i++) {
    const ms = zcodeMsUntilNextTick(() => 0.5);
    assert.ok(ms >= 2 * 60_000 && ms <= 2 * 60_000 + 15_000);
  }
  setClaimIntervalMin(7);
  try {
    assert.equal(claimIntervalMin(), 7);
    for (let i = 0; i < 20; i++) {
      const ms = zcodeMsUntilNextTick(() => 0.5);
      assert.ok(ms >= 7 * 60_000 && ms <= 7 * 60_000 + 15_000);
    }
  } finally { setClaimIntervalMin(2); }
});

test('stopScheduler 清掉普通与 ZCode 两套定时器状态', async () => {
  const { getSchedulerInfo } = await import('../src/checkin.js');
  enableZcodeAutoClaimWindow();
  assert.equal(getSchedulerInfo().zcode.enabled, true);
  stopScheduler();
  assert.equal(getSchedulerInfo().zcode.enabled, true, '开关本身不因 stop 而变');
  assert.equal(getSchedulerInfo().zcode.nextTickAt, null, '但下一次轮询时间应被清空');
  setAutoClaimEnabled(false);
  refreshZcodeScheduler();
});
