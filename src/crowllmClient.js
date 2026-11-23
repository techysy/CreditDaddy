/**
 * CrowLLM（crowllm.com）钱包余额线 —— 会话槽 + JWT Bearer 渠道。
 *
 * 凭据现实（2026-11-21 全部实测）：钱包端点 /api/user/self 只认登录签发的 **15 分钟
 * JWT**（Authorization Bearer，iss=new-api）。这个 fork 没有 session Cookie（浏览器
 * 请求只有 cf_clearance）、没有刷新端点、没有系统访问令牌 UI/端点、密码登录带
 * Turnstile——服务端持有式凭据全线不通。唯一自动路 = 真浏览器：persist 分区的
 * GitHub 会话让 SPA 静默重跑 OAuth 签发新 JWT，desktop 侧 CDP 拦 XHR 的
 * Authorization 头摘取（river 的 ses._workosAuth 同款），以 storage 同形键
 * `crowllm:access-jwt` 交给 daemon。过期后 401 → 重新走一次登录窗即可。
 *
 * 协议形态（真实会话实锤）：Bearer JWT GET /api/user/self →
 * { success:true, data:{ earned_quota, quota, used_quota, aff_history_quota, … } }；
 * one-api 计数单位 quota_per_unit=500000 → $1 = 500000 quota。
 * 字段语义：earned_quota=赠送（免费目录专用）、quota=付费、可用总数 = 两者之和。
 */

export const CROWLLM_BASE = 'https://crowllm.com';
export const CROWLLM_SELF_URL = `${CROWLLM_BASE}/api/user/self`;
/** one-api 家族计数单位：$1 = 500000 quota（crowllm /api/status 的 quota_per_unit 实测值） */
export const CROWLLM_QUOTA_PER_UNIT = 500000;

import { fetchJsonRace } from './zcodeClient.js';

const FETCH_TIMEOUT_MS = 20000;

/** JWT payload 的 sub = new-api 用户数字 id —— 用户端点的 New-Api-User 头取这里。
 *  实测请求都带这个头（值与 sub 同源）；服务端对它的校验宽度未考，带上不吃亏。 */
function jwtUser(jwt) {
  try {
    const p = JSON.parse(Buffer.from(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return String(p.sub || '');
  } catch { return ''; }
}

function jwtHeaders(jwt) {
  const h = {
    Authorization: 'Bearer ' + jwt,
    Accept: 'application/json, text/plain, */*',
    Referer: CROWLLM_BASE + '/wallet',
    // new-api 系 SPA 的 XHR 形头；自定义 UA 不需要（/api/* 裸 curl 直通，2026-11-21 实测）
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
  const user = jwtUser(jwt);
  if (user) h['New-Api-User'] = user;
  return h;
}

/**
 * 会话 JWT 查钱包。@param {string} jwt 登录签发的 access JWT（CDP 嗅探所得，15 分钟寿命）。
 * @returns {{ auth: boolean, ok?: boolean, balanceUsd?: number, paidUsd?: number,
 *   giftUsd?: number, usedUsd?: number, affUsd?: number, username?: string|null,
 *   email?: string|null, code?: string }}
 * auth:false = JWT 失效/缺失（AUTH_TOKEN_EXPIRED 判 NEED_LOGIN，重新走登录窗即可）。
 */
export async function fetchCrowllmWallet(jwt, { fetchImpl } = {}) {
  if (!jwt) return { auth: false, code: 'no-jwt' };
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));
  let res;
  try {
    res = await doIt(CROWLLM_SELF_URL, { method: 'GET', headers: jwtHeaders(jwt) });
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
  if (!data?.success || !d || (!Number.isFinite(Number(d.quota)) && !Number.isFinite(Number(d.earned_quota)))) return { auth: false, code: 'no-quota' };
  // 2026-11-21 真实会话实锤的字段语义（对照钱包页截图）：
  //   earned_quota = 活动/签到赠送（只能在免费目录用，截图 $110）
  //   quota        = 充值/付费额度（截图「每个模型可用 $0」）
  //   used_quota   = 累计消费；aff_history_quota = 邀请返佣（独立积累池）
  const earned = Number(d.earned_quota) || 0;
  const paid = Number(d.quota) || 0;
  const usedQuota = Number(d.used_quota) || 0;
  const toUsd = (q) => Math.round((q / CROWLLM_QUOTA_PER_UNIT) * 100) / 100;
  return {
    auth: true,
    ok: true,
    // 总可用 = 付费 + 赠送（钱包页「可用总数」口径）
    balanceUsd: toUsd(paid + earned),
    paidUsd: toUsd(paid),
    giftUsd: toUsd(earned),
    usedUsd: toUsd(usedQuota),
    affUsd: toUsd(Number(d.aff_history_quota) || 0),
    // 捕获身份（多号归户/账号命名）
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
  // 行名带 (USD) 尾括号：10R 的 quotaUnitOf 从尾部括号提单位小字（Loomy 的
  // Balance (CNY) 同款约定），头部数字才会渲染成「110（USD）」而不是裸 110。
  // 「免费目录」的语义说明在 CD 面板 hint 与 10R 卡 tooltip 里，不挤行名。
  payload.quotas = {
    Balance: {
      name: '余额 (USD)',
      used,
      total,
      remainingPercentage: pct,
      displayRemaining: true,
      isCreditBalance: true,
      summarizesDetail: true,
    },
  };
  // 赠送额度拆分行：earned_quota 只能在免费目录使用。站点不出拆分时整行省略，
  // 总数行已覆盖。detailOnly: 余额行 balanceUsd 已含赠送（paid+earned），拆分行
  // 若不标 detailOnly 会被 10R 的加性池再算一遍 → 卡面双倍（2026-11-23 用户报）。
  if (Number.isFinite(Number(snap.giftUsd)) && snap.giftUsd > 0) {
    payload.quotas.Gift = {
      name: '赠送额度 (USD)',
      used: 0,
      total: Number(snap.giftUsd),
      remainingPercentage: 100,
      displayRemaining: true,
      isCreditBalance: true,
      giftPack: true,
      detailOnly: true,
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
