/**
 * CrowLLM（crowllm.com）钱包余额线 —— cookie-site 网页会话渠道（tokenharbor/lingxi 模式）。
 *
 * 为什么走网页会话而不是连接的 API key（2026-11-21 实测）：
 * - one-hub 系的 /v1/dashboard/billing/subscription 对 chat key 返回 200，但
 *   hard_limit_usd 恒为 100000000（站点假上限），total_usage 恒 0 —— 不携带钱包数据；
 * - /api/user/self 等 new-api 用户端点要「系统访问令牌」（个人中心生成）或网页会话，
 *   chat key（连接里那把 48 字符串）一律 401；
 * - 用户看到的 $110 赠送额度只在登录后的网页钱包（/api/user/self 的 quota 字段）。
 *
 * 协议形态：new-api 家族标准 —— 带网页会话 Cookie GET /api/user/self，
 * { success:true, data:{ quota, used_quota, … } }；quota 是 one-api 计数单位，
 * quota_per_unit=500000 → 美元 = quota / 500000。未登录/会话失效 401。
 */

export const CROWLLM_BASE = 'https://crowllm.com';
export const CROWLLM_SELF_URL = `${CROWLLM_BASE}/api/user/self`;
/** one-api 家族计数单位：$1 = 500000 quota（crowllm /api/status 的 quota_per_unit 实测值） */
export const CROWLLM_QUOTA_PER_UNIT = 500000;

import { fetchJsonRace } from './zcodeClient.js';

const FETCH_TIMEOUT_MS = 20000;

function cookieHeaders(cookie) {
  return {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    Referer: CROWLLM_BASE + '/',
    // new-api 系 SPA 的 XHR 形头；自定义 UA 不需要（/api/* 裸 curl 直通，2026-11-21 实测）
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

/**
 * 网页会话查钱包。@returns {{ auth: boolean, ok?: boolean, balanceUsd?: number,
 *   usedUsd?: number, giftUsd?: number|null, code?: string }}
 * auth:false = 会话失效（401 / 非 JSON / 无 data）；giftUsd 拿得到拆分就带，拿不到 null。
 */
export async function fetchCrowllmWallet(cookie, { fetchImpl } = {}) {
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));
  let res;
  try {
    res = await doIt(CROWLLM_SELF_URL, { method: 'GET', headers: cookieHeaders(cookie) });
  } catch (e) {
    return { auth: false, code: e?.message || 'network' };
  }
  if (res.status === 401 || res.status === 403) return { auth: false, code: 'NEED_LOGIN' };
  if (!res.ok) return { auth: false, code: `HTTP ${res.status}` };
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { return { auth: false, code: 'non-json' }; }
  // new-api 形态 { success, data }；data.quota 缺失视为会话失效（半登录态防误报余额 0）
  const d = data?.data;
  if (!data?.success || !d || !Number.isFinite(Number(d.quota))) return { auth: false, code: 'no-quota' };
  const quota = Number(d.quota);
  const usedQuota = Number(d.used_quota) || 0;
  // new-api 的 user 行没有独立的「赠送额度」字段（充值/赠送都混在 quota）；
  // 拆分行只在站点带出来时才出（防御式，缺省 null 不画）
  const gift = Number.isFinite(Number(d.gift_quota)) ? Number(d.gift_quota) : null;
  const toUsd = (q) => Math.round((q / CROWLLM_QUOTA_PER_UNIT) * 100) / 100;
  return {
    auth: true,
    ok: true,
    balanceUsd: toUsd(quota),
    usedUsd: toUsd(usedQuota),
    giftUsd: gift === null ? null : toUsd(gift),
    // 捕获身份（多号归户/账号命名）：new-api 的 display_name / username / email
    username: String(d.display_name || d.username || '').trim() || null,
    email: String(d.email || '').trim() || null,
  };
}

/**
 * 额度卡 payload（10R 免费额度页直接消费；source 形态与 lingxi/tokenharbor 同口径）。
 * liveData = fetchCrowllmWallet 的实时结果；缺省回退 meta.quotaSnapshot 快照。
 */
export function buildCrowllmQuotaPayload(account, liveData = null) {
  const uid = account.uid || 'default';
  const cleanSource = `crowllm-${String(uid).toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 32);
  const label = String(account?.name || '').trim() || 'CrowLLM';

  if (liveData && liveData.auth === false) {
    return {
      source: cleanSource,
      payload: {
        provider: 'crowllm',
        label,
        message: 'CrowLLM 会话已失效，请在 CreditDaddy「网页会话」页重新登录捕获',
      },
    };
  }

  let snap = liveData?.ok ? { balanceUsd: liveData.balanceUsd, usedUsd: liveData.usedUsd, giftUsd: liveData.giftUsd } : null;
  let ageTag = '';
  if (!snap) {
    const s = account.meta?.quotaSnapshot;
    if (s && Number.isFinite(Number(s.total))) {
      snap = { balanceUsd: Number(s.total), usedUsd: Number(s.used) || 0, giftUsd: Number(s.giftUsd ?? null) };
      ageTag = snapshotAgeTag(s);
    }
  }
  if (!snap || !Number.isFinite(Number(snap.balanceUsd))) {
    return {
      source: cleanSource,
      payload: { provider: 'crowllm', label, message: 'CrowLLM 余额未知（尚未成功捕获会话）' },
    };
  }

  const balance = Math.max(0, Number(snap.balanceUsd));
  const used = Math.max(0, Number(snap.usedUsd) || 0);
  const total = balance + used;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((balance / total) * 1000) / 10)) : 0;

  const payload = {
    provider: 'crowllm',
    label,
    plan: '钱包余额' + ageTag,
  };
  payload.quotas = {
    Balance: {
      name: `剩余 $${balance}（免费目录）`,
      used,
      total,
      remainingPercentage: pct,
      displayRemaining: true,
      isCreditBalance: true,
      summarizesDetail: true,
    },
  };
  // 赠送额度拆分行：截图口径「赠送额度 $110，只能在免费目录使用」。站点不出 gift_quota
  // 拆分时（user/self 无该字段）整行省略，总数行已覆盖。
  if (Number.isFinite(Number(snap.giftUsd)) && snap.giftUsd > 0) {
    payload.quotas.Gift = {
      name: `赠送额度 $${snap.giftUsd}`,
      used: 0,
      total: Number(snap.giftUsd),
      remainingPercentage: 100,
      displayRemaining: true,
      isCreditBalance: true,
      giftPack: true,
    };
  }
  return { source: cleanSource, payload };
}

function snapshotAgeTag(snap) {
  const at = Date.parse(snap?.at || '');
  if (!Number.isFinite(at)) return '';
  const age = Date.now() - at;
  if (age < 24 * 3600e3) return '';
  return `（快照 ${Math.floor(age / 86400e3)} 天前）`;
}
