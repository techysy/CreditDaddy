/**
 * MiniMax Code 服务端 API 客户端 — 用户信息、额度查询、每日签到与 Token 续期。
 *
 * 双渠道（issue #54）：国内 / 国际同协议同 client（mcode-public），只换域名——
 *   CN   https://agent.minimax.cn + https://account.minimax.cn（官方客户端 NEXT_PUBLIC_LOCALE=zh）
 *   Intl https://agent.minimax.io + https://account.minimax.io（NEXT_PUBLIC_LOCALE=en）
 * 端点实证：@mavis/oauth-core/dist/endpoint-config.js 的 ACCOUNT_ORIGINS（2026-11-07 从
 * 官方客户端 app.asar 拆包），与本机 ~/.minimax/auth/prod/<region>/mcode-public/ 布局互证。
 *
 * 官方标准端点（CN，intl 同路径）：
 *   - 用户资料：GET {agent}/matrix/api/v1/user/profile
 *   - 额度查询：POST {agent}/matrix/api/v1/commerce/get_membership_info
 *   - 签到状态：GET {agent}/minimax-cloud/api/v1/signin/status?timezone_offset=28800&is_desktop=1&client=desktop
 *   - 签到领取：POST {agent}/minimax-cloud/api/v1/signin/claim?timezone_offset=28800&is_desktop=1&client=desktop
 *   - Token 续期：POST {account}/oauth2/token
 *
 * 补全模型网关端点：
 *   - Anthropic 兼容端点：POST {agent}/mavis/api/v1/llm/v1/messages
 */

import { createHash } from 'node:crypto';
import { fetchJsonRace } from './zcodeClient.js';
import { withRefreshDedupe, refreshFpDead } from './refreshGuard.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

/** MiniMax 渠道档位：cn（国内，agent.minimax.cn）/ global（国际，agent.minimax.io） */
export const MINIMAX_FLAVORS = {
  cn: { agent: 'https://agent.minimax.cn', account: 'https://account.minimax.cn' },
  global: { agent: 'https://agent.minimax.io', account: 'https://account.minimax.io' },
};

/** 账号档位判定：provider 为 minimax-global 或 meta.minimaxFlavor 标记的走国际线，其余国内 */
export function minimaxFlavorOf(account) {
  if (account?.provider === 'minimax-global') return 'global';
  return account?.meta?.minimaxFlavor === 'global' ? 'global' : 'cn';
}

function basesOf(account) {
  return MINIMAX_FLAVORS[minimaxFlavorOf(account)] || MINIMAX_FLAVORS.cn;
}

// 兼容旧引用（网关 / minimaxLocal 等按 CN 域名直连的地方）；新代码请用 basesOf(account)
export const MINIMAX_AGENT_BASE = 'https://agent.minimax.cn';
export const MINIMAX_ACCOUNT_BASE = 'https://account.minimax.cn';
export const MINIMAX_MESSAGES_URL = `${MINIMAX_AGENT_BASE}/mavis/api/v1/llm/v1/messages`;

export const PROFILE_URL = `${MINIMAX_AGENT_BASE}/matrix/api/v1/user/profile`;
export const MEMBERSHIP_URL = `${MINIMAX_AGENT_BASE}/matrix/api/v1/commerce/get_membership_info`;
export const SIGNIN_STATUS_URL = `${MINIMAX_AGENT_BASE}/minimax-cloud/api/v1/signin/status?timezone_offset=28800&is_desktop=1&client=desktop`;
export const SIGNIN_CLAIM_URL = `${MINIMAX_AGENT_BASE}/minimax-cloud/api/v1/signin/claim?timezone_offset=28800&is_desktop=1&client=desktop`;
export const TOKEN_REFRESH_URL = `${MINIMAX_ACCOUNT_BASE}/oauth2/token`;

/** 按账号档位解析各端点（CN / 国际只差域名，路径完全一致） */
export function minimaxEndpointsOf(account) {
  const { agent, account: accountBase } = basesOf(account);
  return {
    agent,
    account: accountBase,
    messagesUrl: `${agent}/mavis/api/v1/llm/v1/messages`,
    profileUrl: `${agent}/matrix/api/v1/user/profile`,
    membershipUrl: `${agent}/matrix/api/v1/commerce/get_membership_info`,
    signinStatusUrl: `${agent}/minimax-cloud/api/v1/signin/status?timezone_offset=28800&is_desktop=1&client=desktop`,
    signinClaimUrl: `${agent}/minimax-cloud/api/v1/signin/claim?timezone_offset=28800&is_desktop=1&client=desktop`,
    tokenRefreshUrl: `${accountBase}/oauth2/token`,
  };
}

