/**
 * mirasim API 客户端 — 用户资料、套餐、现行「额度」口径查询。
 *
 *   GET https://auth.mirasim.ai/auth/me            用户资料（name, email, plan, plan_exp, id）
 *   GET https://relay.mirasim.ai/v1/credits/activity   现行额度口径：个人额度余额 + 按笔（lots）到期
 *   GET https://relay.mirasim.ai/v2/machines/:nodeId/credit  空间额度（余额 / 本人可用）
 *   GET https://relay.mirasim.ai/v1/limits         老「平台额度」滚动窗口（5h/7d…），现仅作熔断信号
 *       注：relay.mirasim.ai 对大陆直连限制区域（429），需走统一出口 fetchJsonRace 代理
 *
 * 口径变更（2026-11-25 实测对照 mirasim 设置 › 额度页）：
 *   mirasim 已不再按「5h 滚动窗口 / 7d 全局上限 / 分模型上限」发放额度，现行是
 *   「额度来源三分（本机账号 / 个人额度 / 空间额度）+ 个人额度按笔有效期、先用最早到期的」。
 *   /v1/limits 那个 `30d` 窗口其实就是个人额度池的累计视图（used + 各笔剩余之和 = 全部笔额度），
 *   它的 `reset_at` 是 2126 年的占位值——按「周期重置倒计时」渲染会算出「36492 天后重置」。
 *   接口的 credits/remaining 是「分」单位（UI ÷100 显示：765.175 → 7.65）。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { withRefreshDedupe } from './refreshGuard.js';

const AUTH_ME_URL = 'https://auth.mirasim.ai/auth/me';
const RELAY_LIMITS_URL = 'https://relay.mirasim.ai/v1/limits';
const AUTH_REFRESH_URL = 'https://auth.mirasim.ai/auth/refresh';
const CREDITS_ACTIVITY_URL = 'https://relay.mirasim.ai/v1/credits/activity?limit=50';
const spaceCreditUrl = (nodeId) => `https://relay.mirasim.ai/v2/machines/${encodeURIComponent(nodeId)}/credit`;

/** 接口额度单位是「分」，UI 显示 ÷100（保留两位） */
const toCredits = (v) => Math.round(Number(v) || 0) / 100;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 每笔额度的种类 → 人话名（对齐 mirasim 渲染层 kind 词典） */
const LOT_KIND_LABELS = {
  carry: '原有余额',
  token_pack: 'Token 包',
  code: '兑换码',
  ops: '额度调整',
  payout: '展示项提回',
};
/** 邀请活动发的额度单独点名（reward.campaign=invite） */
const lotLabel = (lot) => (lot?.reward?.campaign === 'invite' ? '邀请奖励' : (LOT_KIND_LABELS[lot?.kind] || '额度'));

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
    // 并发互斥 + 失效链熔断：与 minimax / workbuddy 共用 refreshGuard
    const creds = await withRefreshDedupe(account, refreshMirasimToken, {
      deadMessage: 'mirasim 凭据链已被服务端作废，等待重新登录',
      deadNotice: 'mirasim 凭据链已失效，将不再自动重试（重新登录或重新导入该账号后自动恢复）',
    });
    account.token = creds.token;
    account.refreshToken = creds.refreshToken;
    if (creds.expiresAt) account.expiresAt = creds.expiresAt;
    token = creds.token;
    refreshed = true;
    if (account.id) {
      try {
        const { withAccounts } = await import('./store.js');
        await withAccounts((list) => {
          const cur = list.find((it) => it.id === account.id);
          if (cur) {
            cur.token = creds.token;
            cur.refreshToken = creds.refreshToken;
            if (creds.expiresAt) cur.expiresAt = creds.expiresAt;
            cur.updatedAt = new Date().toISOString();
          }
        });
      } catch {}
    }
    await ctx?.onRefresh?.(creds);
  };
  let r = await fn(token);
  if (r.status === 401 && !refreshed) {
    await doRefresh();
    r = await fn(token);
  }
  return r;
}

