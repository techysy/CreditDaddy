/**
 * ZCode（智谱 GLM / Z.ai）API 客户端 — 额度查询。协议移植自 zcode-switch（MIT）src-tauri/src/quota.rs。
 *
 *   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit      Coding Plan 窗口额度（提示次数 / 使用时长）
 *   GET https://open.bigmodel.cn/api/biz/subscription/list          当前订阅（套餐名 / 到期）
 *   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance        Start Plan / Z.ai 渠道余额
 * 以上都是 ZCode 客户端自身调用的官方接口；鉴权 token 在多个候选里依次尝试：
 *   config.json 中 coding-plan provider 的 apiKey → zcodejwttoken → oauth:<provider>:access_token
 *
 * ZCode 没有“每日签到”：积分来自活动领取（billing/preview + billing/claim），领取需阿里云验证码，
 * 这里不实现领取，providers.js 中 ZCode 也不提供 checkin。
 *
 * ⚠️ 额度解析按 zcode-switch 的字段映射实现，开发时所用账号无有效套餐，未经真实数据验证。
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { defaultSecret, safeDecrypt } from './zcrypto.js';

const QUOTA_LIMIT_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
const SUBSCRIPTION_URL = 'https://open.bigmodel.cn/api/biz/subscription/list';
const BILLING_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
const APP_VERSION = '3.11.2';

const platform = () => `${process.platform}-${process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch}`;

function zaiHeaders(token, deviceMid) {
  return {
    'User-Agent': `ZCode/${APP_VERSION}`,
    'HTTP-Referer': 'https://zcode.z.ai',
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': APP_VERSION,
    'X-Platform': platform(),
    'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN',
    'X-Os-Category': process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    ...(deviceMid ? { 'X-Device-Mid': deviceMid } : {}),
    Authorization: `Bearer ${token}`,
    'x-request-id': crypto.randomUUID(),
  };
}

function bigmodelHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'User-Agent': `ZCode/${APP_VERSION}`, 'x-request-id': crypto.randomUUID() };
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { code: res.status, msg: text.slice(0, 120) }; }
}

const businessOk = (v) => {
  const code = v?.code;
  return (code === undefined || code === 200 || code === 0) && v?.success !== false;
};

/** 按 zcode-switch candidate_tokens 的顺序收集可用 token（去重） */
export function candidateTokens(account) {
  const creds = account.meta?.credentials || {};
  const config = account.meta?.config || {};
  const secret = defaultSecret(os.homedir());
  const out = [];
  const add = (t) => { if (typeof t === 'string' && t.trim().length > 20 && !out.includes(t)) out.push(t); };
  const providers = Object.entries(config.provider || {})
    .sort(([, a], [, b]) => (b?.enabled === true) - (a?.enabled === true));
  for (const [id, p] of providers) {
    const k = p?.options?.apiKey;
    if (id.includes('coding-plan') && typeof k === 'string' && !k.startsWith('enc:')) add(k);
  }
  add(safeDecrypt(creds.zcodejwttoken, secret));
  const active = safeDecrypt(creds['oauth:active_provider'], secret) || 'zai';
  for (const key of [`oauth:${active}:access_token`, 'oauth:bigmodel:access_token', 'oauth:zai:access_token']) {
    add(safeDecrypt(creds[key], secret));
  }
  return out;
}

/** Start Plan 渠道要用 zcodejwttoken 或 config 中 start-plan provider 的 key */
function billingTokens(account) {
  const creds = account.meta?.credentials || {};
  const config = account.meta?.config || {};
  const secret = defaultSecret(os.homedir());
  const out = [];
  const jwt = safeDecrypt(creds.zcodejwttoken, secret);
  if (jwt && jwt.length > 20) out.push(jwt);
  for (const [id, p] of Object.entries(config.provider || {})) {
    const k = p?.options?.apiKey;
    if (id.includes('start-plan') && typeof k === 'string' && !k.startsWith('enc:') && k.length > 20 && !out.includes(k)) out.push(k);
  }
  return out;
}

const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