/** 账户动作类端点（签到 / 额度 / 资料）的服务端签名，取自 10Router open-sse 实现 */
const SIGN_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2';
const md5hex = (s) => createHash('md5').update(s).digest('hex');

/**
 * 构造 signed account 请求：查询参数与请求头参与签名，签名值绑定
 * URL+时间戳(+body)，因此不能与裸 fetch 的查询串混用。
 * @returns {{url: string, headers: object, body?: string}}
 */
export function signedMiniMaxRequest(flavor, path, { access, userID, body, now = Date.now() } = {}) {
  const lang = flavor === 'global' ? 'en' : 'zh';
  const url = new URL(path, basesOf({ provider: flavor === 'global' ? 'minimax-global' : 'minimax' }).agent);
  url.search = new URLSearchParams({
    device_platform: 'mcode',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    unix: String(now),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: lang,
    lang,
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: String(userID ?? '').trim() || '0',
    client: 'mcode',
  }).toString();
  const at = url.pathname + url.search;
  const ts = Math.floor(now / 1000);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'MiniMaxCode',
    Authorization: `Bearer ${String(access || '').trim()}`,
    yy: json === undefined
      ? md5hex(`${encodeURIComponent(at)}_{}${md5hex(String(now))}ooui`)
      : md5hex(`${encodeURIComponent(at)}_${json}${md5hex(String(now))}ooui`),
    'x-timestamp': String(ts),
    'x-signature': json === undefined ? md5hex(`${ts}${SIGN_SECRET}`) : md5hex(`${ts}${SIGN_SECRET}${json}`),
  };
  return { url: url.toString(), headers, body: json };
}

