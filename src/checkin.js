/**
 * 签到调度 — 逻辑对齐 10router qoderCheckin.js：
 *   - 一次 tick 扫描全部账号
 *   - 已确认完成今日签到的账号当天跳过（state.json 记忆）
 *   - "无可领活动" 不记忆（每日 10:00 (UTC+8) 刷新积分，之后还会出现可领活动）
 *   - "签到日" 以积分刷新时刻 10:00 (UTC+8) 为界，与本机时区无关
 *   - 国际版每台设备每天只能领一次（服务端按设备风控身份限领）：本机已有账号领取后，
 *     其余国际版账号标记为 limited 并当日记忆，不再反复请求
 *   - 定时器每 ~2h + 抖动执行一次；多轮签到（定时 / 手动）串行执行
 */

import { loadAccounts, loadState, saveState, withAccounts } from './store.js';
import { checkinOne } from './qoderClient.js';
import { logger } from './logger.js';

const TICK_MS = 2 * 60 * 60 * 1000;        // 2 小时
const TICK_JITTER_MS = 10 * 60 * 1000;     // ±10 分钟抖动，避免整点请求特征

// 每日积分刷新：10:00 (UTC+8) = 02:00 UTC。签到日 = (now - 2h) 的 UTC 日期
const REFRESH_UTC_OFFSET_MS = 2 * 60 * 60 * 1000;

let timerHandle = null;
let tickQueue = Promise.resolve();
let nextTickAt = null;
let lastTick = null;   // { at, summary }
let ticking = false;

/** 调度器状态（面板展示用） */
export function getSchedulerInfo() {
  return { running: Boolean(timerHandle), nextTickAt, lastTick, ticking };
}

/**
 * 当前所属的"签到日"（YYYY-MM-DD）。以 10:00 (UTC+8) 为日界：
 * 刷新前领过的记录不会让刷新后的新一轮被跳过；也不受 NAS / 海外机器时区影响。
 */
