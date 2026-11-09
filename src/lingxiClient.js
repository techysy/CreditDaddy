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

/**
 * 稳定身份：WPS 会话罐里的 `uid` cookie（WPS 账号 uid，纯数字；与 wps_sid 同罐收割，
 * 登录号变了它必变）。tasks/balance 响应无任何身份字段、user 系端点 404（2026-11-09
 * 本机实测）——cookie 罐是唯一可靠身份源，多号归户（capture 匹配 / 10R 卡 source）都用它。
 * @returns {string|null}
 */
export function lingxiIdentityFromCookie(cookie) {
  for (const seg of String(cookie || '').split(';')) {
    const i = seg.indexOf('=');
    if (i < 1) continue;
    if (seg.slice(0, i).trim() === 'uid') {
      const v = seg.slice(i + 1).trim();
      if (/^\d{1,20}$/.test(v)) return v;
    }
  }
  return null;
}

/**
 * uid 展示脱敏（用户要求，手机号同款口径）：≥7 位前 3 后 3，4~6 位前 1 后 1，更短全掩。
 * 只用于行名等显示位；归户哈希 / 账号 uid / 10R source 仍用原始值。
 * @param {string|number} uid
 * @returns {string}
 */
export function maskLingxiUid(uid) {
  const s = String(uid ?? '');
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-3);
  if (s.length >= 4) return s.slice(0, 1) + '****' + s.slice(-1);
  return '****';
}

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
 * 任务面板：每日签到状态 + 智点余额/资源包一次拿全。
 * @param {string} cookie
 * @param {{ fetchImpl?: Function }} [opts]
 * @returns {Promise<{ auth: boolean, checkedIn?: boolean, reward?: number, dayReward?: number, streakDays?: number,
 *            balance?: number, packs?: Array, raw?: object, code?: string }>}
 *   auth=false = 会话失效；其余字段尽力而为（接口各自独立，某一路失败不带该字段）
 *
 * 余额接口实测形状（2026-11-07 本机实证）：
 *   { data: { bonus_credits: [{balance, value, consumed, expire_time, effect_time, sku_key}],
 *             purchased_credits: [...], total_bonus, total_purchased, total_balance, ... } }
 *   —— 余额看 total_balance（兜底 total_bonus + total_purchased）；bonus_credits[] 是逐包资源
 *   （活动赠送 +800 / 任务奖励 +100 各一行，带有效期），推 10R 按 LongCat 逐包明细出卡。
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
      if (Array.isArray(days)) {
        out.streakDays = days.filter((d) => d?.claimed || d?.status === 'claimed').length;
        // 当天奖励 = 本轮第 streakDays+1 天的 reward（每日 100 / 第七天 200，#53 实测口径）；
        // claim 响应的 total_claimed_credits 是本轮周期累计，不能当当天额展示
        const dayReward = Number(days[out.streakDays]?.reward ?? days[out.streakDays]?.rewardAmount);
        if (Number.isFinite(dayReward) && dayReward > 0) out.dayReward = dayReward;
      }
    }
    out.raw = { tasks: tasks.length };
  } catch (e) {
    return { auth: false, code: e?.message || 'network' };
  }
  // 2) 智点余额 + 资源包明细（旁路：失败不推翻 auth 判定）
  try {
    const r = await doFetch(LINGXI_BALANCE_URL, { cookie, fetchImpl });
    if (r.ok) {
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      const d = data?.data || {};
      const bal = Number(d.total_balance ?? d.total_bonus);
      if (Number.isFinite(bal)) out.balance = bal;
      // 逐包：活动赠送（bonus）+ 购买（purchased）合并，每包 {balance, value, consumed, expireAt, kind}
      const rows = [...(Array.isArray(d.bonus_credits) ? d.bonus_credits : []), ...(Array.isArray(d.purchased_credits) ? d.purchased_credits : [])];
      const packs = rows
        .map((p, i) => ({
          id: `${p?.sku_key || 'pack'}-${i}`,
          balance: Number(p?.balance) || 0,
          total: Number(p?.value) || 0,
          consumed: Number(p?.consumed) || 0,
          expireAt: p?.expire_time ? new Date(p.expire_time).toISOString() : null,
          kind: p?.sku_key === 'ai_credits_grant' ? 'grant' : String(p?.sku_key || ''),
        }))
        .filter((p) => p.total > 0 || p.balance > 0);
      if (packs.length) out.packs = packs;
    }
  } catch { /* 余额拿不到不阻断 */ }
  return out;
}