/** 账户端点统一入口：国际版走签名 + 代理优先（CN 网络直连 agent.minimax.io 会被 307 到 CN 域名家族） */
function signedCall(account, path, { access, userID, body, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const flavor = minimaxFlavorOf(account);
  const req = signedMiniMaxRequest(flavor, path, { access, userID, body });
  return fetchJsonRace(req.url, {
    method: req.body === undefined ? 'GET' : 'POST',
    headers: req.headers,
    body: req.body ?? null,
    timeoutMs,
    preferProxy: flavor === 'global',
  });
}

/** 307 到别的域名家族 = 地区限制，本机配置代理即可，token 本身没问题 */
function geoNote(requestedUrl, res) {
  try {
    const from = new URL(requestedUrl).host;
    const to = new URL(res.url || requestedUrl).host;
    if (from === to) return null;
    return `上游 ${from} 在当前网络被重定向到 ${to}（地区限制）——请为国际版配置代理后重试`;
  } catch {
    return null;
  }
}

/** 签名里的 user_id：账号已解析出 uid 时带上，未解析按 10Router 口径退化为 "0" */
function uiOf(account) {
  return account?.uid || account?.meta?.realUserID || undefined;
}

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
export async function refreshMiniMaxToken(refreshToken, { flavor = 'cn' } = {}) {
  if (!refreshToken) throw new Error('缺少 refreshToken');
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  form.set('client_id', 'mcode-public');
  form.set('scope', 'agent.default');
  form.set('audience', 'agent-backend');

  const res = await fetchJsonRace(MINIMAX_FLAVORS[flavor].account + '/oauth2/token', {
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
 * 并发互斥 + 失效链熔断已提升到 src/refreshGuard.js —— workbuddy / mirasim 复用同一守卫。
 * MiniMax 特有的点：刷新前先 alignMiniMaxFromLocal 对齐本机客户端最新链（客户端会轮换）。
 * 刷新成功后内置自动原子持久化到账号库（防单次轮换的 refreshToken 因调用方未传 onRefresh 而丢失在内存）。
 */
export function refreshAccountToken(account, ctx = {}) {
  return withRefreshDedupe(account, async (a) => {
    try {
      const { alignMiniMaxFromLocal } = await import('./minimaxLocal.js');
      alignMiniMaxFromLocal(a, ctx.log);
    } catch {}
    ctx.log?.('MiniMax token 已过期，正在自动刷新…');
    try {
      const refreshed = await refreshMiniMaxToken(a.refreshToken, { flavor: minimaxFlavorOf(a) });
      const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
      const creds = {
        token: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt,
      };
      a.token = creds.token;
      a.refreshToken = creds.refreshToken;
      a.expiresAt = expiresAt;

      // 关键防护：只要账号有 id，无条件立即持久化回写账号库！
      // MiniMax 采用严格单次轮换（Single-Use Refresh Token Rotation）：旧 refreshToken
      // 只要刷新成功就在服务端当场作废。如果依赖外界传 onRefresh，任何未传上下文的调用
      // （如后台额度卡推送、轻量查询等）都会让新 token 丢在内存，下次读盘只能读到作废的旧链，
      // 导致用户「1天内必报 invalid_grant 凭据作废」。
      if (a.id) {
        try {
          const { withAccounts } = await import('./store.js');
          await withAccounts((list) => {
            const cur = list.find((it) => it.id === a.id);
            if (cur) {
              cur.token = creds.token;
              cur.refreshToken = creds.refreshToken;
              cur.expiresAt = expiresAt;
              cur.updatedAt = new Date().toISOString();
            }
          });
        } catch (saveErr) {
          ctx.log?.(`MiniMax 刷新凭据落盘失败: ${saveErr.message}`);
        }
      }

      await ctx.onRefresh?.(creds);
      return creds;
    } catch (refErr) {
      ctx.log?.(`MiniMax token 自动刷新失败: ${refErr.message}`);
      throw refErr;
    }
  }, {
    deadMessage: 'MiniMax 凭据链已被服务端作废，等待重新登录',
    deadNotice: 'MiniMax 凭据链已失效，将不再自动重试（重新登录或重新导入该账号后自动恢复）',
    log: ctx.log,
  });
}

/**
 * 获取用户信息
 */
export async function fetchMiniMaxProfile(token, { flavor = 'cn' } = {}) {
  const res = await fetchJsonRace(MINIMAX_FLAVORS[flavor].agent + '/matrix/api/v1/user/profile', {
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
    const res = await signedCall(account, '/matrix/api/v1/commerce/get_membership_info', { access: token, userID: uiOf(account), body: {} });
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
 * 只查签到状态，不打 claim（10R 只读推送用，issue #33）。
 * 刷新失败等凭据问题照常抛错；查询失败返回 null（推送侧降级为不带签到字段）。
 * @returns {Promise<{checkedToday: boolean, streakDays: number, points: number, bonusPoints: number}|null>}
 */
export async function fetchMiniMaxCheckinStatus(account, ctx = {}) {
  try {
    return await withMiniMaxAuth(account, async (token) => {
      const statusRes = await signedCall(account, '/minimax-cloud/api/v1/signin/status', { access: token, userID: uiOf(account) });
      if (!statusRes.ok) return null;
      const statusData = await statusRes.json().catch(() => null);
      if (!statusData || statusData.base_resp?.status_code !== 0) return null;
      const today = (statusData.data?.days || []).find((d) => d.is_today);
      if (!today) return null;
      return {
        checkedToday: today.status === 3,
        streakDays: today.day_no || 0,
        points: today.points || 0,
        bonusPoints: today.bonus_points || 0,
      };
    }, ctx);
  } catch {
    return null;   // 推送是旁路：凭据失效 / 网络抖动都不该炸整轮推送
  }
}

/**
 * 每日自动签到 (checkin)
 */
export async function checkinMiniMax(account, ctx = {}) {
  return withMiniMaxAuth(account, async (token) => {
    // 1. 查询签到状态
    const statusRes = await signedCall(account, '/minimax-cloud/api/v1/signin/status', { access: token, userID: uiOf(account) });
    if (statusRes.status === 401 || statusRes.status === 403) {
      const geo = geoNote(statusRes.url, statusRes);
      if (geo) throw new Error(geo);
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

    // 2. 发起签到 claim（status=GET，claim=POST；动词错了是裸 404，不是签名错）
    const claimRes = await signedCall(account, '/minimax-cloud/api/v1/signin/claim', { access: token, userID: uiOf(account), body: {} });
    if (claimRes.status === 401 || claimRes.status === 403) {
      const geo = geoNote(claimRes.url, claimRes);
      if (geo) throw new Error(geo);
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
