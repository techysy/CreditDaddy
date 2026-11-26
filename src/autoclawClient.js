/**
 * AutoClaw（智谱澳龙 / AutoGLM 桌面端）账号面协议 —— 非官方逆向接口。
 *
 * 协议单一事实来源 = 10Router 源码（open-sse/shared/autoclaw/{constants,client}.js，
 * 其上游为 hj0185755/AutoClaw2api + hubo1989/opencode-autoclaw-auth 的字段笔记）。
 * CD 侧只做「账号面」：签到 / 额度 / 资料 / 刷新；聊天网关不在本产品线范围。
 *
 * 两套独立账号体系、两条线（token 不跨域互通）：
 *   autoclaw     国际版：Z.AI web OAuth 登录，账号面 autoglm-api.autoglm.ai
 *   autoclaw-cn  国内版：+86 短信码登录，账号面 autoglm-api.zhipuai.cn
 *                        （聊天走第三个 host autoglm-acceleration-api.zhipuai.cn，CD 不用）
 * 归属判别：access/refresh JWT 的 source_id claim 以 "agent" 开头 = CN，否则 = intl。
 *
 * wire 规则（踩过的坑，改动前务必读）：
 *  - 账号面**业务失败也回 HTTP 200**，成功与否只看 body.code（envelope.code === 0）。
 *  - 缺 / 库默认 User-Agent 会被上游 WAF 405（阿里云拦截页），必须显式带 AutoClaw/<ver>。
 *  - 请求体必带 source_id + device_id（缺 device_id → 400001）。
 *  - 每次调用重算 X-Auth-Sign = md5(appId&ts&appKey)。
 *  - 刷新：先 /userapi/v1/refresh，业务码 400002 才退到 /userapi/v1/agent-refresh。
 *  - task 端点是 chat base 的**兄弟路径**（…/proxy/autoclaw-task-list），
 *    写成 …/proxy/autoclaw/autoclaw-task-list 是 404。
 *  - 签到走 task-complete（服务端幂等），文档里的 /userapi/v1/user-info 实测 code:0 但不给分。
 *
 * ## 凭据纪律（rt 单次轮换，与本机客户端共存的关键）
 *
 * refresh token 是**单次使用轮换制**（10R 与 Nous/QwenWork 同口径注释）：谁拿它刷新，
 * 旧的那条当场作废。本机 AutoClaw 客户端与 CreditDaddy 若各持一份快照去刷，必互杀
 * （meoo test.12 事故同款）。因此本模块的顺序是：
 *   1) 账号库里的 access 还没到期 → 直接用；
 *   2) 到期 → **重读本机客户端 auth.json**（客户端在跑就会自己轮换，读到新的即用，
 *      零副作用，并把账号库对齐到客户端的最新一对）；
 *   3) 本机也没有更新的凭据（客户端没跑）→ 才由 CD 发起刷新（优先用本机那条 rt）。
 * 绝不写本机 auth.json：收割只读（客户端运行中退出会把它内存里的旧登录覆盖回来，
 * 写回去反而制造不一致）。
 *
 * 副作用要如实告诉用户：CD 代刷之后，AutoClaw 桌面端下次刷新会失败并要求重新登录
 * （10Router 的渠道说明也是同一句：不要让桌面客户端与代理同时用同一个号）。
 * token 只在本机进程内流转，不落日志、不出本机。
 */

import crypto from 'node:crypto';
import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';

// ── 常量（对齐 10R shared/autoclaw/constants.js）──

export const AUTOCLAW_APP_ID = '100003';
export const AUTOCLAW_APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5';
export const AUTOCLAW_PRODUCT = 'autoclaw';
export const AUTOCLAW_SOURCE_ID = 'autoclaw';

export const AUTOCLAW_GLOBAL_HOST = 'https://autoglm-api.autoglm.ai';
export const AUTOCLAW_CN_HOST = 'https://autoglm-api.zhipuai.cn';

export const AUTOCLAW_PATHS = {
  refresh: '/userapi/v1/refresh',
  refreshAlt: '/userapi/v1/agent-refresh',
  userProfile: '/userapi/v1/user-profile',
  wallets: `/agent-assetmgr/api/v2/wallets?biz_app_id=${AUTOCLAW_PRODUCT}`,
  taskList: '/autoclaw-proxy/proxy/autoclaw-task-list',
  taskComplete: '/autoclaw-proxy/proxy/autoclaw-task-complete',
  // 国内版（+86）短信两步直登：10R src/lib/oauth/providers/autoclaw-cn.js 同源。
  // 尾斜杠是端点形状的一部分（少斜杠 → 400001/404）；code 必须发数字（见 autoclawSmsCodeValue）。
  smsSend: '/userapi/v1/agent-send-code',
  smsLogin: '/userapi/v1/agent-login/',
  // 邀请（裂变）活动：反解 app.asar 主进程 getInviteInfo / useInviteCode 得到（非 10R 实现，
  // 10R 全无 invite/fission 代码）。status 里既有自己的码也有绑定状态。
  inviteStatus: '/agent-assetmgr/api/v1/fission-v2/status',
  inviteActivity: '/agent-assetmgr/api/v1/fission-v2/online-activity-info',
  inviteBind: '/agent-assetmgr/api/v1/fission-v2/bind',
};

