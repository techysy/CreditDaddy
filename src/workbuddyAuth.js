/**
 * WorkBuddy / CodeBuddy 浏览器登录 — 与 WorkBuddy 桌面端（platform=WorkBuddy）同一流程：
 *
 *   1. POST {host}/v2/plugin/auth/state?platform=WorkBuddy        → {state, authUrl}
 *   2. 用户在浏览器（桌面版为隐私窗口）打开 authUrl 登录
 *   3. GET  {host}/v2/plugin/auth/token?state=…                   code 11217 = 等待；成功返回 accessToken 等
 *   4. GET  {host}/v2/plugin/login/account?state=…（Bearer）       code 12151 = 等待；返回当前账号
 *   5. GET  {host}/v2/plugin/accounts（Bearer）                    账号列表（best-effort）
 *
 * 3~5 组装成与 workbuddy-desktop.info 相同结构的会话，经 sessionToAccount 入库，
 * 因此浏览器登录的账号与「本机导入」一样可签到、查积分、一键切换 WorkBuddy 客户端。
 * 国内版走 www.codebuddy.cn（WorkBuddy 客户端默认域名），国际版走 www.codebuddy.ai。
 */

import { FETCH_TIMEOUT_MS } from './constants.js';
import { sessionToAccount } from './workbuddyLocal.js';

const HOSTS = { workbuddy: 'www.codebuddy.cn', 'workbuddy-intl': 'www.codebuddy.ai' };
const PLATFORM = 'WorkBuddy';
const USER_AGENT = 'CLI/2.108.1 CodeBuddy/2.108.1';
const RETRY_FETCH_TOKEN = 11217;
const RETRY_FETCH_ACCOUNT = 12151;
const ACCOUNT_MAX_ATTEMPTS = 8;   // 拿到 token 后账号信息迟迟不就绪时，退化为仅 token 入库

function headers(host, extra = {}) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Domain': host,
    'X-Product': 'SaaS',
    ...extra,
  };
}
const ANON = { 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' };

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { res, body };
}

export async function startWorkbuddyLogin(provider) {
  const host = HOSTS[provider] || HOSTS.workbuddy;
  const { res, body } = await fetchJson(`https://${host}/v2/plugin/auth/state?platform=${PLATFORM}`, {
    method: 'POST',
    headers: headers(host, { 'X-No-Authorization': 'true', 'X-No-User-Id': 'true' }),
    body: '{}',
  });
  const d = body?.data;
  if (!res.ok || body?.code !== 0 || !d?.state || !d?.authUrl) {
    throw new Error('WorkBuddy 登录初始化失败：' + (body?.msg || 'HTTP ' + res.status));
  }
  return {
    url: d.authUrl,
    expiresInMs: 10 * 60e3,
    intervalMs: 3000,
    data: { provider, host, state: d.state, token: null, accountAttempts: 0 },
  };
}

/** 单次轮询（按阶段推进，状态存在 data 上）：{status:'pending'} | {status:'ok', input}；失败抛错 */
export async function pollWorkbuddyLogin(data) {
  const { host, state } = data;
  if (!data.token) {
    const { res, body } = await fetchJson(`https://${host}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: headers(host, ANON),
    });
    if (body?.code === RETRY_FETCH_TOKEN) return { status: 'pending' };
    if (res.status >= 500 || res.status === 429) return { status: 'pending' };
    if (!res.ok || body?.code !== 0 || !body?.data?.accessToken) {
      throw new Error('WorkBuddy 授权失败：' + (body?.msg || 'HTTP ' + res.status));
    }
    const now = Date.now();
    const t = body.data;
    data.token = {
      ...t,
      domain: t.domain || host,
      lastRefreshTime: now,
      ...(Number.isFinite(t.expiresIn) ? { expiresAt: now + t.expiresIn * 1000 } : {}),
      ...(Number.isFinite(t.refreshExpiresIn) ? { refreshExpiresAt: now + t.refreshExpiresIn * 1000 } : {}),
    };
  }

  const auth = { Authorization: `Bearer ${data.token.accessToken}` };
  let account = null;
  data.accountAttempts++;
  try {
    const { res, body } = await fetchJson(`https://${host}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
      headers: headers(host, { ...auth, 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' }),
    });
    if (res.ok && body?.code === 0 && body.data && typeof body.data === 'object') account = body.data;
    else if (data.accountAttempts < ACCOUNT_MAX_ATTEMPTS
      && (body?.code === RETRY_FETCH_ACCOUNT || res.status === 401 || res.status === 403 || res.status >= 500)) {
      return { status: 'pending' };
    }
  } catch {
    if (data.accountAttempts < ACCOUNT_MAX_ATTEMPTS) return { status: 'pending' };
  }

  let list = [];
  if (account) {
    try {
      const { res, body } = await fetchJson(`https://${host}/v2/plugin/accounts`, { headers: headers(host, auth) });
      if (res.ok && Array.isArray(body?.data?.accounts)) list = body.data.accounts;
    } catch {}
  }

  // 与 WorkBuddy 客户端的会话文件同构；拿不到账号信息时只保留 token（可签到 / 查积分，不能切换客户端）
  const session = account
    ? {
      account: { ...(list.find((a) => a.uid === account.uid) || {}), ...account, lastLogin: true },
      accounts: list.filter((a) => a.pluginEnabled),
      allAccounts: list,
      auth: data.token,
    }
    : { auth: data.token };
  const input = sessionToAccount(session, '浏览器登录');
  if (!input) throw new Error('WorkBuddy 返回的 token 无法识别（签发方不是 CodeBuddy / WorkBuddy）');
  if (!account) delete input.meta.session;
  input.source = 'browser';
  return { status: 'ok', input };
}
