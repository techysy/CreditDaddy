/**
 * DuMate 百度搭子（console.bce.baidu.com / dumate.cn）网页会话与每日登录积分领取。
 *
 * 协议与 10Router PR #113（open-sse/services/dumate.js 及 dumateCheckin.js）完全对齐：
 *   1. 网关 token 换取（验证会话连通性）：
 *      GET https://console.bce.baidu.com/api/dumate/app/token/get
 *      - 带 Cookie 头（需含 BDUSS 与 bce-user-info）
 *      - 成功返回 { code: 0, success: true, result: { token, expired_at } }
 *      - 失败（重定向到登录页、返回 HTML 登录页或 JSON message 含“过期/登录”）判为会话失效
 *   2. 每日登录积分领取：
 *      POST https://console.bce.baidu.com/api/dumate/points/loginBonus
 *      - 请求头带 csrftoken（从 bce-user-info 解码取得）、Cookie、Origin/Referer
 *      - 接口自带幂等，成功返回 { code: 0, success: true }
 *   3. 凭据 = 百度控制台会话 Cookie（支持 raw Cookie 字符串或 JSON array），
 *      捕获后可直接同步至 10Router（映射为 dumate 连接，以 Cookie 作为 apiKey）。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';

export const DUMATE_CONSOLE_ORIGIN = 'https://console.bce.baidu.com';
export const DUMATE_CONSOLE_HOST = 'console.bce.baidu.com';
export const DUMATE_TOKEN_URL = `${DUMATE_CONSOLE_ORIGIN}/api/dumate/app/token/get`;
export const DUMATE_LOGIN_BONUS_URL = `${DUMATE_CONSOLE_ORIGIN}/api/dumate/points/loginBonus`;
export const DUMATE_QUOTA_OVERVIEW_URL = `${DUMATE_CONSOLE_ORIGIN}/api/dumate/points/quota_overview`;
export const DUMATE_USER_INFO_URL = `${DUMATE_CONSOLE_ORIGIN}/api/dumate/user/info`;
export const DUMATE_INVITE_GET_URL = `${DUMATE_CONSOLE_ORIGIN}/api/dumate/invitation_code/get`;
export const DUMATE_INVITE_REDEEM_URL = `${DUMATE_CONSOLE_ORIGIN}/api/dumate/invitation_code/redeem`;
export const DUMATE_INVITED_COUNT_URL = `${DUMATE_CONSOLE_ORIGIN}/api/dumate/invitation_code/invited/count`;
/** 个人版官网（邀请分享链接同客户端口径） */
export const DUMATE_HOME_URL = 'https://www.dumate.cn/?track=yqyl';
/** 个人版登录入口（客户端 login-config 现网值，from=oa_dumate 标记个人版渠道） */
export const DUMATE_LOGIN_URL = 'https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F';
export const DUMATE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function normCookie(c) {
  return { name: String(c.name), value: String(c.value ?? ''), domain: String(c.domain || '') };
}

/**
 * 将传入的 Cookie 凭据（字符串、JSON 数组或包含 cookies 的对象）归一化为 [{ name, value, domain }]
 */
export function parseDumateCookies(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter((c) => c && c.name).map(normCookie);
  if (typeof input === 'object') return Array.isArray(input.cookies) ? parseDumateCookies(input.cookies) : [];
  const text = String(input).trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return parseDumateCookies(JSON.parse(text));
    } catch {
      return [];
    }
  }
  const raw = text.replace(/^cookie:\s*/i, '');
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim(), domain: '' };
    })
    .filter(Boolean);
}

function domainMatches(cookie, host) {
  if (!cookie.domain) return true;
  const d = cookie.domain.replace(/^\./, '');
  return host === d || host.endsWith(`.${d}`);
}