/** 邀请活动 id / business（客户端硬编码，两端一致） */
export const AUTOCLAW_INVITE_ACTIVITY = 'autoclaw_fission';
export const AUTOCLAW_INVITE_BUSINESS = AUTOCLAW_PRODUCT;
/** 国内手机号（11 位、不带 +86）：与 10R AUTOCLAW_CN_PHONE_RE 同一条规则 */
export const AUTOCLAW_CN_PHONE_RE = /^1[3-9]\d{9}$/;

export const AUTOCLAW_REFRESH_FALLBACK_CODE = 400002;
export const AUTOCLAW_DAILY_SIGNIN_TASK = 'daily_signin';
/** access JWT 约 24h 有效：留 10 分钟提前量判「快到期」 */
export const AUTOCLAW_REFRESH_LEAD_MS = 10 * 60 * 1000;
export const AUTOCLAW_FALLBACK_EXPIRES_IN_S = 5 * 3600;

export const AUTOCLAW_REGIONS = {
  intl: { providerId: 'autoclaw', accountHost: AUTOCLAW_GLOBAL_HOST, channel: 'AutoClaw4', version: '1.18.1' },
  cn: { providerId: 'autoclaw-cn', accountHost: AUTOCLAW_CN_HOST, channel: 'AutoClaw26', version: '2.1.0' },
};

/** 业务码 → 人话（10R oauth.businessCodes 口径） */
export const AUTOCLAW_BUSINESS_CODES = {
  400000: '登录已失效，请重新登录',
  400001: '请求参数缺失或格式不对',
  400002: '签名校验未通过',
  429: '操作太频繁，请稍后再试',
  630202: '验证码错误',
  630203: '操作太频繁，请稍后再试',
  630012: '账号最近注销过',
  631000: '登录失败（客户端身份头缺失）',
  631010: '不是该企业成员',
  631011: '企业已停用',
  631012: '企业服务不可用',
  631013: '企业不支持此操作',
  631014: '所在地区不支持',
  631015: '企业账号需先选择身份',
  631016: '身份凭证过期，请重新登录',
};

export function explainAutoclawCode(code) {
  const n = Number(code);
  return Number.isInteger(n) ? AUTOCLAW_BUSINESS_CODES[n] || null : null;
}

// ── token 工具 ──

/** 去掉（可能重复的）"Bearer " 前缀：本机客户端导出的 token 自带一个 */
export function bareToken(value) {
  let s = String(value ?? '').trim();
  while (s.toLowerCase().startsWith('bearer ')) s = s.slice(7).trim();
  return s;
}

/** 解 JWT payload（不验签：只解自己账号的 claim） */
export function jwtPayload(token) {
  const part = bareToken(token).split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function jwtClaim(token, key) {
  const p = jwtPayload(token);
  return p && Object.prototype.hasOwnProperty.call(p, key) ? p[key] : undefined;
}

/** token 属于哪套账号体系：source_id 以 agent 开头 = CN（短信号），其它 = intl（OAuth） */
export function autoclawRegionOfToken(token) {
  const sid = jwtClaim(token, 'source_id');
  if (typeof sid !== 'string' || !sid) return null;
  return /^agent/i.test(sid) ? 'cn' : 'intl';
}

/** 账号归属区域：token claim 优先（refresh 再 access），provider id 兜底 */
export function autoclawRegionFor(provider, credentials = {}) {
  return autoclawRegionOfToken(credentials?.refreshToken)
    || autoclawRegionOfToken(credentials?.accessToken || credentials?.token)
    || (provider === 'autoclaw-cn' ? 'cn' : 'intl');
}

export const autoclawRegionConfig = (region) => AUTOCLAW_REGIONS[region === 'cn' ? 'cn' : 'intl'];

/** 账号面 host 尝试顺序：自家域在前（token 打到对侧域必 401） */
export function autoclawHostOrder(region) {
  return region === 'cn'
    ? [AUTOCLAW_REGIONS.cn.accountHost, AUTOCLAW_REGIONS.intl.accountHost]
    : [AUTOCLAW_REGIONS.intl.accountHost, AUTOCLAW_REGIONS.cn.accountHost];
}

/** access JWT 的到期毫秒（解不出按 iat+5h 兜底，绝不返回 NaN） */
export function autoclawExpiresAtMs(token) {
  const exp = jwtClaim(token, 'exp');
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) return exp * 1000;
  const iat = jwtClaim(token, 'iat');
  if (typeof iat === 'number' && Number.isFinite(iat) && iat > 0) return (iat + AUTOCLAW_FALLBACK_EXPIRES_IN_S) * 1000;
  return null;
}

/** 该 access token 是否还能用（含提前量） */
export function autoclawTokenUsable(token, nowMs = Date.now()) {
  const at = autoclawExpiresAtMs(token);
  return at !== null && at - nowMs > AUTOCLAW_REFRESH_LEAD_MS;
}

export function autoclawDeviceIdOf(token) {
  const d = jwtClaim(token, 'device_id');
  return typeof d === 'string' && d ? d : null;
}

// ── 请求头 ──

/** 官方客户端的 X-Tm：win | mac | linux-x64（裸 "linux" 在海外侧 403） */
export function autoclawPlatformTm(platform = process.platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux-x64';
}

export function autoclawUserAgent(region) {
  return `AutoClaw/${autoclawRegionConfig(region).version}`;
}

