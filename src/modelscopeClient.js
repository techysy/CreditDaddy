/**
 * ModelScope 魔搭（modelscope.cn）魔粒（Magicube）余额抓取（CD#25）。
 *
 * 凭据 = havana 登录会话 cookie（阿里账号体系）；API 面走 `<host>/openapi/v1/…`：
 *  - GET /openapi/v1/magicubes/balance        余额（每日魔粒额度自动发放，无签到动作端点）
 *  - GET /api/v1/users/login/info             身份 userInfo（Name）
 *  - GET /api/v1/users/info                   身份 accountInfo（email / email_extra[]）
 * 端点事实源：2026-10-14 前端 chunk 考古（86 chunk 无 claim/signIn POST——「Login Reward」
 * 为登录自动入账，「Daily Magicube Rewards!」为入账提示弹层）。
 *
 * 安全纪律：会话 cookie 只存本机账号库（0600），推 10Router 只带魔粒余额数字。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';
import { snapshotAgeTag } from './externalQuota.js';

export const MS_BASE = 'https://modelscope.cn';
export const MS_BALANCE_URL = `${MS_BASE}/openapi/v1/magicubes/balance`;
export const MS_TRANSACTIONS_URL = `${MS_BASE}/openapi/v1/magicubes/transactions`;
// 身份走账号体系（前端 axios baseURL = `${host}/api`，非 /openapi）——2026-10-14 端点探测：
// GET /api/v1/users/login/info → Data{Name,…}（initializeUserInfo 源头）
// GET /api/v1/users/info      → Data{email, email_extra[],…}（getAccountInfo 源头）
// 注意这两条响应信封是**大写** {Code,Message,Success,Data}；magicubes 走 /openapi 是小写。
export const MS_LOGIN_INFO_URL = `${MS_BASE}/api/v1/users/login/info`;
export const MS_USER_INFO_URL = `${MS_BASE}/api/v1/users/info`;

const MS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function msHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    Cookie: String(cookie || '').trim(),
    Referer: `${MS_BASE}/magicube/usage?tab=earn`,
    'User-Agent': MS_UA,
  };
}

/**
 * 从魔粒余额响应里提取余额数字。事实源（2026-10-14 前端 store 映射）：
 *   `balance: e?.total_balance || 0, available_balance: e?.available_balance || 0`
 * 卡面口径对齐官方「My Magicubes」= total_balance（UI 的 balance 即它）；
 * available_balance 作兜底（可用口径）。其余键为演化兜底。
 */
export function parseMagicubeBalance(body) {
  const d = body?.data || body?.result || body || {};
  const cand = [
    d.total_balance, d.totalBalance,
    d.available_balance, d.availableBalance,
    d.balance, d.amount, d.total, d.magicube, d.magicubes, d.available,
    d.balance?.amount, d.balance?.total, body?.balance,
  ];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
  }
  return null;
}

/**
 * 身份：`GET /api/v1/users/login/info`（userInfo，Name）+ `GET /api/v1/users/info`
 * （accountInfo，`email` / `email_extra[]`——顶栏 findLast(e => e.email === u?.email && e.identity === 'user')）。
 * 信封大写 `{Code,Message,Success,Data}`（前端 `accountInfo:(await Yi())?.Data`），兼容小写兜底。
 * 宽容解析，抽不到返 null。
 */
export function parseMsIdentity(body) {
  const d = body?.Data || body?.data || body?.result || body || {};
  const id = d.user_id || d.userId || d.id || d.uid || d.UserID || d.UserId || null;
  const email = d.email || d.Email || d.user_email || d.mail
    || (Array.isArray(d.email_extra) ? (d.email_extra.find((e) => e?.identity === 'user')?.email || d.email_extra[0]?.email) : null)
    || null;
  const name = d.Name || d.name || d.user_name || d.nick || null;
  return { id: id ? String(id) : null, email: email ? String(email) : null, name: name ? String(name) : null };
}

/**
 * 用会话 cookie 探测魔粒余额（捕获验证 + 推卡 live 读共用）。
 * 401/403 → 会话失效；200 但解析不出 → 结构变化（分开归类，对齐既有探测口径）。
 * @returns {Promise<{ok: boolean, balance?: number, identity?: object, raw?: object, error?: string, status?: number}>}
 */
