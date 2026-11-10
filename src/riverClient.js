/**
 * River AI（console.river.ai）网页控制台余额抓取（联调：$25 免费额度卡）。
 *
 * 凭据 = WorkOS SPA 会话（localStorage `workos:access-token` / `workos:refresh-token` /
 * `workos:expires-at` / `workos:user`）——console API 只认 `Authorization: Bearer <WorkOS JWT>`，
 * cookie 无关。`rv_` 开头的 API key 只能打 api.river.ai 的 OpenAI 兼容面（/v1/models 等），
 * **看不到余额**（/v1/billing 等是 gRPC UNIMPLEMENTED），所以走网页会话线
 * （issue #23 收割线的 localStorage 变体，desktop 侧按 site.localStorageKeys 收割）。
 *
 * 余额：GET /api/billing/account → { balance_usd: number, ... }（联调实测消费口径）。
 * 刷新：POST https://auth.console.river.ai/user_management/authenticate
 *       body { client_id, grant_type: "refresh_token", refresh_token }——WorkOS 单次轮换：
 *       刷新成功旧 refresh 立即作废，新链必须当场原子落盘（与 minimaxClient 同款防护，
 *       绝不依赖调用方传回调）。client_id 公开（GET /api/auth/config → workos_client_id）。
 *
 * 安全纪律：会话 token 只存本机账号库（0600），推送到 10Router 的载荷只带余额数字。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';
import { snapshotAgeTag } from './externalQuota.js';

export const RIVER_CONSOLE_BASE = 'https://console.river.ai';
export const RIVER_BILLING_URL = `${RIVER_CONSOLE_BASE}/api/billing/account`;
export const RIVER_AUTH_CONFIG_URL = `${RIVER_CONSOLE_BASE}/api/auth/config`;
/** WorkOS AuthKit SPA 的 localStorage 键（desktop 收割按此名单读） */
export const RIVER_STORAGE_KEYS = ['workos:access-token', 'workos:refresh-token', 'workos:expires-at', 'workos:user'];
/** WorkOS 刷新端点（console 配置 workos_api_hostname = auth.console.river.ai） */
export const RIVER_WORKOS_AUTH_BASE = 'https://auth.console.river.ai';

/**
 * 从 JWT payload 的 exp 提取绝对到期时间（ISO 字符串）。
 * @param {string} token
 * @returns {string|null}
 */
export function jwtExpiresAt(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * 判断 Bearer token 是否已过期。
 * 留 60 秒容差：WorkOS 上游有时钟容差（实测过期 25 秒仍返 200）；
 * 过早判定会白刷一次单次轮换的 refresh 链（多消耗一次轮换，且有与浏览器抢刷新的风险）。
 * 只有在已过期且超过 60 秒容差后才视为过期。
 */
export function isBearerExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() > t + 60_000;
}

