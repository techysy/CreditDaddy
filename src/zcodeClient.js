/**
 * ZCode（智谱 GLM / Z.ai）API 客户端 — 额度查询。协议移植自 zcode-switch（MIT）src-tauri/src/quota.rs。
 *
 *   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit      Coding Plan 窗口额度（提示次数 / 使用时长）
 *   GET https://open.bigmodel.cn/api/biz/subscription/list          当前订阅（套餐名 / 到期）
 *   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance        Start Plan / Z.ai 渠道余额
 * 以上都是 ZCode 客户端自身调用的官方接口；鉴权 token 在多个候选里依次尝试：
 *   config.json 中 coding-plan provider 的 apiKey → zcodejwttoken → oauth:<provider>:access_token
 *
 * 活动领取（同样移植自 zcode-switch claim.rs）：
 *   GET  https://zcode.z.ai/api/v1/zcode-plan/billing/preview  可领取的活动套餐列表
 *   POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim    领取（需 X-Aliyun-Captcha-Verify-Param，验证码在面板里跑）
 *   GET  https://zcode.z.ai/api/v1/client/configs              data.configs.captcha：验证码 sceneId / prefix / region
 * ZCode 没有“每日签到”，providers.js 中 ZCode 不提供 checkin。
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { defaultSecret, safeDecrypt } from './zcrypto.js';

const QUOTA_LIMIT_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
const SUBSCRIPTION_URL = 'https://open.bigmodel.cn/api/biz/subscription/list';
const BILLING_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
const BILLING_PREVIEW_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/preview';
const BILLING_CLAIM_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/claim';
const CLIENT_CONFIGS_URL = 'https://zcode.z.ai/api/v1/client/configs';
const APP_VERSION = '3.11.2';

/** 领取失败码 → 中文提示（取自 zcode-switch i18n.rs） */
const CLAIM_FAIL = {
  1001: '套餐不存在',
  1002: '活动已结束或套餐暂不可领取',
  1003: '该套餐已经领取过',
  1004: '不符合领取条件',
  1005: '今日领取名额已用完',
  3001: '领取参数错误，请刷新后重试',
  3007: '验证码校验失败，请重试',
  401: '请先登录后再领取',
};

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
    'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
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

/** 领取用的 token：zcodejwttoken 优先，其次 start-plan key（与 claim.rs claim_token 一致） */
function claimToken(account) {
  const t = billingTokens(account);
  if (!t.length) throw new Error('账号快照里没有可用的 zcodejwttoken，请在 ZCode 重新登录（或重新本机导入）后再领取');
  return t[0];
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
  const epochMs = (v) => iso(Number(v) * (Number(v) < 1e12 ? 1000 : 1));
  const plans = Array.isArray(d.plans) ? d.plans.filter((p) => String(p.status || '').toLowerCase() === 'active') : [];
  const balanceParts = (Array.isArray(d.balances) ? d.balances : []).map((b) => {
    const total = Number(b.total_units);
    const used = Number(b.used_units);
    const remaining = Number(b.remaining_units ?? b.available_units);
    return {
      name: b.show_name || b.name || b.entitlement_id || b.plan_id || '额度',
      unit: b.unit_type === 'token' ? 'Token' : (b.unit_type || ''),
      total: Number.isFinite(total) ? total : 0,
      used: Number.isFinite(used) ? used : 0,
      remaining: Number.isFinite(remaining) ? remaining : Math.max(0, (total || 0) - (used || 0)),
      expiresAt: epochMs(b.expire_at || b.period_end || 0),
      recurring: Boolean(b.period && b.period !== 'one_time'),
    };
  });
  // balances 可能为空（例如活动权益还没到 effective_at）：此时从生效套餐的权益里派生展示额度。
  // effective_at 在未来的权益标记 pending，面板显示「xx 生效」而不是「剩余 xx」。
  const now = Date.now();
  const entitlementParts = plans.flatMap((p) =>
    (Array.isArray(p.entitlements) ? p.entitlements : [])
      .filter((e) => e.unit_type === 'token' && Number(e.grant_units) > 0)
      .map((e) => {
        const grant = Number(e.grant_units);
        const startsAt = epochMs(e.effective_at || p.starts_at);
        const pending = Boolean(startsAt && new Date(startsAt).getTime() > now);
        return {
          name: e.show_name || e.entitlement_id || '活动额度',
          unit: 'Token',
          total: grant,
          used: 0,
          remaining: pending ? 0 : grant,
          pending,
          startsAt,
          expiresAt: epochMs(p.ends_at),
          recurring: Boolean(e.period && e.period !== 'one_time'),
        };
      }),
  );
  const parts = balanceParts.length ? balanceParts : entitlementParts;
  // 套餐有效期卡片上显示在「有效期至」列之外，这里记录最近的套餐结束时间
  const planEndsAt = plans.map((p) => epochMs(p.ends_at)).filter(Boolean).sort()[0] || null;
  const sum = (k) => parts.reduce((s, p) => s + (p[k] || 0), 0);
  return {
    total: sum('total'), used: sum('used'), remaining: sum('remaining'),
    unit: parts[0]?.unit || 'Token',
    plan: plans[0]?.name || plans[0]?.plan_id || null,
    planEndsAt,
    parts,
    empty: parts.length === 0 && plans.length === 0,
    exceeded: false,
  };
}