/** 资源包快照（进 meta.lingxiPacks，与 longcatPacks 同形） */
export function lingxiSnapshot(packs) {
  return { packs, at: new Date().toISOString() };
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
  // 展示口径的当天额：优先当日奖励（check_in_days[连签天数].reward），
  // 退 reward_amount；绝不直接用 claim 的 total_claimed_credits（周期累计，会虚报 N 倍）
  const reward = status.dayReward ?? status.reward ?? 100;
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

  // 2026-11-09 实测：连签第 3 天 claim 返回 total_claimed_credits=300，余额实动 +100——
  // 该字段是本轮周期累计（100×3），当当天额展示会虚报 3 倍（第七天会虚报成 800）。
  // pts 一律走任务状态的当日奖励链，不再读累计值。
  const pts = reward;
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
 * 10Router 外部配额卡：智点储值卡 + 逐包明细（与 LongCat 资源包卡同款纪律）。
 *  - Balance 汇总行 = 全部包 balance 之和（isCreditBalance + summarizesDetail）；
 *  - 逐包明细腿 = 每包一行（detailOnly，used=consumed、total=包总量、resetAt=包有效期），
 *    活动赠送包带 giftPack 标记；0 余额包也出行（可见耗尽）；
 *  - 拿不到任何包 → 单值余额卡兜底；连余额都拿不到 → message 状态卡。
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

  // live 优先，快照兜底（非 live 且 >24h 由 ageTag 标注陈粮）
  let packs = liveData?.packs;
  let ageTag = '';
  if (!Array.isArray(packs)) {
    const snap = account.meta?.quotaSnapshot;
    packs = account.meta?.lingxiPacks?.packs;
    ageTag = snapshotAgeTag(snap ?? account.meta?.lingxiPacks);
  }
  const active = (packs || []).filter((p) => p && Number.isFinite(Number(p.balance)));
  const balance = active.length
    ? active.reduce((s, p) => s + Math.max(0, Number(p.balance)), 0)
    : Number(liveData?.balance);

  const payload = {
    provider: 'lingxi',
    label,
    plan: t('智点余额') + ageTag,
  };

  if (active.length && balance > 0) {
    const pct1 = (rem, tot) => (tot > 0 ? Math.max(0, Math.min(100, Math.round((rem / tot) * 1000) / 10)) : 0);
    const totalAll = active.reduce((s, p) => s + Math.max(0, Number(p.total) || 0), 0);
    const usedAll = active.reduce((s, p) => s + Math.max(0, Number(p.consumed) || 0), 0);
    payload.quotas = {
      Balance: {
        name: `${t('剩余')} ${balance} (${t('智点')})`,
        used: usedAll,
        total: totalAll,
        remainingPercentage: pct1(balance, totalAll),
        displayRemaining: true,
        isCreditBalance: true,
        summarizesDetail: true,
      },
    };
    for (const [i, p] of active.entries()) {
      const kind = p.kind === 'grant' || (p.total > 0 && p.consumed === 0 && !Number.isFinite(p.consumed));
      payload.quotas[`Pack${i + 1}`] = {
        name: kind ? t('活动赠送包') : t('智点包'),
        used: Math.max(0, Number(p.consumed) || 0),
        total: Math.max(0, Number(p.total) || 0) || Math.max(0, Number(p.balance) || 0),
        remainingPercentage: pct1(Math.max(0, Number(p.balance)), Math.max(0, Number(p.total) || 0) || Math.max(0, Number(p.balance) || 0)),
        displayRemaining: true,
        isCreditBalance: true,
        ...(p.kind === 'grant' ? { giftPack: true } : {}),
        detailOnly: true,
        resetAt: p.expireAt || undefined,
      };
    }
  } else if (Number.isFinite(balance) && balance >= 0) {
    // 拿不到逐包（旧快照 / 接口半程失败）：单值余额卡兜底
    payload.quotas = {
      Balance: {
        name: t('智点余额'),
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
