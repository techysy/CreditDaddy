/**
 * Trae CN 服务端 API — 额度查询与每日签到领积分。
 *
 *   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status  {}  是否已签 / 可领额度
 *   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim   {}  领取（约 150 通用积分/天）
 *   POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage     {"require_usage":true,"req_source":2}
 *
 * 鉴权：authorization: Cloud-IDE-JWT <jwt>（本机客户端 storage.json 解出的那个）。
 * 这些接口是 IDE 自己在调的，因此必须带全套 IDE 请求头；风控要求 x-device-id 为纯数字设备号，
 * 传 GUID 会返回 code 9074。多账号签到时每号必须用独立设备码（同一设备号服务端限每日一领），
 * 故 x-device-id 按 uid 确定性派生。响应统一信封 { code, message, ... }，code !== 0 即业务失败。
 *
 * 请求头集与错误码口径来自社区逆向（TraeWorkAssistant trae_checkin.rs / star620 TraeApiClient.cs 实测）。
 */

import crypto from 'node:crypto';
import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { uidFromJwt } from './traeLocal.js';

export const TRAE_API = 'https://api.trae.cn';

const STATUS_URL = `${TRAE_API}/trae/api/v2/ug/checkin_credits/status`;
const CLAIM_URL = `${TRAE_API}/trae/api/v2/ug/checkin_credits/claim`;
const USAGE_URL = `${TRAE_API}/trae/api/v2/pay/ide_user_ent_usage`;
const PAY_STATUS_URL = `${TRAE_API}/trae/api/v2/pay/ide_user_pay_status`;

/** 签到应得额度兜底：claim 有时只返回 { code:0 } 不带 credits 字段（status 预告值也拿不到时用） */
const TRAE_DEFAULT_DAILY_CREDITS = 100;

/** 时间戳宽容转换：Trae 部分字段是秒、部分是毫秒 */
const iso = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() < 9000 ? d.toISOString() : null;
};

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

/**
 * x-market-user-id / vscode-sessionid 不在客户端 storage.json 里，按 uid 确定性派生：
 * 同一账号每次请求指纹恒定（随机值会让服务端看到「每台请求换一台设备」）。
 */
function seeded(uid, salt, n) {
  const prefix = `${salt}:${uid}`;
  const out = [];
  for (let counter = 0; out.length < n; counter++) {
    out.push(...crypto.createHash('sha256').update(`${prefix}:${counter}`).digest());
  }
  return out.slice(0, n);
}

/**
 * 同机多账号的设备分离（issue #28）：同一个真机 deviceId 只能给「该设备的首账号」用
 * （服务端按设备限每日一领，第二个号起必吃 9074）。首账号按账号顺序定，与签到轮顺序一致。
 * 返回 Set<accountId>；调用方对非首账号不得传 storedDeviceId（走派生号）。
 */
export function traePrimaryIds(accounts) {
  const seen = new Set();
  const primary = new Set();
  for (const a of accounts || []) {
    if (!a || a.provider !== 'trae') continue;
    const dev = String(a.meta?.deviceId || '').trim();
    if (!dev || seen.has(dev)) continue;
    seen.add(dev);
    primary.add(a.id);
  }
  return primary;
}

