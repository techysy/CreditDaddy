/**
 * 小米 MiMo 开放平台（platform.xiaomimimo.com）控制台会话与余额抓取（issue #26）。
 *
 * 10Router 的 xiaomi-mimo 云端 API Key 上游为按量计费，没有配额 API；
 * 小米控制台提供了用户资料与充值余额接口。CreditDaddy 在账号会话收割线（#23）下：
 *  1. 用会话 Cookie 抓取小米控制台的账号 UID 与实时余额；
 *  2. 按 10Router 外部配额规范（#24）将余额数值以单值余额卡（isStoredValueRow）
 *     形式推送到 10Router（source: xiaomi-mimo-{userId}）。
 *
 * 安全纪律：仅向 10Router 推送余额标量数字，任何 Cookie / Token 材料绝不出本机。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';
import { snapshotAgeTag } from './externalQuota.js';

export const MIMO_PLATFORM_BASE = 'https://platform.xiaomimimo.com';
export const MIMO_USER_PROFILE_URL = `${MIMO_PLATFORM_BASE}/api/v1/userProfile`;
export const MIMO_BALANCE_URL = `${MIMO_PLATFORM_BASE}/api/v1/balance`;
export const MIMO_CONSOLE_URL = `${MIMO_PLATFORM_BASE}/console/balance`;

function mimoHeaders(cookie, referer = `${MIMO_PLATFORM_BASE}/`) {
  return {
    Cookie: String(cookie || '').trim(),
    Referer: referer,
    Accept: 'application/json, text/plain, */*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

/**
 * 获取小米控制台用户资料（提取 UID 与账号名）
 * @param {string} cookie
 * @param {{ fetchImpl?: Function }} [opts]
 * @returns {Promise<{ ok: boolean, userId: string|null, userName?: string, raw?: object, error?: string }>}
 */