/** 按目标 host 生成过滤后的 Cookie 头字符串 */
export function buildDumateCookieHeader(cookies, host = DUMATE_CONSOLE_HOST) {
  const list = Array.isArray(cookies) ? cookies : parseDumateCookies(cookies);
  return list
    .filter((c) => c.name && domainMatches(c, host))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * 从 bce-user-info Cookie 提取 csrftoken（URL 解码并去除两边引号）
 */
export function extractDumateCsrfToken(cookies, host = DUMATE_CONSOLE_HOST) {
  const list = Array.isArray(cookies) ? cookies : parseDumateCookies(cookies);
  const c = list.find((x) => x.name === 'bce-user-info' && domainMatches(x, host));
  if (!c?.value) return '';
  let v = c.value;
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep raw */
  }
  return v.replace(/^["']+|["']+$/g, '');
}

/**
 * 从 bce-user-info 中提取标识 ID（若包含形如 timestamp|userId 则提取后半段）
 */
export function extractDumateUserId(cookies) {
  const token = extractDumateCsrfToken(cookies);
  if (!token) return null;
  const parts = token.split('|');
  if (parts.length >= 2 && parts[1]) {
    return parts[1].trim();
  }
  return token;
}

/**
 * 补齐 bce-user-info：扫码登录、本机导入拿到的会话常常只有 BDUSS / bce-sessionid，
 * 而领取接口需要 csrftoken，其值就是 bce-user-info 的原文（等于 bce 账户 ID）。
 * 控制台首页不一定下发该 cookie，这里调 /api/dumate/app/token/get，
 * 从 Set-Cookie 的 bce-login-accountid 取账户 ID 补上。
 * @returns {Promise<Array|null>} 补好后的 cookie 数组；无需补或失败返回 null
 */
export async function healDumateCookies(cookies, fetchImpl) {
  const list = Array.isArray(cookies) ? cookies : parseDumateCookies(cookies);
  if (list.some((c) => c.name === 'bce-user-info' && c.value)) return null;
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doIt(`${DUMATE_CONSOLE_ORIGIN}/api/dumate/app/token/get`, {
      headers: {
        Cookie: buildDumateCookieHeader(list),
        Accept: 'application/json',
        Origin: DUMATE_CONSOLE_ORIGIN,
        Referer: `${DUMATE_CONSOLE_ORIGIN}/dumate/channel`,
        'User-Agent': DUMATE_USER_AGENT,
      },
      redirect: 'manual',
    });
    if (res.status < 200 || res.status >= 300) return null;
    const raw = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const extra = [];
    let accountId = '';
    for (const item of raw) {
      const [pair] = String(item).split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!name) continue;
      if (name === 'bce-login-accountid') {
        try {
          accountId = decodeURIComponent(value);
        } catch {
          accountId = value;
        }
      }
      extra.push({ name, value, domain: DUMATE_CONSOLE_HOST });
    }
    if (!accountId) return null;
    const kept = list.filter((c) => !extra.some((e) => e.name === c.name));
    return [...kept, ...extra, { name: 'bce-user-info', value: accountId, domain: DUMATE_CONSOLE_HOST }];
  } catch {
    return null;
  }
}

/**
 * 账号脱敏掩码显示
 */
export function maskDumateUserId(id) {
  const s = String(id ?? '');
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-3);
  if (s.length >= 4) return s.slice(0, 1) + '****' + s.slice(-1);
  return '****';
}

export function parseConsoleJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* fall through */
  }
  return null;
}

export function consoleMessage(payload) {
  const m = payload?.message;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object') return m.global || JSON.stringify(m);
  return '';
}

/**
 * 验证百度搭子会话并换取网关 token：
 * @returns {Promise<{ auth: boolean, ok: boolean, token?: string, expiredAt?: string, code?: string|number, error?: string }>}
 */