export function dayKey(nowMs = Date.now()) {
  return new Date(nowMs - REFRESH_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function msUntilNextTick(nowMs = Date.now(), rand = Math.random) {
  return Math.max(TICK_MS + Math.floor(rand() * TICK_JITTER_MS), 1000);
}

async function getDoneMap(state) {
  const today = dayKey();
  const raw = state?.qoderDailyDone;
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  // 只保留今天的记录，其余清掉
  for (const k of Object.keys(map)) if (map[k] !== today) delete map[k];
  return map;
}

/**
 * 执行一轮签到。多次调用会排队串行执行，避免同一账号被并发领取、state.json 互相覆盖。
 * @param {{provider?: string, skipIfCheckedToday?: boolean, onlyAccountId?: string}} opts
 */
export function runCheckinTick(opts = {}) {
  const run = tickQueue.then(() => runTickNow(opts));
  tickQueue = run.catch(() => {});
  return run;
}

async function runTickNow(opts) {
  ticking = true;
  try { return await runTickInner(opts); } finally { ticking = false; }
}

async function runTickInner(opts) {
  const accounts = (await loadAccounts()).filter(
    (a) => (!opts.provider || a.provider === opts.provider)
        && (!opts.onlyAccountId || a.id === opts.onlyAccountId)
  );

  if (accounts.length === 0) {
    return { results: [], summary: '没有匹配的账号' };
  }

  const state = await loadState();
  const memo = await getDoneMap(state);
  const today = dayKey();
  const results = [];
  // 本设备今日领取国际版每日积分的账号 { day, accountId, name }
  let deviceClaim = state?.deviceClaim?.day === today ? state.deviceClaim : null;

  for (const account of accounts) {
    const label = account.name || account.id;
    try {
      if (opts.skipIfCheckedToday && memo[account.id] === today) {
        results.push({ accountId: account.id, account: label, provider: account.provider, status: 'already', memoized: true });
        continue;
      }

      let outcome = await checkinOne(account);
      if (account.provider === 'qoder' && outcome.risk) {
        if (outcome.status === 'checked-in') {
          deviceClaim = { day: today, accountId: account.id, name: label };
        } else if (outcome.status === 'no-activity' && deviceClaim && deviceClaim.accountId !== account.id) {
          outcome = { ...outcome, status: 'limited', message: `本机今日国际版额度已由「${deviceClaim.name}」领取（Qoder 每台设备每天限领一次）` };
        }
      }
      results.push(outcome);
      if (outcome.uid && !account.uid) account.uid = outcome.uid;
      account.lastResult = {
        status: outcome.status,
        message: outcome.error || outcome.message || null,
        amount: outcome.claimedAmount || 0,
        at: new Date().toISOString(),
      };

      if (outcome.status === 'checked-in') {
        memo[account.id] = today;
        account.lastCheckin = new Date().toISOString();
        logger.info('CHECKIN', `${label} 领取成功 +${outcome.claimedAmount} Credits`);
      } else if (outcome.status === 'already') {
        memo[account.id] = today;
        account.lastCheckin = account.lastCheckin || new Date().toISOString();
        logger.info('CHECKIN', `${label}：${outcome.message || '今日已领'}`);
      } else if (outcome.status === 'limited') {
        memo[account.id] = today;
        logger.info('CHECKIN', `${label}：${outcome.message}`);
      } else if (outcome.status === 'no-activity') {
        // 不记忆——积分窗口（10:00 UTC+8）打开后还会出现可领活动
        logger.debug('CHECKIN', `${label}：${outcome.message || '当前无可领取的活动'}`);
      } else {
        logger.warn('CHECKIN', `${label} 领取失败：${outcome.error || outcome.status}`);
      }
    } catch (err) {
      results.push({ accountId: account.id, account: label, provider: account.provider, status: 'failed', error: err?.message || String(err) });
      account.lastResult = { status: 'failed', message: err?.message || String(err), amount: 0, at: new Date().toISOString() };
      logger.error('CHECKIN', `${label} 异常：${err?.message || err}`);
    }
  }

  // 保存签到日历与账号 lastCheckin / lastResult / uid（在账号锁内重新读取，不覆盖期间的增删）
  await withAccounts((all) => {
    for (const updated of accounts) {
      const cur = all.find((a) => a.id === updated.id);
      if (!cur) continue;
      cur.lastCheckin = updated.lastCheckin;
      if (updated.lastResult) cur.lastResult = updated.lastResult;
      if (updated.uid && !cur.uid) cur.uid = updated.uid;
    }
  });
  await saveState({ ...state, qoderDailyDone: memo, deviceClaim });

  const claimed = results.filter((r) => r.status === 'checked-in');
  const failed = results.filter((r) => r.status === 'failed');
  const none = results.filter((r) => r.status === 'no-activity');
  const limited = results.filter((r) => r.status === 'limited');
  const already = results.length - claimed.length - failed.length - none.length - limited.length;
  const totalCredits = claimed.reduce((s, r) => s + (r.claimedAmount || 0), 0);
  const summary = `签到汇总：成功 ${claimed.length}（+${totalCredits} Credits）、已领 ${already}`
    + (limited.length ? `、本机限领 ${limited.length}` : '')
    + `、无活动 ${none.length}、失败 ${failed.length}`;
  logger.info('CHECKIN', summary);
  lastTick = { at: new Date().toISOString(), summary };

  return { results, summary };
}

/** 启动定时签到（每 ~2h 一轮，当天已成功的账号自动跳过） */
export function startScheduler() {
  if (timerHandle) return;
  const scheduleNext = () => {
    const delay = msUntilNextTick();
    nextTickAt = new Date(Date.now() + delay).toISOString();
    timerHandle = setTimeout(async () => {
      try {
        await runCheckinTick({ skipIfCheckedToday: true });
      } catch (err) {
        logger.error('CHECKIN', `定时轮失败：${err?.message || err}`);
      } finally {
        scheduleNext();
      }
    }, delay);
    if (timerHandle.unref) timerHandle.unref();
    logger.info('CHECKIN', `定时签到已启动，下次执行约 ${Math.round(delay / 60000)} 分钟后`);
  };
  scheduleNext();
  // 启动后 15 秒先跑一轮引导签到
  setTimeout(() => {
    runCheckinTick({ skipIfCheckedToday: true }).catch((e) =>
      logger.error('CHECKIN', `引导轮失败：${e?.message || e}`));
  }, 15000).unref?.();
}

export function stopScheduler() {
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
  nextTickAt = null;
}