export async function fetchMagicubeBalance(cookie, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS, method: init.method }));
  try {
    const res = await doFetch(MS_BALANCE_URL, { headers: msHeaders(cookie) });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, authExpired: true, error: `会话失效（HTTP ${res.status}）` };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const balance = parseMagicubeBalance(body);
    if (balance === null) {
      // 失败时把响应字段名带进错误（只记键名不记值）——字段演化时一眼定位
      const keys = Object.keys(body?.data && typeof body.data === 'object' ? body.data : body || {}).slice(0, 12).join(',');
      return { ok: false, status: res.status, error: `未能从响应中提取魔粒余额（响应字段：${keys || '空'}）`, raw: body };
    }
    // 身份尽力而为：users/login/info（Name）+ users/info（email/email_extra）双向合并；失败不挡余额
    let identity = null;
    for (const url of [MS_LOGIN_INFO_URL, MS_USER_INFO_URL]) {
      try {
        const r2 = await doFetch(url, { method: 'GET', headers: msHeaders(cookie) });
        if (!r2.ok) continue;
        const b2 = await r2.json().catch(() => null);
        const parsed = parseMsIdentity(b2);
        const keys = Object.keys(b2?.Data && typeof b2.Data === 'object' ? b2.Data : b2?.data && typeof b2.data === 'object' ? b2.data : b2 || {}).slice(0, 12).join(',');
        // 合并而非首中即停：login/info 带 Name、users/info 带 email——互补
        identity = {
          id: identity?.id || parsed.id || null,
          email: identity?.email || parsed.email || null,
          name: identity?.name || parsed.name || null,
          keys: [identity?.keys, keys].filter(Boolean).join(' | '),
        };
        if (identity.email && identity.name && identity.id) break;
      } catch { /* 下一个兜底 */ }
    }
    return { ok: true, balance, identity, raw: body };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 发放记录（transactions）→ 今日/长期拆分。项形（2026-10-14 前端映射）：
 *   { type: 'EARN' | 'SPEND_CONFIRM' | 'EXPIRE', expire_days, total_amount ?? amount, date | gmt_created }
 * 有效期字段是 **expire_days**（前端行渲染 `e.expire_days>1 ? 有效期{days}天 : 有效期{day}天`）——
 * 缺失按未知处理（归长期），绝不折算成 1 天误吞进今日。
 * 口径：**今日发放** = 今日获得且 `expire_days<=1` 的 EARN 之和（官方「每日发放 有效期1天」）；
 * **长期** = total_balance − 今日（吸收消耗/过期误差，与官方发放记录页对得上：300 = 200 + 50 + 50）。
 */
export function parseMagicubeLedger(items, totalBalance, now = Date.now()) {
  const list = Array.isArray(items) ? items : [];
  const d0 = new Date(now);
  const todayStr = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  let today = 0;
  for (const it of list) {
    if (!it || it.type !== 'EARN') continue;
    const days = Number(it.expire_days ?? it.days);
    const amt = Number(it.total_amount ?? it.amount);
    // 仅 (0,1] 天有效才算今日发放；expire_days=0（长期有效）/缺失/90 天均归长期
    if (!Number.isFinite(days) || days <= 0 || days > 1 || !Number.isFinite(amt) || amt < 0) continue;
    const day = String(it.date || it.gmt_created || '').split(' ')[0].split('T')[0].trim();
    if (day === todayStr) today += amt;
  }
  const total = Number(totalBalance);
  if (Number.isFinite(total)) today = Math.min(today, Math.max(0, total));
  return { today: Math.round(today * 100) / 100, long: Number.isFinite(total) ? Math.round(Math.max(0, total - today) * 100) / 100 : null };
}

