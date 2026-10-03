/**
 * 签到调度：普通账号每 ~2h 扫描一次；ZCode 自动活动领取使用独立的短周期调度。
 */

import { loadAccounts, loadState, withAccounts, withState } from './store.js';
import { productImpl } from './providers.js';
import { productOf } from './constants.js';
import { startUsageSyncScheduler } from './tenrouter.js';
import { refreshContext } from './accounts.js';
import { zcodeAutoClaim } from './zcodeAutoClaim.js';
import { clearQuotaMark } from './zcodeGateway.js';
import {
  autoClaimEnabled, autoClaimUntil, enableAutoClaimFor, setAutoClaimEnabled,
  claimIntervalMin, claimWindowMin,
  warmZcodeAppVersion,
} from './zcodeClient.js';
import { logger } from './logger.js';

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;
const ZCODE_JITTER_MS = 15 * 1000;
const ZCODE_FIRST_DELAY_MS = 2 * 60 * 1000;

// 各产品「业务日」刷新时点（UTC+8）：Qoder 每日 10:00 放出/重置领取资格，其余产品按 00:00。
// 签到日 = 对应时点起的日历日：dayKey(now, provider) = (now + (8 - 刷新小时)h) 的 UTC 日期
const DAY_REFRESH_HOUR_UTC8 = { qoder: 10, 'qoder-cn': 10 };

let timerHandle = null;
let zcodeTimerHandle = null;
let zcodeExpiryTimerHandle = null;
let zcodeExpiryAt = null;
let zcodeNextTickAt = null;
let zcodeLastTick = null;
let zcodeTicking = false;
let zcodeQueue = Promise.resolve();
let tickQueue = Promise.resolve();
let nextTickAt = null;
let lastTick = null;
let ticking = false;

/** 调度器状态（面板展示用） */
export function getSchedulerInfo() {
  const enabled = autoClaimEnabled();
  return {
    running: Boolean(timerHandle), nextTickAt, lastTick, ticking,
    zcode: {
      enabled,
      intervalMin: claimIntervalMin(),
      windowMin: claimWindowMin(),
      autoOffAt: enabled ? autoClaimUntil() : null,
      nextTickAt: enabled ? zcodeNextTickAt : null,
      lastTick: zcodeLastTick,
      ticking: zcodeTicking,
    },
  };
}

/** 签到业务日。Qoder 以 10:00 (UTC+8) 为界，其余产品以 00:00 (UTC+8) 为界；默认 Qoder 口径（/api/status 展示用）。 */
export function dayKey(nowMs = Date.now(), provider = 'qoder') {
  const h = DAY_REFRESH_HOUR_UTC8[provider] ?? 0;
  return new Date(nowMs + (8 - h) * 3600 * 1000).toISOString().slice(0, 10);
}

export function msUntilNextTick(nowMs = Date.now(), rand = Math.random) {
  return Math.max(TICK_MS + Math.floor(rand() * TICK_JITTER_MS), 1000);
}

export function zcodeMsUntilNextTick(rand = Math.random) {
  const base = claimIntervalMin() * 60 * 1000;
  return Math.max(base + Math.floor(rand() * ZCODE_JITTER_MS), 1000);
}

/** 按用户配置的「自动领取计划」开启 ZCode 自动领取；首次资格检查两分钟后开始。
 *  运行时长在面板弹窗里配置（默认 60 分钟；0 = 一直运行直到手动关闭）。 */
export function enableZcodeAutoClaimWindow() {
  const w = claimWindowMin();
  if (w > 0) enableAutoClaimFor(w * 60 * 1000);
  else setAutoClaimEnabled(true);
  syncZcodeScheduler(true);
  return autoClaimUntil();
}

/** 更新 ZCode 定时器，autoClaimUntil 是持久化的到期时间，重启后仍会生效。 */
export function refreshZcodeScheduler() {
  syncZcodeScheduler();
}

function clearZcodeTimers() {
  if (zcodeTimerHandle) clearTimeout(zcodeTimerHandle);
  if (zcodeExpiryTimerHandle) clearTimeout(zcodeExpiryTimerHandle);
  zcodeTimerHandle = null;
  zcodeExpiryTimerHandle = null;
  zcodeExpiryAt = null;
  zcodeNextTickAt = null;
}

function scheduleZcodeNextTick(delay = zcodeMsUntilNextTick()) {
  if (!autoClaimEnabled()) {
    syncZcodeScheduler();
    return;
  }
  if (zcodeTimerHandle) clearTimeout(zcodeTimerHandle);
  zcodeNextTickAt = new Date(Date.now() + delay).toISOString();
  zcodeTimerHandle = setTimeout(() => {
    zcodeTimerHandle = null;
    zcodeNextTickAt = null;
    runZcodeTick().catch((err) => logger.error('ZCODE-CLAIM', `资格轮询失败：${err?.message || err}`))
      .finally(() => scheduleZcodeNextTick());
  }, delay);
  zcodeTimerHandle.unref?.();
}

