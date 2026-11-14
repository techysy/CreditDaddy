/**
 * Meoo 秒悟控制面 API 客户端（issue #65 独立产品线）。
 *
 * Meoo 有正规的 CLI API 面（2026-11-15 实测验证），凭证两种：
 *   - OAuth 令牌（meooAuth.js PKCE 回环换发，access + refresh）
 *   - 控制面 Key（meoo.com → 设置 → API 密钥，meoo_ak_ 开头）
 * 请求头统一：Authorization: Bearer <token> + X-Meoo-Client: cli + X-Meoo-CLI-Version: 0.5.8
 *
 *   GET /open/v1/cli-compat/account/identity      身份（uid / 昵称）
 *   GET /open/v1/cli-compat/account/points        积分账面：data.account.{availableBalance,
 *       totalGranted, totalConsumed, totalExpired} + data.activeGrants[]（按来源聚合；
 *       grantDetails[].expiresDate 是批次有效期——每日赠送 6 天滚动、订阅/邀请 30 天）
 *   GET /open/v1/cli-compat/projects              项目列表
 *   GET /open/v1/cli-compat/projects/{urlId}/cloud/environment → data.meooProjectApiKey
 *       （enabled:false = 云服务未开）
 *
 * 签到：没有领取端点——「领取」= 登录等价动作（身份读）+ totalGranted 增量核验
 * （10R meoo-daily-claim 同款算法，claimed=true 仅当账面真的涨了，绝不假装成功）。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';

export const MEOO_CP_BASE = 'https://meoo.com';
export const MEOO_IDENTITY_URL = `${MEOO_CP_BASE}/open/v1/cli-compat/account/identity`;
export const MEOO_POINTS_URL = `${MEOO_CP_BASE}/open/v1/cli-compat/account/points`;
export const MEOO_PROJECTS_URL = `${MEOO_CP_BASE}/open/v1/cli-compat/projects?page_size=50&view=created`;
export const MEOO_PROJECT_AK_URL = (urlId) => `${MEOO_CP_BASE}/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud/environment`;

export const MEOO_CP_HEADERS = {
  'X-Meoo-Client': 'cli',
  'X-Meoo-CLI-Version': '0.5.8',
};

/** 用户 id 展示脱敏（与灵犀 uid 同口径）：≥7 位前 3 后 3，4~6 位前 1 后 1，更短全掩 */
export function maskMeooUserId(id) {
  const s = String(id ?? '');
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-3);
  if (s.length >= 4) return s.slice(0, 1) + '****' + s.slice(-1);
  return '****';
}

/** 控制面统一请求头 */
export function meooCpHeaders(token) {
  return {
    Authorization: `Bearer ${String(token || '').trim()}`,
    ...MEOO_CP_HEADERS,
    Accept: 'application/json',
  };
}

/**
 * 控制面 GET，归一成 { auth, ok, status, data, code, error }。
 * auth=false = 凭据失效（401/403 或业务 NEED_LOGIN 类）。
 */
async function cpGet(url, token, fetchImpl) {
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, method: 'GET', timeoutMs: FETCH_TIMEOUT_MS }));
  let r;
  try {
    r = await doIt(url, { headers: meooCpHeaders(token) });
  } catch (e) {
    return { auth: true, ok: false, code: 'network', error: e?.message || 'network' };
  }
  const text = await r.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const code = String(body?.errCode ?? body?.error?.code ?? body?.code ?? '');
  if (r.status === 401 || r.status === 403) return { auth: false, ok: false, status: r.status, code: code || `HTTP ${r.status}` };
  if (!r.ok) return { auth: true, ok: false, status: r.status, code: code || `HTTP ${r.status}`, error: body?.errMsg || body?.message || '' };
  if (!body || typeof body !== 'object') return { auth: true, ok: false, status: r.status, code: 'non-json' };
  if (body.success === false) {
    const authCodes = new Set(['NEED_LOGIN', 'LOGIN_INVALID', 'LOGIN_REQUIRED', 'NOT_LOGIN', 'UNAUTHORIZED']);
    if (authCodes.has(code)) return { auth: false, ok: false, status: r.status, code };
    return { auth: true, ok: false, status: r.status, code: code || 'success=false', error: body.errMsg || body.message || '' };
  }
  return { auth: true, ok: true, status: r.status, data: body.data ?? body };
}

