/**
 * 签到调度 — 逻辑对齐 10router qoderCheckin.js：
 *   - 一次 tick 扫描全部账号
 *   - 已确认完成今日签到的账号当天跳过（state.json 记忆）
 *   - "无可领活动" 不记忆（每日 10:00 (UTC+8) 刷新积分，之后还会出现可领活动）
 *   - 定时器每 ~2h + 抖动执行一次
 */

import { loadAccounts, loadState, saveState } from './store.js';
import { checkinOne } from './qoderClient.js';
import { logger } from './logger.js';

const TICK_MS = 2 * 60 * 60 * 1000;        // 2 小时
const TICK_JITTER_MS = 10 * 60 * 1000;     // ±10 分钟抖动，避免整点请求特征

let timerHandle = null;
let running = false;

export function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
 * 执行一轮签到。
 * @param {{provider?: string, skipIfCheckedToday?: boolean, onlyAccountId?: string}} opts
 */
export async function runCheckinTick(opts = {}) {
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

  for (const account of accounts) {
    const label = account.name || account.id;
    try {
      if (opts.skipIfCheckedToday && memo[account.id] === today) {
        results.push({ accountId: account.id, account: label, provider: account.provider, status: 'already', memoized: true });
        continue;
      }

      const outcome = await checkinOne(account);
      results.push(outcome);

      if (outcome.status === 'checked-in') {
        memo[account.id] = today;
        account.lastCheckin = new Date().toISOString();
        logger.info('CHECKIN', `${label} 领取成功 +${outcome.claimedAmount} Credits`);
      } else if (outcome.status === 'already') {
        memo[account.id] = today;
        account.lastCheckin = account.lastCheckin || new Date().toISOString();
        logger.info('CHECKIN', `${label}：${outcome.message || '今日已领'}`);
      } else if (outcome.status === 'no-activity') {
        // 不记忆——积分窗口（10:00 UTC+8）打开后还会出现可领活动
        logger.debug('CHECKIN', `${label}：${outcome.message || '当前无可领取的活动'}`);
      } else {
        logger.warn('CHECKIN', `${label} 领取失败：${outcome.error || outcome.status}`);
      }
    } catch (err) {
      results.push({ accountId: account.id, account: label, provider: account.provider, status: 'failed', error: err?.message || String(err) });
      logger.error('CHECKIN', `${label} 异常：${err?.message || err}`);
    }
  }

  // 保存签到日历与账号 lastCheckin
  const { saveAccounts } = await import('./store.js');
  const all = await loadAccounts();
  for (const updated of accounts) {
    const i = all.findIndex((a) => a.id === updated.id);
    if (i >= 0) all[i].lastCheckin = updated.lastCheckin;
  }
  await saveAccounts(all);
  await saveState({ ...state, qoderDailyDone: memo });

  const claimed = results.filter((r) => r.status === 'checked-in');
  const failed = results.filter((r) => r.status === 'failed');
  const none = results.filter((r) => r.status === 'no-activity');
  const already = results.length - claimed.length - failed.length - none.length;
  const totalCredits = claimed.reduce((s, r) => s + (r.claimedAmount || 0), 0);
  const summary = `签到汇总：成功 ${claimed.length}（+${totalCredits} Credits）、已领 ${already}、无活动 ${none.length}、失败 ${failed.length}`;
  logger.info('CHECKIN', summary);

  return { results, summary };
}

/** 启动定时签到（每 ~2h 一轮，当天已成功的账号自动跳过） */
export function startScheduler() {
  if (timerHandle) return;
  const scheduleNext = () => {
    const delay = msUntilNextTick();
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
}
