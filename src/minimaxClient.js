/**
 * MiniMax Code 服务端 API 客户端 — 用户信息、额度查询、每日签到与 Token 续期。
 *
 * 官方标准端点：
 *   - 用户资料：GET https://agent.minimax.cn/matrix/api/v1/user/profile
 *   - 额度查询：POST https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info
 *   - 签到状态：GET https://agent.minimax.cn/minimax-cloud/api/v1/signin/status?timezone_offset=28800&is_desktop=1&client=desktop
 *   - 签到领取：POST https://agent.minimax.cn/minimax-cloud/api/v1/signin/claim?timezone_offset=28800&is_desktop=1&client=desktop
 *   - Token 续期：POST https://account.minimax.cn/oauth2/token
 *
 * 补全模型网关端点：
 *   - Anthropic 兼容端点：POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

export const MINIMAX_AGENT_BASE = 'https://agent.minimax.cn';
export const MINIMAX_ACCOUNT_BASE = 'https://account.minimax.cn';
export const MINIMAX_MESSAGES_URL = `${MINIMAX_AGENT_BASE}/mavis/api/v1/llm/v1/messages`;

export const PROFILE_URL = `${MINIMAX_AGENT_BASE}/matrix/api/v1/user/profile`;
export const MEMBERSHIP_URL = `${MINIMAX_AGENT_BASE}/matrix/api/v1/commerce/get_membership_info`;
export const SIGNIN_STATUS_URL = `${MINIMAX_AGENT_BASE}/minimax-cloud/api/v1/signin/status?timezone_offset=28800&is_desktop=1&client=desktop`;
export const SIGNIN_CLAIM_URL = `${MINIMAX_AGENT_BASE}/minimax-cloud/api/v1/signin/claim?timezone_offset=28800&is_desktop=1&client=desktop`;
export const TOKEN_REFRESH_URL = `${MINIMAX_ACCOUNT_BASE}/oauth2/token`;

/** 时间戳宽容转换（口径同 traeClient.iso）：≤1e11 视为秒，否则视为毫秒；0/无效 → null */
function isoMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n < 1e11 ? n * 1000 : n);
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() < 9000 ? d.toISOString() : null;
}

function authHeaders(token) {
  const t = token?.startsWith('Bearer ') ? token : `Bearer ${String(token || '').trim()}`;
  return {
    Authorization: t,
    Accept: 'application/json',
  };
}

/**
 * 刷新 MiniMax OAuth 凭据
 * @param {string} refreshToken
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
 */
export async function refreshMiniMaxToken(refreshToken) {
  if (!refreshToken) throw new Error('缺少 refreshToken');
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  form.set('client_id', 'mcode-public');
  form.set('scope', 'agent.default');
  form.set('audience', 'agent-backend');

  const res = await fetchJsonRace(TOKEN_REFRESH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`MiniMax token 刷新失败: HTTP ${res.status} ${text}`);
    if (res.status === 400 || res.status === 401) err.auth = true;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (!data?.access_token) throw new Error('MiniMax token 刷新未返回 access_token');

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: Number(data.expires_in) || 3600,
  };
}

/**
 * 带自动刷新 401 重试的高阶调用。
 *
 * 刷新前若该账号带有 meta.authRecordKey（绑定本机客户端凭据链，仅本机导入账号会有），
 * 先从 ~/.minimax auth.json 重读该 record 的最新 refreshToken——本机客户端会独立轮换刷新，
 * 账号库快照可能已被服务端作废（invalid_grant）。对齐时会校验 uid 归属，链不算本账号的则跳过
 * （见 minimaxLocal.alignMiniMaxFromLocal）。
 * 刷新成功后经 ctx.onRefresh 回写账号库，并尝试安全回写 auth.json（见 minimaxLocal.writeMiniMaxAuth）。
 */