export async function verifyDumateSession(credentialInput, { fetchImpl } = {}) {
  const cookies = parseDumateCookies(credentialInput);
  const header = buildDumateCookieHeader(cookies);
  if (!header) {
    return { auth: false, ok: false, error: t('缺少 Cookie（需包含 console.bce.baidu.com 的 Cookie）') };
  }
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));

  try {
    const res = await doIt(DUMATE_TOKEN_URL, {
      method: 'GET',
      headers: {
        Cookie: header,
        'User-Agent': DUMATE_USER_AGENT,
        Accept: 'application/json',
        Referer: `${DUMATE_CONSOLE_ORIGIN}/`,
      },
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      return { auth: false, ok: false, error: t('DuMate 登录态已失效（控制台重定向到登录页）') };
    }

    const text = await res.text().catch(() => '');
    const payload = parseConsoleJson(text);
    if (!payload) {
      return { auth: false, ok: false, error: t('DuMate 登录态已失效（控制台返回登录页）') };
    }

    const msg = consoleMessage(payload);
    if (payload.code !== 0 || payload.success === false || !payload.result?.token) {
      const expired = /登录|过期|login/i.test(msg);
      return { auth: !expired, ok: false, code: payload.code, error: msg || `code=${payload.code}` };
    }

    return {
      auth: true,
      ok: true,
      token: payload.result.token,
      expiredAt: payload.result.expired_at,
    };
  } catch (err) {
    return { auth: true, ok: false, error: err?.message || t('网络请求异常') };
  }
}

/**
 * 每日领取登录积分：
 * @returns {Promise<{ status: 'checked-in'|'already'|'failed', claimedAmount?: number, message?: string, error?: string, authExpired?: boolean }>}
 */
export async function checkinDumate(account, { fetchImpl } = {}) {
  const cookie = account?.meta?.cookieSiteSession?.cookie || account?.token || '';
  let cookies = parseDumateCookies(cookie);
  let csrftoken = extractDumateCsrfToken(cookies);

  // 会话里缺 bce-user-info 时先补齐（扫码登录、本机导入常见）
  if (!csrftoken) {
    const healed = await healDumateCookies(cookies, fetchImpl).catch(() => null);
    if (healed) {
      cookies = healed;
      csrftoken = extractDumateCsrfToken(cookies);
    }
  }

  if (!csrftoken) {
    return { status: 'failed', error: t('Cookie 缺少 bce-user-info（无法生成 csrftoken）') };
  }

  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));

  try {
    const res = await doIt(DUMATE_LOGIN_BONUS_URL, {
      method: 'POST',
      headers: {
        Cookie: buildDumateCookieHeader(cookies),
        csrftoken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: DUMATE_CONSOLE_ORIGIN,
        Referer: `${DUMATE_CONSOLE_ORIGIN}/`,
        'User-Agent': DUMATE_USER_AGENT,
      },
      body: '{}',
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      return { status: 'failed', error: t('登录态已失效（重定向到登录页）'), authExpired: true };
    }

    const text = await res.text().catch(() => '');
    const payload = parseConsoleJson(text);
    if (!payload) {
      return { status: 'failed', error: t('登录态已失效（控制台返回登录页）'), authExpired: true };
    }

    if (payload.success === true && payload.code === 0) {
      return {
        status: 'checked-in',
        message: t('已领取今日登录赠送积分'),
      };
    }

    const msg = consoleMessage(payload);
    const expired = /登录|过期|login/i.test(msg);
    return {
      status: 'failed',
      error: msg || `code=${payload.code}`,
      authExpired: expired,
    };
  } catch (err) {
    return { status: 'failed', error: err?.message || t('网络请求异常') };
  }
}

