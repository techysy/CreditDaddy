/**
 * Qoder OpenAPI 客户端 — 覆盖：userinfo、配额查询、活动列表、领取、PAT→jobToken 兑换。
 *
 * 签到协议对齐 Qoder App 0.2.x 客户端：
 *   GET  /sash/api/v1/me/campaigns                 → { uid, showCampaign, claimable, campaigns:[…] }
 *   POST /sash/api/v1/me/campaigns/{id}/claim
 * 国际版必须携带设备风控身份（Cosy-MachineToken/Code/Type）才会下发「每天领 100 Credits」，
 * 风控身份由本机 Qoder 客户端的 runtime-info 生成（见 qoderApp.js）；国内版无需。
 */

import {
  OPENAPI_BASE, CN_OPENAPI_BASE,
  USERINFO_PATH, QUOTA_USAGE_PATH,
  CAMPAIGNS_PATH, CAMPAIGN_CLAIM_PATH, JOB_TOKEN_EXCHANGE_PATH,
  buildQoderHeaders, buildExchangeHeaders, FETCH_TIMEOUT_MS,
} from './constants.js';
import { getRiskIdentity, clientVersion, machineOs, machineHostname, machineId } from './qoderApp.js';
import { logger } from './logger.js';

export function apiBase(provider) {
  return provider === 'qoder-cn' ? CN_OPENAPI_BASE : OPENAPI_BASE;
}

async function req(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

/** 拉取账号信息（昵称/邮箱/uid），用于给账号起显示名 */
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
  if (res.status === 401 || res.status === 403) throw new Error(`鉴权失败 (HTTP ${res.status})，token 可能已过期`);
  if (!res.ok) throw new Error(`quota HTTP ${res.status}`);
  return res.json();
}

/**
 * 在基础请求头上叠加客户端身份与设备风控身份（与 Qoder App 的 createAuthorizedHeaders 一致）。
 * 风控身份不可用时只加客户端身份，并在 riskError 中说明原因。
 */
export async function buildCampaignHeaders(account, token, uid) {
  const headers = {
    ...buildQoderHeaders(token),
    'Cosy-Version': clientVersion(account.provider),
    'Cosy-MachineOS': machineOs(),
    'Cosy-MachineId': machineId(account.provider),
  };
  const host = machineHostname();
  if (host) headers['Cosy-MachineHostname'] = host;
  let risk = null, riskError = null;
  try {
    risk = await getRiskIdentity(account.provider, uid);
    if (!risk) riskError = process.platform === 'linux' ? '未安装 Qoder 设备身份组件（面板 Qoder 页可一键安装），无法生成设备风控身份' : '本机未安装 Qoder 客户端，无法生成设备风控身份';
  } catch (e) {
    riskError = e.message;
  }
  if (risk) {
    headers['Cosy-MachineToken'] = risk.machineToken;
    headers['Cosy-MachineCode'] = risk.machineCode;
    headers['Cosy-MachineType'] = risk.machineType;
  }
  return { headers, risk: Boolean(risk), riskError };
}

async function getCampaigns(base, headers) {
  const res = await req(`${base}${CAMPAIGNS_PATH}`, { headers });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`鉴权失败 (HTTP ${res.status})，token 可能已过期`);
    err.auth = true;
    throw err;
  }
  if (!res.ok) throw new Error(`活动列表 HTTP ${res.status}`);
  const payload = await res.json();
  return {
    uid: typeof payload?.uid === 'string' ? payload.uid : null,
    campaigns: Array.isArray(payload?.campaigns) ? payload.campaigns : [],
  };
}

const creditCampaign = (c) => c.actionType === 'CLAIM_BENEFIT';

/**
 * 对单个账号执行一次签到（领取所有可领活动）。
 * 返回结果对象，status 取值：
 *   checked-in  领取成功（含金额）
 *   already     有积分活动但今日已领
 *   no-activity 当前无可领活动（不代表今天签过）
 *   failed      失败（错误见 error 字段）
 * 附带 uid（Qoder 用户 ID），供调用方回写账号。
 */
export async function checkinOne(account) {
  const label = account.name || account.id;
  const base = { accountId: account.id, account: label, provider: account.provider };
  const token = await resolveToken(account);
  if (!token) {
    return { ...base, status: 'failed', error: 'token 不可用（PAT 兑换失败或 token 为空）' };
  }

  try {
    // 1) 基础请求拿 uid（风控身份按 uid 生成）；uid 已知时可直接跳过
    let uid = account.uid || null;
    let first = null;
    if (!uid) {
      first = await getCampaigns(apiBase(account.provider), buildQoderHeaders(token));
      uid = first.uid;
    }

    // 2) 带客户端身份 + 设备风控身份重新拉取（国际版只有这样才会出现每日积分活动）
    const { headers, risk, riskError } = await buildCampaignHeaders(account, token, uid);
    if (riskError) logger.debug('CHECKIN', `${label}：${riskError}`);
    const { campaigns, uid: uid2 } = (risk || !first) ? await getCampaigns(apiBase(account.provider), headers) : first;
    uid = uid2 || uid;

    const claimable = campaigns.filter((c) => creditCampaign(c) && c.claimStatus === 'CLAIMABLE');
    if (claimable.length === 0) {
      if (!campaigns.some(creditCampaign)) {
        const hint = account.provider !== 'qoder' ? '当前无可领取的活动'
          : risk ? '当前无可领取的活动（国际版每台设备每天限领一次，可能已被本机其他账号领取）'
            : `当前无可领取的活动（${riskError || '缺少设备风控身份'}；国际版需要本机安装 Qoder 客户端）`;
        return { ...base, uid, status: 'no-activity', message: hint, claimedAmount: 0, risk };
      }
      return { ...base, uid, status: 'already', message: '今日已领', claimedAmount: 0, risk };
    }

    // 3) 逐个领取
    let totalClaimed = 0;
    const claimedList = [];
    const errors = [];
    for (const c of claimable) {
      try {
        const claimRes = await req(`${apiBase(account.provider)}${CAMPAIGN_CLAIM_PATH(c.campaignId)}`, {
          method: 'POST', headers,
        });
        if (claimRes.ok) {
          const rj = await claimRes.json().catch(() => ({}));
          const amount = rj.benefit?.amount || c.benefit?.amount || 0;
          totalClaimed += amount;
          claimedList.push({ campaignId: c.campaignId, campaignKey: c.campaignKey, amount, status: 'claimed' });
        } else {
          const text = await claimRes.text().catch(() => '');
          errors.push(`HTTP ${claimRes.status} ${text.slice(0, 120)}`);
        }
      } catch (e) { errors.push(e.message); }
    }

    if (claimedList.length > 0) {
      return { ...base, uid, status: 'checked-in', claimedAmount: totalClaimed, campaigns: claimedList, risk };
    }
    return { ...base, uid, status: 'failed', error: `领取失败：${errors.join('；') || '未知原因'}`, risk };
  } catch (err) {
    return { ...base, status: 'failed', error: err?.message || '网络错误' };
  }
}
