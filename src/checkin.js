/**
 * 签到调度：普通账号按配置的间隔（默认每 2h，面板设置可调 1-8h、可全局关闭）扫描一次；
 * ZCode 自动活动领取使用独立的短周期调度。
 */

import { loadAccounts, loadSettings, loadState, withAccounts, withState } from './store.js';
import { productImpl } from './providers.js';
import { productOf, PROVIDER_LABEL } from './constants.js';
import { startUsageSyncScheduler } from './tenrouter.js';
import { refreshContext } from './accounts.js';
import { zcodeAutoClaim } from './zcodeAutoClaim.js';
import { traePrimaryIds } from './traeClient.js';
import { clearQuotaMark } from './zcodeGateway.js';
import {
  autoClaimEnabled, autoClaimUntil, enableAutoClaimFor, setAutoClaimEnabled,
  claimIntervalMin, claimWindowMin,
  warmZcodeAppVersion,
} from './zcodeClient.js';
import { warmWorkbuddyClientPath } from './workbuddyLocal.js';
import { logger } from './logger.js';
import { t as tr } from './i18n.js';

/** 全局自动签到配置：默认开启、每 120 分钟一轮；面板「设置 → 通用」可关 / 调频。 */
export async function autoCheckinEnabled() {
  return (await loadSettings()).autoCheckin !== false;
}
export async function checkinIntervalMin() {
  return Math.max(15, Number((await loadSettings()).checkinIntervalMin) || 120);
}
const TICK_JITTER_MS = 10 * 60 * 1000;
const ZCODE_JITTER_MS = 15 * 1000;
const ZCODE_FIRST_DELAY_MS = 2 * 60 * 1000;