function syncZcodeScheduler(startFresh = false) {
  if (!autoClaimEnabled()) {
    clearZcodeTimers();
    return;
  }

  const expiresAt = autoClaimUntil();
  if (startFresh && zcodeTimerHandle) {
    clearTimeout(zcodeTimerHandle);
    zcodeTimerHandle = null;
    zcodeNextTickAt = null;
  }
  if (!zcodeTimerHandle && !zcodeTicking) scheduleZcodeNextTick(ZCODE_FIRST_DELAY_MS);

  if (expiresAt && zcodeExpiryAt !== expiresAt) {
    if (zcodeExpiryTimerHandle) clearTimeout(zcodeExpiryTimerHandle);
    zcodeExpiryAt = expiresAt;
    zcodeExpiryTimerHandle = setTimeout(() => {
      zcodeExpiryTimerHandle = null;
      setAutoClaimEnabled(false);
      clearZcodeTimers();
      logger.info('ZCODE-CLAIM', '自动领取时段已结束，自动领取已关闭');
    }, Math.max(0, expiresAt - Date.now()));
    zcodeExpiryTimerHandle.unref?.();
  } else if (!expiresAt && zcodeExpiryTimerHandle) {
    // 运行时长为 0（不自动关闭）：清掉可能残留的到期定时器
    clearTimeout(zcodeExpiryTimerHandle);
    zcodeExpiryTimerHandle = null;
    zcodeExpiryAt = null;
  }
}

function runZcodeTick(accountIds, { force = false } = {}) {
  const run = zcodeQueue.then(async () => {
    if (!force && !autoClaimEnabled()) return { results: [], summary: 'ZCode 自动领取已关闭' };
    zcodeTicking = true;
    const results = [];
    const claimedIds = [];
    try {
      const accounts = (await loadAccounts()).filter((a) => a.provider === 'zcode'
        && (!accountIds || accountIds.has(a.id)));
      for (const account of accounts) {
        if (!force && !autoClaimEnabled()) break;
        const label = account.name || account.uid || account.id;
        try {
          const outcome = await zcodeAutoClaim(account);
          if (!outcome) continue;
          if (outcome.status === 'checked-in') {
            claimedIds.push(account.id);
            await clearQuotaMark(account.id);
          }
          results.push({ accountId: account.id, account: label, provider: 'zcode', status: outcome.status, message: outcome.message });
          const lastResult = { status: outcome.status, message: outcome.message, amount: 0, at: new Date().toISOString() };
          await withAccounts((list) => {
            const current = list.find((a) => a.id === account.id);
            if (current) current.lastResult = lastResult;
          });
        } catch (err) {
          logger.warn('ZCODE-CLAIM', `${label} 自动领取异常：${err?.message || err}`);
        }
      }
      zcodeLastTick = {
        at: new Date().toISOString(),
        summary: `ZCode 资格轮询完成：${results.length} 个账号返回活动结果`,
        claimedIds, // 面板据此即时刷新这些账号的额度
      };
      return { results, summary: zcodeLastTick.summary };
    } finally {
      zcodeTicking = false;
    }
  });
  zcodeQueue = run.catch(() => {});
  return run;
}

/** 手动触发一次 ZCode 资格轮询（面板单账号 / 全部领取走这里），与定时轮共用同一队列；手动轮不受开关限制。 */
export function pollZcodeNow(accountIds) {
  return runZcodeTick(accountIds && accountIds.length ? new Set(accountIds) : null, { force: true });
}

async function getDoneMap(state) {
  // 任一口径下仍属于「今天」的记录都保留（0–10 点间 Qoder 记录的业务日还是昨天，不能误删）
  const keepDays = new Set([dayKey(Date.now(), 'qoder'), dayKey(Date.now(), 'workbuddy')]);
  const raw = state?.qoderDailyDone;
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  for (const key of Object.keys(map)) if (!keepDays.has(map[key])) delete map[key];
  return map;
}

