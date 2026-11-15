/**
 * Meoo 秒悟（meoo.com，阿里云）每日首登积分 + 积分余额抓取。
 *
 * 接口（2026-11-13 网页端 bundle 与本机实测）：
 *   GET https://meoo.com/api/mc/entitlement/init
 *       网页前端登录后调用它触发「每日首次登录」积分发放（当前 2000 积分/天）。
 *       → { success: true, data: { initialized, dailyLoginGranted, dailyLoginGrantAmount, inviteRewardArrivals } }
 *       initialized=false 时前端按 500/1000/2000/4000ms 退避重查（账号权益尚在初始化）。
 *   GET https://meoo.com/api/mc/entitlement/get
 *       → data.userPointInfo.account.availableBalance（积分余额）、data.planCode、
 *         data.benefits[]（typeCode=daily_login 的 quota = 每日首登额度）
 *   GET https://meoo.com/api/v1/user/me
 *       → data.user_id / username / email；未登录 data.need_login=true
 *
 * 凭据 = meoo.com 网页会话 Cookie（阿里云 SSO 手机号 + 短信登录后由浏览器写入），
 * 不支持 Meoo CLI 的 OAuth Bearer（/api/mc/* 一律 NEED_LOGIN）。会话寿命未知——
 * 失效统一表现为 HTTP 401 或 { success:false, errCode:'NEED_LOGIN' | 'LOGIN_INVALID' }，
 * 按「会话已失效，请重新登录捕获」处理，不重试、不猜。
 *
 * 首版边界：首登积分 + 余额展示；每日首登积分约 6~7 天后过期、Free 套餐无月度积分；
 * 不推 10Router 外部配额卡（site.no10rSync），不做网关。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';

export const MEOO_BASE = 'https://meoo.com';
export const MEOO_INIT_URL = `${MEOO_BASE}/api/mc/entitlement/init`;
export const MEOO_ENTITLEMENT_URL = `${MEOO_BASE}/api/mc/entitlement/get`;
export const MEOO_USER_URL = `${MEOO_BASE}/api/v1/user/me`;

/** 前端同款退避（毫秒）：initialized=false 时最多再查这几次 */
export const MEOO_INIT_RETRY_MS = [500, 1000, 2000];

const AUTH_CODES = new Set(['NEED_LOGIN', 'LOGIN_INVALID', 'LOGIN_REQUIRED', 'NOT_LOGIN', 'UNAUTHORIZED']);

function meooHeaders(cookie) {
  return {
    Cookie: String(cookie || '').trim(),
    Referer: `${MEOO_BASE}/`,
    Origin: MEOO_BASE,
    Accept: 'application/json, text/plain, */*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

/**
 * GET 一个 Meoo 网页端点，归一成 { auth, ok, status, data, code }。
 * auth=false = 会话失效（401/403 或业务码 NEED_LOGIN 类，或 user/me 的 need_login=true）。
 */
async function meooGet(url, cookie, fetchImpl) {
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, method: 'GET', timeoutMs: FETCH_TIMEOUT_MS }));
  const r = await doIt(url, { headers: meooHeaders(cookie) });
  const text = await r.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const code = String(body?.errCode ?? body?.error?.code ?? body?.code ?? '');
  if (r.status === 401 || r.status === 403 || AUTH_CODES.has(code) || body?.data?.need_login === true) {
    return { auth: false, ok: false, status: r.status, code: code || `HTTP ${r.status}` };
  }
  if (!r.ok) return { auth: true, ok: false, status: r.status, code: code || `HTTP ${r.status}`, message: body?.errMsg || body?.message || '' };
  if (!body || typeof body !== 'object') return { auth: true, ok: false, status: r.status, code: 'non-json' };
  if (body.success === false) return { auth: true, ok: false, status: r.status, code: code || 'success=false', message: body.errMsg || body.message || '' };
  return { auth: true, ok: true, status: r.status, data: body.data ?? body };
}

function authError(msg) {
  const e = new Error(msg);
  e.auth = true;
  return e;
}

/**
 * 用户 id 展示脱敏（与灵犀 uid 同口径）：≥7 位前 3 后 3，4~6 位前 1 后 1，更短全掩。
 * 只用于行名等显示位；归户哈希 / 账号 uid 仍用原始值。
 */