/**
 * 身份：GET identity → { auth, ok, uid, name }
 */
export async function fetchMeooIdentity(token, { fetchImpl } = {}) {
  const r = await cpGet(MEOO_IDENTITY_URL, token, fetchImpl);
  if (!r.auth) return { auth: false, ok: false, code: r.code };
  if (!r.ok) return { auth: true, ok: false, code: r.code, error: r.error };
  const d = r.data || {};
  const uid = d.user_id ?? d.userId ?? d.uid ?? d.id ?? null;
  const name = d.username ?? d.nickname ?? d.displayName ?? null;
  return { auth: true, ok: true, uid: uid != null && String(uid) ? String(uid) : null, name: name ? String(name) : null };
}

/** 把一条 activeGrants 聚合记录拍平成 quota part（到期取批次中最近的有效期） */
function grantToPart(g) {
  const total = Number(g?.totalInitialAmount);
  const remaining = Number(g?.totalRemainingAmount);
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const expiries = (Array.isArray(g?.grantDetails) ? g.grantDetails : [])
    .map((d) => (d?.expiresDate ? Date.parse(d.expiresDate) : NaN))
    .filter((ms) => Number.isFinite(ms));
  const source = String(g?.sourceTypeName || g?.sourceType || '').trim();
  return {
    name: source || t('赠送积分'),
    total: Number.isFinite(total) ? total : remaining,
    used: Number.isFinite(total) ? Math.max(0, total - remaining) : 0,
    remaining,
    recurring: /订阅|subscription/i.test(source),
    expiresAt: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null,
  };
}

/**
 * 积分账面：GET points → { auth, ok, balance, totalGranted, totalConsumed, totalExpired, grants[] }
 */
export async function fetchMeooPoints(token, { fetchImpl } = {}) {
  const r = await cpGet(MEOO_POINTS_URL, token, fetchImpl);
  if (!r.auth) return { auth: false, ok: false, code: r.code };
  if (!r.ok) return { auth: true, ok: false, code: r.code, error: r.error };
  const account = r.data?.account || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const grants = (Array.isArray(r.data?.activeGrants) ? r.data.activeGrants : [])
    .map(grantToPart).filter(Boolean);
  return {
    auth: true,
    ok: true,
    balance: num(account.availableBalance) ?? 0,
    totalGranted: num(account.totalGranted) ?? null,
    totalConsumed: num(account.totalConsumed) ?? 0,
    totalExpired: num(account.totalExpired) ?? null,
    grants,
  };
}

/**
 * 额度（quota 口径）：total = 累计发放（容量口径），used = 累计消耗，
 * remaining = 可用余额；parts 按来源逐包（带批次到期日）。
 */
export async function fetchMeooQuota(account, { fetchImpl } = {}) {
  const token = account?.token;
  if (!token) { const e = new Error(t('Meoo 凭据缺失，请重新登录或粘贴控制面 Key')); e.auth = true; throw e; }
  const pts = await fetchMeooPoints(token, { fetchImpl });
  if (!pts.auth) { const e = new Error(t('Meoo 凭据已失效（{code}），请重新登录或更换控制面 Key', { code: pts.code || '401' })); e.auth = true; throw e; }
  if (!pts.ok) throw new Error(pts.error || t('Meoo 积分查询失败'));
  const total = Number.isFinite(pts.totalGranted) ? pts.totalGranted : pts.balance;
  return {
    unit: '积分',
    total,
    used: pts.totalConsumed ?? 0,
    remaining: pts.balance,
    exceeded: pts.balance <= 0,
    parts: pts.grants.length ? pts.grants : [{ name: t('可用积分'), total, used: pts.totalConsumed ?? 0, remaining: pts.balance }],
    empty: pts.balance <= 0,
  };
}

/**
 * 项目 AK（推送 10R 前预解析，连接落地即用）：
 * @returns {{ urlId: string|null, apiKey: string|null, akStatus: 'active'|'disabled'|'none' }}
 */
