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
 * 带自动刷新 401 重试的高阶调用
 */
export async function withMiniMaxAuth(account, fn, ctx = {}) {
  try {
    return await fn(account.token);
  } catch (err) {
    if (err?.auth && account.refreshToken) {
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
        return await fn(creds.token);
      } catch (refErr) {
        ctx.log?.(`MiniMax token 自动刷新失败: ${refErr.message}`);
        throw refErr;
      }
    }
    throw err;
  }
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
      name: '免费/活动算力币',
      total: free,
      used: 0,
      remaining: free,
      recurring: true,
      unit: '算力币',
    });
  }
  if (purchased > 0) {
    parts.push({
      name: '购买算力币',
      total: purchased,
      used: 0,
      remaining: purchased,
      recurring: false,
      unit: '算力币',
    });
  }
  if (!parts.length) {
    parts.push({
      name: '算力币',
      total,
      used: 0,
      remaining: total,
      recurring: true,
      unit: '算力币',
    });
  }

  return {
    total: Math.round(total * 100) / 100,
    used: 0,
    remaining: Math.round(total * 100) / 100,
    unit: '算力币',
    plan: data.plan_name || (data.is_pro_builder ? 'Pro' : '免费版'),
    planExpiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
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
        message: `今日第 ${today.day_no} 天已签到（${today.points} + ${today.bonus_points} 算力币）`,
        amount: (today.points || 0) + (today.bonus_points || 0),
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
        message: `今日已领取（+${pts} 算力币）`,
        amount: pts,
      };
    }

    return {
      status: 'checked-in',
      message: `签到成功第 ${cdata.day_no || today?.day_no || 1} 天（+${pts} 算力币）`,
      amount: pts,
    };
  }, ctx);
}