export function maskMeooUserId(id) {
  const s = String(id ?? '');
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-3);
  if (s.length >= 4) return s.slice(0, 1) + '****' + s.slice(-1);
  return '****';
}

/**
 * 身份：GET /api/v1/user/me。
 * @returns {Promise<{auth: boolean, ok?: boolean, userId?: string|null, code?: string}>}
 *   username / email 可能是手机号，不回传（只取稳定 user_id 做归户）。
 */
export async function fetchMeooIdentity(cookie, { fetchImpl } = {}) {
  try {
    const r = await meooGet(MEOO_USER_URL, cookie, fetchImpl);
    if (!r.auth) return { auth: false, code: r.code };
    if (!r.ok) return { auth: true, ok: false, code: r.code };
    const id = r.data?.user_id ?? r.data?.userId ?? r.data?.open_id ?? null;
    return { auth: true, ok: true, userId: id != null && String(id) ? String(id) : null };
  } catch (e) {
    return { auth: true, ok: false, code: e?.message || 'network' };
  }
}

/** 把一条 activeGrants 记录拍平成 { source, remaining, total, effectiveAt, expireAt } 列表（形状尽力而为） */
function flattenGrants(grants) {
  const out = [];
  for (const g of Array.isArray(grants) ? grants : []) {
    const source = String(g?.sourceType || g?.source || '');
    const details = Array.isArray(g?.grantDetails) && g.grantDetails.length ? g.grantDetails : [g];
    for (const d of details) {
      const remaining = Number(d?.remainingAmount ?? d?.remaining ?? d?.availableAmount);
      if (!Number.isFinite(remaining)) continue;
      const total = Number(d?.grantAmount ?? d?.amount ?? d?.totalAmount);
      out.push({
        source,
        remaining,
        total: Number.isFinite(total) ? total : remaining,
        effectiveAt: d?.effectiveDate || null,
        expireAt: d?.expiresDate || d?.expireDate || null,
      });
    }
  }
  return out;
}

/**
 * 权益与积分余额：GET /api/mc/entitlement/get。
 * @returns {Promise<{auth: boolean, ok?: boolean, balance?: number, planCode?: string, dailyLoginQuota?: number,
 *            grants?: Array<{source, remaining, total, effectiveAt, expireAt}>, code?: string}>}
 */
export async function fetchMeooEntitlement(cookie, { fetchImpl } = {}) {
  try {
    const r = await meooGet(MEOO_ENTITLEMENT_URL, cookie, fetchImpl);
    if (!r.auth) return { auth: false, code: r.code };
    if (!r.ok) return { auth: true, ok: false, code: r.code };
    const d = r.data || {};
    const upi = d.userPointInfo || {};
    const out = { auth: true, ok: true };
    const bal = Number(upi.account?.availableBalance);
    if (Number.isFinite(bal)) out.balance = bal;
    if (d.planCode) out.planCode = String(d.planCode).toLowerCase();
    const daily = Array.isArray(d.benefits) ? d.benefits.find((b) => b?.typeCode === 'daily_login') : null;
    const dq = Number(daily?.quota);
    if (Number.isFinite(dq) && dq > 0) out.dailyLoginQuota = dq;
    const grants = flattenGrants(upi.activeGrants);
    if (grants.length) out.grants = grants;
    return out;
  } catch (e) {
    return { auth: true, ok: false, code: e?.message || 'network' };
  }
}

function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 每日首登积分：调 entitlement/init（网页端登录后同款调用）。
 *  - dailyLoginGranted=true 且金额>0 → checked-in（+N 积分）
 *  - initialized=true 但本次没有发放 → already（今日已发放，多为网页端已登录过）
 *  - initialized 一直为 false（前端同款退避后仍未就绪）→ failed，下轮自动重试
 *  - NEED_LOGIN / 401 → failed，提示重新登录捕获（不抛，签到轮记一次失败即可）
 * @returns {Promise<{ status: 'checked-in'|'already'|'failed', message: string, claimedAmount?: number, amount?: number, balanceAfter?: number, authExpired?: boolean }>}
 */
