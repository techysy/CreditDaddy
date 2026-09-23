/**
 * Qoder OpenAPI 客户端 — 调用结构源自 10router 实测代码。
 * 覆盖：userinfo、配额查询、活动列表、领取、PAT→jobToken 兑换。
 */

import {
  OPENAPI_BASE, CN_OPENAPI_BASE,
  USERINFO_PATH, QUOTA_USAGE_PATH,
  CAMPAIGNS_PATH, CAMPAIGN_CLAIM_PATH, JOB_TOKEN_EXCHANGE_PATH,
  buildQoderHeaders, buildExchangeHeaders, FETCH_TIMEOUT_MS,
} from './constants.js';

export function apiBase(provider) {
  return provider === 'qoder-cn' ? CN_OPENAPI_BASE : OPENAPI_BASE;
}

async function req(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return res;
}

/** PAT (pt-...) 兑换短期 job token (jt-...)。普通 JSON POST，无需 COSY 签名。 */
export async function exchangePatToJobToken(pat, isCn = false) {
  const url = `${isCn ? CN_OPENAPI_BASE : OPENAPI_BASE}${JOB_TOKEN_EXCHANGE_PATH}`;
  const res = await req(url, {
    method: 'POST',
    headers: buildExchangeHeaders(),
    body: JSON.stringify({ personal_token: pat }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PAT 兑换失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('PAT 兑换未返回 job token');
  return { jobToken: data.token, expiresAt: data.expires_at || null };
}

/** 解析账号的有效请求 token：PAT 先兑换成 job token */
export async function resolveToken(account) {
  const token = String(account.token || '').trim();
  if (!token) return null;
  if (token.startsWith('pt-')) {
    try {
      const { jobToken } = await exchangePatToJobToken(token, account.provider === 'qoder-cn');
      return jobToken;
    } catch {
      return null; // 兑换失败按无 token 处理，由上层报告
    }
  }
  return token;
}

/** 拉取账号信息（昵称/邮箱），用于给账号起显示名 */
export async function fetchUserinfo(account) {
  const token = await resolveToken(account);
  if (!token) throw new Error('token 不可用');
  const res = await req(`${apiBase(account.provider)}${USERINFO_PATH}`, {
    headers: buildQoderHeaders(token),
  });
  if (!res.ok) throw new Error(`userinfo HTTP ${res.status}`);
  return res.json();
}

/** 查询配额/积分用量 */
export async function fetchQuotaUsage(account) {
  const token = await resolveToken(account);
  if (!token) throw new Error('token 不可用');
  const res = await req(`${apiBase(account.provider)}${QUOTA_USAGE_PATH}`, {
    headers: buildQoderHeaders(token),
  });
  if (!res.ok) throw new Error(`quota HTTP ${res.status}`);
  return res.json();
}

/**
 * 对单个账号执行一次签到（领取所有可领活动）。
 * 返回结果对象，status 取值：
 *   checked-in  领取成功（含金额）
 *   already     有积分活动但今日已领
 *   no-activity 当前无可领活动（不代表今天签过）
 *   failed      失败（错误见 error 字段）
 */
export async function checkinOne(account) {
  const label = account.name || account.id;
  const token = await resolveToken(account);

  if (!token) {
    return { accountId: account.id, account: label, provider: account.provider, status: 'failed', error: 'token 不可用（PAT 兑换失败或 token 为空）' };
  }

  const base = apiBase(account.provider);
  const headers = buildQoderHeaders(token);

  try {
    // 1) 拉活动列表
    const listRes = await req(`${base}${CAMPAIGNS_PATH}`, { headers });
    if (listRes.status === 401 || listRes.status === 403) {
      return { accountId: account.id, account: label, provider: account.provider, status: 'failed', error: `鉴权失败 (HTTP ${listRes.status})，token 可能已过期` };
    }
    if (!listRes.ok) {
      return { accountId: account.id, account: label, provider: account.provider, status: 'failed', error: `HTTP ${listRes.status}` };
    }
    const payload = await listRes.json();
    const campaigns = Array.isArray(payload?.campaigns) ? payload.campaigns : [];

    // 2) 筛出可领的积分活动（逻辑同 10router）
    const claimable = campaigns.filter(
      (c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE'
    );

    if (claimable.length === 0) {
      const creditCampaigns = campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT');
      if (creditCampaigns.length === 0) {
        return { accountId: account.id, account: label, provider: account.provider, status: 'no-activity', message: '当前无可领取的活动', claimedAmount: 0 };
      }
      return { accountId: account.id, account: label, provider: account.provider, status: 'already', message: '今日已领或无待领活动', claimedAmount: 0 };
    }

    // 3) 逐个领取
    let totalClaimed = 0;
    const claimedList = [];
    for (const c of claimable) {
      try {
        const claimRes = await req(`${base}${CAMPAIGN_CLAIM_PATH(c.campaignId)}`, {
          method: 'POST', headers,
        });
        if (claimRes.ok) {
          const rj = await claimRes.json().catch(() => ({}));
          const amount = rj.benefit?.amount || c.benefit?.amount || 0;
          totalClaimed += amount;
          claimedList.push({ campaignId: c.campaignId, campaignKey: c.campaignKey, amount, status: 'claimed' });
        }
      } catch { /* 单个活动失败不影响其余 */ }
    }

    if (claimedList.length > 0) {
      return { accountId: account.id, account: label, provider: account.provider, status: 'checked-in', claimedAmount: totalClaimed, campaigns: claimedList };
    }
    return { accountId: account.id, account: label, provider: account.provider, status: 'failed', error: '所有活动领取均失败' };
  } catch (err) {
    return { accountId: account.id, account: label, provider: account.provider, status: 'failed', error: err?.message || '网络错误' };
  }
}