const RIVER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function riverHeaders(token) {
  return {
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${String(token || '').trim()}`,
    Referer: `${RIVER_CONSOLE_BASE}/billing`,
    'User-Agent': RIVER_UA,
  };
}

/**
 * 解析 desktop 收割到的 localStorage 快照 → WorkOS 会话对象。
 * 实测（2026-10-14 联调复盘）：console SPA 的 WorkOS AuthKit 把 token 放**内存 Map**
 * （`Co`），localStorage 通常为空；持久会话走 **cookie 通道**（`WORKOS_REFRESH_SESSION`）。
 * 键名仍按标准四键 + 前缀扫描兜底（dev 模式 / 旧版 SDK 可能写盘；refresh 键带 clientId 后缀）。
 * @param {Record<string, string|null>} storage 键值均为 localStorage 原文（user 为 JSON 串）
 * @returns {{ accessToken: string|null, refreshToken: string|null, expiresAt: string|null, user: {id?: string, email?: string, name?: string} }}
 */
export function parseRiverSession(storage) {
  const s = storage && typeof storage === 'object' ? storage : {};
  const pick = (k) => {
    const v = s[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  // refresh 键可能是 workos:refresh-token 或 workos:refresh-token:<clientId>（f5() 拼键）
  const refresh = pick('workos:refresh-token')
    || Object.entries(s).find(([k, v]) => k.startsWith('workos:refresh-token:') && typeof v === 'string' && v.trim())?.[1]?.trim()
    || null;
  let user = {};
  try {
    const raw = pick('workos:user');
    if (raw) {
      const u = JSON.parse(raw);
      user = {
        id: u.id || u.user_id || null,
        email: u.email || null,
        name: [u.firstName || u.first_name, u.lastName || u.last_name].filter(Boolean).join(' ') || u.name || null,
      };
    }
  } catch { /* user 解析失败不影响 token 可用性 */ }
  const at = pick('workos:access-token');
  const exp = pick('workos:expires-at') || jwtExpiresAt(at);
  return {
    accessToken: at,
    refreshToken: refresh,
    expiresAt: exp,
    user,
  };
}

/** 账号 → 会话对象（meta.workosSession 为准，token 字段兜底 accessToken，cookie 取 cookieSiteSession） */
export function riverSessionOf(account) {
  const cookie = account?.meta?.workosSession?.cookie || account?.meta?.cookieSiteSession?.cookie || '';
  const sess = account?.meta?.workosSession;
  if (sess && (sess.accessToken || account?.token || cookie)) {
    const accessToken = sess.accessToken || account?.token || null;
    const expiresAt = sess.expiresAt || account?.expiresAt || jwtExpiresAt(accessToken);
    return { ...sess, accessToken, expiresAt, cookie: sess.cookie || cookie };
  }
  const accessToken = account?.token || null;
  const expiresAt = account?.expiresAt || jwtExpiresAt(accessToken);
  return (account?.token || cookie)
    ? { accessToken, refreshToken: null, expiresAt, user: account?.meta?.workosUser || {}, cookie }
    : null;
}

/** 从 billing/account 响应里提取余额数字（宽容解析，联调字段 evolution 兜底） */
export function parseRiverBalance(body) {
  const d = body?.data || body?.result || body || {};
  const cand = [d.balance_usd, d.balanceUsd, d.balance, d.available_balance_usd, d.availableBalance, body?.balance_usd];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
  }
  return null;
}

/**
 * 刷新 WorkOS 会话（单次轮换）。两种授予：
 *  1) body `refresh_token`（有 refreshToken 链时）；
 *  2) **cookie 授予**（useCookie 语义，SPA 重载续期的真实通道）：不带 refresh_token 参数，
 *     凭 `WORKOS_REFRESH_SESSION` 等会话 cookie 换新链。
 * **只要账号有 id 就无条件原子落盘**——旧 refresh 刷新成功即作废（MiniMax 同款教训）。
 */
export async function refreshRiverSession(account, { fetchImpl, log } = {}) {
  const sess = riverSessionOf(account);
  if (!sess?.refreshToken && !sess?.cookie) {
    const err = new Error('River 会话无 refreshToken/会话 cookie，请重新登录捕获');
    err.authInvalid = true;
    throw err;
  }
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS, method: init.method, body: init.body }));
  // client_id 公开可查；失败用空（WorkOS 会报错，上层归为刷新失败）
  let clientId = sess.clientId || null;
  if (!clientId) {
    try {
      const r = await doFetch(RIVER_AUTH_CONFIG_URL, { headers: { Accept: 'application/json', 'User-Agent': RIVER_UA } });
      const cfg = await r.json();
      clientId = cfg?.workos_client_id || null;
      if (cfg?.workos_api_hostname) sess.authBase = `https://${cfg.workos_api_hostname}`;
    } catch { /* 用默认端点重试一次 */ }
  }
  const authBase = sess.authBase || RIVER_WORKOS_AUTH_BASE;
  const res = await doFetch(`${authBase}/user_management/authenticate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': RIVER_UA,
      ...(sess.cookie ? { Cookie: String(sess.cookie) } : {}),
    },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: 'refresh_token',
      ...(sess.refreshToken ? { refresh_token: sess.refreshToken } : {}),   // cookie 授予时省略（SDK useCookie 同款）
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const err = new Error(`River 会话刷新失败（HTTP ${res.status}${data?.error_description || data?.error ? '：' + (data.error_description || data.error) : ''}）`);
    if (res.status === 400 || res.status === 401 || res.status === 403) err.authInvalid = true;
    throw err;
  }
  const parsedUser = parseWorkOsUser(data.user) || sess.user;
  const expiresAt = Number.isFinite(data.expires_in)
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : jwtExpiresAt(data.access_token);
  const creds = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || sess.refreshToken || null,   // 无新 refresh 时保留旧链
    expiresAt,
    clientId: clientId || undefined,
    authBase: authBase || undefined,
    user: parsedUser,
  };
  // 无条件落盘兜底（单次轮换防丢链）
  if (account?.id) {
    try {
      const { withAccounts } = await import('./store.js');
      await withAccounts((list) => {
        const cur = list.find((it) => it.id === account.id);
        if (cur) {
          cur.token = creds.accessToken;
          cur.expiresAt = creds.expiresAt;
          cur.meta = {
            ...(cur.meta || {}),
            workosSession: { ...(cur.meta?.workosSession || {}), ...creds },
          };
          cur.updatedAt = new Date().toISOString();
        }
      });
    } catch (saveErr) {
      log?.(`River 刷新凭据落盘失败: ${saveErr.message}`);
    }
  }
  // 同步内存对象，调用方即便不落盘也拿到新链
  if (account) {
    account.token = creds.accessToken;
    account.refreshToken = creds.refreshToken;
    account.expiresAt = creds.expiresAt;
    if (account.meta) account.meta.workosSession = { ...(account.meta.workosSession || {}), ...creds };
  }
  return creds;
}

function parseWorkOsUser(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    id: u.id || u.user_id || null,
    email: u.email || null,
    name: [u.firstName || u.first_name, u.lastName || u.last_name].filter(Boolean).join(' ') || u.name || null,
  };
}

/**
 * 读取 River 控制台余额。按 WorkOS SPA 的真实续期链尝试三通道：
 *  1) 会话 cookie 直连（同源 API 自动带 cookie，无需 Bearer——别混发失效 Bearer 触发
 *     "invalid WorkOS access token"）；
 *  2) Bearer accessToken（内存/写盘通道的残留）；
 *  3) cookie/refresh 兑换新 access token（单次轮换落盘）→ Bearer 重试。
 * @returns {Promise<{ok: boolean, balance?: number, raw?: object, error?: string, status?: number, channel?: string, session?: object}>}
 */
export async function fetchRiverBalance(account, { fetchImpl, log } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS }));
  const sess = riverSessionOf(account);
  const cookie = sess?.cookie || account?.meta?.cookieSiteSession?.cookie || '';
  if (!sess?.accessToken && !cookie) {
    return { ok: false, error: 'River 会话缺失（storage token 与会话 cookie 均无），请重新登录捕获' };
  }

  const attempt = async ({ token = null, useCookie = false }) => {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Referer: `${RIVER_CONSOLE_BASE}/billing`,
      'User-Agent': RIVER_UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(useCookie && cookie ? { Cookie: String(cookie) } : {}),
    };
    const res = await doFetch(RIVER_BILLING_URL, { headers });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, authExpired: true, error: `会话失效（HTTP ${res.status}）` };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const balance = parseRiverBalance(body);
    if (balance === null) return { ok: false, status: res.status, error: '未能从响应中提取余额（balance_usd）', raw: body };
    return { ok: true, balance, raw: body };
  };

  // 1) cookie 直连
  const misses = [];
  let authExpired = false;
  if (cookie) {
    const r = await attempt({ useCookie: true }).catch((e) => ({ ok: false, error: e.message || String(e) }));
    if (r.ok) return { ...r, channel: 'cookie' };
    if (r.authExpired) authExpired = true;
    misses.push(`cookie:${r.status || r.error || '?'}`);
  }
  // 2) Bearer：本地已知过期（留 60s 容差）直接跳过，避免每轮无谓 401 浪费网络
  const bearerExpired = isBearerExpired(sess?.expiresAt);
  if (sess?.accessToken) {
    if (bearerExpired) {
      misses.push(t('bearer:过期跳过'));
    } else {
      const r = await attempt({ token: sess.accessToken }).catch((e) => ({ ok: false, error: e.message || String(e) }));
      if (r.ok) return { ...r, channel: 'bearer' };
      if (r.authExpired) authExpired = true;
      misses.push(`bearer:${r.status || r.error || '?'}`);
    }
  }
  // 3) 刷新兑换（cookie 授予或 refreshToken 授予）→ Bearer 重试
  if (sess?.refreshToken || cookie) {
    try {
      log?.(t('River 直连未过（{misses}），正在兑换新 access token…', { misses: misses.join(' / ') || '—' }));
      const creds = await refreshRiverSession(account?.id ? account : { meta: { workosSession: { ...sess, cookie } } }, { fetchImpl, log });
      const r = await attempt({ token: creds.accessToken, useCookie: true }).catch((e) => ({ ok: false, error: e.message || String(e) }));
      if (r.ok) return { ...r, channel: 'refresh', session: creds };
      if (r.authExpired) authExpired = true;
      return { ok: false, status: r.status, authExpired, error: `兑换成功但读余额仍失败：${r.error || ''}` };
    } catch (e) {
      // 刷新端点拒绝（refresh 链已死 / 会话注销）= 明确 auth 失效；网络类错误维持通道实测结论
      return { ok: false, status: 401, authExpired: e?.authInvalid === true || authExpired, error: `River 会话刷新失败：${e.message}` };
    }
  }
  return { ok: false, status: 401, authExpired, error: 'River 会话全部通道未通过（cookie/Bearer/刷新兑换），请重新登录捕获' };
}

/**
 * 组装单个 River 账号的 10Router external-quota 载荷（储值余额卡，与 MiMo 卡同口径：
 * 汇总行 summarizeDetail 不进逐包明细——单值余额没有可折叠的明细）。
 * @param {object} account
 * @param {{ balance?: number, error?: string, authInvalid?: boolean }} [liveData]
 *   authInvalid = live 拉取（含刷新兑换链）明确会话失效——不回退旧快照，降级 message 状态卡
 * @returns {{ source: string, payload: object }}
 */
export function buildRiverQuotaPayload(account, liveData = null) {
  const sess = account?.meta?.workosSession || {};
  const userId = account?.uid || sess.user?.id || '';
  const short = String(userId).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  const source = short ? `river-${short}`.slice(0, 32) : `river-${(account?.id || 'default').slice(0, 24)}`;
  const nameStr = String(account?.name || '');
  // 邮箱优先取 WorkOS 会话；兜底从账号名里抽（名字本身就是「River AI (邮箱)」形状，
  // 直接整体拼进括号会套成 River AI (River AI (…)) 双层壳）
  const email = sess.user?.email || /[\w.+-]+@[\w-]+\.[\w.]+/.exec(nameStr)?.[0] || '';

  if (liveData?.authInvalid) {
    return {
      source,
      payload: {
        provider: 'river',
        label: (nameStr || (email ? `River AI (${email})` : 'River AI')).slice(0, 100),
        message: liveData.error || t('River 控制台会话已失效，请在 CreditDaddy「网页会话」页重新登录捕获'),
      },
    };
  }

  let balance = liveData?.balance;
  let ageTag = '';
  if (!Number.isFinite(balance)) {
    const snap = account?.meta?.quotaSnapshot;
    const rb = account?.meta?.riverBalance;
    balance = Number(snap?.total ?? rb?.balanceUsd);
    // 快照回退（非 live）：距今 >24h 的陈粮在副标题标注数据时刻（可见性兜底）
    ageTag = snapshotAgeTag(snap?.at ? snap : rb);
  }

  // label = 账号别名（用户可改）——10R 侧「同名认领」的匹配键：与连接同名即把余额挂上连接卡
  const label = (nameStr || (email ? `River AI (${email})` : 'River AI')).slice(0, 100);
  const payload = {
    provider: 'river',
    label,
    plan: t('免费额度余额') + ageTag,
  };

  if (Number.isFinite(balance) && balance >= 0) {
    payload.quotas = {
      Balance: {
        name: 'Balance (USD)',
        used: 0,
        total: Math.max(0, balance) || 0.000001,
        remainingPercentage: balance > 0 ? 100 : 0,
        displayRemaining: true,
        isCreditBalance: true,
        summarizesDetail: true,
      },
    };
  } else {
    payload.message = liveData?.error || t('River 控制台会话已失效，请在 CreditDaddy「网页会话」页重新登录捕获');
  }

  return { source, payload };
}
