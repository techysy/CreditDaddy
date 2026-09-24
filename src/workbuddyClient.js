/**
 * WorkBuddy（腾讯 CodeBuddy 系）API 客户端 — 签到、积分、token 刷新。
 *
 * 协议对齐 WorkBuddy 桌面端与 10router 的 codebuddyCheckin / usage / tokenRefresh：
 *   POST {host}/v2/billing/meter/checkin-activity-status   今日是否已签、连签天数、每日额度
 *   POST {host}/v2/billing/meter/daily-checkin             签到（400 + 10001/“已签到” = 今日已签）
 *   POST {host}/v2/billing/meter/get-user-resource         积分包（data.Response.Data.Accounts[]）
 *   POST {host}/v2/plugin/auth/token/refresh               刷新（X-Refresh-Token 头）
 * 请求头：Authorization Bearer + X-User-Id（JWT sub）+ X-Domain（token 所属域名）。
 *
 * WorkBuddy 登录 token 是 Keycloak JWT，签发方决定归属与 API 域名：
 *   www.codebuddy.cn / www.workbuddy.cn / copilot.tencent.com → 国内版
 *   www.codebuddy.ai / www.workbuddy.ai                       → 国际版
 *
 * token 只在过期或 401 时刷新：刷新会轮换 refreshToken，若该账号正登录在 WorkBuddy
 * 客户端里，主动刷新可能让客户端手里的旧 refreshToken 失效。
 */

import { FETCH_TIMEOUT_MS } from './constants.js';