const PLAN_PERIOD_LABEL = { daily: '每日', weekly: '每周', monthly: '每月' };
const fmtGrantUnits = (n) => (n >= 1e8 ? `${+(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${+(n / 1e4).toFixed(1)}万` : String(Math.round(n)));

/** billing/preview → 可领取活动列表（parse_plan 的移植） */
export function normalizePlans(previewResp) {
  const plans = Array.isArray(previewResp?.data?.plans) ? previewResp.data.plans : [];
  const out = [];
  for (const p of plans) {
    const planId = String(p.plan_id || p.planId || '').trim();
    if (!planId) continue;
    const grantItems = (Array.isArray(p.entitlements) ? p.entitlements : [])
      .filter((e) => e.meter === 'model_usage' && e.unit_type === 'token' && String(e.show_name || '').trim())
      .map((e) => ({
        name: String(e.show_name).trim(),
        units: Number(e.grant_units || e.grantUnits || 0),
        period: String(e.period || 'one_time'),
      }));
    out.push({
      planId,
      name: String(p.name || '').trim(),
      description: String(p.description || '').trim(),
      priority: Number(p.priority || 0),
      grants: grantItems.map((g) => `${g.name} · ${fmtGrantUnits(g.units)} Token（${PLAN_PERIOD_LABEL[g.period] || '一次性'}）`),
    });
  }
  out.sort((a, b) => b.priority - a.priority || a.planId.localeCompare(b.planId));
  return out;
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

// ── 活动领取 ──

/** 可领取的活动列表。账户当前没有可领活动时返回 []（不是错误）。 */
export async function fetchClaimPlans(account) {
  const token = claimToken(account);
  const v = await getJson(
    `${BILLING_PREVIEW_URL}?app_version=${APP_VERSION}&platform=${platform()}`,
    zaiHeaders(token, account.meta?.deviceMid),
  );
  if (v?.code !== 0) throw new Error(v?.msg || v?.message || `查询活动列表失败（code ${v?.code}）`);
  return { plans: normalizePlans(v), serverTime: v?.data?.server_time ? new Date(v.data.server_time * 1000).toISOString() : null };
}

/** 验证码配置（无需登录）。当前服务端未下发时返回 { enabled: false }。 */
export async function fetchCaptchaConfig() {
  const v = await getJson(CLIENT_CONFIGS_URL, zaiHeaders(''));
  if (v?.code !== 0) throw new Error('获取验证码配置失败');
  const c = v?.data?.configs?.captcha || {};
  return {
    enabled: c.enabled === true,
    region: typeof c.region === 'string' ? c.region : '',
    prefix: typeof c.prefix === 'string' ? c.prefix : '',
    sceneId: typeof c.sceneId === 'string' ? c.sceneId : '',
  };
}

/**
 * 领取活动套餐。captchaParam 为空时不带验证码头（服务端风控可能拒绝，错误信息原样返回）。
 * 返回 { planName, startsAt, endsAt, serverTime }；失败抛出带 code / nextAt 的 Error。
 */
export async function claimPlan(account, planId, { captchaParam = '', region = '' } = {}) {
  const token = claimToken(account);
  const headers = zaiHeaders(token, account.meta?.deviceMid);
  if (captchaParam && captchaParam.trim()) headers['X-Aliyun-Captcha-Verify-Param'] = captchaParam.trim();
  if (region && region.trim()) headers['X-Aliyun-Captcha-Verify-Region'] = region.trim();
  const res = await fetch(BILLING_CLAIM_URL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId }),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let v;
  try { v = JSON.parse(text); } catch { v = { code: res.status, msg: text.slice(0, 200) }; }
  const code = Number(v?.code ?? -1);
  if (code !== 0) {
    const serverMsg = v?.msg || v?.message || '';
    const base = CLAIM_FAIL[code] || '领取失败';
    const err = new Error(serverMsg ? `${base}（${serverMsg}）` : base);
    err.code = code;
    // 1005（名额用完）带上套餐结束时间，方便提示下次什么时候再试
    if (code === 1005 && v?.data?.plan?.ends_at) err.nextAt = new Date(v.data.plan.ends_at * 1000).toISOString();
    throw err;
  }
  const plan = v?.data?.plan || {};
  return {
    planName: plan.name || planId,
    startsAt: plan.starts_at ? new Date(plan.starts_at * 1000).toISOString() : null,
    endsAt: plan.ends_at ? new Date(plan.ends_at * 1000).toISOString() : null,
    serverTime: v?.data?.server_time ? new Date(v.data.server_time * 1000).toISOString() : null,
  };
}
