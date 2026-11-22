/**
 * ZCode 定时计划周槽位纯函数（zcodeClient.js）：nextWeeklyPlanRunAt / weekSlotMinutes。
 * 2026-11-22 用户口径：周一~四 20:00、周五 22:00、周末不排（ZCode 周末集成在
 * WEEKEND BUILD 活动里）。只测纯函数——dailyClaimPlan/setDailyClaimPlan 读写真实
 * zcode-net.json，测试不碰；时钟调度（checkin.js syncDailyPlanScheduler）与该函数
 * 共用同一槽位口径，槽位对了时钟就对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWeeklyPlanRunAt, weekSlotMinutes } from '../src/zcodeClient.js';

// 2026-11-22 是周日（11-01 也是周日）。week[0..6] = 周一..周日
const WEEK = ['20:00', '20:00', '20:00', '20:00', '22:00', null, null];
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('weekSlotMinutes：合法时刻→分钟数，空/非法→null', () => {
  assert.equal(weekSlotMinutes('20:00'), 1200);
  assert.equal(weekSlotMinutes('9:05'), 545);
  assert.equal(weekSlotMinutes('00:00'), 0);
  assert.equal(weekSlotMinutes(''), null);
  assert.equal(weekSlotMinutes(null), null);
  assert.equal(weekSlotMinutes('24:00'), null);
  assert.equal(weekSlotMinutes('20:61'), null);
  assert.equal(weekSlotMinutes('abc'), null);
});

test('周日白天：下一个槽位是周一 20:00（周末不排被跳过）', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 22, 10, 0), WEEK), at(2026, 11, 23, 20, 0));
});

test('周一白天：当天 20:00 到点触发', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 23, 9, 0), WEEK), at(2026, 11, 23, 20, 0));
});

test('周一 20:00 整点边界：at >= now 返回当前时刻（delay 钳 1s，due 判定放行）', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 23, 20, 0), WEEK), at(2026, 11, 23, 20, 0));
});

test('周一 20:01 已过点：跳过今天扫到周二（槽位函数只给未来；补跑由时钟 due 判定兜住）', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 23, 20, 1), WEEK), at(2026, 11, 24, 20, 0));
});

test('周四 20:30（20:00 已过）：下一个是周五 22:00——周五单独时刻生效', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 26, 20, 30), WEEK), at(2026, 11, 27, 22, 0));
});

test('周五 21:00：当天 22:00 触发', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 27, 21, 0), WEEK), at(2026, 11, 27, 22, 0));
});

test('周五 23:00 已过点：跳过周末，下周一 20:00', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 27, 23, 0), WEEK), at(2026, 11, 30, 20, 0));
});

test('七天全没排：null（时钟不排定时器，面板显示未排）', () => {
  assert.equal(nextWeeklyPlanRunAt(at(2026, 11, 22, 10, 0), Array(7).fill(null)), null);
});

test('跨年边界：周四中午查仅周日排的计划，扫到下周日（2027-01-03）', () => {
  const week = [null, null, null, null, null, null, '08:30'];
  assert.equal(nextWeeklyPlanRunAt(at(2026, 12, 31, 12, 0), week), at(2027, 1, 3, 8, 30));
});