export function traeDevice(uid, storedDeviceId, attempt = 0) {
  // 首选**登录时注册的真机号**（meta.deviceId，本机导入时从 storage.json 抓的）：
  // 服务端大概率把「号-设备」绑在登录时注册的那台上——陌生设备号打接口吃 9074
  //（issue #31 报告者实测派生号一律被拒、同一时刻真机号可领；本机实测同现象：
  // 导入首日派生号签到成功，之后每天 9074，重试换派生号 3 轮也全拒）。
  // 注意：同机导入的 N 个账号 meta.deviceId 相同（traeLocal 导入时盖同一个值）——
  // 真机号只能给该设备的首账号（见 traePrimaryIds），其余账号由调用方传 null 走派生，
  // 否则第二个号起每天 9074（issue #28 的回归）。attempt>0 一律轮换派生号。
  if (attempt === 0 && storedDeviceId && /^\d{8,}$/.test(String(storedDeviceId))) {
    const m = seeded(`${uid}`, 'market:0', 16);
    m[6] = (m[6] & 0x0f) | 0x40;
    m[8] = (m[8] & 0x3f) | 0x80;
    const h = m.map((b) => b.toString(16).padStart(2, '0')).join('');
    return {
      deviceId: String(storedDeviceId),
      marketUserId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
      sessionId: seeded(uid, 'sess', 32).map((b) => b.toString(16).padStart(2, '0')).join(''),
    };
  }
  // attempt=0 为默认指纹（跨天稳定恒定）；attempt>0 派生结果互异但同样确定（同 attempt 重放一致）。
  const d = seeded(`${uid}`, `devid:${attempt}`, 15).map((b) => String(48 + (b % 10)));
  const m = seeded(`${uid}`, `market:${attempt}`, 16);
  m[6] = (m[6] & 0x0f) | 0x40;
  m[8] = (m[8] & 0x3f) | 0x80;
  const h = m.map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    deviceId: d.join(''),
    marketUserId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
    sessionId: seeded(uid, 'sess', 32).map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

function traeHeaders(jwt, dev) {
  const token = jwt.startsWith('Cloud-IDE-JWT ') ? jwt : `Cloud-IDE-JWT ${jwt.trim()}`;
  return {
    accept: '*/*',
    'accept-language': 'zh-CN',
    authorization: token,
    'content-type': 'application/json',
    'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    'x-market-client-id': 'VSCode 1.107.1',
    'x-market-user-id': dev.marketUserId,
    'x-user-region': 'CN',
    'x-device-id': dev.deviceId,
    'x-lgw-req-sdk-type': '3',
    'package-type': 'stable_cn',
    'x-request-id': hex(16),
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': process.platform === 'win32' ? 'windows' : process.platform,
    'app-version': '0.1.45',
    'x-tt-trace-id': `00-${hex(8)}-01`,
    'vscode-sessionid': dev.sessionId,
  };
}

/** checked_in / credits 可能被包在 data / result 信封里，只读顶层会把已签账号判成未签而重复领取 */
function findField(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return undefined;
  if (key in obj) return obj[key];
  for (const child of [obj.data, obj.result, obj.Result]) {
    const v = findField(child, key, depth + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** 统一 POST → { status, body }；401 / code 1001 抛 auth 错误（凭据失效）。attempt 透传给设备派生（9074 轮换重试用）。
 *  storedDeviceId 显式传 null = 强制走派生号（同机非首账号，见 traePrimaryIds）；缺省读 account.meta.deviceId */
async function post(url, account, body = {}, attempt = 0, storedDeviceId) {
  const jwt = account.token;
  if (!jwt) throw new Error('账号缺少 Trae 登录 token（请到 Trae 客户端登录后用「本机导入」同步）');
  const uid = account.uid || uidFromJwt(jwt);
  const dev = traeDevice(uid || 'anonymous', storedDeviceId !== undefined ? storedDeviceId : account.meta?.deviceId, attempt);
  const res = await fetchJsonRace(url, {
    method: 'POST',
    headers: traeHeaders(jwt, dev),
    body: JSON.stringify(body),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (res.status === 401) {
    const e = new Error('Trae 登录凭据已失效，请在 Trae 客户端重新登录后重新本机导入');
    e.auth = true;
    throw e;
  }
  const parsed = await res.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Trae 接口返回无法解析（HTTP ${res.status}）`);
  }
  const code = Number(parsed.code);
  if (code === 1001) {
    const e = new Error(String(parsed.message || 'Trae JWT 已被服务端吊销'));
    e.auth = true;
    throw e;
  }
  return { status: res.status, body: parsed, uid, code: Number.isFinite(code) ? code : null, message: String(parsed.message || '') };
}

/** claim/status 的业务失败（code !== 0）不带 HTTP 错误状态，按 code 与 message 判定 */
const authDead = (e) => Boolean(e && e.auth);

/** 业务失败提示统一附 code：9074 之外的风控码全靠它定位（issue #31 排查被 message 吞码坑过） */
const withCode = (message, code) => (Number.isFinite(code) && code !== 0 ? `${message}（code ${code}）` : message);

/**
 * 额度：ide_user_ent_usage 的权益包列表 → CreditDaddy 统一结构。
 * 剩余 = entitlement_base_info.quota.credits_limit − pack 顶层 usage.credits_amount（逐包求和）。
 *
 * ⚠️ 这个接口返回裸对象，没有 { code, message } 信封（与签到接口不同），
 * 只有 code 存在且非 0 才算业务失败。总额度优先取服务端自报的 usage_summary，
 * 逐包明细仍按 pack 展开（面板要显示每包到期时间）。
 */
export async function fetchTraeQuota(account) {
  const r = await post(USAGE_URL, account, { require_usage: true, req_source: 2 });
  if (r.code !== null && r.code !== 0) throw new Error(`Trae 额度接口返回错误：${r.message || `code ${r.code}`}`);
  const packs = (findField(r.body, 'user_entitlement_pack_list') || []).filter((p) => p && typeof p === 'object');
  // 每天签到会新发一个 150 分 / 7 天有效期的包，账户上同名包能堆到 30 个；
  // 逐包直出会淹掉面板，故按名称归并（到期时间取最早的那个）。
  const byName = new Map();
  let total = 0;
  let used = 0;
  for (const pack of packs) {
    const base = pack.entitlement_base_info || {};
    const limit = Number(base.quota?.credits_limit);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const spent = Number(pack.usage?.credits_amount) || 0;
    // product_id 209 = Work 积分，其余是通用积分
    const isWork = Number(base.product_id) === 209;
    const name = pack.group_name || pack.display_desc || (isWork ? 'Work 积分' : '通用积分');
    const expiresAt = iso(pack.expire_time ?? base.end_time);
    const prev = byName.get(name);
    if (prev) {
      prev.total += limit;
      prev.used += spent;
      if (expiresAt && (!prev.expiresAt || expiresAt < prev.expiresAt)) prev.expiresAt = expiresAt;
    } else {
      byName.set(name, { name, total: limit, used: spent, expiresAt, recurring: !isWork, unit: '积分' });
    }
    total += limit;
    used += spent;
  }
  const parts = [...byName.values()]
    .map((p) => ({ ...p, total: round2(p.total), used: round2(p.used), remaining: round2(Math.max(p.total - p.used, 0)) }))
    .sort((a, b) => b.remaining - a.remaining);
  const summary = r.body.usage_summary && typeof r.body.usage_summary === 'object' ? r.body.usage_summary : null;
  if (summary && Number(summary.total_amount) > 0) {
    total = Number(summary.total_amount);
    used = Number(summary.consumed_amount) || 0;
  }
  const plan = await fetchTraePlan(account).catch(() => null);
  return {
    total: round2(total),
    used: round2(used),
    remaining: round2(Math.max(total - used, 0)),
    exceeded: total > 0 && total - used <= 0,
    // 顶层不设 unit：面板 creditSum 用「有 unit 即异单位」来排除合计，
    // Trae 与 Qoder 同为「积分」口径，必须计入剩余积分合计。
    plan: plan?.plan || null,
    planExpiresAt: plan?.expiresAt || null,
    parts,
    empty: parts.length === 0 && !summary,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** ide_user_pay_status → 套餐名（Free / Lite / Pro）与到期时间；查不到不影响额度 */
async function fetchTraePlan(account) {
  const r = await post(PAY_STATUS_URL, account, { req_source: 2 });
  if (r.code !== null && r.code !== 0) return null;
  const name = findField(r.body, 'user_pay_identity_str');
  const expire = findField(r.body, 'end_time') ?? findField(r.body, 'next_billing_time');
  return { plan: typeof name === 'string' && name ? name : null, expiresAt: iso(expire) };
}

/**
 * 每日签到：先查 status，已签则报 already，未签才 claim。
 * 返回 CreditDaddy 的签到契约 { status, claimedAmount?, message?, uid? }。
 */
export async function checkinTrae(account, ctx = {}) {
  const uid = account.uid || uidFromJwt(account.token || '');
  const label = account.name || account.id;
  const base = { accountId: account.id, account: label, provider: 'trae' };
  // 同机多账号：真机号只给该 deviceId 的首账号（ctx.traePrimaryIds 由签到循环按全量
  // trae 账号算好），非首账号强制派生号——否则第二个号起每天 9074（issue #28）
  const devArg = (!ctx.traePrimaryIds || ctx.traePrimaryIds.has(account.id)) ? undefined : null;
  let r;
  try {
    r = await post(STATUS_URL, account, {}, 0, devArg);
  } catch (e) {
    if (authDead(e)) throw e;
    return { ...base, status: 'failed', message: e.message, uid };
  }
  if (r.code !== 0) {
    // 服务端部分拒绝文案也长「已经签到」样（如「当前设备今日已经签到」）——归 already，
    // 面板显示「今日已领」而非「领取失败」；多账号同 IP / 同登录源被服务端风控合并时走这条
    if (/已经签到|已签到|already.*sign/i.test(String(r.message || ''))) {
      return { ...base, status: 'already', message: withCode(r.message || '今天已签到', r.code), uid };
    }
    // 9074 实测两副面孔（issue #31）：面板文案「当前参与用户太多」像瞬时限流，但报告者对照
    // 实验显示派生设备号被服务端一律拒 9074、同一时刻真机号可领——服务端大概率只认登录时
    // 注册的设备号。因此重试时**轮换派生设备号**（attempt 递增），退避 + 换号双管齐下；
    // 重试耗尽归 failed（不写签到 memo，下一轮还试）
    if (r.code === 9074) {
      return finalizeClaim(await claimWithRetry(ctx, (i) => post(CLAIM_URL, account, {}, i, devArg)), base, uid, TRAE_DEFAULT_DAILY_CREDITS);
    }
    return { ...base, status: 'failed', message: withCode(r.message || `code ${r.code}`, r.code), uid };
  }
  const already = findField(r.body, 'checked_in');
  if (already === true || already === 1) {
    return { ...base, status: 'already', message: '今天已签到', uid };
  }

  // 签到应得额度：status 接口里通常预告 credits / extra_credits（如 100 积分），
  // claim 接口有时只返回 { code: 0, message: "success" } 而不包含 credits 字段，作为 fallback 避免 +0
  const expectedCredits = Number(findField(r.body, 'credits') ?? findField(r.body, 'extra_credits')) || TRAE_DEFAULT_DAILY_CREDITS;

  return finalizeClaim(await claimWithRetry(ctx, (i) => post(CLAIM_URL, account, {}, i, devArg)), base, uid, expectedCredits);
}

/**
 * claim 重试：间隔 3s/8s/15s，每次重试换一个派生设备号（attempt 1/2/3）。
 * 首次尝试用默认指纹（attempt 0），始终失败返回最后一次响应（由 finalizeClaim 归 failed）。
 */
async function claimWithRetry(ctx, attemptFn) {
  const backoff = [0, 3000, 8000, 15000];
  let res = await attemptFn(0);
  for (let i = 1; i < backoff.length && res.code === 9074; i++) {
    ctx.log?.(`Trae 服务端拒绝（code 9074），${backoff[i] / 1000}s 后换设备号重试（${i}/${backoff.length - 1}）`);
    await new Promise((ok) => setTimeout(ok, backoff[i]));
    res = await attemptFn(i);
  }
  return res;
}

/** claim 响应 → 签到契约；「已经签到」文案归 already，9074 重试耗尽归 failed（不写 memo 可下轮重试） */
function finalizeClaim(c, base, uid, fallbackCredits = 0) {
  if (c.code !== 0) {
    if (/已经签到|已签到|already.*sign/i.test(String(c.message || ''))) {
      return { ...base, status: 'already', message: withCode(c.message || '今天已签到', c.code), uid };
    }
    return { ...base, status: 'failed', message: withCode(c.message || `code ${c.code}`, c.code), uid };
  }
  const claimed = Number(findField(c.body, 'credits')) || fallbackCredits;
  return { ...base, status: 'checked-in', claimedAmount: claimed, message: claimed ? `签到成功，+${claimed} 积分` : '签到成功', uid };
}

/**
 * 添加账号时的校验：Trae 的 token 是本地可自证的 JWT（含 uid 与到期时间），
 * 不需要网络往返；凭据只来自 Trae 客户端登录后的本机导入。
 */
export async function verifyTraeAccount(account) {
  const token = account.token;
  if (!token || token.split('.').length !== 3) throw new Error('不是 Trae 的 Cloud-IDE-JWT token');
  let payload;
  try { payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch {
    throw new Error('Trae token 的 JWT 负载无法解析');
  }
  const uid = payload?.data?.id ? String(payload.data.id) : null;
  if (!uid) throw new Error('Trae token 里缺少用户 id');
  const exp = Number(payload.exp);
  if (Number.isFinite(exp) && exp * 1000 < Date.now()) {
    throw new Error(`这个 Trae token 已于 ${new Date(exp * 1000).toLocaleString()} 过期，请到 Trae 客户端重新登录后重新导入`);
  }
  return { uid, name: account.name || null, email: account.email || null };
}