export async function withMiniMaxAuth(account, fn, ctx = {}) {
  try {
    return await fn(account.token);
  } catch (err) {
    if (!err?.auth || !account.refreshToken) throw err;
    const creds = await refreshAccountToken(account, ctx);
    // 重试放在刷新之外：刷新成功但重试再 401 时，日志该说的是「重试仍被拒」，
    // 而不是误导人的「自动刷新失败」（那时新 token 其实已经拿到并落库了）
    return await fn(creds.token);
  }
}

/**
 * refreshToken 是一次性的、刷新即轮换：两个并发 401 拿同一个 refreshToken 去刷新，
 * 必然一个成功一个 invalid_grant。签到轮（checkin）与面板的额度查询互不知情，
 * 面板每 2 分钟刷一轮账号额度，很容易和 2 小时一次的签到轮撞上。
 * 用 in-flight 表把同一账号的并发刷新合并成一次，后到者直接用刷新出来的新 token 重试。
 */
const refreshInFlight = new Map();

function refreshAccountToken(account, ctx = {}) {
  const key = account.id || account.token;
  const inflight = refreshInFlight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    // 本机导入账号：刷新前对齐客户端最新的 refreshToken，避免用陈旧快照刷新触发 invalid_grant
    try {
      const { alignMiniMaxFromLocal } = await import('./minimaxLocal.js');
      alignMiniMaxFromLocal(account, ctx.log);
    } catch {}
    ctx.log?.('MiniMax token 已过期，正在自动刷新…');
    try {
      const refreshed = await refreshMiniMaxToken(account.refreshToken);
      const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
      const creds = {
        token: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt,
      };
      account.token = creds.token;
      account.refreshToken = creds.refreshToken;
      account.expiresAt = expiresAt;
      await ctx.onRefresh?.(creds);
      return creds;
    } catch (refErr) {
      ctx.log?.(`MiniMax token 自动刷新失败: ${refErr.message}`);
      throw refErr;
    }
  })().finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, p);
  return p;
}

/**
 * 获取用户信息
 */