export async function resolveMeooProjectAk(token, { fetchImpl } = {}) {
  try {
    const pr = await cpGet(MEOO_PROJECTS_URL, token, fetchImpl);
    if (!pr.ok) return { urlId: null, apiKey: null, akStatus: 'none' };
    const list = Array.isArray(pr.data?.projects) ? pr.data.projects
      : Array.isArray(pr.data?.list) ? pr.data.list
      : Array.isArray(pr.data) ? pr.data : [];
    const first = list.find((p) => p?.urlId || p?.id) || null;
    const urlId = first ? String(first.urlId ?? first.id) : null;
    if (!urlId) return { urlId: null, apiKey: null, akStatus: 'none' };
    const ar = await cpGet(MEOO_PROJECT_AK_URL(urlId), token, fetchImpl);
    const ak = ar.ok ? ar.data?.meooProjectApiKey : null;
    if (!ak || ak.enabled === false) return { urlId, apiKey: null, akStatus: ak && ak.enabled === false ? 'disabled' : 'none' };
    return { urlId, apiKey: String(ak.apiKey || ak.key || '') || null, akStatus: 'active' };
  } catch {
    return { urlId: null, apiKey: null, akStatus: 'none' };
  }
}

/**
 * 每日登录积分（无领取端点）：基线账面 → 登录等价动作（身份读，OAuth 行同样以
 * 控制面读触发；10R 同款口径）→ 复读账面 → delta 判定。claimed=true 仅当
 * totalGranted 真的涨了，绝不假装成功。
 * @returns {{ status: 'checked-in'|'already'|'failed', claimedAmount?, amount?, balanceAfter?, message?, authExpired? }}
 */
export async function checkinMeoo(account, ctx = {}) {
  const token = account?.token;
  const fetchImpl = ctx?.fetchImpl;
  const sleep = ctx?.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!token) return { status: 'failed', message: t('Meoo 凭据缺失，请重新登录或粘贴控制面 Key') };

  // ① 基线账面
  let before;
  try { before = await fetchMeooPoints(token, { fetchImpl }); } catch (e) {
    return { status: 'failed', message: t('Meoo 积分账面读取失败：{err}', { err: e?.message || 'network' }) };
  }
  if (!before.auth) return { status: 'failed', authExpired: true, message: t('Meoo 凭据已失效（{code}），请重新登录或更换控制面 Key', { code: before.code || '401' }) };
  if (!before.ok || !Number.isFinite(before.totalGranted)) {
    return { status: 'failed', message: t('Meoo 未返回积分账面数据，无法核验领取结果') };
  }

  // ② 登录等价动作：OAuth 行强制刷新一次令牌（10R 同款——刷新即登录信号），
  //    Key 行做一次带凭据的身份读。都 best-effort，成败由复读裁决。
  let credential = token;
  if (account?.refreshToken) {
    try {
      const { refreshMeooToken } = await import('./meooAuth.js');
      const tok = await refreshMeooToken(account.refreshToken);
      credential = tok.access_token;
      const refreshed = {
        token: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString(),
      };
      // 刷新结果回写账号库（refreshContext），10R 同步行下次推新令牌
      try { await ctx?.onRefresh?.(refreshed); } catch { /* 回写失败不阻断 */ }
    } catch { /* 刷新失败不阻断——复读账面裁决 */ }
  }
  try { await fetchMeooIdentity(credential, { fetchImpl }); } catch { /* 触发动作本身不是裁决 */ }

  // ③ 复读账面（发放落账有延迟，短重试几拍）
  let after = before;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);
    try { after = await fetchMeooPoints(credential, { fetchImpl }); } catch { break; }
    if (Number.isFinite(after?.totalGranted) && after.totalGranted > before.totalGranted) break;
  }

  // ④ 账面裁决
  const delta = Number.isFinite(after?.totalGranted) ? after.totalGranted - before.totalGranted : 0;
  const balance = Number.isFinite(after?.balance) ? after.balance : before.balance;
  if (delta > 0) {
    ctx?.log?.(t('Meoo 每日登录积分已到账'));
    return {
      status: 'checked-in',
      message: t('已领取每日登录积分 +{n}', { n: delta }),
      claimedAmount: delta,
      amount: delta,
      balanceAfter: balance,
    };
  }
  // 已领过也算当日闭环（10R 同口径：再触发只是白做动作）
  return { status: 'already', message: t('今日可能已领取，或该权益需在 meoo.com 网页登录触发'), balanceAfter: balance };
}
