import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkinLingxi, fetchLingxiStatus, LINGXI_TASKS_URL, LINGXI_BALANCE_URL, LINGXI_BASE } from '../src/lingxiClient.js';

// 七天一轮：每天 reward 100，第七天 200（#53 提案者实测口径）
const CYCLE_REWARDS = [100, 100, 100, 100, 100, 100, 200];
const daysOf = (claimedCount) =>
  Array.from({ length: 7 }, (_, i) => ({ claimed: i < claimedCount, reward: CYCLE_REWARDS[i] }));

function taskBody({ status = 'available', rewardAmount = 100, days = null } = {}) {
  const daily = { task_key: 'daily_check_in', status, reward_amount: rewardAmount };
  if (days) daily.extra = { check_in_days: days };
  return { result: 'ok', data: { tasks: [daily] } };
}

function mockFetch({ tasksBody, claimBody, claimStatus = 200, balanceBody } = {}) {
  return async (url) => {
    if (url === LINGXI_TASKS_URL) return { status: 200, ok: true, text: async () => JSON.stringify(tasksBody) };
    if (String(url).startsWith(`${LINGXI_BASE}/api/public/v1/tasks/daily_check_in/claim`)) {
      return { status: claimStatus, ok: claimStatus === 200, text: async () => JSON.stringify(claimBody) };
    }
    if (url === LINGXI_BALANCE_URL) return { status: 200, ok: true, text: async () => JSON.stringify(balanceBody || { data: { total_balance: 1100 } }) };
    throw new Error(`unexpected url: ${url}`);
  };
}

const account = { meta: { cookieSiteSession: { cookie: 'wps_sid=test' } } };

test('连签第 3 天：当天额 +100，不吃 claim 返回的周期累计 300', async () => {
  const r = await checkinLingxi(account, { fetchImpl: mockFetch({
    tasksBody: taskBody({ days: daysOf(2) }),
    claimBody: { result: 'ok', data: { total_claimed_credits: 300 } },
  }) });
  assert.equal(r.status, 'checked-in');
  assert.equal(r.claimedAmount, 100);
  assert.equal(r.amount, 100);
  assert.match(r.message, /\+100 灵点/);
});

test('第七天：当天额 +200（reward_amount 仍是 100，当日奖励在 check_in_days[6]）', async () => {
  const r = await checkinLingxi(account, { fetchImpl: mockFetch({
    tasksBody: taskBody({ days: daysOf(6) }),
    claimBody: { result: 'ok', data: { total_claimed_credits: 800 } },
  }) });
  assert.equal(r.status, 'checked-in');
  assert.equal(r.claimedAmount, 200);
  assert.match(r.message, /\+200 灵点/);
});

test('没有 check_in_days 时退 reward_amount，绝不虚报周期累计', async () => {
  const r = await checkinLingxi(account, { fetchImpl: mockFetch({
    tasksBody: taskBody({}),
    claimBody: { result: 'ok', data: { total_claimed_credits: 500 } },
  }) });
  assert.equal(r.claimedAmount, 100);
});

test('already 路径同样按当日奖励报数（第七天「今日已签到（+200 灵点）」）', async () => {
  const r = await checkinLingxi(account, { fetchImpl: mockFetch({
    tasksBody: taskBody({ status: 'claimed', days: daysOf(6) }),
  }) });
  assert.equal(r.status, 'already');
  assert.equal(r.amount, 200);
  assert.match(r.message, /今日已签到（\+200 灵点）/);
});

test('fetchLingxiStatus 提取 streakDays / dayReward，余额旁路失败不推翻 auth', async () => {
  const st = await fetchLingxiStatus('wps_sid=test', { fetchImpl: mockFetch({
    tasksBody: taskBody({ days: daysOf(2) }),
  }) });
  assert.equal(st.auth, true);
  assert.equal(st.checkedIn, false);
  assert.equal(st.streakDays, 2);
  assert.equal(st.dayReward, 100);
  assert.equal(st.balance, 1100);
});

test('claimed 状态（已签过）时绝不 POST claim', async () => {
  let claimed = false;
  const fetchImpl = async (url) => {
    if (String(url).includes('/claim')) { claimed = true; return { status: 200, ok: true, text: async () => '{}' }; }
    if (url === LINGXI_TASKS_URL) return { status: 200, ok: true, text: async () => JSON.stringify(taskBody({ status: 'claimed', days: daysOf(3) })) };
    return { status: 200, ok: true, text: async () => JSON.stringify({ data: { total_balance: 1100 } }) };
  };
  const r = await checkinLingxi(account, { fetchImpl });
  assert.equal(r.status, 'already');
  assert.equal(claimed, false);
});
