/**
 * 妙手（美团 CatPaw）桌面网关 API 客户端 — 用户信息与额度/版本查询。
 *
 *   GET https://catx.nocode.cn/api/gateway/auth/current-user    用户信息（userId, name, mobile, avatarUrl）
 *   GET https://catx.nocode.cn/api/gateway/credit/balance       可用额度 + 当前套餐（体验版/专业版…）
 *
 * 鉴权：本机妙手客户端解密出的 access_token，放在 X-Auth-Token 头
 * （客户端内部 API 封装同款；网页端 credit.catpaw.meituan.com 的接口只认浏览器 Cookie，不适用）。
 * 响应统一信封 { code: 0, message, data }，code !== 0 视为业务错误。
 *
 * 凭据由妙手客户端登录管理（网页 OAuth 轮转），没有对外的 refresh 接口：
 * token 失效（401）时提示在妙手客户端重新登录后重新本机导入。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

export const CATPAW_GATEWAY = 'https://catx.nocode.cn';

const gw = (p) => CATPAW_GATEWAY + '/api/gateway' + p;
const authHeaders = (token) => ({ 'X-Auth-Token': token, Accept: 'application/json' });

/** GET 网关接口并拆信封；401 → e.auth = true（凭据失效） */
async function gwGet(path, token) {
  const res = await fetchJsonRace(gw(path), { headers: authHeaders(token), timeoutMs: FETCH_TIMEOUT_MS });
  if (res.status === 401) {
    const e = new Error('妙手登录凭据已过期，请在妙手客户端重新登录后到「添加账号 → 本机导入」同步');
    e.auth = true;
    throw e;
  }
  if (!res.ok) throw new Error(`妙手接口 ${path} 失败: HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error(`妙手接口 ${path} 返回无法解析`);
  if (body.code !== 0) {
    const msg = String(body.message || body.errorCode || '未知错误');
    if (body.code === 401 || /未登录|登录失效/.test(msg)) {
      const e = new Error('妙手登录凭据已过期，请在妙手客户端重新登录后重新本机导入');
      e.auth = true;
      throw e;
    }
    throw new Error(`妙手接口 ${path} 返回错误：${msg}`);
  }
  return body.data;
}

/** 用户信息 → { userId, name, mobile, avatarUrl } */
export async function fetchCatpawProfile(token) {
  if (!token) throw new Error('账号缺少 token');
  const d = await gwGet('/auth/current-user', token);
  if (!d || !d.userId) throw new Error('妙手用户信息响应缺少 userId（上游结构可能变化）');
  return { userId: String(d.userId), name: d.name || null, mobile: d.mobile || null, avatarUrl: d.avatarUrl || null };
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/** credit/balance → 统一配额结构（可用妙手 Credits + 当前版本；无总量口径，不计入面板「剩余积分」合计） */
export function normalizeCatpawBalance(d) {
  // 注意 Number(null) === 0：字段缺失 / 为 null 都要判为空额度，而不是 0
  const raw = d?.availableCredits;
  const credits = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const plan = d?.userPlan || {};
  const planName = plan.planName || (plan.pro ? '专业版' : '体验版');
  const remaining = Number.isFinite(credits) ? credits : null;
  return {
    total: remaining ?? 0,
    used: 0,
    remaining: remaining ?? 0,
    unit: 'Credits',
    plan: planName,
    planExpiresAt: iso(Number(plan.expireTime)),
    nextRefreshAt: iso(Number(plan.nextRefreshTime)),
    parts: [{
      name: '可用额度',
      total: remaining ?? 0,
      used: 0,
      remaining: remaining ?? 0,
      unit: 'Credits',
      expiresAt: iso(Number(plan.nextRefreshTime)),
      recurring: true,
    }],
    empty: remaining === null,
    exceeded: plan.status ? plan.status !== 'active' : false,
    pro: plan.pro === true,
    autoRenew: plan.autoRenew === true,
  };
}

/** 查询额度与版本（一次 balance 请求即含 userPlan；401 抛 auth 错误） */
export async function fetchCatpawQuota(account) {
  if (!account.token) throw new Error('账号缺少 token');
  return normalizeCatpawBalance(await gwGet('/credit/balance', account.token));
}

/**
 * 云端用量（按天 token 总量，无输入/输出/缓存拆分、无模型维度）：
 *   GET /api/gateway/v1/usage/token/daily?startTime=&endTime=   → { daily: [{ date: 'YYYY-MM-DD', totalTokens }] }
 * 当天的桶随用随涨，调用方应只取已结束的日期，避免同一天反复快照产生重复行。
 */
export async function fetchCatpawTokenDaily(token, { startTime, endTime } = {}) {
  if (!token) throw new Error('账号缺少 token');
  const d = await gwGet(`/v1/usage/token/daily?startTime=${startTime}&endTime=${endTime}`, token);
  return Array.isArray(d && d.daily) ? d.daily : [];
}