// 各产品「业务日」刷新时点（UTC+8）：Qoder 每日 10:00 放出/重置领取资格，其余产品按 00:00。
// 签到日 = 对应时点起的日历日：dayKey(now, provider) = (now + (8 - 刷新小时)h) 的 UTC 日期
const DAY_REFRESH_HOUR_UTC8 = { qoder: 10, 'qoder-cn': 10 };
// 领取日志的积分单位：默认 Credits（Qoder/WorkBuddy 系），网页会话线各自带单位
const CHECKIN_UNIT = { lingxi: '灵点', doubao: '额度' };

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
export async function getSchedulerInfo() {
  const enabled = autoClaimEnabled();
  const autoCk = await autoCheckinEnabled();
  return {
    enabled: autoCk,
    intervalMin: await checkinIntervalMin(),
    running: Boolean(timerHandle), nextTickAt: autoCk ? nextTickAt : null, lastTick, ticking,
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

export async function msUntilNextTick(rand = Math.random) {
  return Math.max((await checkinIntervalMin()) * 60 * 1000 + Math.floor(rand() * TICK_JITTER_MS), 1000);
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
    runZcodeTick().catch((err) => logger.error('ZCODE-CLAIM', '资格轮询失败:{err}', { err: err?.message || err }))
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
      logger.info('ZCODE-CLAIM', '自动领取时段已结束,自动领取已关闭', {});
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
          if (outcome.status === 'checked-in' || outcome.status === 'partial') {
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
          logger.warn('ZCODE-CLAIM', '{label} 自动领取异常:{err}', { label, err: err?.message || err });
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
      // 手动轮（pollZcodeNow）结束时不会像定时轮那样 .finally 里补排下一个 tick；
      // 若手动轮进行中用户刚开启自动领取，syncZcodeScheduler 又因 zcodeTicking=true
      // 跳过了排程——这里兜底补排（内部先清旧句柄，重复调用无害），否则自动领取静默死掉
      if (autoClaimEnabled()) scheduleZcodeNextTick();
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
  // workbuddy-intl 无 checkin 动作（providers.js 的 intl 分支已删），providers 过滤天然跳过；
  // trae-intl 同理（ug 签到接口只在国内站注册，国际号连排程都不进——10R traeCheckin 同口径）。
  // 「活跃请求」全局开关随该机制一并删除（设置项不再读写）
  const accounts = allAccounts.filter(
    (a) => a.provider !== 'trae-intl'
        && (!opts.provider || a.provider === opts.provider)
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
  // Trae 同机多账号：真机 deviceId 只给每个设备的首账号（其余走派生号），按全量账号顺序定
  const traePrimary = traePrimaryIds(allAccounts);

  for (const account of accounts) {
    const pTag = `[${PROVIDER_LABEL[account.provider] || account.provider}]`;
    const label = `${pTag} ${account.name || account.id}`;
    // 「今日已领」按各产品自己的业务日界比对：Qoder 10 点翻日，其余 0 点翻日
    const todayFor = dayKey(Date.now(), account.provider);
    try {
      if (opts.skipIfCheckedToday && memo[account.id] === todayFor) {
        results.push({ accountId: account.id, account: label, provider: account.provider, status: 'already', memoized: true });
        continue;
      }

      const ctx = { ...refreshContext(account, (message) => logger.info('CHECKIN', '{label}:{msg}', { label, msg: message })), traePrimaryIds: traePrimary };
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
        logger.info('CHECKIN', '{label} 领取成功 +{amount} {unit}', { label, amount: outcome.claimedAmount, unit: CHECKIN_UNIT[account.provider] || 'Credits' });
      } else if (outcome.status === 'already') {
        memo[account.id] = todayFor;
        account.lastCheckin = account.lastCheckin || new Date().toISOString();
        logger.info('CHECKIN', '{label}:{msg}', { label, msg: outcome.message || '今日已领' });
      } else if (outcome.status === 'limited') {
        memo[account.id] = todayFor;
        logger.info('CHECKIN', '{label}:{msg}', { label, msg: outcome.message });
      } else if (outcome.status === 'no-activity') {
        logger.debug('CHECKIN', '{label}:{msg}', { label, msg: outcome.message || '当前无可领取的活动' });
      } else {
        logger.warn('CHECKIN', '{label} 领取失败:{err}', { label, err: outcome.error || outcome.status });
      }
    } catch (err) {
      results.push({ accountId: account.id, account: label, provider: account.provider, status: 'failed', error: err?.message || String(err) });
      account.lastResult = { status: 'failed', message: err?.message || String(err), amount: 0, at: new Date().toISOString() };
      logger.error('CHECKIN', '{label} 异常:{err}', { label, err: err?.message || err });
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
  const summaryKey = limited.length
    ? '签到汇总：成功 {ok}（+{credits} Credits）、已领 {al}、本机限领 {limited}、无活动 {none}、失败 {fail}'
    : '签到汇总：成功 {ok}（+{credits} Credits）、已领 {al}、无活动 {none}、失败 {fail}';
  const summaryArgs = { ok: claimed.length, credits: totalCredits, al: already, limited: limited.length, none: none.length, fail: failed.length };
  // 摘要走 i18n 模板（key+args，面板按界面语言 T() 渲染，与日志同源同语）；
  // summary 保留简中拼接兜底旧面板/CLI 直读（不再被面板展示路径使用）
  const summary = `签到汇总：成功 ${claimed.length}（+${totalCredits} Credits）、已领 ${already}`
    + (limited.length ? `、本机限领 ${limited.length}` : '')
    + `、无活动 ${none.length}、失败 ${failed.length}`;
  logger.info('CHECKIN', summaryKey, summaryArgs);
  lastTick = { at: new Date().toISOString(), summary, summaryKey, summaryArgs };
  return { results, summary, summaryKey, summaryArgs };
}

async function scheduleTick() {
  const delay = await msUntilNextTick();
  nextTickAt = new Date(Date.now() + delay).toISOString();
  timerHandle = setTimeout(async () => {
    try {
      await runCheckinTick({ skipIfCheckedToday: true, includeZcode: false });
    } catch (err) {
      logger.error('CHECKIN', '定时轮失败:{err}', { err: err?.message || err });
    } finally {
      scheduleTick();
    }
  }, delay);
  timerHandle.unref?.();
  logger.info('CHECKIN', '定时签到已启动,下次执行约 {min} 分钟后', { min: Math.round(delay / 60000) });
}

/** 启动普通签到调度与 ZCode 独立轮询调度。 */
export async function startScheduler() {
  if (timerHandle) return;
  startUsageSyncScheduler();
  startWebSessionWatch();
  warmZcodeAppVersion();
  // WorkBuddy 自定义安装路径发现（issue #46）：注册表 / 进程探测要起子进程，
  // 只能在这里异步预热一次；detectWorkbuddy 本身保持同步零子进程（1.6.6 白屏教训）。
  warmWorkbuddyClientPath().catch(() => {});
  if (await autoCheckinEnabled()) {
    scheduleTick();
    setTimeout(() => {
      runCheckinTick({ skipIfCheckedToday: true, includeZcode: false }).catch((err) =>
        logger.error('CHECKIN', '引导轮失败:{err}', { err: err?.message || err }));
    }, 15000).unref?.();
  } else {
    logger.info('CHECKIN', '自动签到已关闭（面板设置可开启）');
  }
  syncZcodeScheduler();
}

/** 面板修改全局自动签到开关 / 频率后重同步（daemon PUT /api/settings 调用）。 */
export async function resyncAutoCheckinScheduler() {
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; nextTickAt = null; }
  if (await autoCheckinEnabled()) scheduleTick();
  else logger.info('CHECKIN', '自动签到已关闭');
}

export function stopScheduler() {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  nextTickAt = null;
  clearZcodeTimers();
}


// ── Qoder 网页会话保活监视（10R 联调反馈：三账号 cookie 齐过期才在 10R 卡面发现）──
// 网页会话 cookie 无法离线续期（必须真浏览器登录），但可以**提前发现**：每日用已存
// cookie 真探测一次（probeWebSession），失效落 meta.qoderWebDead——面板徽章从
// 「7 天陈旧」升级成「已失效」红色态，导出提示同步点名，不再等 10R 卡面亮红。
let wsWatchTimer = null;
const WS_WATCH_INTERVAL_MS = 6 * 3600 * 1000;   // 每 6 小时一检（cookie 寿命以天计，足够密）

/**
 * 保活监视单轮（导出以便回归测试直测）：
 *  - probeWebSession 明确拒绝（返回 null）→ 判死，落 meta.qoderWebDead
 *  - 探测通过 → 清标记（复活）
 *  - 网络异常（抛错）→ 保守不动标记（下一轮再试，避免抖动误杀）
 */
export async function runWebSessionWatchTick() {
  const { probeWebSession } = await import('./qoderClient.js');
  const accounts = await loadAccounts();
  const qoders = accounts.filter((a) => String(a.provider || '').startsWith('qoder')
    && a.meta?.qoderWebSession?.cookie);
  for (const a of qoders) {
    const cookie = a.meta.qoderWebSession.cookie;
    let dead = false;
    try {
      const probe = await probeWebSession(a.provider, cookie);
      dead = !probe?.user_id;   // 探测接口不认这份 cookie = 失效
    } catch { continue; }       // 网络异常保守跳过（下一轮再试），只有明确被拒才判死
    if (dead !== Boolean(a.meta.qoderWebDead)) {
      await withAccounts((list) => {
        const hit = list.find((x) => x.id === a.id);
        if (!hit) return;
        hit.meta = { ...(hit.meta || {}) };
        if (dead) hit.meta.qoderWebDead = { at: new Date().toISOString() };
        else delete hit.meta.qoderWebDead;
        hit.updatedAt = new Date().toISOString();
      });
      if (dead) logger.warn('WEBSession', '{name} 网页会话已失效（探测接口拒绝）——请重新「浏览器登录」补 cookie', { name: a.name || a.id });
    }
  }
}

export function startWebSessionWatch() {
  if (wsWatchTimer) return;
  const tick = () => runWebSessionWatchTick().catch((e) =>
    logger.warn('WEBSession', '网页会话保活监视失败:{err}', { err: e?.message || e }));
  setTimeout(tick, 45 * 1000).unref?.();   // 启动 45 秒后先跑一轮首检
  wsWatchTimer = setInterval(tick, WS_WATCH_INTERVAL_MS);
  wsWatchTimer.unref?.();
}