export async function fetchMiniMaxProfile(token) {
  const res = await fetchJsonRace(PROFILE_URL, {
    headers: authHeaders(token),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (res.status === 401) {
    const err = new Error('MiniMax 登录凭据已失效 (401)');
    err.auth = true;
    throw err;
  }
  if (!res.ok) throw new Error(`获取 MiniMax 用户信息失败: HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data || data.base_resp?.status_code !== 0) {
    const msg = data?.base_resp?.status_msg || '未知错误';
    throw new Error(`MiniMax 用户信息错误: ${msg}`);
  }
  return {
    userId: String(data.user_id || ''),
    name: data.user_name || null,
    email: data.email || null,
    avatarUrl: data.avatar_url || data.default_avatar_url || null,
  };
}

/**
 * 校验 MiniMax 账号 (verify)
 */
export async function verifyMiniMaxAccount(account) {
  const p = await fetchMiniMaxProfile(account.token);
  return {
    name: p.name || `MiniMax_${p.userId.slice(-6)}`,
    uid: p.userId,
    email: p.email,
  };
}

/**
 * 查询额度 (quota)
 */
export async function fetchMiniMaxQuota(account, ctx = {}) {
  return withMiniMaxAuth(account, async (token) => {
    const res = await fetchJsonRace(MEMBERSHIP_URL, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (res.status === 401) {
      const err = new Error('MiniMax 凭据已失效 (401)');
      err.auth = true;
      throw err;
    }
    if (!res.ok) throw new Error(`获取 MiniMax 额度失败: HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    if (!data || data.base_resp?.status_code !== 0) {
      const msg = data?.base_resp?.status_msg || '未知错误';
      throw new Error(`MiniMax 额度错误: ${msg}`);
    }
    return normalizeMiniMaxQuota(data);
  }, ctx);
}

/**
 * 解析并归一化 MiniMax 额度
 */
export function normalizeMiniMaxQuota(data) {
  const summary = data.op_credit_summary || {};
  const total = Number(summary.total_remaining_amount ?? data.total_remains_credit) || 0;
  const free = Number(summary.free_remaining_amount) || 0;
  const purchased = Number(summary.purchased_remaining_amount) || 0;

  const parts = [];
  if (free > 0) {
    parts.push({
      name: '免费/活动积分',
      total: free,
      used: 0,
      remaining: free,
      recurring: true,
      unit: '积分',
    });
  }
  if (purchased > 0) {
    parts.push({
      name: '购买积分',
      total: purchased,
      used: 0,
      remaining: purchased,
      recurring: false,
      unit: '积分',
    });
  }
  if (!parts.length) {
    parts.push({
      name: '积分',
      total,
      used: 0,
      remaining: total,
      recurring: true,
      unit: '积分',
    });
  }

  return {
    total: Math.round(total * 100) / 100,
    used: 0,
    remaining: Math.round(total * 100) / 100,
    // 顶层不设 unit：面板 creditSum 用「有 unit 即异单位」来排除合计，
    // MiniMax 与 Qoder / Trae 同为「积分」口径，必须计入剩余积分合计。
    plan: data.plan_name || (data.is_pro_builder ? 'Pro' : '免费版'),
    // expires_at 是毫秒时间戳：再乘 1000 会显示成 58729 年（实测免费版返回 0，按无到期处理）
    planExpiresAt: isoMs(data.expires_at),
    parts,
    empty: total <= 0,
  };
}

/**
 * 每日自动签到 (checkin)
 */
export async function checkinMiniMax(account, ctx = {}) {
  return withMiniMaxAuth(account, async (token) => {
    // 1. 查询签到状态
    const statusRes = await fetchJsonRace(SIGNIN_STATUS_URL, {
      headers: authHeaders(token),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (statusRes.status === 401) {
      const err = new Error('MiniMax 凭据已失效 (401)');
      err.auth = true;
      throw err;
    }
    if (!statusRes.ok) throw new Error(`查询签到状态失败: HTTP ${statusRes.status}`);
    const statusData = await statusRes.json().catch(() => null);
    if (!statusData || statusData.base_resp?.status_code !== 0) {
      throw new Error(`查询签到状态错误: ${statusData?.base_resp?.status_msg || '未知'}`);
    }

    const days = statusData.data?.days || [];
    const today = days.find((d) => d.is_today);

    // status: 3 = 已领取，1 = 未领取/待领取
    if (today && today.status === 3) {
      return {
        status: 'already',
        message: `今日第 ${today.day_no} 天已签到（${today.points} + ${today.bonus_points} 积分）`,
        amount: (today.points || 0) + (today.bonus_points || 0),
        streakDays: today.day_no || 0,
      };
    }

    // 2. 发起签到 claim
    const claimRes = await fetchJsonRace(SIGNIN_CLAIM_URL, {
      method: 'POST',
      headers: authHeaders(token),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (claimRes.status === 401) {
      const err = new Error('MiniMax 凭据已失效 (401)');
      err.auth = true;
      throw err;
    }
    if (!claimRes.ok) throw new Error(`签到领取失败: HTTP ${claimRes.status}`);
    const claimData = await claimRes.json().catch(() => null);
    if (!claimData || claimData.base_resp?.status_code !== 0) {
      throw new Error(`签到领取错误: ${claimData?.base_resp?.status_msg || '未知'}`);
    }

    const cdata = claimData.data || {};
    // claim_result: 1 = 新签到成功, 2 = 重复签到已领
    const pts = Number(cdata.points) || (today ? (today.points || 0) + (today.bonus_points || 0) : 0);
    if (cdata.claim_result === 2) {
      return {
        status: 'already',
        message: `今日已领取（+${pts} 积分）`,
        amount: pts,
        streakDays: cdata.day_no || today?.day_no || 0,
      };
    }

    return {
      status: 'checked-in',
      message: `签到成功第 ${cdata.day_no || today?.day_no || 1} 天（+${pts} 积分）`,
      claimedAmount: pts,
      amount: pts,
      streakDays: cdata.day_no || today?.day_no || 0,
    };
  }, ctx);
}