/** 托管层签名头：md5(appId&ts&appKey)，每次调用重算 */
export function autoclawSignHeaders(nowMs = Date.now()) {
  const ts = String(Math.floor(nowMs / 1000));
  return {
    'X-Auth-Appid': AUTOCLAW_APP_ID,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': crypto.createHash('md5').update(`${AUTOCLAW_APP_ID}&${ts}&${AUTOCLAW_APP_KEY}`).digest('hex'),
  };
}

export function autoclawIdentityHeaders(region) {
  const cfg = autoclawRegionConfig(region);
  return {
    'User-Agent': autoclawUserAgent(region),
    'X-Version': cfg.version,
    'X-Tm': autoclawPlatformTm(),
    'X-Product': AUTOCLAW_PRODUCT,
    'X-Channel': cfg.channel,
    'X-Lang': 'zh-CN',
    'X-Client-Type': 'pc',
  };
}

export function autoclawBizHeaders(region, accessToken = null, nowMs = Date.now()) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    ...autoclawIdentityHeaders(region),
    ...autoclawSignHeaders(nowMs),
    Origin: 'http://localhost:18432',
    Referer: 'http://localhost:18432/',
  };
  if (accessToken) h.Authorization = `Bearer ${bareToken(accessToken)}`;
  return h;
}

// ── 错误 ──

const DEAD_LOGIN_RE = /invalid_grant|revoked|expired|登录已失效|未登录|重新登录|token\s*失效/i;
// 400000「用户未登录，请重新登录」是 /refresh 对死链/外域 rt 的回答（HTTP 200 + body.code）
const DEAD_LOGIN_CODES = new Set([400000, 631016]);

export function isAutoclawDeadLogin(e) {
  return e?.signIn === 'expired'
    || e?.status === 401
    || e?.status === 403
    || DEAD_LOGIN_CODES.has(Number(e?.code))
    || DEAD_LOGIN_RE.test(String(e?.message || ''));
}

export class AutoclawApiError extends Error {
  constructor(message, { code = null, status = null, data = null, signIn = null } = {}) {
    super(message);
    this.name = 'AutoclawApiError';
    this.code = code;
    this.status = status;
    this.data = data;
    this.signIn = signIn;
    // CD 通用失效标记：e.auth = true → accounts/quota 侧按「凭据失效」处理
    if (signIn === 'expired' || status === 401 || status === 403) this.auth = true;
  }
}

// ── 网络 ──

const defaultFetch = (url, init) => fetchJsonRace(url, {
  method: init.method,
  headers: init.headers,
  ...(init.body != null ? { body: init.body } : {}),
  timeoutMs: init?.signal?.timeout || FETCH_TIMEOUT_MS,
});

/**
 * 账号面 POST：body 里合并 source_id + device_id。
 * 成功（envelope.code === 0）返回 data，否则抛 AutoclawApiError —— HTTP 200 不代表成功。
 */