/** 统一配额结构（现行「额度」口径：个人额度按笔 + 空间额度；老窗口仅作降级与熔断信号） */
export function normalizeMirasimQuota({ activity = null, limits = null, profile = null, spaceCredit = null, agentSources = [] } = {}) {
  const epochToIso = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null);
  const lots = (Array.isArray(activity?.balance?.lots) ? activity.balance.lots : [])
    .map((l) => ({
      name: lotLabel(l),
      total: toCredits(l.credits),
      remaining: toCredits(l.remaining),
      grantedAt: Number.isFinite(l.grantedAt) ? new Date(l.grantedAt).toISOString() : null,
      expiresAt: Number.isFinite(l.expiresAt) ? new Date(l.expiresAt).toISOString() : null,
      recurring: false,
    }))
    // 消费顺序 = 到期顺序（先用最早到期的），面板逐笔展示时按此次序
    .sort((a, b) => String(a.expiresAt || '9999').localeCompare(String(b.expiresAt || '9999'))
      || String(a.grantedAt || '9999').localeCompare(String(b.grantedAt || '9999')));

  const personalRemaining = toCredits(activity?.balance?.remaining);
  // mirasim 额度页的「额度明细」只列还没用完的笔（花完的进「额度变动」历史），
  // 百分比也按这些笔的总额算：7.65 / 10.01 → 76.4%。老 /v1/limits 的 budget 把
  // 已花完的笔也算进去（15.01 → 51%），那不是现行页的口径。
  const alive = lots.filter((l) => l.remaining > 0);
  const aliveTotal = round2(alive.reduce((s, l) => s + l.total, 0));
  const personalTotal = round2(lots.reduce((s, l) => s + l.total, 0));
  const pctBase = aliveTotal > 0 ? aliveTotal : personalTotal;
  const remainingPercentage = pctBase > 0
    ? Math.max(0, Math.min(100, Math.round((personalRemaining / pctBase) * 1000) / 10))
    : (personalRemaining > 0 ? 100 : 0);

  const spaceAvailable = spaceCredit && typeof spaceCredit === 'object';
  const space = spaceAvailable ? {
    // me.remaining 为 null 表示「不限」（所有者未设上限），按空间余额本身展示
    remaining: Number.isFinite(spaceCredit.me?.remaining) ? toCredits(spaceCredit.me.remaining) : toCredits(spaceCredit.balance),
    balance: toCredits(spaceCredit.balance),
    payer: spaceCredit.me?.payer || spaceCredit.mode || null,
  } : null;

  const gotActivity = activity != null;
  const exhausted = gotActivity && personalRemaining <= 0 && !(space && space.remaining > 0);

  // 降级：个人额度接口读不到（区域限流 / 上游变更）时，现行 /v1/limits 只剩一个额度池窗口，
  // 它的 budget-used 与 balance.remaining 同源（实测 1501-735.82 = 765.175 = 7.65），
  // 可以当作余额用；多个窗口（老的 5h/7d 并行窗口）就没有「余额」可言，只留窗口行。
  const legacyWindows = normalizeMirasimWindows(limits);
  const degraded = !gotActivity && legacyWindows.length === 1 && legacyWindows[0].total > 0;
  const headTotal = gotActivity ? pctBase : (degraded ? round2(legacyWindows[0].total / 100) : 0);
  // 余额可为负（末笔扣穿后服务端记负数余量，实测 -2.27 分）：显示口径钳到 0，
  // 用尽状态另由 exhausted 表达——面板与仪表盘汇总都不该出现「-0.02」这种数字。
  const headRemaining = Math.max(0, gotActivity ? personalRemaining : (degraded ? round2(legacyWindows[0].remaining / 100) : 0));
  const headPct = headTotal > 0
    ? Math.max(0, Math.min(100, Math.round((headRemaining / headTotal) * 1000) / 10))
    : (headRemaining > 0 ? 100 : remainingPercentage);

  return {
    unit: '额度',
    // total/used 用「还没用完的笔」口径，与 mirasim 额度明细逐笔的 7.64/10.00 一致
    total: headTotal,
    used: Math.max(0, round2(headTotal - headRemaining)),
    remaining: headRemaining,
    remainingPercentage: headPct,
    percent: Math.max(0, Math.min(100, 100 - headPct)),
    plan: profile?.plan ? String(profile.plan).toUpperCase() : (limits?.paid ? 'PRO' : 'FREE'),
    planExpiresAt: epochToIso(profile?.plan_exp),
    // 按笔到期：先用最早到期的那笔（截图口径「最早一笔 2027年2月22日 到期」）
    earliestExpiresAt: alive[0]?.expiresAt || null,
    lots,
    space,
    windows: legacyWindows,
    // 各智能体单独设定的额度来源（本机 mirasim 客户端记录，按 uid 索引）：
    // 有条目就意味着这些智能体不跟这里的个人/空间额度走，面板据此提示
    agentSources: Array.isArray(agentSources) ? agentSources : [],
    bottleneck: exhausted ? { name: '个人额度' } : null,
    // 什么都没读到才算「无额度」；新接口失败但老窗口还在时走面板的百分比降级，不要提前打空态
    empty: !gotActivity && !degraded && !(space && space.remaining > 0),
    exceeded: exhausted || limits?.suspended === true,
    // 个人额度接口不可用（区域限流 / 上游变更）：面板据此显示「—」而不是编出来的 0
    partial: !gotActivity,
  };
}
/** 老「平台额度」滚动窗口解析（5h/7d/分模型上限）——现行口径不再展示，仅留作降级兜底 */
export function normalizeMirasimWindows(limits) {
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

  return windows.map((w) => {
    const budget = Number(w.budget) || 0;
    const used = Number(w.used) || 0;
    const remaining = Math.max(0, budget - used);
    const usedPct = budget > 0 ? Math.min(100, Math.round((used / budget) * 1000) / 10) : 0;

    return {
      name: WINDOW_LABELS[w.name] || w.name,
      rawName: w.name,
      total: budget,
      used,
      remaining,
      percent: usedPct,
      remainingPercentage: Math.max(0, Math.round((100 - usedPct) * 10) / 10),
      unit: '',
      // 上游 30d 窗口的 reset_at 是 2126 年的占位值（额度按笔到期、没有周期重置），
      // 只认 5h/7d 这类真窗口，其余一律不给「N 天后重置」
      resetAt: /^(5h|7d|7d_.+)$/.test(String(w.name)) ? epochToIso(w.reset_at) : null,
      expiresAt: /^(5h|7d|7d_.+)$/.test(String(w.name)) ? epochToIso(w.reset_at) : null,
      recurring: true,
    };
  });
}