/** 发放记录拉取（拆分用，fail-soft：失败返回 null，卡面回退单值） */
export async function fetchMagicubeLedger(cookie, totalBalance, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS }));
  try {
    const res = await doFetch(`${MS_TRANSACTIONS_URL}?page=1&page_size=50`, { headers: msHeaders(cookie) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const d = body?.data;
    const items = Array.isArray(d) ? d : (d?.list || d?.records || d?.items || body?.list || body?.records || []);
    return parseMagicubeLedger(items, totalBalance);
  } catch { return null; }
}

/**
 * 一次跑齐「余额 + 身份 + 流水拆分」——捕获入库与就地重探共用。
 * @returns {Promise<{ok: boolean, error?: string, status?: number, balance?: number,
 *   identity?: string|null, keys?: string, msSession?: object, msBalance?: object, ledger?: object}>}
 */
export async function probeMagicubeSession(cookie, { fetchImpl } = {}) {
  const bal = await fetchMagicubeBalance(cookie, { fetchImpl });
  if (!bal.ok) return { ok: false, error: bal.error, status: bal.status };
  const ledger = await fetchMagicubeLedger(cookie, bal.balance, { fetchImpl }).catch(() => null);
  const s = bal.identity || {};
  const hasIdentity = Boolean(s.id || s.email || s.name);
  return {
    ok: true,
    balance: bal.balance,
    identity: s.email || s.name || s.id || null,
    keys: s.keys || '',
    msSession: hasIdentity ? s : {},
    ledger,
    msBalance: {
      amount: bal.balance,
      today: ledger?.today ?? null,
      long: ledger?.long ?? null,
      at: new Date().toISOString(),
    },
  };
}

/**
 * 组装 ModelScope 魔粒余额的 10Router external-quota 载荷（储值计数卡）。
 * 有拆分时：汇总行名 = 副标题「今日发放 X · 长期 Y (魔粒)」+ 逐包明细两腿（今日 1 天有效 / 长期）；
 * 无拆分回退单值行。label = 账号别名（10R「同名认领」匹配键）。
 * @param {object} account
 * @param {{ balance?: number, ledger?: object, error?: string, authInvalid?: boolean }} [liveData]
 *   authInvalid = live 拉取明确 401/403（魔搭会话失效）——不回退旧快照，降级 message 状态卡
 */
export function buildModelScopeQuotaPayload(account, liveData = null) {
  const sess = account?.meta?.msSession || {};
  const userId = account?.uid || sess.id || '';
  const short = String(userId).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  const source = short ? `modelscope-${short}`.slice(0, 32) : `modelscope-${(account?.id || 'default').slice(0, 24)}`;
  const nameStr = String(account?.name || '').trim();
  const email = sess.email || /[\w.+-]+@[\w-]+\.[\w.]+/.exec(nameStr)?.[0] || '';

  if (liveData?.authInvalid) {
    return {
      source,
      payload: {
        provider: 'modelscope',
        label: (nameStr || (email ? `ModelScope (${email})` : 'ModelScope')).slice(0, 100),
        message: liveData.error || t('ModelScope 会话已失效，请在 CreditDaddy「账号会话」页重新登录捕获'),
      },
    };
  }

  let balance = liveData?.balance;
  let ageTag = '';
  if (!Number.isFinite(balance)) {
    const snap = account?.meta?.quotaSnapshot;
    balance = Number(snap?.total ?? account?.meta?.msBalance?.amount);
    // 快照回退（非 live）：距今 >24h 的陈粮在副标题标注数据时刻（可见性兜底）
    ageTag = snapshotAgeTag(snap?.at ? snap : account?.meta?.msBalance);
  }
  const ledger = liveData?.ledger || account?.meta?.msBalance || null;

  // label = 账号别名（用户可改）——10R「同名认领」的匹配键
  const label = (nameStr || (email ? `ModelScope (${email})` : 'ModelScope')).slice(0, 100);
  const payload = {
    provider: 'modelscope',
    label,
    plan: t('魔粒余额') + ageTag,
  };

  if (Number.isFinite(balance) && balance >= 0) {
    const total = Math.max(0, balance) || 0.000001;
    const hasSplit = ledger && Number.isFinite(ledger.today) && Number.isFinite(ledger.long);
    const name = hasSplit
      ? t('今日发放 {today} · 长期 {long} (魔粒)', { today: Number(ledger.today).toFixed(0), long: Number(ledger.long).toFixed(0) })
      : t('魔粒余额（个）');
    payload.quotas = {
      Balance: {
        name,
        used: 0,
        total,
        remainingPercentage: balance > 0 ? 100 : 0,
        displayRemaining: true,
        isCreditBalance: true,
        summarizesDetail: true,
      },
    };
    if (hasSplit) {
      payload.quotas.Today = {
        name: t('今日发放（1 天有效）'),
        used: 0,
        total: Math.max(0.000001, Number(ledger.today) || 0.000001),
        remainingPercentage: Number(ledger.today) > 0 ? 100 : 0,
        displayRemaining: true,
        isCreditBalance: true,
        detailOnly: true,
      };
      payload.quotas.LongTerm = {
        name: t('长期余额'),
        used: 0,
        total: Math.max(0.000001, Number(ledger.long) || 0.000001),
        remainingPercentage: Number(ledger.long) > 0 ? 100 : 0,
        displayRemaining: true,
        isCreditBalance: true,
        detailOnly: true,
      };
    }
  } else {
    payload.message = liveData?.error || t('ModelScope 会话已失效，请在 CreditDaddy「账号会话」页重新登录捕获');
  }

  return { source, payload };
}
