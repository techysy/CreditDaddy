/**
 * WPS 灵犀（lingxi.kdocs.cn）签到与灵点余额抓取（issue #53）。
 *
 * 接口（提案者 2026-11-06 本机实测）：
 *   GET  https://lingxi.kdocs.cn/api/public/v1/tasks
 *        data.tasks[] 里 task_key == 'daily_check_in'，status 是 claimed / available
 *   POST https://lingxi.kdocs.cn/api/public/v1/tasks/daily_check_in/claim?date=YYYY-MM-DD
 *        → {"result":"ok","data":{"total_claimed_credits":...}}
 *   GET  https://lingxi.kdocs.cn/api/public/v1/credits/balance
 *
 * 奖励：每天 100 灵点，七天一轮第七天 200（提案者实测，网上旧文「200/天」已过时）。
 * 凭据 = WPS 会话 Cookie（wps_sid / kso_sid / rtk 等约 300+ 天），无签名参数。
 * 幂等性提案者未验证：claimed 状态下不再 POST claim（先查 tasks，status=available 才 claim）。
 *
 * 首版边界（按 #53 讨论）：签到 + 灵点余额；不做网关 / 对话补全（补全端点提案者未看清）。
 * 灵点只在灵犀界面消费，官方无 API——推送 10Router 只带余额数字出卡。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';
import { snapshotAgeTag } from './externalQuota.js';

export const LINGXI_BASE = 'https://lingxi.kdocs.cn';
export const LINGXI_TASKS_URL = `${LINGXI_BASE}/api/public/v1/tasks`;
export const LINGXI_BALANCE_URL = `${LINGXI_BASE}/api/public/v1/credits/balance`;

export const DAILY_CHECK_IN_KEY = 'daily_check_in';

function lingxiHeaders(cookie) {
  return {
    Cookie: String(cookie || '').trim(),
    Referer: `${LINGXI_BASE}/`,
    Origin: LINGXI_BASE,
    Accept: 'application/json, text/plain, */*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

function doFetch(url, { method = 'GET', cookie, fetchImpl } = {}) {
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, method, timeoutMs: FETCH_TIMEOUT_MS }));
  return doIt(url, { headers: lingxiHeaders(cookie) });
}

function authErr(status) {
  const e = new Error(`灵犀会话已失效（HTTP ${status}）`);
  e.auth = true;
  return e;
}

/** 本地日 YYYY-MM-DD（claim 的 date 参数按提案者实测口径） */
function localDayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 任务面板：每日签到状态 + 灵点余额一次拿全。
 * @param {string} cookie
 * @param {{ fetchImpl?: Function }} [opts]
 * @returns {Promise<{ auth: boolean, checkedIn?: boolean, reward?: number, streakDays?: number, balance?: number, raw?: object, code?: string }>}
 *   auth=false = 会话失效；其余字段尽力而为（接口各自独立，某一路失败不带该字段）
 */
export async function fetchLingxiStatus(cookie, { fetchImpl } = {}) {
  const out = { auth: true };
  // 1) 任务列表（探测 + 签到状态）
  try {
    const r = await doFetch(LINGXI_TASKS_URL, { cookie, fetchImpl });
    if (r.status === 401 || r.status === 403) return { auth: false };
    if (!r.ok) return { auth: false, code: `HTTP ${r.status}` };
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { return { auth: false, code: 'non-json' }; }
    const tasks = data?.data?.tasks;
    if (!Array.isArray(tasks)) return { auth: false, code: 'no-tasks' };
    const daily = tasks.find((x) => x?.task_key === DAILY_CHECK_IN_KEY || x?.taskKey === DAILY_CHECK_IN_KEY);
    if (daily) {
      out.checkedIn = String(daily.status || '') === 'claimed';
      const reward = Number(daily.reward_amount ?? daily.rewardAmount);
      if (Number.isFinite(reward) && reward > 0) out.reward = reward;
      const days = daily.extra?.check_in_days || daily.extra?.checkInDays;
      if (Array.isArray(days)) out.streakDays = days.filter((d) => d?.claimed || d?.status === 'claimed').length;
    }
    out.raw = { tasks: tasks.length };
  } catch (e) {
    return { auth: false, code: e?.message || 'network' };
  }
  // 2) 灵点余额（旁路：失败不推翻 auth 判定）
  try {
    const r = await doFetch(LINGXI_BALANCE_URL, { cookie, fetchImpl });
    if (r.ok) {
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      const bal = Number(data?.data?.total_credits ?? data?.data?.totalCredits ?? data?.data?.credits ?? data?.data?.balance);
      if (Number.isFinite(bal)) out.balance = bal;
    }
  } catch { /* 余额拿不到不阻断 */ }
  return out;
}

/**
 * 每日签到：先查任务状态（claimed 直接返回已签），available 才 POST claim。
 * 幂等性未验证（提案者停在了风控边界），所以绝不盲打 claim。
 * @returns {{ status: 'checked-in'|'already'|'failed', message: string, claimedAmount?: number }}
 */
