/**
 * LongCat（longcat.chat，美团）Token 资源包余额抓取（issue #29）。
 *
 * 纯只读接入——资源包为购买/赠送发放，无签到动作端点。
 * 凭据 = longcat.chat 会话 cookie（美团账号体系 SSO），打平台 API 走 cookie 直连
 * （fetch wrapper 只加 Content-Type + x-requested-with，无 Bearer/CSRF——2026-10-15
 * chunk 考古 + 登录态实测；未登录 401 `{"code":401,"msg":"用户未登录，请先登录"}`）。
 *
 * 数据端点（事实源 = 登录态响应，2026-10-15）：
 *   POST /api/pay/quota/metering/token-packs/summary   body {}
 *     → data.currentLot   当前消耗中的包（含 remainingToken/consumedToken/totalToken/
 *       expireTime/consumeOrder/grantCategory/source，可能为 null——全部包耗尽时）
 *     → data.otherLots[]  其余可用包（同形状；expireTime "YYYY-MM-DD HH:mm:ss"）
 *   （/commercial/entitlements/token-packs/list 实测返回空分页壳，summary 已含全部字段，不采用）
 *
 * 卡面口径（issue #37 定版「字段即真相」）：Balance 汇总行 = 全部 ACTIVE 包
 * remaining 之和（isCreditBalance + summarizesDetail，used/total 推 Σ消耗/Σ总量，
 * 10R 的池条按真实消耗画空段）；逐包明细腿 = currentLot + otherLots 各一行
 * （detailOnly，used=consumed、total=包总量、remainingPercentage=剩余%、
 * name 纯文案「获赠资源包/资源包」，到期日走 resetAt），排序按 consumeOrder
 * ——官方「赠送先扣、近到期先扣」的消耗顺序。
 *
 * 安全纪律：会话 cookie 只存本机账号库（0600），推 10Router 只带 token 数字标量。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';

export const LC_BASE = 'https://longcat.chat';
export const LC_PACKS_SUMMARY_URL = `${LC_BASE}/api/pay/quota/metering/token-packs/summary`;

const LC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function lcHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Cookie: String(cookie || '').trim(),
    Referer: `${LC_BASE}/platform/usage`,
    Origin: LC_BASE,
    // 站点 fetch wrapper 的事实头（考古 index-6651bc05 chunk）；m-appkey 实测非必需，带上同形
    'x-requested-with': 'XMLHttpRequest',
    'm-appkey': 'fe_com.sankuai.friday.longcat.platform',
    'X-Client-Language': 'zh',
    'User-Agent': LC_UA,
  };
}

/** "YYYY-MM-DD HH:mm:ss"（UTC+8）→ ISO；解析不出返 null */
export function lcTimeToIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  // 站点时间按美团口径为 UTC+8（remainSeconds 与 expireTime 实测自洽）
  const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

/**
 * summary 响应 → 全部 ACTIVE 包列表。宽容解析：currentLot/otherLots 缺失按空处理。
 * @returns {{ ok: true, packs: Array<{total, remaining, consumed, expireAt, grantCategory, source, consumeOrder}>, raw?: object }
 *          | { ok: false, error: string, status?: number, authExpired?: boolean, raw?: object }}
 */
export function parsePacksSummary(body) {
  const d = body?.data && typeof body.data === 'object' ? body.data : null;
  if (!d) return { ok: false, error: 'summary 响应无 data', raw: body };
  const lots = [];
  if (d.currentLot && typeof d.currentLot === 'object') lots.push(d.currentLot);
  if (Array.isArray(d.otherLots)) lots.push(...d.otherLots.filter((x) => x && typeof x === 'object'));
  const packs = [];
  for (const it of lots) {
    if (String(it.status || 'ACTIVE') !== 'ACTIVE') continue;
    const remaining = Number(it.remainingToken);
    const total = Number(it.totalToken);
    if (!Number.isFinite(remaining) || !Number.isFinite(total)) continue;
    packs.push({
      total,
      remaining: Math.max(0, remaining),
      consumed: Number(it.consumedToken) || 0,
      expireAt: lcTimeToIso(it.expireTime),
      grantCategory: String(it.grantCategory || ''),
      source: String(it.source || ''),
      consumeOrder: Number(it.consumeOrder) || 99,
    });
  }
  packs.sort((a, b) => a.consumeOrder - b.consumeOrder || String(a.expireAt).localeCompare(String(b.expireAt)));
  return { ok: true, packs };
}