/** BigModel quota/limit → 统一结构（unit 字段标明非积分单位，面板不计入“剩余积分”合计） */
export function normalizeQuotaLimit(limitResp, subResp) {
  const limits = Array.isArray(limitResp?.data?.limits) ? limitResp.data.limits : [];
  const parts = limits.map((l) => {
    const unitLabel = l.type === 'TOKENS_LIMIT' ? '次' : l.type === 'TIME_LIMIT' ? '分钟' : '';
    const name = l.type === 'TOKENS_LIMIT' ? '提示次数' : l.type === 'TIME_LIMIT' ? '使用时长' : String(l.type || '额度');
    const total = Number(l.usage);
    const used = Number(l.currentValue);
    const remaining = Number.isFinite(Number(l.remaining)) ? Number(l.remaining) : Math.max(0, total - used);
    return {
      name, unit: unitLabel,
      total: Number.isFinite(total) ? total : 0,
      used: Number.isFinite(used) ? used : 0,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      expiresAt: iso(l.nextResetTime),
      recurring: true,
    };
  });
  const sub = businessOk(subResp) && Array.isArray(subResp?.data)
    ? (subResp.data.find((s) => s.status === 'VALID' && s.inCurrentPeriod !== false) || subResp.data[0])
    : null;
  // 主额度优先取“使用时长”，与 zcode-switch 一致
  const main = parts.find((p) => p.unit === '分钟' && p.total > 0) || parts.find((p) => p.total > 0) || null;
  return {
    total: main?.total || 0,
    used: main?.used || 0,
    remaining: main?.remaining || 0,
    unit: main?.unit || '',
    plan: sub?.productName || limitResp?.data?.level || null,
    planExpiresAt: sub?.endTime || sub?.expireTime || null,
    parts,
    empty: parts.length === 0,
    exceeded: false,
  };
}

/** zcode.z.ai billing/balance → 统一结构 */
export function normalizeBalance(balanceResp) {
  const d = balanceResp?.data || {};
  const plans = Array.isArray(d.plans) ? d.plans.filter((p) => String(p.status || '').toLowerCase() === 'active') : [];
  const parts = (Array.isArray(d.balances) ? d.balances : []).map((b) => {
    const total = Number(b.total_units);
    const used = Number(b.used_units);
    const remaining = Number(b.remaining_units ?? b.available_units);
    return {
      name: b.show_name || b.name || b.entitlement_id || b.plan_id || '额度',
      unit: b.unit_type === 'token' ? 'Token' : (b.unit_type || ''),
      total: Number.isFinite(total) ? total : 0,
      used: Number.isFinite(used) ? used : 0,
      remaining: Number.isFinite(remaining) ? remaining : Math.max(0, (total || 0) - (used || 0)),
      expiresAt: iso(Number(b.expire_at || b.period_end || 0) * (Number(b.expire_at || b.period_end) < 1e12 ? 1000 : 1)),
      recurring: Boolean(b.period && b.period !== 'one_time'),
    };
  });
  const sum = (k) => parts.reduce((s, p) => s + (p[k] || 0), 0);
  return {
    total: sum('total'), used: sum('used'), remaining: sum('remaining'),
    unit: parts[0]?.unit || 'Token',
    plan: plans[0]?.name || plans[0]?.plan_id || null,
    parts,
    empty: parts.length === 0 && plans.length === 0,
    exceeded: false,
  };
}

/**
 * 额度查询：先试 BigModel Coding Plan（quota/limit），再试 Z.ai / Start Plan（billing/balance）。
 * 都没有有效套餐时返回 { empty: true }（不是错误：很多账号只用免费额度）。
 */
export async function fetchZcodeQuota(account) {
  const tokens = candidateTokens(account);
  if (!tokens.length) throw new Error('账号快照里没有可用 token，请在 ZCode 登录后重新导入');
  let lastErr = null;
  let authFails = 0;
  for (const t of tokens) {
    try {
      const limit = await getJson(QUOTA_LIMIT_URL, bigmodelHeaders(t));
      if (businessOk(limit)) {
        const sub = await getJson(SUBSCRIPTION_URL, bigmodelHeaders(t)).catch(() => null);
        return { ...normalizeQuotaLimit(limit, sub), source: 'bigmodel' };
      }
      if (limit?.code === 401) authFails++;
      else lastErr = limit?.msg || lastErr;
    } catch (e) { lastErr = e.message; }
  }
  for (const t of billingTokens(account)) {
    try {
      const bal = await getJson(`${BILLING_BALANCE_URL}?app_version=${APP_VERSION}`, zaiHeaders(t, account.meta?.deviceMid));
      if (businessOk(bal)) return { ...normalizeBalance(bal), source: 'zcode.z.ai' };
      if (bal?.code === 401) authFails++;
    } catch (e) { lastErr = e.message; }
  }
  if (authFails && authFails >= tokens.length) throw new Error('鉴权失败，登录可能已过期，请在 ZCode 重新登录后重新导入');
  // “当前用户不存在coding plan”之类属于无套餐，按空额度返回
  if (!lastErr || /不存在|no.*plan/i.test(lastErr)) {
    return { total: 0, used: 0, remaining: 0, unit: '', plan: null, parts: [], empty: true, exceeded: false };
  }
  throw new Error(`额度查询失败：${lastErr}`);
}