export async function checkinLingxi(account, ctx = {}) {
  const cookie = account?.meta?.cookieSiteSession?.cookie;
  if (!cookie) {
    const e = new Error('灵犀会话缺失，请在「网页会话」页重新登录捕获');
    e.auth = true;
    throw e;
  }
  const log = ctx?.log;
  // 1. 任务状态
  let status;
  try {
    status = await fetchLingxiStatus(cookie, { fetchImpl: ctx?.fetchImpl });
  } catch (e) {
    return { status: 'failed', message: t('灵犀签到查询失败：{err}', { err: e.message }) };
  }
  if (!status.auth) {
    const e = new Error('灵犀会话已失效，请到「网页会话」页重新登录捕获');
    e.auth = true;
    throw e;
  }
  const reward = status.reward ?? 100;
  if (status.checkedIn) {
    return {
      status: 'already',
      message: t('今日已签到（+{n} 灵点）', { n: reward }),
      amount: reward,
      streakDays: status.streakDays,
    };
  }
  // 2. claim（仅 available 时）
  const claimUrl = `${LINGXI_BASE}/api/public/v1/tasks/${DAILY_CHECK_IN_KEY}/claim?date=${localDayKey()}`;
  let claimData = null;
  try {
    const r = await doFetch(claimUrl, { method: 'POST', cookie, fetchImpl: ctx?.fetchImpl });
    const text = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) {
      const e = new Error('灵犀会话已失效，请重新登录捕获');
      e.auth = true;
      throw e;
    }
    try { claimData = text ? JSON.parse(text) : null; } catch { claimData = null; }
    if (!r.ok) {
      return { status: 'failed', message: t('灵犀签到失败：HTTP {n} {msg}', { n: r.status, msg: (claimData?.message || claimData?.error || '').slice(0, 120) }) };
    }
    if (claimData && claimData.result !== 'ok' && claimData?.code && String(claimData.code) !== '0') {
      // 服务端明确拒绝（如风控 / 重复）：如实上抛，不猜
      return { status: 'failed', message: t('灵犀签到被拒：{msg}', { msg: String(claimData.message || claimData.error || claimData.code).slice(0, 120) }) };
    }
  } catch (e) {
    if (e.auth) throw e;
    return { status: 'failed', message: t('灵犀签到失败：{err}', { err: e.message }) };
  }

  const claimed = Number(claimData?.data?.total_claimed_credits ?? claimData?.data?.totalClaimedCredits);
  const pts = Number.isFinite(claimed) && claimed > 0 ? claimed : reward;
  log?.('灵犀签到成功');
  return {
    status: 'checked-in',
    message: t('签到成功（+{n} 灵点）', { n: pts }),
    claimedAmount: pts,
    amount: pts,
    ...(Number.isFinite(status.balance) ? { balanceAfter: status.balance } : {}),
  };
}

/**
 * 灵点余额（quota 口径：remaining = 灵点余额）
 */
export async function fetchLingxiQuota(account, ctx = {}) {
  const cookie = account?.meta?.cookieSiteSession?.cookie;
  if (!cookie) {
    const e = new Error('灵犀会话缺失，请重新登录捕获');
    e.auth = true;
    throw e;
  }
  const status = await fetchLingxiStatus(cookie, { fetchImpl: ctx?.fetchImpl });
  if (!status.auth) {
    const e = new Error('灵犀会话已失效，请重新登录捕获');
    e.auth = true;
    throw e;
  }
  const balance = Number(status.balance);
  return {
    total: Number.isFinite(balance) ? balance : 0,
    used: 0,
    remaining: Number.isFinite(balance) ? balance : 0,
    exceeded: false,
    plan: t('灵点'),
    planExpiresAt: null,
    parts: Number.isFinite(balance) ? [{
      name: t('灵点余额'),
      total: balance,
      used: 0,
      remaining: balance,
      recurring: true,
      unit: '灵点',
    }] : [],
    empty: !Number.isFinite(balance) || balance <= 0,
  };
}

/**
 * 10Router 外部配额卡（灵点余额单值卡，与 xiaomi-mimo 同款形状）
 */
export function buildLingxiQuotaPayload(account, liveData = null) {
  const uid = account.uid || identityHashOfLocal(account) || 'default';
  const cleanSource = `lingxi-${String(uid).toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 32);
  const label = String(account?.name || '').trim() || t('WPS 灵犀');

  if (liveData?.authInvalid) {
    return {
      source: cleanSource,
      payload: {
        provider: 'lingxi',
        label,
        message: liveData.error || t('灵犀会话已失效，请在 CreditDaddy「网页会话」页重新登录捕获'),
      },
    };
  }

  const snap = account.meta?.quotaSnapshot;
  let balance = Number(liveData?.balance);
  let ageTag = '';
  if (!Number.isFinite(balance)) {
    balance = Number(snap?.total);
    ageTag = snapshotAgeTag(snap);
  }

  const payload = {
    provider: 'lingxi',
    label,
    plan: t('灵点余额') + ageTag,
  };
  if (Number.isFinite(balance) && balance >= 0) {
    payload.quotas = {
      Balance: {
        name: t('灵点余额'),
        used: 0,
        total: Math.max(0, balance) || 0.000001,
        displayRemaining: true,
        isCreditBalance: true,
        recurring: true,
      },
    };
  } else {
    payload.message = t('灵点余额暂不可查（会话失效请重新登录捕获，或官方接口异常稍后自动重试）');
  }
  return { source: cleanSource, payload };
}

// 本地身份哈希（避免与 cookieSites 循环依赖；口径同 identityHashOf）
function identityHashOfLocal(account) {
  const v = account?.meta?.identityHash || account?.email || account?.name || '';
  if (!v) return null;
  let h = 0;
  const s = String(v);
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) | 0) >>> 0;
  return 'ih' + h.toString(36);
}