/**
 * 用会话 cookie 探测资源包余额（捕获验证 + 推卡 live 读共用）。
 * 401（{"code":401,"msg":"用户未登录…"}）/403 → 会话失效（authExpired）。
 * code!==0 的其他业务错归结构/状态异常（分开归类，对齐既有探测口径）。
 * @returns {Promise<{ok: boolean, packs?: Array, raw?: object, error?: string, status?: number, authExpired?: boolean}>}
 */
export async function fetchLongcatPacks(cookie, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS, method: init.method, body: init.body }));
  try {
    const res = await doFetch(LC_PACKS_SUMMARY_URL, { method: 'POST', headers: lcHeaders(cookie), body: '{}' });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, authExpired: true, error: `会话失效（HTTP ${res.status}）` };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return { ok: false, status: res.status, error: '非 JSON 响应' };
    if (Number(body.code) === 401) {
      return { ok: false, status: 401, authExpired: true, error: String(body.msg || '会话失效') };
    }
    if (Number(body.code) !== 0) {
      return { ok: false, status: res.status, error: `业务错误 code ${body.code}：${body.msg || ''}`.trim(), raw: body };
    }
    const parsed = parsePacksSummary(body);
    if (!parsed.ok) return { ok: false, status: res.status, error: parsed.error, raw: body };
    return { ok: true, packs: parsed.packs, raw: body };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 身份解析（2026-10-15 实测）：GET /api/v1/user-current（cookie 直连，GET 无 body）。
 * 信封形状宽容解析：{code:0,data:{…}}（对齐 packs API）；401/403 归会话失效（fail-soft，
 * 调用方把身份缺失当无身份单例处理，不阻断捕获）。
 * @returns {Promise<{ ok: boolean, session?: {userId, email, name}, raw?: object, error?: string, status?: number }>}
 */