export async function autoclawPost(host, path, payload, {
  region = 'intl',
  accessToken = null,
  deviceId = null,
  fetchImpl = null,
} = {}) {
  const doFetch = fetchImpl || defaultFetch;
  if (!deviceId) throw new AutoclawApiError(t('AutoClaw 请求缺少 device_id（无法确定设备身份），请重新在本机导入账号'));
  const body = { ...(payload || {}), source_id: AUTOCLAW_SOURCE_ID, device_id: deviceId };
  let res, text = '';
  try {
    res = await doFetch(`${host}${path}`, {
      method: 'POST',
      headers: autoclawBizHeaders(region, accessToken),
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    throw new AutoclawApiError(t('AutoClaw 账号面请求失败：{err}', { err: e?.message || e }));
  }
  let env = null;
  try { env = text ? JSON.parse(text) : null; } catch { env = null; }
  if (!env || typeof env !== 'object') {
    // WAF 拦截页（405 阿里云 HTML）也落这里：把 status 说清楚，别让人以为是账号问题
    const dead = res.status === 401 || res.status === 403;
    throw new AutoclawApiError(
      t('AutoClaw 账号面返回非 JSON（HTTP {status}）：{snip}', { status: res.status, snip: String(text).replace(/\s+/g, ' ').slice(0, 100) }),
      { status: res.status, signIn: dead ? 'expired' : null },
    );
  }
  if (env.code !== 0) {
    const reason = explainAutoclawCode(env.code);
    const msg = reason
      ? t('{reason}（上游 code {code}）', { reason, code: env.code })
      : String(env.msg || `AutoClaw 业务失败 (code ${env.code})`);
    throw new AutoclawApiError(msg, { code: env.code ?? null, status: res.status, data: env });
  }
  return env.data && typeof env.data === 'object' ? env.data : {};
}

/**
 * 账号面 GET：wallets 用 { code, data } 信封，task-list 用裸 { data: [...] }（无 code）——
 * 两种都认，显式非 0 的 code 一律拒绝。
 */
async function autoclawGet(host, path, accessToken, { region = 'intl', fetchImpl = null } = {}) {
  const doFetch = fetchImpl || defaultFetch;
  let res, text = '';
  try {
    res = await doFetch(`${host}${path}`, { method: 'GET', headers: autoclawBizHeaders(region, accessToken) });
    text = await res.text();
  } catch (e) {
    throw new AutoclawApiError(t('AutoClaw 账号面请求失败：{err}', { err: e?.message || e }));
  }
  if (res.status === 401 || res.status === 403) {
    throw new AutoclawApiError(t('AutoClaw 登录已失效（HTTP {status}）', { status: res.status }), { status: res.status, signIn: 'expired' });
  }
  let env = null;
  try { env = text ? JSON.parse(text) : null; } catch { env = null; }
  const bareData = env && typeof env === 'object' && !('code' in env) && 'data' in env;
  if (!env || (typeof env !== 'object') || (!bareData && env.code !== 0)) {
    throw new AutoclawApiError(
      String(env?.msg || t('AutoClaw {path} 失败（HTTP {status}）', { path: path.split('?')[0], status: res.status })),
      { code: env?.code ?? null, status: res.status },
    );
  }
  return env.data;
}

// ── 具体端点 ──

/** 登录/刷新响应 → 归一化字段（上游 snake_case） */
export function autoclawTokenFields(data, fallbackRefresh = null) {
  const accessToken = bareToken(data?.access_token);
  if (!accessToken) throw new AutoclawApiError(t('AutoClaw 响应里没有 access_token'), { data });
  const refreshToken = bareToken(data?.refresh_token || fallbackRefresh || '');
  if (!refreshToken) throw new AutoclawApiError(t('AutoClaw 响应里没有 refresh_token'), { data });
  const expMs = autoclawExpiresAtMs(accessToken);
  return {
    accessToken,
    refreshToken,
    expiresIn: expMs ? Math.max(1, Math.floor((expMs - Date.now()) / 1000)) : AUTOCLAW_FALLBACK_EXPIRES_IN_S,
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    userId: data?.user_id != null ? String(data.user_id) : null,
    userPhone: typeof data?.user_phone === 'string' ? data.user_phone : null,
    userName: typeof data?.user_name === 'string' ? data.user_name : null,
  };
}

/**
 * 刷新（host 匹配 + 400002 退路）。
 * @returns {Promise<{accessToken,refreshToken,expiresIn,expiresAt}|{error:'invalid_grant'}|null>}
 *   每个 host 都判死才返回 invalid_grant（rt 在对侧域上是「外域 token」，单次死判不算）；
 *   瞬时失败返回 null。
 */
export async function refreshAutoclawCredentials(refreshToken, {
  region = null, deviceId = null, fetchImpl = null, log = null,
} = {}) {
  const rt = bareToken(refreshToken);
  if (!rt) return null;
  const home = autoclawRegionOfToken(rt) || region || 'intl';
  const dev = deviceId || autoclawDeviceIdOf(rt);
  if (!dev) return { error: 'invalid_grant' };   // 无设备身份打不进账号面
  let allDead = true, lastError = null;
  for (const host of autoclawHostOrder(home)) {
    let hostDead = false;
    for (const path of [AUTOCLAW_PATHS.refresh, AUTOCLAW_PATHS.refreshAlt]) {
      try {
        const data = await autoclawPost(host, path, { refresh_token: rt }, { region: home, deviceId: dev, fetchImpl });
        const f = autoclawTokenFields(data, rt);
        return { accessToken: f.accessToken, refreshToken: f.refreshToken, expiresIn: f.expiresIn, expiresAt: f.expiresAt };
      } catch (e) {
        lastError = e;
        hostDead = isAutoclawDeadLogin(e);
        // 只有第一跳的 400002 才值得试第二跳
        if (path === AUTOCLAW_PATHS.refresh && Number(e?.code) === AUTOCLAW_REFRESH_FALLBACK_CODE) continue;
        break;
      }
    }
    if (!hostDead) allDead = false;
  }
  log?.(t('AutoClaw 凭据刷新失败：{err}', { err: lastError?.message || 'unknown' }));
  return allDead && lastError ? { error: 'invalid_grant' } : null;
}

export async function fetchAutoclawProfile(accessToken, { region = 'intl', deviceId, fetchImpl = null } = {}) {
  try {
    return await autoclawPost(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.userProfile, {},
      { region, accessToken, deviceId, fetchImpl });
  } catch {
    return null;
  }
}

/** 显示名：昵称 → 脱敏手机号 → 兜底（手机号绝不原样外显） */
export function autoclawDisplayName(profile, fallback = '') {
  const name = String(profile?.user_name || profile?.nickname || '').trim();
  if (name) return name;
  const phone = String(profile?.user_phone || '').trim();
  if (phone.length >= 7) return maskAutoclawPhone(phone);
  return fallback;
}

/** 手机号脱敏：131****3656（本机 auth.json 里已是脱敏形态，这里兜住未脱敏的输入） */
export function maskAutoclawPhone(phone) {
  const s = String(phone ?? '').trim();
  if (!s) return null;
  if (s.includes('*')) return s;
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : '****';
}

/** 钱包快照 { total_balance, wallets[] }；读不到抛错（绝不把「读不到」报成 0） */
export async function fetchAutoclawWallets(accessToken, { region = 'intl', fetchImpl = null } = {}) {
  return autoclawGet(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.wallets, accessToken, { region, fetchImpl });
}

export async function fetchAutoclawTasks(accessToken, { region = 'intl', fetchImpl = null } = {}) {
  const data = await autoclawGet(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.taskList, accessToken, { region, fetchImpl });
  return Array.isArray(data) ? data : [];
}

/**
 * 每日签到（服务端幂等）。返回 { claimed, already, points, streak, message }。
 * ⚠ 真打一次就消耗当天资格：自动化只在调度轮里跑，手工验证先用 fetchAutoclawTasks 读状态。
 */
export async function claimAutoclawDailySignin(accessToken, { region = 'intl', deviceId, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || defaultFetch;
  let res, text = '';
  try {
    res = await doFetch(`${autoclawRegionConfig(region).accountHost}${AUTOCLAW_PATHS.taskComplete}`, {
      method: 'POST',
      headers: autoclawBizHeaders(region, accessToken),
      body: JSON.stringify({ task_id: AUTOCLAW_DAILY_SIGNIN_TASK, source_id: AUTOCLAW_SOURCE_ID, device_id: deviceId }),
    });
    text = await res.text();
  } catch (e) {
    return { claimed: false, already: false, points: 0, streak: 0, message: t('AutoClaw 签到请求失败：{err}', { err: e?.message || e }) };
  }
  if (res.status === 401 || res.status === 403) {
    const e = new AutoclawApiError(t('AutoClaw 登录已失效（HTTP {status}）', { status: res.status }), { status: res.status, signIn: 'expired' });
    e.auth = true;
    throw e;
  }
  let env = null;
  try { env = text ? JSON.parse(text) : null; } catch { env = null; }
  const d = env?.data || {};
  const points = Number(d.reward_points) || 0;
  const streak = Number(d.continuous_days) || 0;
  if (d.success) {
    return {
      claimed: true, already: false, points, streak,
      message: streak
        ? t('已签到 +{points} 积分 · 连续 {streak} 天', { points, streak })
        : t('已签到 +{points} 积分', { points }),
    };
  }
  if (d.already_completed) return { claimed: false, already: true, points, streak, message: t('今日已签到') };
  return { claimed: false, already: false, points: 0, streak: 0, message: String(d.message || env?.msg || t('AutoClaw 签到失败')) };
}

/** 签到状态（只读）：task-list 里 daily_signin 的完成情况；读不到返回 null */
export async function fetchAutoclawSigninStatus(accessToken, opts = {}) {
  try {
    const tasks = await fetchAutoclawTasks(accessToken, opts);
    const daily = tasks.find((x) => x?.task_id === AUTOCLAW_DAILY_SIGNIN_TASK);
    if (!daily) return null;
    return {
      done: String(daily.status || '') === 'completed',
      reward: Number(daily.reward_points) || 0,
      raw: daily,
    };
  } catch {
    return null;
  }
}

// ── CD 统一结构：额度 ──

const WALLET_LABELS = {
  reward: '奖励积分',
  daily: '每日积分',
  subscription: '订阅积分',
  fuel_pack: '加油包积分',
  other: '其他积分',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * AutoClaw 额度 = 纯积分账面（无总量、无重置窗）。
 * 口径照 10R services/usage/autoclaw.js：headline 一条余额行，非零分类钱包逐条列出，
 * task list 可读时追加「每日签到」状态行。读不到抛错，由上层显示错误而不是 0。
 */
export function normalizeAutoclawQuota(wallets, signin = null) {
  const total = Math.max(0, num(wallets?.total_balance) ?? 0);
  const parts = [];
  for (const w of Array.isArray(wallets?.wallets) ? wallets.wallets : []) {
    const balance = num(w?.balance);
    if (!(balance > 0)) continue;
    // 已知类型走自家标签表（可翻译）；上游 display_name 只作未知类型的兜底——
    // 直接拿它当名字会让英文界面夹着中文「奖励积分」
    const known = WALLET_LABELS[w?.public_wallet_type];
    parts.push({
      name: known ? t(known) : t(String(w?.display_name || '积分')),
      total: balance,
      used: 0,
      remaining: balance,
      expiresAt: w?.expire_at || w?.expires_at || null,
      recurring: false,
      unit: '积分',
    });
  }
  if (signin) {
    parts.push({
      name: t('每日签到'),
      total: signin.reward || 200,
      used: 0,
      remaining: signin.done ? (signin.reward || 200) : 0,
      expiresAt: null,
      recurring: true,
      unit: '积分',
    });
  }
  return {
    unit: '积分',
    total,
    used: 0,
    remaining: total,
    exceeded: total <= 0,
    plan: null,
    planExpiresAt: null,
    parts: parts.length ? parts : [{ name: t('积分余额'), total, used: 0, remaining: total, expiresAt: null, recurring: true, unit: '积分' }],
    empty: total <= 0,
  };
}

// ── 邀请（裂变）活动：反解客户端 app.asar 得到的三条真端点 ──
//
// 10Router 全无 invite/fission 实现（registry 里只有运营 notice 文案），这三条来自
// AutoClaw 桌面客户端自身的主进程 API 层（getInviteInfo / getInviteOnlineActivityInfo /
// useInviteCode → IPC invite-code:info / :use）。渲染进程的绑定形状：
//   inviteCode.use({ activity_id: 'autoclaw_fission', business: 'autoclaw', invite_code })
//   → res.code 为假值 = 成功（有值即失败，文案「邀请码使用失败」）
// 鉴权与 wallets/task 同一套（Bearer access + 身份头 + X-Auth-Sign + source_id/device_id）。
//
// ⚠ 活动配置里 bind_inviter_reward_event = "bind_and_query"：字面义「绑定与查询都结算发奖」，
// 所以读 status 不是纯只读——它可能改变账面。只在用户打开邀请码弹窗时读一次，
// **绝不挂进额度轮询 / 状态轮询**。bind 本身有副作用且每号仅一次，未经用户同意不打。

/** 邀请活动状态（自己的码 + 绑定状态 + 活动配置 + 统计） */
export async function fetchAutoclawInviteStatus(accessToken, { region = 'cn', deviceId, fetchImpl = null } = {}) {
  const q = `?activity_id=${encodeURIComponent(AUTOCLAW_INVITE_ACTIVITY)}&business=${encodeURIComponent(AUTOCLAW_INVITE_BUSINESS)}`;
  return autoclawGet(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.inviteStatus + q, accessToken, { region, fetchImpl });
}

/** 在线活动列表（只有活动配置，不含个人码——要展示规则但不碰结算时用这条） */
export async function fetchAutoclawInviteActivities(accessToken, { region = 'cn', fetchImpl = null } = {}) {
  const q = `?business=${encodeURIComponent(AUTOCLAW_INVITE_BUSINESS)}`;
  const data = await autoclawGet(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.inviteActivity + q, accessToken, { region, fetchImpl });
  return Array.isArray(data?.activities) ? data.activities : [];
}

/**
 * 绑定邀请码（POST fission-v2/bind）。⚠ 有副作用：每号仅一次资格，成功后不可撤销。
 * 上游业务失败照旧走 envelope.code（HTTP 200 不代表成功），autoclawPost 已抛错。
 */
export async function bindAutoclawInviteCode(accessToken, code, { region = 'cn', deviceId, fetchImpl = null } = {}) {
  const c = String(code ?? '').trim();
  if (!c) throw new AutoclawApiError(t('邀请码不能为空'));
  return autoclawPost(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.inviteBind,
    { activity_id: AUTOCLAW_INVITE_ACTIVITY, business: AUTOCLAW_INVITE_BUSINESS, invite_code: c },
    { region, accessToken, deviceId, fetchImpl });
}

/** 秒级时间戳 → ISO（非数值回 null，绝不回 NaN / Invalid Date） */
export function autoclawSecToIso(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/**
 * status 响应 → 面板所需形状。缺字段一律 null（不猜、不补 0）：
 * 「读不到」与「真的是 0」在 UI 上必须是两件事（10Router 同款红线）。
 */
export function normalizeAutoclawInvite(data) {
  const act = data?.activity || null;
  const share = data?.share || null;
  const bind = data?.bind || null;
  const stats = data?.stats || null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    myCode: typeof share?.invite_code === 'string' && share.invite_code ? share.invite_code : null,
    canShare: share?.can_share === true,
    codeExpiresAt: autoclawSecToIso(share?.expires_at),
    bindStatus: typeof bind?.status === 'string' ? bind.status : null,
    canBind: bind?.can_bind === true,
    // 邀请方奖励：单次额度 + 名额上限 + 剩余次数（实测 1000 × 15）
    inviterReward: n(act?.bind_inviter_reward_amount),
    rewardLimit: n(stats?.bind_reward_limit ?? act?.bind_inviter_reward_limit),
    remainingRewards: n(stats?.remaining_bind_reward_count),
    rewardedCount: n(stats?.rewarded_bind_count),
    invitedCount: n(stats?.invited_count),
    rewardValidDays: n(act?.bind_inviter_reward_valid_days),
    // 被邀请方当前上游配 0 —— 文案必须照实说，不能照抄 Loomy 的「双方各 +5000」
    inviteeReward: n(act?.bind_invitee_reward_amount),
    activityEnabled: act?.enabled === true,
    activityStatus: typeof act?.status === 'string' ? act.status : null,
    activityStartsAt: autoclawSecToIso(act?.starts_at),
    activityEndsAt: autoclawSecToIso(act?.ends_at),
  };
}

// ── 国内版短信两步直登（+86）：端点与 10R autoclaw-cn.js 同源 ──

/** 验证码必须按数字发（字符串 → 400001；上游把 code:0 当空值）——10R autoclawSmsCodeValue 同款 */
export function autoclawSmsCodeValue(code) {
  const s = String(code ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : s;
}

/** 手机号清洗 + 校验（去 +86 前缀；不合法直接抛，绝不发出去） */
export function cleanAutoclawCnPhone(phone) {
  const p = String(phone ?? '').trim().replace(/^\+?86/, '');
  if (!AUTOCLAW_CN_PHONE_RE.test(p)) throw new AutoclawApiError(t('手机号格式不正确（11 位，不带 +86）'));
  return p;
}

/** 第一步：下发短信验证码（deviceId 必须由调用方给——这是 CD 自己派生的那份） */
export async function sendAutoclawCnSmsCode(phone, { deviceId, fetchImpl = null } = {}) {
  const p = cleanAutoclawCnPhone(phone);
  await autoclawPost(AUTOCLAW_REGIONS.cn.accountHost, AUTOCLAW_PATHS.smsSend, { phone: p },
    { region: 'cn', deviceId, fetchImpl });
  return { sent: true, phone: p };
}

/** 第二步：验证码换 token 对（响应字段与 refresh 同形，走 autoclawTokenFields 归一） */
export async function loginAutoclawCnBySms({ phone, code }, { deviceId, fetchImpl = null } = {}) {
  const p = cleanAutoclawCnPhone(phone);
  const c = String(code ?? '').trim();
  if (!/^\d{4,8}$/.test(c)) throw new AutoclawApiError(t('验证码应为 4–8 位数字'));
  const data = await autoclawPost(AUTOCLAW_REGIONS.cn.accountHost, AUTOCLAW_PATHS.smsLogin,
    { phone: p, code: autoclawSmsCodeValue(c) }, { region: 'cn', deviceId, fetchImpl });
  const fields = autoclawTokenFields(data);
  if (!fields.userId) throw new AutoclawApiError(t('AutoClaw 登录响应不完整（缺 user_id）'), { data });
  return { ...fields, phone: p };
}

/**
 * 该 AutoClaw 账号是否「CD 独占刷新权」= 可安全同步给 10Router（口径 (a)）。
 *
 * 判据只有两个来源，都在 autoclawAuth.js 登录时写下：source='sms-login'（短信直登的号，
 * 桌面客户端根本没登录它）或 meta.autoclawCdOwned。**本机收割来的号（source='local-app'）
 * 一律返回 false** —— 那种号有第三个副本（桌面客户端每小时自己轮换 rt），推给 10R 就是
 * 三副本互杀，用户会看到「桌面客户端突然要重新登录」。
 * 放在协议层（不放 autoclawAuth.js）是刻意的：同步侧要 import 它，而 autoclawAuth 会
 * 经 accounts.js → providers.js → 本文件绕回来，判据放哪都必须是无依赖的那一头。
 */
export function canSyncAutoclawAccount(account) {
  if (!account || !String(account.provider).startsWith('autoclaw')) return false;
  return account.source === 'sms-login' || account.meta?.autoclawCdOwned === true;
}

// ── 凭据编排（本机优先，见文件头纪律）──
/**
 * 本机 auth.json 里这一对凭据是否就是「这个账号」的。
 *
 * 必须判：AutoClaw 一个客户端只登一个号，用户在客户端换登别的号之后，
 * 若不比对就无条件对齐，等于把 A 账号的凭据悄悄换成 B —— 面板上 A 的积分、
 * A 的签到全打到 B 身上（还可能连带把 B 的 rt 写进 A 的账号行）。
 * 比对优先级：设备号（导入时记下的 meta.autoclawDeviceId）→ uid（JWT user_id）。
 * 两个都对不上（老账号行没记设备号也没 uid）就**不借用**本机凭据，宁可用账号库
 * 里的旧对去刷新，也不跨账号串凭据。
 */
export function autoclawLocalBelongsTo(local, account) {
  if (!local) return false;
  const dev = local.deviceId || autoclawDeviceIdOf(local.refreshToken) || autoclawDeviceIdOf(local.accessToken);
  if (account?.meta?.autoclawDeviceId && dev) return String(account.meta.autoclawDeviceId) === String(dev);
  const uid = jwtClaim(local.accessToken, 'user_id');
  if (account?.uid != null && uid != null) return String(account.uid) === String(uid);
  return false;
}

/**
 * 取一个可用的 access token。顺序（每一步都记在返回值的 from 上，日志/测试可断言）：
 *   'account'   账号库里的 access 还没到期 → 直接用，零副作用；
 *   'local'     到期 → 重读本机客户端 auth.json：客户端在跑就会自己轮换，读到新的即用，
 *               零副作用，并把账号库对齐到客户端这一对（否则下次只能拿死链去刷）；
 *   'refreshed' 两边都过期 → CD 代刷。两条 rt 谁新试谁（CD 刷过 → 账号库那条新；
 *               客户端刷过 → 本机那条新；旧的已被服务端作废，试了必 invalid_grant，
 *               所以失败就换下一条，全死才判登录失效）。
 * 绝不写本机 auth.json：客户端退出时会用内存里的登录覆盖文件，写回去只会制造不一致。
 * @returns {Promise<{accessToken,refreshToken,expiresAt,region,deviceId,from}>}
 */
export async function resolveAutoclawAuth(account, ctx = {}) {
  const { loadAutoclawLocalCredential } = await import('./autoclawLocal.js');
  const localFile = await loadAutoclawLocalCredential().catch(() => null);
  // 客户端换登过别的号 → 本机这一对不是这个账号的，一律不借用（见 autoclawLocalBelongsTo）
  const local = autoclawLocalBelongsTo(localFile, account) ? localFile : null;
  const acctAccess = bareToken(account?.token);
  const acctRefresh = bareToken(account?.refreshToken);
  const localAccess = bareToken(local?.accessToken);
  const localRefresh = bareToken(local?.refreshToken);

  const region = autoclawRegionFor(account?.provider, {
    refreshToken: localRefresh || acctRefresh,
    accessToken: localAccess || acctAccess,
  });
  // 设备身份以**这个账号自己的 token 绑定**为准（服务端拿它复核设备，10R 同口径），
  // 其次才是导入时记录的 meta / 本机文件里的 deviceId —— 顺序反了会把别人的设备号
  // 带进这个号的刷新请求（400001/400002 一类签名与参数错，根因极难查）。
  const deviceId = autoclawDeviceIdOf(acctRefresh) || autoclawDeviceIdOf(acctAccess)
    || account?.meta?.autoclawDeviceId
    || local?.deviceId || autoclawDeviceIdOf(localRefresh) || autoclawDeviceIdOf(localAccess)
    || null;

  // 1) 账号库
  if (autoclawTokenUsable(acctAccess)) {
    return { accessToken: acctAccess, refreshToken: acctRefresh, expiresAt: account?.expiresAt || null, region, deviceId, from: 'account' };
  }
  // 2) 本机客户端（更新且在有效期内）
  if (autoclawTokenUsable(localAccess)) {
    const expiresAt = new Date(autoclawExpiresAtMs(localAccess)).toISOString();
    const creds = { token: localAccess, refreshToken: localRefresh || acctRefresh, expiresAt };
    try { await ctx.onRefresh?.(creds); } catch {}
    ctx.log?.(t('AutoClaw 凭据已对齐本机客户端的最新登录'));
    // 出参统一 accessToken（onRefresh 走 store 的 token 口径，两者别混用）
    return { accessToken: creds.token, refreshToken: creds.refreshToken, expiresAt, region, deviceId, from: 'local' };
  }
  // 3) CD 代刷：两条 rt 谁新试谁，去重（本机与账号库常是同一对，重复打只是白烧一次请求）
  const order = [...new Set([localRefresh, acctRefresh].filter(Boolean))];
  if (order.length === 2 && (jwtClaim(order[0], 'iat') || 0) < (jwtClaim(order[1], 'iat') || 0)) order.reverse();
  if (!order.length) throw autoclawAuthError(t('AutoClaw 没有可用的登录凭据：请在客户端登录后重新「本机导入」'));
  if (!deviceId) throw autoclawAuthError(t('AutoClaw 缺少设备身份（device_id），无法刷新凭据：请在客户端登录后重新「本机导入」'));
  let transient = null;
  for (const rt of order) {
    const r = await refreshAutoclawCredentials(rt, { region, deviceId, fetchImpl: ctx.fetchImpl, log: ctx.log });
    if (r && r.error !== 'invalid_grant') {
      const creds = { token: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt };
      try { await ctx.onRefresh?.(creds); } catch {}
      ctx.log?.(t('AutoClaw 凭据已由 CreditDaddy 代刷（AutoClaw 桌面端下次刷新会要求重新登录）'));
      return { accessToken: creds.token, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt, region, deviceId, from: 'refreshed' };
    }
    if (!r) transient = true;
  }
  if (transient) throw new AutoclawApiError(t('AutoClaw 凭据刷新失败（网络或服务端异常，稍后自动重试）'));
  throw autoclawAuthError(t('AutoClaw 登录已失效：请在客户端重新登录后再「本机导入」'));
}

function autoclawAuthError(msg) {
  const e = new AutoclawApiError(msg, { signIn: 'expired' });
  e.auth = true;
  return e;
}

/** 额度查询（providers.js quota 入口） */
export async function fetchAutoclawQuotaForAccount(account, ctx = {}) {
  const auth = await resolveAutoclawAuth(account, ctx);
  const net = { region: auth.region, deviceId: auth.deviceId, fetchImpl: ctx.fetchImpl };
  const wallets = await fetchAutoclawWallets(auth.accessToken, net);
  const signin = await fetchAutoclawSigninStatus(auth.accessToken, net);
  return normalizeAutoclawQuota(wallets, signin);
}

/**
 * 每日签到（providers.js checkin 入口）。
 * status：checked-in（含积分与连签）/ already / failed；成功回写 balanceAfter 走既有落库口径。
 */
export async function checkinAutoclaw(account, ctx = {}) {
  const auth = await resolveAutoclawAuth(account, ctx);
  const net = { region: auth.region, deviceId: auth.deviceId, fetchImpl: ctx.fetchImpl };
  const r = await claimAutoclawDailySignin(auth.accessToken, net);
  if (r.claimed || r.already) {
    let balanceAfter;
    try {
      const w = await fetchAutoclawWallets(auth.accessToken, net);
      const total = num(w?.total_balance);
      if (total !== null) balanceAfter = total;
    } catch {}
    return {
      status: r.claimed ? 'checked-in' : 'already',
      message: r.message,
      ...(r.claimed ? { claimedAmount: r.points } : {}),
      ...(r.claimed && r.streak ? { streakDays: r.streak - 1 } : {}),   // 调度器对 checked-in 再 +1
      ...(balanceAfter !== undefined ? { balanceAfter } : {}),
    };
  }
  return { status: 'failed', error: r.message, message: r.message };
}

/** 添加账号时的身份补全（本机导入 / 手工贴 token 都走这里） */
/**
 * 添加账号时的身份补全。accounts.addAccount 只取 name / uid / email 三项，
 * region 与掩码手机号一并回传供调用方（与将来的手工贴 token 线）使用。
 */
export async function verifyAutoclawAccount(account) {
  const auth = await resolveAutoclawAuth(account, {});
  const p = await fetchAutoclawProfile(auth.accessToken, { region: auth.region, deviceId: auth.deviceId });
  const uid = p?.id != null ? String(p.id) : (p?.user_id != null ? String(p.user_id) : (jwtClaim(auth.accessToken, 'user_id') != null ? String(jwtClaim(auth.accessToken, 'user_id')) : null));
  if (!uid) throw new AutoclawApiError(t('AutoClaw 身份验证失败（响应里没有用户 id）'));
  return {
    uid,
    name: autoclawDisplayName(p, ''),
    email: typeof p?.email === 'string' && p.email ? p.email : null,
    region: auth.region,
    phone: maskAutoclawPhone(p?.user_phone),
  };
}