/** 查询 mirasim 完整配额；401 时自动用 refreshToken 续期一次并重试（ctx.onRefresh 回写凭据） */
export async function fetchMirasimQuota(account, ctx = {}) {
  if (!account.token) throw new Error('账号缺少 token');

  const getProfile = (token) => fetchJsonRace(AUTH_ME_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const getActivity = (token) => fetchJsonRace(CREDITS_ACTIVITY_URL, {
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
    // 刷新也失败 / 网络错误：没有 refreshToken 或 refreshToken 失效时如实抛出，其余继续试额度
    if (e.authInvalid) throw e;
  }

  // 现行口径主数据源：个人额度（按笔）。失败不阻断——退回老窗口结构并在面板标注来源缺失。
  let activity = null;
  try {
    const ares = await withToken(account, getActivity, ctx);
    if (ares.ok) activity = await ares.json();
  } catch (e) {
    if (e.authInvalid) throw e;
  }

  const res = await withToken(account, getLimits, ctx).catch((e) => {
    if (e.authInvalid) throw e;
    if (activity) return null;   // 老接口挂了但新口径拿到了：不再当作查询失败
    throw new Error(`查询额度失败：${e.message}`);
  });

  if (!res && !activity) throw new Error('查询额度失败');
  if (res && !res.ok && !activity) {
    if (res.status === 401) { const e = new Error('mirasim 登录凭据已过期，请在 mirasim 客户端重新登录后重新导入'); e.auth = true; throw e; }
    if (res.status === 429) {
      // 区域受限时返回 profile 里的基础套餐信息，不完全阻断
      return {
        unit: '额度', total: 0, used: 0, remaining: 0, remainingPercentage: 0,
        plan: profile?.plan || 'Plus',
        planExpiresAt: profile?.plan_exp ? new Date(profile.plan_exp * 1000).toISOString() : null,
        lots: [], space: null, windows: [], parts: [], agentSources: [], empty: false, partial: true,
        warning: '云端限流或直连网络受限（配置代理后可查询实时额度）',
      };
    }
    throw new Error(`查询额度失败: HTTP ${res.status}`);
  }

  const limits = res && res.ok ? await res.json().catch(() => null) : null;

  // 空间额度：只有本机 mirasim 客户端连着空间时才查（nodeId 取自客户端 setting.json）。
  // 查不到/无权限都按「未知」处理，不影响个人额度展示。
  let spaceCredit = null;
  try {
    const { currentSpaceNodeId } = await import('./mirasimLocal.js');
    const nodeId = currentSpaceNodeId();
    if (nodeId) {
      const sres = await withToken(account, (token) => fetchJsonRace(spaceCreditUrl(nodeId), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeoutMs: FETCH_TIMEOUT_MS,
      }), ctx).catch(() => null);
      if (sres && sres.ok) spaceCredit = await sres.json().catch(() => null);
    }
  } catch {}

  // 各智能体单独设定的额度来源：mirasim 客户端按人存在本机 collab/person-agent-routes.json，
  // 没有对外查询接口，只能读本机文件（按账号 uid 取，读不到就当没有）。
  let agentSources = [];
  try {
    const { agentCreditSources } = await import('./mirasimLocal.js');
    agentSources = agentCreditSources(account.uid);
  } catch {}

  return normalizeMirasimQuota({ activity, limits, profile, spaceCredit, agentSources });
}