export async function checkinMeoo(account, ctx = {}) {
  const cookie = account?.meta?.cookieSiteSession?.cookie || account?.token;
  if (!cookie) {
    return { status: 'failed', authExpired: true, message: t('Meoo 会话缺失，请在「网页会话」页登录 meoo.com 后捕获') };
  }
  const fetchImpl = ctx?.fetchImpl;
  const sleep = ctx?.sleep || sleepMs;
  let r;
  try {
    r = await meooGet(MEOO_INIT_URL, cookie, fetchImpl);
    for (const ms of MEOO_INIT_RETRY_MS) {
      if (!r.auth || !r.ok || r.data?.initialized) break;
      await sleep(ms);
      r = await meooGet(MEOO_INIT_URL, cookie, fetchImpl);
    }
  } catch (e) {
    return { status: 'failed', message: t('Meoo 首登积分领取失败：{err}', { err: e?.message || 'network' }) };
  }
  if (!r.auth) {
    return { status: 'failed', authExpired: true, message: t('Meoo 会话已失效（{code}），请到「网页会话」页重新登录 meoo.com 并捕获', { code: r.code || 'NEED_LOGIN' }) };
  }
  if (!r.ok) {
    return { status: 'failed', message: t('Meoo 首登积分领取失败：{err}', { err: [r.code, r.message].filter(Boolean).join(' ').slice(0, 120) }) };
  }
  const data = r.data || {};
  if (!data.initialized) {
    return { status: 'failed', message: t('Meoo 账号权益仍在初始化，稍后自动重试') };
  }
  // 余额旁路（失败不影响领取结果）
  let balanceAfter;
  try {
    const ent = await fetchMeooEntitlement(cookie, { fetchImpl });
    if (ent.ok && Number.isFinite(ent.balance)) balanceAfter = ent.balance;
  } catch { /* 余额拿不到不阻断 */ }
  const amount = Number(data.dailyLoginGrantAmount);
  if (data.dailyLoginGranted && Number.isFinite(amount) && amount > 0) {
    ctx?.log?.(t('Meoo 首登积分领取成功'));
    return {
      status: 'checked-in',
      message: t('首登积分已发放（+{n} 积分）', { n: amount }),
      claimedAmount: amount,
      amount,
      ...(balanceAfter !== undefined ? { balanceAfter } : {}),
    };
  }
  return {
    status: 'already',
    message: t('今日首登积分已发放'),
    ...(balanceAfter !== undefined ? { balanceAfter } : {}),
  };
}

/**
 * 积分余额（quota 口径：remaining = 可用积分；parts 按发放来源逐笔，带到期日）
 */
export async function fetchMeooQuota(account, ctx = {}) {
  const cookie = account?.meta?.cookieSiteSession?.cookie || account?.token;
  if (!cookie) throw authError(t('Meoo 会话缺失，请在「网页会话」页登录 meoo.com 后捕获'));
  const ent = await fetchMeooEntitlement(cookie, { fetchImpl: ctx?.fetchImpl });
  if (!ent.auth) throw authError(t('Meoo 会话已失效（{code}），请到「网页会话」页重新登录 meoo.com 并捕获', { code: ent.code || 'NEED_LOGIN' }));
  if (!ent.ok) throw new Error(t('Meoo 积分查询失败：{err}', { err: ent.code || '' }));
  const balance = Number.isFinite(ent.balance) ? ent.balance : 0;
  const SOURCE_LABEL = { DAILY_LOGIN: '每日首登', INVITE_REWARD: '邀请奖励', SUBSCRIPTION: '订阅' };
  const parts = (ent.grants || []).map((g) => ({
    name: t(SOURCE_LABEL[g.source] || '积分包'),
    total: g.total,
    used: Math.max(0, g.total - g.remaining),
    remaining: g.remaining,
    expiresAt: isoOrNull(g.expireAt),
    recurring: false,
    unit: '秒悟积分',
  }));
  return {
    total: balance,
    used: 0,
    remaining: balance,
    exceeded: false,
    plan: ent.planCode ? `Meoo ${ent.planCode}` : 'Meoo',
    planExpiresAt: null,
    parts: parts.length ? parts : [{ name: t('积分余额'), total: balance, used: 0, remaining: balance, recurring: true, unit: '秒悟积分' }],
    empty: balance <= 0,
  };
}
