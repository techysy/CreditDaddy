/**
 * 千问办公 API 客户端 — 覆盖：account-context（资料+套餐+配额）、余额。
 *
 * 千问办公与 Qoder 同源（内部名 qoderwork），但没有 Qoder 的 /api/v1/userinfo、
 * /api/v2/quota/usage（企业版专用）与 sash 活动/签到——个人版资料与配额都从
 * account-context 一次取全（data.user / data.plan / data.quota / data.page）。
 *
 * 端点与请求头来自 10router open-sse + 本机真机日志交叉验证；鉴权只看 Bearer，
 * X-QwenWork-* 客户端身份头带上与官方客户端保持一致。
 */

import {
  QWENWORK_GATEWAY_BASE, CN_QWENWORK_GATEWAY_BASE,
  QWENWORK_ACCOUNT_CONTEXT_PATH,
  buildQwenworkHeaders, FETCH_TIMEOUT_MS,
} from './constants.js';
import { fetchJsonRace } from './zcodeClient.js';

export function apiBase(provider) {
  return provider === 'qwenwork-cn' ? CN_QWENWORK_GATEWAY_BASE : QWENWORK_GATEWAY_BASE;
}

// 统一走 fetchJsonRace（连接段限时 + 配置了出口代理时直连/代理双路兜底）。
// 国际版网关按 IP 识别地区：preferProxy 与 Qoder 国际版同口径。
async function req(url, options = {}) {
  const { preferProxy = false, ...rest } = options;
  return fetchJsonRace(url, { ...rest, timeoutMs: FETCH_TIMEOUT_MS, preferProxy });
}

/** account-context 响应里的 data（{code:'ok', data:{...}} 或直接对象，双层都兜住） */
function unwrapData(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.data && typeof payload.data === 'object' ? payload.data : payload;
}

/**
 * 拉取账号资料（昵称/邮箱/uid），用于给账号起显示名与归属校验。
 * 与 Qoder 的 /api/v1/userinfo 不同：这里 data.user 嵌套一层，且没有 token 就没有资料。
 */
export async function fetchUserinfo(account) {
  const token = String(account.token || '').trim();
  if (!token) throw new Error('token 不可用');
  const res = await req(`${apiBase(account.provider)}${QWENWORK_ACCOUNT_CONTEXT_PATH}`, {
    headers: buildQwenworkHeaders(token),
    preferProxy: account.provider === 'qwenwork',
  });
  if (res.status === 401 || res.status === 403) throw new Error(`鉴权失败 (HTTP ${res.status})，token 可能已过期`);
  if (!res.ok) throw new Error(`account-context HTTP ${res.status}`);
  const payload = await res.json().catch(() => null);
  const data = unwrapData(payload);
  if (!data?.user || typeof data.user !== 'object') throw new Error(`account-context 响应缺 user（HTTP ${res.status}）`);
  const u = data.user;
  return {
    id: u.id || u.user_id || null,
    name: u.name || u.nickname || u.username || null,
    username: u.username || null,
    email: u.email || null,
    isBiz: Boolean(u.is_biz),
    plan: data.plan || null,
    quota: data.quota || null,
  };
}

/**
 * 查询配额/积分：account-context 的 data.quota = { total, used, remaining, exceeded }。
 * 千问办公个人版是积分余额制（total/used 常为 null，remaining = 剩余积分，实测 899.99）。
 * 返回原始 data，由 providers.js 归一化。
 */
export async function fetchQuotaUsage(account) {
  const token = String(account.token || '').trim();
  if (!token) throw new Error('token 不可用');
  const res = await req(`${apiBase(account.provider)}${QWENWORK_ACCOUNT_CONTEXT_PATH}`, {
    headers: buildQwenworkHeaders(token),
    preferProxy: account.provider === 'qwenwork',
  });
  if (res.status === 401 || res.status === 403) throw new Error(`鉴权失败 (HTTP ${res.status})，token 可能已过期`);
  if (!res.ok) throw new Error(`quota HTTP ${res.status}`);
  const payload = await res.json().catch(() => null);
  const data = unwrapData(payload);
  if (!data || typeof data !== 'object') throw new Error(`quota 响应非 JSON（HTTP ${res.status}）`);
  if (!data.quota || typeof data.quota !== 'object') throw new Error('account-context 响应缺 quota');
  return data;
}