/** 个人版控制台请求头（Cookie + csrftoken，与客户端 bceConsoleRequest 同口径） */
export function dumateConsoleHeaders(credentialInput, { json = false } = {}) {
  const cookies = parseDumateCookies(credentialInput);
  const h = {
    Cookie: buildDumateCookieHeader(cookies),
    Accept: 'application/json',
    'User-Agent': DUMATE_USER_AGENT,
    Origin: DUMATE_CONSOLE_ORIGIN,
    Referer: `${DUMATE_CONSOLE_ORIGIN}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  const csrf = extractDumateCsrfToken(cookies);
  if (csrf) h.csrftoken = csrf;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/**
 * 个人版身份：GET /api/dumate/user/info → { bceUserId, displayName, userId, firstLoginBonus }
 * @returns {Promise<{auth: boolean, ok: boolean, uid?: string, displayName?: string, code?: string|number, error?: string}>}
 */
export async function fetchDumateIdentity(credentialInput, { fetchImpl } = {}) {
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doIt(DUMATE_USER_INFO_URL, { method: 'GET', headers: dumateConsoleHeaders(credentialInput), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) return { auth: false, ok: false, error: t('DuMate 登录态已失效（控制台重定向到登录页）') };
    const payload = parseConsoleJson(await res.text().catch(() => ''));
    if (!payload) return { auth: false, ok: false, error: t('DuMate 登录态已失效（控制台返回登录页）') };
    if (payload.code !== 0 || payload.success === false) {
      const msg = consoleMessage(payload);
      return { auth: !/登录|过期|login/i.test(msg), ok: false, code: payload.code, error: msg || `code=${payload.code}` };
    }
    const r = payload.result || {};
    return { auth: true, ok: true, uid: r.bceUserId || r.userId || null, displayName: r.displayName || null };
  } catch (err) {
    return { auth: true, ok: false, error: err?.message || t('网络请求异常') };
  }
}

/**
 * 我的邀请码：GET /api/dumate/invitation_code/get → { invitationCode, type, activityId }
 */
export async function fetchDumateMyInviteCode(credentialInput, { fetchImpl } = {}) {
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doIt(DUMATE_INVITE_GET_URL, { method: 'GET', headers: dumateConsoleHeaders(credentialInput), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) return { auth: false, ok: false, error: t('DuMate 登录态已失效（控制台重定向到登录页）') };
    const payload = parseConsoleJson(await res.text().catch(() => ''));
    if (!payload) return { auth: false, ok: false, error: t('DuMate 登录态已失效（控制台返回登录页）') };
    if (payload.code !== 0 || payload.success === false) {
      const msg = consoleMessage(payload);
      return { auth: !/登录|过期|login/i.test(msg), ok: false, code: payload.code, error: msg || `code=${payload.code}` };
    }
    return { auth: true, ok: true, code: payload.result?.invitationCode || null, type: payload.result?.type || null, activityId: payload.result?.activityId || null };
  } catch (err) {
    return { auth: true, ok: false, error: err?.message || t('网络请求异常') };
  }
}

/**
 * 兑换邀请码：POST /api/dumate/invitation_code/redeem
 * body 与客户端同口径：{ invitationCode, timezone, source: 'pc' }（双方各 +2000 积分，每号仅一次）
 */
export async function redeemDumateInviteCode(credentialInput, code, { fetchImpl } = {}) {
  const clean = String(code || '').trim();
  if (!clean) return { ok: false, error: t('邀请码不能为空') };
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doIt(DUMATE_INVITE_REDEEM_URL, {
      method: 'POST',
      headers: dumateConsoleHeaders(credentialInput, { json: true }),
      body: JSON.stringify({ invitationCode: clean, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, source: 'pc' }),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) return { ok: false, authExpired: true, error: t('登录态已失效（重定向到登录页）') };
    const payload = parseConsoleJson(await res.text().catch(() => ''));
    if (!payload) return { ok: false, authExpired: true, error: t('登录态已失效（控制台返回登录页）') };
    if (payload.code !== 0 || payload.success === false) {
      const msg = consoleMessage(payload);
      return { ok: false, authExpired: /登录|过期|login/i.test(msg), error: msg || `code=${payload.code}` };
    }
    return { ok: true, message: typeof payload.message === 'string' ? payload.message : '', result: payload.result ?? null };
  } catch (err) {
    return { ok: false, error: err?.message || t('网络请求异常') };
  }
}

/**
 * 额度查询（DuMate 个人版积分概览）
 * 对齐客户端积分明细（quota_overview 接口）：
 *  - 订阅积分（subscription）
 *  - 赠送积分（login_bonus / event_bonus 等）
 *  - 增购积分（plan_point）
 *  - 最近到期时间（nearestExpiryPackage）
 */
export async function fetchDumateQuota(account, { fetchImpl } = {}) {
  const cookie = account?.meta?.cookieSiteSession?.cookie || account?.token || '';
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const url = `${DUMATE_QUOTA_OVERVIEW_URL}?timezone=${encodeURIComponent(tz)}&clientType=desktop&ignoreLoginBonus=true`;

  const res = await doIt(url, {
    method: 'GET',
    headers: dumateConsoleHeaders(cookie),
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400) {
    const err = new Error(t('DuMate 登录态已失效（控制台重定向到登录页）'));
    err.auth = true;
    throw err;
  }

  const text = await res.text().catch(() => '');
  const payload = parseConsoleJson(text);
  if (!payload) {
    const err = new Error(t('DuMate 登录态已失效（控制台返回登录页）'));
    err.auth = true;
    throw err;
  }

  if (payload.code !== 0 || payload.success === false) {
    const msg = consoleMessage(payload);
    const expired = /登录|过期|login/i.test(msg);
    const err = new Error(msg || `code=${payload.code}`);
    err.auth = expired;
    throw err;
  }

  const r = payload.result || {};
  const total = parseFloat(r.totalPoints) || 0;
  const used = parseFloat(r.usedPoints) || 0;
  const remaining = Math.max(0, total - used);

  const parts = [];
  const subs = Array.isArray(r.subscription) ? r.subscription.filter((s) => s.status === 'active') : [];
  const incs = Array.isArray(r.incremental) ? r.incremental.filter((s) => s.status === 'active') : [];

  const fmtDate = (sec) => (Number(sec) > 0 ? new Date(sec * 1000).toISOString() : null);

  for (const s of subs) {
    const pTotal = parseFloat(s.totalPoints) || 0;
    const pUsed = parseFloat(s.usedPoints) || 0;
    const pRem = Math.max(0, pTotal - pUsed);
    parts.push({
      name: s.packageType === 'plan_experience' ? t('体验版订阅积分') : t('订阅积分'),
      total: pTotal,
      used: pUsed,
      remaining: pRem,
      recurring: true,
      expiresAt: fmtDate(s.pointsExpireDate || s.expireDate),
    });
  }

  for (const s of incs) {
    const pTotal = parseFloat(s.totalPoints) || 0;
    const pUsed = parseFloat(s.usedPoints) || 0;
    const pRem = Math.max(0, pTotal - pUsed);
    const isLoginBonus = s.source === 'login_bonus';
    const isGrant = s.packageType === 'grant_point' || s.packageType === 'event_bonus';
    const name = isLoginBonus ? t('登录赠送积分') : (isGrant ? t('赠送积分') : t('增购积分'));
    parts.push({
      name,
      total: pTotal,
      used: pUsed,
      remaining: pRem,
      recurring: false,
      expiresAt: fmtDate(s.pointsExpireDate || s.expireDate),
    });
  }

  // 找最近到期包的到期时间
  let nearestExp = null;
  const allActive = [...subs, ...incs].filter((p) => p.pointsExpireDate || p.expireDate);
  allActive.sort((a, b) => (a.pointsExpireDate || a.expireDate) - (b.pointsExpireDate || b.expireDate));
  if (allActive.length > 0) {
    nearestExp = fmtDate(allActive[0].pointsExpireDate || allActive[0].expireDate);
  }

  // 付费套餐（客户端同款 currentPlanType 口径）：plan_pro / plan_max / plan_team = 付费，
  // plan_experience = 免费体验版不出徽章。取档位最高的一单。
  const PLAN_RANK = { plan_max: 3, plan_pro: 2, plan_team: 2 };
  const PLAN_LABEL = { plan_max: 'Max', plan_pro: 'PRO', plan_team: 'Team' };
  const topPaid = [...subs].sort((a, b) => (PLAN_RANK[b.packageType] || 0) - (PLAN_RANK[a.packageType] || 0))[0];
  const plan = topPaid && PLAN_RANK[topPaid.packageType] ? PLAN_LABEL[topPaid.packageType] : null;

  return {
    unit: '积分',
    total,
    used,
    remaining,
    parts: parts.length > 0 ? parts : [{ name: t('可用积分'), total, used, remaining }],
    expiresAt: nearestExp,
    exceeded: remaining <= 0,
    plan,
    planExpiresAt: topPaid ? fmtDate(topPaid.expireDate || topPaid.pointsExpireDate) : null,
  };
}