const USER_AGENT = 'CLI/2.108.1 CodeBuddy/2.108.1';
const CN_DEFAULT_HOST = 'www.codebuddy.cn';
const INTL_DEFAULT_HOST = 'www.codebuddy.ai';
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export function decodeJwt(jwt) {
  try {
    const seg = String(jwt).split('.')[1];
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 从 token 推断归属：{ provider, host, uid, expiresAt }；不是 CodeBuddy 系 token 时 provider 为 null。
 */
export function inspectToken(token) {
  const c = decodeJwt(token) || {};
  let host = null;
  try { host = new URL(c.iss).host; } catch {}
  let provider = null;
  if (host && /(codebuddy|workbuddy)\.ai$/.test(host)) provider = 'workbuddy-intl';
  else if (host && /(codebuddy|workbuddy)\.cn$|copilot\.tencent\.com$/.test(host)) provider = 'workbuddy';
  return {
    provider,
    host,
    uid: typeof c.sub === 'string' ? c.sub : null,
    expiresAt: Number.isFinite(c.exp) ? new Date(c.exp * 1000).toISOString() : null,
    name: c.name || c.preferred_username || c.nickname || null,
  };
}

/** API 域名：优先客户端记录的 auth.domain，其次 token 签发方，最后按区域默认 */
export function apiHost(account) {
  const meta = account.meta || {};
  const fromToken = inspectToken(account.token).host;
  const host = meta.domain || (fromToken && fromToken !== 'copilot.tencent.com' ? fromToken : null);
  return host || (account.provider === 'workbuddy-intl' ? INTL_DEFAULT_HOST : CN_DEFAULT_HOST);
}

function headersFor(account, token) {
  const meta = account.meta || {};
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-User-Id': account.uid || inspectToken(token).uid || '',
    'X-Domain': apiHost(account),
    'X-Product': 'SaaS',
    'User-Agent': USER_AGENT,
  };
  if (meta.enterpriseId) {
    h['X-Enterprise-Id'] = meta.enterpriseId;
    h['X-Tenant-Id'] = meta.enterpriseId;
  }
  return h;
}

async function post(account, path, token) {
  const res = await fetch(`https://${apiHost(account)}${path}`, {
    method: 'POST',
    headers: headersFor(account, token),
    body: '{}',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body, text };
}

// 国际版「活跃领取」探测：官方规则为「当天有 ≥1 次有效对话请求即视为活跃用户，发放每日赠送积分」。
// 没有签到接口，所以每天发一条免费档模型（rateMultiplier 0，~0 消耗）的极短流式请求。
// 对齐 10router src/sse/services/codebuddyCheckin.js 的 intl 探测（stream 网关的系统提示与 typed blocks 是必需的，否则 11101）。
const INTL_PROBE_MODEL = 'hy4-preview';
async function postIntlProbe(account, token) {
  const res = await fetch(`https://${apiHost(account)}/v2/chat/completions`, {
    method: 'POST',
    headers: { ...headersFor(account, token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: INTL_PROBE_MODEL,
      stream: true,
      max_tokens: 16,
      messages: [
        { role: 'system', content: 'You are CodeBuddy Code.' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }),
    signal: AbortSignal.timeout(Math.max(FETCH_TIMEOUT_MS, 25_000)),
  });
  // 2xx = 会话建立成功，把 SSE 流排干（最多几个 token）
  const text = await res.text().catch(() => '');
  return { status: res.status, text };
}

/**
 * 国际版「活跃领取」：一次免费档对话请求使账号成为当日活跃用户。
 * 返回与每日签到一致的结果对象（session-ok → checked-in，claimedAmount 0 表示额度随官方结算发放）。
 */
export async function checkinWorkbuddyIntl(account, { onRefresh } = {}) {
  const label = account.name || account.id;
  const base = { accountId: account.id, account: label, provider: account.provider };
  try {
    const r = await withToken(account, (t) => postIntlProbe(account, t), onRefresh);
    if (r.status === 401) return { ...base, status: 'failed', error: '鉴权失败（401），token 已失效，请在客户端重新登录后重新导入' };
    if (r.status === 429) return { ...base, status: 'no-activity', message: '今日额度已耗尽，活跃请求暂不可达（等官方发放后再试）', claimedAmount: 0 };
    if (r.status >= 200 && r.status < 300) {
      return { ...base, uid: account.uid, status: 'checked-in', claimedAmount: 0, message: '已发送活跃请求（保持活跃，活跃不等于必有奖励）' };
    }
    const m = (() => { try { return JSON.parse(r.text)?.error?.data?.msg || ''; } catch { return ''; } })();
    return { ...base, status: 'failed', error: `活跃请求失败：HTTP ${r.status} ${m || r.text.slice(0, 120)}`.trim() };
  } catch (e) {
    return { ...base, status: 'failed', error: e?.message || '网络错误' };
  }
}

export function isExpired(account, now = Date.now()) {
  const exp = account.expiresAt || inspectToken(account.token).expiresAt;
  return Boolean(exp) && new Date(exp).getTime() - EXPIRY_SKEW_MS <= now;
}

/**
 * 用 refreshToken 换新 token。返回 { token, refreshToken, expiresAt, refreshExpiresAt, raw } 或抛错。
 */
export async function refreshWorkbuddyToken(account) {
  if (!account.refreshToken) throw new Error('没有 refreshToken，无法刷新，请重新导入该账号');
  const hosts = [apiHost(account)];
  if (account.provider === 'workbuddy' && !hosts.includes('copilot.tencent.com')) hosts.push('copilot.tencent.com');
  let lastError = null;
  for (const host of hosts) {
    try {
      const res = await fetch(`https://${host}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          'X-Domain': host === 'copilot.tencent.com' ? 'copilot.tencent.com' : apiHost(account),
          'X-Refresh-Token': account.refreshToken,
          'X-Auth-Refresh-Source': 'plugin',
          'X-Product': 'SaaS',
          ...(account.meta?.enterpriseId ? { 'X-Enterprise-Id': account.meta.enterpriseId } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const j = await res.json().catch(() => ({}));
      const d = j?.data;
      if (res.ok && j?.code === 0 && d?.accessToken) {
        const now = Date.now();
        return {
          token: d.accessToken,
          refreshToken: d.refreshToken || account.refreshToken,
          expiresAt: d.expiresIn ? new Date(now + d.expiresIn * 1000).toISOString() : inspectToken(d.accessToken).expiresAt,
          refreshExpiresAt: d.refreshExpiresIn ? new Date(now + d.refreshExpiresIn * 1000).toISOString() : null,
          raw: d,
        };
      }
      // 12153 / 401：refreshToken 已失效（账号在别处登出或会话被轮换），只能重新登录
      if (res.status === 401 || String(j?.code) === '12153' || /refresh token is invalid/i.test(j?.msg || '')) {
        const e = new Error('登录已失效，请在 WorkBuddy 客户端重新登录该账号后，到「添加账号 → 本机导入」同步');
        e.authInvalid = true;
        throw e;
      }
      lastError = new Error(`刷新失败：HTTP ${res.status} ${j?.msg || ''}`.trim());
    } catch (e) {
      if (e.authInvalid) throw e;
      lastError = e;
    }
  }
  throw lastError || new Error('刷新失败');
}

/**
 * 以有效 token 执行 fn(token)；token 过期或返回 401 时刷新一次再重试。
 * 刷新成功会通过 onRefresh(newCreds) 回写账号（调用方负责持久化）。
 */
async function withToken(account, fn, onRefresh) {
  let token = account.token;
  let refreshed = false;
  const doRefresh = async () => {
    const creds = await refreshWorkbuddyToken(account);
    Object.assign(account, { token: creds.token, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt });
    token = creds.token;
    refreshed = true;
    await onRefresh?.(creds);
  };
  if (isExpired(account) && account.refreshToken) await doRefresh();
  let r = await fn(token);
  if (r.status === 401 && !refreshed && account.refreshToken) {
    await doRefresh();
    r = await fn(token);
  }
  return r;
}

const ALREADY_RE = /已签到|签到过|重复签到|already|repeat/i;

/**
 * 签到。返回与 Qoder 一致的结果对象（status: checked-in / already / failed）。
 * @param {object} account
 * @param {{ onRefresh?: (creds) => Promise<void>|void }} [opts]
 */
export async function checkinWorkbuddy(account, { onRefresh } = {}) {
  const label = account.name || account.id;
  const base = { accountId: account.id, account: label, provider: account.provider };
  try {
    // 1) 先查状态：今日已签则不再 POST
    const st = await withToken(account, (t) => post(account, '/v2/billing/meter/checkin-activity-status', t), onRefresh);
    if (st.status === 401) return { ...base, status: 'failed', error: '鉴权失败（401），token 已失效，请在 WorkBuddy 重新登录后重新导入' };
    const sd = st.status === 200 && st.body?.code === 0 ? st.body.data || {} : null;
    const streak = sd ? { streakDays: sd.streak_days ?? 0, dailyCredit: sd.daily_credit ?? null } : {};
    if (sd && (sd.today_checked_in === true || sd.checked_in === true)) {
      return { ...base, uid: account.uid, status: 'already', message: `今日已签（连签 ${sd.streak_days ?? 0} 天）`, claimedAmount: 0, ...streak };
    }

    // 2) 签到
    const r = await withToken(account, (t) => post(account, '/v2/billing/meter/daily-checkin', t), onRefresh);
    const code = r.body?.code ?? r.body?.error_code;
    const msg = r.body?.msg ?? r.body?.message ?? '';
    if (r.status >= 200 && r.status < 300 && (code === 0 || code === undefined)) {
      const d = r.body?.data || {};
      const amount = Number(d.credit ?? d.today_credit ?? d.daily_credit ?? sd?.today_credit ?? sd?.daily_credit ?? 0) || 0;
      return { ...base, uid: account.uid, status: 'checked-in', claimedAmount: amount, message: `签到成功（连签 ${(sd?.streak_days ?? 0) + 1} 天）`, ...streak };
    }
    if ((r.status === 400 || (r.status === 200 && code !== 0)) && (String(code) === '10001' || ALREADY_RE.test(msg))) {
      return { ...base, uid: account.uid, status: 'already', message: '今日已签', claimedAmount: 0, ...streak };
    }
    if (r.status === 404) {
      return { ...base, status: 'no-activity', message: `${apiHost(account)} 暂无签到活动（接口 404）`, claimedAmount: 0 };
    }
    return { ...base, status: 'failed', error: `签到失败：HTTP ${r.status} ${msg || r.text.slice(0, 120)}`.trim() };
  } catch (e) {
    return { ...base, status: 'failed', error: e?.message || '网络错误' };
  }
}

const num = (precise, plain) => {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
};
const REFILL_GAP_MS = 2 * 24 * 3600e3;
const toIso = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v).replace(' ', 'T') + (String(v).includes('+') || String(v).endsWith('Z') ? '' : '+08:00'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * 积分包汇总，归一成 { total, used, remaining, parts: [{ name, total, used, remaining, expiresAt, recurring }] }。
 * 循环额度包（体验版月度额度）取 Cycle* 字段，活动赠送包取 Capacity* 字段（同 10router usage/codebuddy-cn）。
 */
export async function fetchWorkbuddyQuota(account, { onRefresh } = {}) {
  const r = await withToken(account, (t) => post(account, '/v2/billing/meter/get-user-resource', t), onRefresh);
  if (r.status === 401 || r.status === 403) throw new Error(`鉴权失败 (HTTP ${r.status})，token 可能已过期`);
  if (r.status !== 200 || r.body?.code !== 0) throw new Error(`积分查询失败：HTTP ${r.status} ${r.body?.msg || ''}`.trim());
  const list = r.body?.data?.Response?.Data?.Accounts;
  const packs = Array.isArray(list) ? list : [];
  const now = Date.now();
  const parts = packs.map((a) => {
    const cycleEnd = toIso(a.CycleEndTime);
    const deductEnd = toIso(a.DeductionEndTime);
    const recurring = Boolean(cycleEnd && deductEnd && new Date(deductEnd) - new Date(cycleEnd) > REFILL_GAP_MS);
    // 循环包（体验版月度额度）看本周期的 Cycle* 字段；一次性赠送包看 Capacity* 字段。直接用 *Remain，不自行相减
    const total = recurring ? num(a.CycleCapacitySizePrecise, a.CycleCapacitySize) : num(a.CapacitySizePrecise, a.CapacitySize);
    const used = recurring ? num(a.CycleCapacityUsedPrecise, a.CycleCapacityUsed) : num(a.CapacityUsedPrecise, a.CapacityUsed);
    const remaining = recurring ? num(a.CycleCapacityRemainPrecise, a.CycleCapacityRemain) : num(a.CapacityRemainPrecise, a.CapacityRemain);
    return {
      name: a.PackageName || a.SubProductName || '积分包',
      total, used, remaining,
      expiresAt: recurring ? cycleEnd : (deductEnd || cycleEnd),
      recurring,
    };
  }).filter((p) => p.total > 0 && (!p.expiresAt || new Date(p.expiresAt).getTime() > now));
  parts.sort((a, b) => (b.remaining > 0) - (a.remaining > 0) || String(a.expiresAt).localeCompare(String(b.expiresAt)));
  const sum = (k) => Math.round(parts.reduce((s, p) => s + p[k], 0) * 100) / 100;
  return { total: sum('total'), used: sum('used'), remaining: sum('remaining'), parts, exceeded: false };
}
