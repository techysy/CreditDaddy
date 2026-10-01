/**
 * MiniMax Code OpenAPI 客户端 — 覆盖：userinfo、配额查询、每日签到。
 *
 * 协议对齐 MiniMax Code 桌面客户端 0.x：
 *   GET  /api/v1/user/profile                 → { id, name, email, … }
 *   GET  /api/v1/user/billing/quota           → { used, total, remaining, expiresAt? }
 *   POST /api/v1/user/campaigns/checkin       → { status: success|already, amount?, message? }
 *
 * Token 格式：由桌面客户端登录后生成的 Bearer Token（类似 workbuddy/zcode）
 */

import { logger } from './logger.js';

const API_BASE = 'https://api.minimax.com'; // 需要根据实际流量调整
const FETCH_TIMEOUT_MS = 30_000;

/** 解析账号的有效请求 token：直接从 account.token 中读取 */
export async function resolveToken(account) {
  const token = String(account.token || '').trim();
  return token.startsWith('Bearer ') ? token : (token || null);
}

/** 拉取账号信息（昵称/邮箱/uid），用于给账号起显示名 */
export async function fetchUserinfo(account) {
  const token = await resolveToken(account);
  if (!token) throw new Error('token 不可用');

  const res = await fetch(`${API_BASE}/api/v1/user/profile`, {
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`userinfo HTTP ${res.status}: ${text.slice(0, 120)}`);
  }

  return res.json();
}

/** 查询配额/积分用量 */
export async function fetchQuotaUsage(account) {
  const token = await resolveToken(account);
  if (!token) throw new Error('token 不可用');

  const res = await fetch(`${API_BASE}/api/v1/user/billing/quota`, {
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`quota HTTP ${res.status}: ${text.slice(0, 120)}`);
  }

  return res.json();
}

/**
 * 在基础请求头上叠加客户端身份与设备风控身份
 */
async function buildCampaignHeaders(token, uid) {
  const headers = {
    Authorization: token,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // TODO: 如果需要设备风控身份，可以参考 qoderApp.js 中的 getRiskIdentity
  // 例如：Cosy-MachineToken/Cosy-MachineCode 等头部

  return { headers };
}

/**
 * 执行一次 MiniMax 签到（领取每日积分）
 *
 * 返回结果对象，status 取值：
 *   success     领取成功（含金额）
 *   already     今日已领
 *   no-campaign 当前无可领活动
 *   failed      失败（错误见 error 字段）
 * 附带 uid（MiniMax 用户 ID），供调用方回写账号。
 */
export async function checkinOne(account) {
  const label = account.name || account.id;
  const base = { accountId: account.id, account: label, provider: account.provider };
  const token = await resolveToken(account);

  if (!token) {
    return { ...base, status: 'failed', error: 'token 不可用' };
  }

  try {
    // 1) 获取用户 uid（如果还没有的话）
    let uid = account.uid || null;
    if (!uid) {
      try {
        const info = await fetchUserinfo(account);
        uid = info.id;
      } catch (e) {
        logger.debug('MINIMAX CHECKIN', `${label}: 无法获取 userinfo: ${e.message}`);
        // userinfo 失败不影响后续尝试
      }
    }

    // 2) 构建请求头
    const { headers } = await buildCampaignHeaders(token, uid);

    // 3) 发起签到请求
    const res = await fetch(`${API_BASE}/api/v1/user/campaigns/checkin`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');

      // 409 可能表示今日已签到
      if (res.status === 409 || res.status === 400) {
        const data = JSON.parse(text).catch(() => ({}));
        const msg = data.message || data.error || '今日已签到';
        return { ...base, uid, status: 'already', message: msg };
      }

      return { ...base, uid, status: 'failed', error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    }

    const result = await res.json();

    // 4) 解析响应
    if (result.success || result.code === 0) {
      const amount = result.data?.amount || result.amount || 0;
      return {
        ...base,
        uid,
        status: 'success',
        claimedAmount: amount,
        message: result.message || '签到成功',
      };
    } else {
      return {
        ...base,
        uid,
        status: 'already',
        message: result.message || result.error || '今日已签到',
      };
    }

  } catch (err) {
    logger.warn('MINIMAX CHECKIN', `${label}: ${err.message}`);
    return { ...base, status: 'failed', error: err.message };
  }
}

/** 友好化配额数据，统一为 Credits 结构 */
export function normalizeQuota(quotaData) {
  if (!quotaData) return null;

  const raw = quotaData;

  // 支持的字段映射（根据实际 API 调整）
  const mapField = (key, defaultVal = 0) => Number(raw[key] ?? raw[`total_${key}`] ?? raw[`remaining_${key}`] ?? defaultVal);

  return {
    total: mapField('total_quota', raw.total || raw.limit || 0),
    used: mapField('used'),
    remaining: mapField('remaining'),
    parts: [], // MiniMax 可能没有细分资源包
  };
}