/** 多次调用排队串行执行，避免并发签到和 state.json 覆盖。 */
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
  const allAccounts = await loadAccounts();
  const accounts = allAccounts.filter(
    (a) => (!opts.provider || a.provider === opts.provider)
        && (!opts.product || productOf(a.provider) === opts.product)
        && (!opts.onlyAccountId || a.id === opts.onlyAccountId)
        && typeof productImpl(a.provider)?.checkin === 'function'
  );
  const zAccounts = (opts.includeZcode !== false && autoClaimEnabled()
      && !opts.onlyAccountId
      && (!opts.provider || opts.provider === 'zcode')
      && (!opts.product || opts.product === 'zcode'))
    ? allAccounts.filter((a) => a.provider === 'zcode')
    : [];

  if (accounts.length === 0 && zAccounts.length === 0) {
    return { results: [], summary: '没有匹配的账号' };
  }

  const state = await loadState();
  const memo = await getDoneMap(state);
  const today = dayKey();
  const results = [];
  let deviceClaim = state?.deviceClaim?.day === today ? state.deviceClaim : null;

  for (const account of accounts) {
    const label = account.name || account.id;
    // 「今日已领」按各产品自己的业务日界比对：Qoder 10 点翻日，其余 0 点翻日
    const todayFor = dayKey(Date.now(), account.provider);
    try {
      if (opts.skipIfCheckedToday && memo[account.id] === todayFor) {
        results.push({ accountId: account.id, account: label, provider: account.provider, status: 'already', memoized: true });
        continue;
      }

      const ctx = refreshContext(account, (message) => logger.info('CHECKIN', `${label}：${message}`));
      let outcome = await productImpl(account.provider).checkin(account, ctx);
      outcome = { accountId: account.id, account: label, provider: account.provider, ...outcome };
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
        ...(outcome.streakDays !== undefined ? { streakDays: outcome.streakDays + (outcome.status === 'checked-in' ? 1 : 0) } : {}),
        at: new Date().toISOString(),
      };

      if (outcome.status === 'checked-in') {
        memo[account.id] = todayFor;
        account.lastCheckin = new Date().toISOString();
        logger.info('CHECKIN', `${label} 领取成功 +${outcome.claimedAmount} Credits`);
      } else if (outcome.status === 'already') {
        memo[account.id] = todayFor;
        account.lastCheckin = account.lastCheckin || new Date().toISOString();
        logger.info('CHECKIN', `${label}：${outcome.message || '今日已领'}`);
      } else if (outcome.status === 'limited') {
        memo[account.id] = todayFor;
        logger.info('CHECKIN', `${label}：${outcome.message}`);
      } else if (outcome.status === 'no-activity') {
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

  if (accounts.length) {
    await withAccounts((all) => {
      for (const updated of accounts) {
        const current = all.find((a) => a.id === updated.id);
        if (!current) continue;
        current.lastCheckin = updated.lastCheckin;
        if (updated.lastResult) current.lastResult = updated.lastResult;
        if (updated.uid && !current.uid) current.uid = updated.uid;
      }
    });
    await withState((fresh) => {
      // 只覆盖签到轮自己负责的两个键：state.json 里还有网关写的 zcodeGatewayExhausted，
      // 拿本轮开头读到的旧快照整份落盘会把别人刚写的东西抹掉
      fresh.qoderDailyDone = memo;
      fresh.deviceClaim = deviceClaim;
    });
  }

  if (zAccounts.length) {
    const zResult = await runZcodeTick(new Set(zAccounts.map((a) => a.id)));
    results.push(...zResult.results);
  }

  const claimed = results.filter((r) => r.status === 'checked-in');
  const failed = results.filter((r) => r.status === 'failed');
  const none = results.filter((r) => r.status === 'no-activity');
  const limited = results.filter((r) => r.status === 'limited');
  const already = results.length - claimed.length - failed.length - none.length - limited.length;
  const totalCredits = claimed.reduce((sum, r) => sum + (r.claimedAmount || 0), 0);
  const summary = `签到汇总：成功 ${claimed.length}（+${totalCredits} Credits）、已领 ${already}`
    + (limited.length ? `、本机限领 ${limited.length}` : '')
    + `、无活动 ${none.length}、失败 ${failed.length}`;
  logger.info('CHECKIN', summary);
  lastTick = { at: new Date().toISOString(), summary };
  return { results, summary };
}

/** 启动普通签到调度与 ZCode 独立轮询调度。 */
export function startScheduler() {
  if (timerHandle) return;
  startUsageSyncScheduler();
  warmZcodeAppVersion();
  const scheduleNext = () => {
    const delay = msUntilNextTick();
    nextTickAt = new Date(Date.now() + delay).toISOString();
    timerHandle = setTimeout(async () => {
      try {
        await runCheckinTick({ skipIfCheckedToday: true, includeZcode: false });
      } catch (err) {
        logger.error('CHECKIN', `定时轮失败：${err?.message || err}`);
      } finally {
        scheduleNext();
      }
    }, delay);
    timerHandle.unref?.();
    logger.info('CHECKIN', `定时签到已启动，下次执行约 ${Math.round(delay / 60000)} 分钟后`);
  };
  scheduleNext();
  syncZcodeScheduler();
  setTimeout(() => {
    runCheckinTick({ skipIfCheckedToday: true, includeZcode: false }).catch((err) =>
      logger.error('CHECKIN', `引导轮失败：${err?.message || err}`));
  }, 15000).unref?.();
}

export function stopScheduler() {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  nextTickAt = null;
  clearZcodeTimers();
}