export async function fetchXiaomiMimoProfile(cookie, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doFetch(MIMO_USER_PROFILE_URL, { headers: mimoHeaders(cookie) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `会话失效（HTTP ${res.status}）`, status: res.status, authExpired: true };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { return { ok: false, error: '非 JSON 响应', rawText: text }; }
    // 宽容解析：通常结构为 { code: 0, data: { userId: '...', userName: '...' } } 或平铺
    const d = data?.data || data?.result || data || {};
    const userId = d.userId || d.user_id || d.id || d.uid || data.userId || null;
    const userName = d.userName || d.user_name || d.nickname || d.name || d.email || null;
    if (!userId) return { ok: false, error: '未能从响应中提取 userId', data };
    return { ok: true, userId: String(userId), userName: userName ? String(userName) : null, raw: data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * 获取小米控制台账户余额
 * @param {string} cookie
 * @param {string|number} userId
 * @param {{ fetchImpl?: Function }} [opts]
 * @returns {Promise<{ ok: boolean, balance: number, cash?: number, voucher?: number, raw?: object, error?: string }>}
 */
export async function fetchXiaomiMimoBalance(cookie, userId, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS }));
  const referer = `${MIMO_CONSOLE_URL}?userId=${encodeURIComponent(userId || '')}`;
  try {
    const res = await doFetch(MIMO_BALANCE_URL, { headers: mimoHeaders(cookie, referer) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `会话失效（HTTP ${res.status}）`, status: res.status, authExpired: true };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { return { ok: false, error: '非 JSON 响应', rawText: text }; }
    const d = data?.data || data?.result || data || {};
    // 提取数字：可用余额 / 账户余额
    const cand = [
      d.availableBalance, d.available_balance,
      d.balance,
      d.totalBalance, d.total_balance,
      d.cashBalance, d.cash_balance,
      d.amount,
      data.balance,
    ];
    let balance = 0;
    for (const v of cand) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) { balance = n; break; }
    }
    const cash = Number(d.cashBalance ?? d.cash_balance ?? d.cash);
    const voucher = Number(d.giftBalance ?? d.gift_balance ?? d.voucherBalance ?? d.voucher_balance ?? d.voucher);
    return {
      ok: true,
      balance: Math.round(balance * 100) / 100,
      cash: Number.isFinite(cash) ? Math.round(cash * 100) / 100 : undefined,
      voucher: Number.isFinite(voucher) ? Math.round(voucher * 100) / 100 : undefined,
      raw: data,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * 组装单个小米 MiMo 账号的 10Router external-quota 载荷
 * @param {object} account
 * @param {{ balance?: number, cash?: number, voucher?: number, error?: string, authInvalid?: boolean }} [liveData]
 *   authInvalid = live 拉取明确 401/403（会话失效）——此时不回退旧快照，降级 message 状态卡
 *   （死会话挂旧数字会让 10R 卡面永远看不出失效，快照 TTL 还被每轮推送续命）
 * @returns {{ source: string, payload: object }}
 */
export function buildXiaomiMimoQuotaPayload(account, liveData = null) {
  const userId = account.meta?.userId || account.uid || (account.name?.match(/UID[:：\s]*([0-9a-zA-Z_-]+)/i)?.[1]) || 'default';
  const cleanSource = `xiaomi-mimo-${String(userId).toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 32);

  if (liveData?.authInvalid) {
    return {
      source: cleanSource,
      payload: {
        provider: 'xiaomi-mimo',
        label: String(account?.name || '').trim() || `Xiaomi MiMo (UID: ${userId})`,
        message: liveData.error || t('小米控制台会话已失效，请在 CreditDaddy「账号会话」页重新登录捕获'),
      },
    };
  }

  const snap = account.meta?.quotaSnapshot;
  const mimoBal = account.meta?.mimoBalance;
  let balance = liveData?.balance;
  let ageTag = '';
  if (!Number.isFinite(balance)) {
    balance = Number(snap?.total ?? snap?.balance ?? mimoBal?.balance);
    // 快照回退（非 live）：距今 >24h 的陈粮在副标题标注数据时刻（可见性兜底）
    ageTag = snapshotAgeTag(snap?.at ? snap : mimoBal);
  }

  let cash = liveData?.cash;
  if (!Number.isFinite(cash)) {
    cash = Number(mimoBal?.cash);
  }

  let voucher = liveData?.voucher;
  if (!Number.isFinite(voucher)) {
    voucher = Number(mimoBal?.voucher);
  }

  // label = 账号别名（用户可改）——10R「同名认领」的匹配键：与连接同名即把余额挂上连接卡；
  // 默认名保持 Xiaomi MiMo (UID: …)（daemon 捕获时的归户名）
  const label = String(account?.name || '').trim() || `Xiaomi MiMo (UID: ${userId})`.slice(0, 100);
  const payload = {
    provider: 'xiaomi-mimo',
    label,
    plan: t('控制台充值余额') + ageTag,
  };

  if (Number.isFinite(balance) && balance >= 0) {
    // 对齐小米官方控制台的储值池呈现口径：
    //  - 顶部 Headline 渲染为可用余额「✦ 32.88 (CNY)」；
    //  - 副标题对齐官方明确标注「现金余额：¥ 0.00 · 赠送余额：¥ 32.88」；
    //  - 现金 / 赠送两腿折进「逐包明细」（各一行、含 0 腿），外层不再重复画进度条。
    // Balance 是汇总行：`summarizesDetail` 让 10R 的 isSummaryRow 把它从逐包明细
    // 里丢掉（10R 卡面纪律：汇总句混进明细首行 = 同一数值印两遍）。
    const cashVal = Number.isFinite(cash) ? cash : 0;
    const voucherVal = Number.isFinite(voucher) ? voucher : balance;
    const subText = t('现金余额：¥ {cash} · 赠送余额：¥ {voucher}', { cash: cashVal.toFixed(2), voucher: voucherVal.toFixed(2) });

    const quotas = {
      Balance: {
        name: `${subText} (CNY)`,
        used: 0,
        total: Math.max(0, balance) || 0.000001,
        remainingPercentage: balance > 0 ? 100 : 0,
        displayRemaining: true,
        summarizesDetail: true,
      },
    };
    // 明细两腿：0 值也出行（副标题已标明两腿，逐包明细对位给「现金余额」「赠送余额」
    // 各行）；detailOnly 不进汇总池，0 腿不扰动单值沉淀。
    if (Number.isFinite(cash)) {
      quotas.Cash = {
        name: t('现金余额 (CNY)'),
        used: 0,
        total: Math.max(0, cash),
        remainingPercentage: cash > 0 ? 100 : 0,
        displayRemaining: true,
        detailOnly: true,
      };
    }
    if (Number.isFinite(voucher)) {
      quotas.Voucher = {
        name: t('赠送余额 (CNY)'),
        used: 0,
        total: Math.max(0, voucher),
        remainingPercentage: voucher > 0 ? 100 : 0,
        displayRemaining: true,
        detailOnly: true,
      };
    }
    payload.quotas = quotas;
  } else {
    payload.message = liveData?.error || t('小米控制台会话已失效，请在 CreditDaddy「账号会话」页重新登录捕获');
  }

  return { source: cleanSource, payload };
}