export async function fetchLongcatIdentity(cookie, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, timeoutMs: FETCH_TIMEOUT_MS, method: init.method }));
  try {
    const res = await doFetch(`${LC_BASE}/api/v1/user-current`, { method: 'GET', headers: lcHeaders(cookie) });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: `会话失效（HTTP ${res.status}）` };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return { ok: false, status: res.status, error: '非 JSON 响应' };
    const d = body?.data && typeof body.data === 'object' ? body.data : body?.user && typeof body.user === 'object' ? body.user : null;
    if (!d) return { ok: false, status: res.status, error: 'user-current 响应无 data', raw: body };
    const userId = d.userId ?? d.id ?? d.uid ?? null;
    const email = d.email ?? d.mail ?? null;
    const name = d.name ?? d.nickname ?? d.username ?? null;
    if (userId == null && !email && !name) return { ok: false, status: res.status, error: 'user-current 无身份字段', raw: body };
    const uid = d.uid ?? null;
    return {
      ok: true,
      session: {
        ...(userId != null ? { userId: String(userId) } : {}),
        ...(uid != null && String(uid) !== String(userId ?? '') ? { uid: String(uid) } : {}),
        ...(email ? { email: String(email) } : {}),
        ...(name ? { name: String(name) } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 快照入库形状（capture/reprobe 共用）：全部 ACTIVE 包 + 时间戳 */
export function longcatSnapshot(packs) {
  return {
    packs,
    at: new Date().toISOString(),
  };
}

/**
 * 组装 LongCat 资源包的 10Router external-quota 载荷（储值卡 + 逐包明细）。
 *  - Balance 汇总行 = 全部 ACTIVE 包 remaining 之和（isCreditBalance + summarizesDetail，
 *    used/total 推 Σ消耗/Σ总量——池条据此画消耗空段）；
 *  - 逐包明细腿 = 每包一行（detailOnly，used=consumed、total=包总量、name 纯文案），
 *    0 剩余包也出行；
 *  - 无可用包（全部耗尽/过期）→ message 状态卡。
 * @param {object} account  meta.longcatPacks（快照）
 * @param {{ packs?: Array, error?: string, authInvalid?: boolean }} [liveData]
 *   authInvalid = live 拉取明确 401/403——不回退旧快照，降级 message 状态卡
 * @returns {{ source: string, payload: object }}
 */
export function buildLongcatQuotaPayload(account, liveData = null) {
  const sess = account?.meta?.longcatSession || {};
  const userId = sess.userId || account?.uid || '';
  const short = String(userId).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  const source = short ? `longcat-${short}`.slice(0, 32) : `longcat-${(account?.id || 'default').slice(0, 24)}`;
  const nameStr = String(account?.name || '').trim();
  const email = sess.email || /[\w.+-]+@[\w-]+\.[\w.]+/.exec(nameStr)?.[0] || '';
  const label = (nameStr || (email ? `LongCat (${email})` : 'LongCat')).slice(0, 100);

  if (liveData?.authInvalid) {
    return {
      source,
      payload: {
        provider: 'longcat',
        label,
        message: liveData.error || t('LongCat 会话已失效，请在 CreditDaddy「账号会话」页重新登录捕获'),
      },
    };
  }

  // live 优先，快照兜底（非 live 且 >24h 由 snapshotAgeTag 标注陈粮）
  let packs = liveData?.packs;
  let ageTag = '';
  if (!Array.isArray(packs)) {
    const snap = account?.meta?.quotaSnapshot;
    packs = account?.meta?.longcatPacks?.packs;
    ageTag = snapshotAge(snap?.at ?? account?.meta?.longcatPacks?.at);
  }

  const active = (packs || []).filter((p) => p && Number.isFinite(Number(p.remaining)));
  const balance = active.reduce((s, p) => s + Math.max(0, Number(p.remaining)), 0);
  const payload = { provider: 'longcat', label, plan: t('Token 资源包') + ageTag };

  if (active.length && balance > 0) {
    const f = (n) => {
      const v = Number(n) || 0;
      return v >= 1e4 ? `${Math.round(v / 1e4 * 100) / 100} 万` : String(v);
    };
    // 字段即真相（issue #37）：used/total/remainingPercentage 推真实数字，
    // name 只做纯文案——10R 渲染链自会出倒计时、剩余/总量与消耗百分比，
    // 数字拼进 name 只会让卡面同一数值印两遍、进度条与文字互相矛盾。
    const pct1 = (rem, tot) => (tot > 0 ? Math.max(0, Math.min(100, Math.round((rem / tot) * 1000) / 10)) : 0);
    const totalAll = active.reduce((s, p) => s + Math.max(0, Number(p.total) || 0), 0);
    const usedAll = active.reduce((s, p) => s + Math.max(0, Number(p.consumed) || 0), 0);
    payload.quotas = {
      Balance: {
        name: `${t('剩余')} ${f(balance)} (${t('Token')})`,
        used: usedAll,
        total: totalAll,
        remainingPercentage: pct1(balance, totalAll),
        displayRemaining: true,
        isCreditBalance: true,
        summarizesDetail: true,
      },
    };
    for (const [i, p] of active.entries()) {
      const kind = p.grantCategory === 'GIFT' || p.source === 'FREE_PACK';
      payload.quotas[`Pack${i + 1}`] = {
        name: kind ? t('获赠资源包') : t('资源包'),
        used: Math.max(0, Number(p.consumed) || 0),
        total: Number(p.total),
        remainingPercentage: pct1(Math.max(0, Number(p.remaining)), Number(p.total)),
        displayRemaining: true,
        isCreditBalance: true,
        ...(kind ? { giftPack: true } : {}),
        detailOnly: true,
        resetAt: p.expireAt || undefined,
      };
    }
  } else {
    payload.message = liveData?.error || t('LongCat 资源包已耗尽或会话未捕获，请在 CreditDaddy「账号会话」页重新登录捕获');
  }

  return { source, payload };
}

/** 快照陈粮标注（与 externalQuota.snapshotAgeTag 同口径；此处避免循环依赖本地实现） */
function snapshotAge(at) {
  const ts = Date.parse(at || '');
  if (!Number.isFinite(ts)) return '';
  if (Date.now() - ts < 24 * 3600_000) return '';
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return t('（数据 {m}-{d} {hh}:{mm}）', { m: d.getMonth() + 1, d: d.getDate(), hh: p2(d.getHours()), mm: p2(d.getMinutes()) });
}
