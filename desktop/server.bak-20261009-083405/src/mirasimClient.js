/**
 * mirasim API 客户端 — 用户资料、套餐、5h/7d 滚动窗口配额查询。
 *
 *   GET https://auth.mirasim.ai/auth/me      用户资料（name, email, plan, plan_exp, id）
 *   GET https://relay.mirasim.ai/v1/limits   滚动窗口（5h, 7d, 7d_claude 等）
 *       注：relay.mirasim.ai 对大陆直连限制区域（429），需走统一出口 fetchJsonRace 代理
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

const AUTH_ME_URL = 'https://auth.mirasim.ai/auth/me';
const RELAY_LIMITS_URL = 'https://relay.mirasim.ai/v1/limits';
const AUTH_REFRESH_URL = 'https://auth.mirasim.ai/auth/refresh';

export async function fetchMirasimProfile(token) {
  const res = await fetchJsonRace(AUTH_ME_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    if (res.status === 401) { const e = new Error('mirasim 登录凭据已过期'); e.auth = true; throw e; }
    throw new Error(`获取 mirasim 用户信息失败: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 用 refreshToken 换新凭据（refreshToken 会轮换，两个都要保存）。
 * 返回 { token, refreshToken, expiresAt }；没有 refreshToken 或刷新失败抛错。
 */
export async function refreshMirasimToken(account) {
  if (!account.refreshToken) throw new Error('没有 refreshToken，无法刷新，请在 mirasim 客户端重新登录后重新导入');
  const res = await fetchJsonRace(AUTH_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: { refresh_token: account.refreshToken },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error('refreshToken 已失效，请在 mirasim 客户端重新登录后到「添加账号 → 本机导入」同步');
      e.authInvalid = true;
      throw e;
    }
    throw new Error(`mirasim 凭据刷新失败: HTTP ${res.status}`);
  }
  const d = await res.json();
  const token = d.access_token || d.accessToken;
  if (!token) throw new Error('mirasim 刷新响应缺少 access_token（上游结构可能变化）');
  let expiresAt = null;
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (Number.isFinite(p.exp)) expiresAt = new Date(p.exp * 1000).toISOString();
  } catch {}
  return { token, refreshToken: d.refresh_token || d.refreshToken || account.refreshToken, expiresAt };
}

/**
 * 以有效 token 执行 fn(token)；401 时刷新一次再重试。
 * 刷新成功经 ctx.onRefresh(newCreds) 回写账号库与 setting.json（调用方负责持久化）。
 */
async function withToken(account, fn, ctx) {
  let token = account.token;
  let refreshed = false;
  const doRefresh = async () => {
    const creds = await refreshMirasimToken(account);
    account.token = creds.token;
    account.refreshToken = creds.refreshToken;
    if (creds.expiresAt) account.expiresAt = creds.expiresAt;
    token = creds.token;
    refreshed = true;
    await ctx?.onRefresh?.(creds);
  };
  let r = await fn(token);
  if (r.status === 401 && !refreshed) {
    await doRefresh();
    r = await fn(token);
  }
  return r;
}

/** 统一配额结构（对齐 Qoder/WorkBuddy/ZCode） */
export function normalizeMirasimLimits(limits, profile = null) {
  const windows = Array.isArray(limits?.windows) ? limits.windows : [];
  const epochToIso = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null);

  const WINDOW_LABELS = {
    '5h': '5小时窗口',
    '7d': '7天全局窗口',
    '7d_claude': '7天 Claude 上限',
    '7d_sonnet': '7天 Sonnet 上限',
    '7d_opus': '7天 Opus 上限',
    '7d_fable': '7天 Fable 上限',
  };

  const parts = windows.map((w) => {
    const budget = Number(w.budget) || 0;
    const used = Number(w.used) || 0;
    const remaining = Math.max(0, budget - used);
    const usedPct = budget > 0 ? Math.min(100, Math.round((used / budget) * 1000) / 10) : 0;
    const remPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);

    return {
      name: WINDOW_LABELS[w.name] || w.name,
      total: budget,
      used,
      remaining,
      percent: usedPct,
      remainingPercentage: remPct,
      unit: '',
      resetAt: epochToIso(w.reset_at),
      expiresAt: epochToIso(w.reset_at),
      recurring: true,
    };
  });

  // 瓶颈短板原则：5h 窗口与 7d 全局窗口是“与”的关系（任何一个见底，请求就发不出去）
  // 逻辑上：周额度没了，5 小时即使是 100% 也没有意义！所以主额度必须反映实际可用状态
  const w5h = parts.find((p) => p.name.includes('5小时'));
  const w7d = parts.find((p) => p.name.includes('7天全局'));
  const bottleneck = w7d && w7d.remainingPercentage <= 0 ? w7d
    : w5h && w5h.remainingPercentage <= 0 ? w5h
    : w7d && w5h ? (w7d.remainingPercentage < w5h.remainingPercentage ? w7d : w5h)
    : parts[0] || null;

  const rem = bottleneck ? bottleneck.remainingPercentage : 0;
  const isExhausted = bottleneck ? bottleneck.remainingPercentage <= 0 : false;

  return {
    total: 100,
    used: 100 - rem,
    remaining: rem,
    unit: '%',
    plan: profile?.plan ? String(profile.plan).toUpperCase() : (limits?.paid ? 'PRO' : 'FREE'),
    planExpiresAt: epochToIso(profile?.plan_exp),
    bottleneckLabel: isExhausted ? (bottleneck?.name || '额度') + '已用尽' : null,
    parts,
    empty: parts.length === 0,
    exceeded: limits?.suspended === true || isExhausted,
  };
}

/** 查询 mirasim 完整配额；401 时自动用 refreshToken 续期一次并重试（ctx.onRefresh 回写凭据） */
export async function fetchMirasimQuota(account, ctx = {}) {
  if (!account.token) throw new Error('账号缺少 token');

  const getProfile = (token) => fetchJsonRace(AUTH_ME_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const getLimits = (token) => fetchJsonRace(RELAY_LIMITS_URL, {
    headers: { Authorization: `Bearer ${token}`, 'x-mirasim-probe': 'usage', Accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  let profile = null;
  try {
    const pres = await withToken(account, getProfile, ctx);
    if (pres.ok) profile = await pres.json();
  } catch (e) {
    // 刷新也失败 / 网络错误：没有 refreshToken 或 refreshToken 失效时如实抛出，其余继续试 limits
    if (e.authInvalid) throw e;
  }

  const res = await withToken(account, getLimits, ctx).catch((e) => {
    if (e.authInvalid) throw e;
    throw new Error(`查询额度失败：${e.message}`);
  });

  if (!res.ok) {
    if (res.status === 401) { const e = new Error('mirasim 登录凭据已过期，请在 mirasim 客户端重新登录后重新导入'); e.auth = true; throw e; }
    if (res.status === 429) {
      // 区域受限时返回 profile 里的基础套餐信息，不完全阻断
      return {
        total: 100, used: 0, remaining: 100, unit: '%',
        plan: profile?.plan || 'Plus',
        planExpiresAt: profile?.plan_exp ? new Date(profile.plan_exp * 1000).toISOString() : null,
        parts: [],
        empty: false,
        warning: '云端限流或直连网络受限（配置代理后可查询实时 5h/7d 窗口）',
      };
    }
    throw new Error(`查询额度失败: HTTP ${res.status}`);
  }

  const limits = await res.json();
  return normalizeMirasimLimits(limits, profile);
}
