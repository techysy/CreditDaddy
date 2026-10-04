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
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { defaultSecret, safeDecrypt } from './zcrypto.js';
import { ensureVirtualDeviceMid } from './zcodeLocal.js';

const QUOTA_LIMIT_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
const SUBSCRIPTION_URL = 'https://open.bigmodel.cn/api/biz/subscription/list';
const BILLING_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
const BILLING_PREVIEW_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/preview';
const BILLING_CLAIM_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/claim';
const CLIENT_CONFIGS_URL = 'https://zcode.z.ai/api/v1/client/configs';
// 与 zcode-switch 一致：billing 类接口对客户端版本有校验（版本过低直接 3001 parameter error），
// 所以优先上报本机已安装 ZCode 的版本（注册表读取），没有客户端时退回兜底值。
const APP_VERSION_FALLBACK = '3.14.3';
let appVersionCache = null;
let appVersionPromise = null;

/** 读注册表拿本机已安装 ZCode 的版本（单 hive，失败返回空串） */
function queryUninstallHive(hive) {
  return new Promise((resolve) => {
    execFile('reg', ['query', hive, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

async function detectAppVersion() {
  if (process.platform !== 'win32') return null;
  for (const hive of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    const out = await queryUninstallHive(hive);
    const m = out.match(/ZCode[^\r\n]*\r?\n(?:.*\r?\n)*?\s*DisplayVersion\s+REG_SZ\s+([\d.]+)/)
      || out.match(/DisplayName\s+REG_SZ\s+ZCode[^\r\n]*[\s\S]{0,400}?DisplayVersion\s+REG_SZ\s+([\d.]+)/);
    if (m) return m[1];
  }
  return null;
}

/** 客户端版本号（异步：注册表枚举较慢，不能在请求处理里同步执行阻塞事件循环） */
export function zcodeAppVersion() {
  if (appVersionCache) return Promise.resolve(appVersionCache);
  if (!appVersionPromise) {
    appVersionPromise = detectAppVersion()
      .catch(() => null)
      .then((v) => { appVersionCache = v || APP_VERSION_FALLBACK; return appVersionCache; });
  }
  return appVersionPromise;
}

/** 启动时预热版本探测（调度器调用），首个真实请求前缓存即可就绪 */
export function warmZcodeAppVersion() {
  zcodeAppVersion().catch(() => {});
}
/** 测试用：重置版本探测缓存 */
export function _resetAppVersionCache(v) { appVersionCache = v || null; appVersionPromise = null; }

// ── HTTP 出口：直连优先 / 代理优先（可切换），任一路成功即返回 ──
// 代理地址：优先用面板里保存的 proxyUrl（zcode-net.json，0600），没有则退回 HTTPS_PROXY 环境变量

function codeHome() {
  return process.env.CREDITDADDY_HOME || process.env.QODERDADDY_HOME || path.join(os.homedir(), '.creditdaddy');
}
const NET_PREFS_FILE = () => path.join(codeHome(), 'zcode-net.json');

let netPrefCache = null;
function netPref() {
  if (netPrefCache) return netPrefCache;
  try {
    const j = JSON.parse(fs.readFileSync(NET_PREFS_FILE(), 'utf8'));
    netPrefCache = {
      proxyFirst: j.proxyFirst === true,
      proxyUrl: typeof j.proxyUrl === 'string' && j.proxyUrl.trim() ? j.proxyUrl.trim() : null,
      autoClaim: j.autoClaim === true,
      autoClaimUntil: Number.isFinite(j.autoClaimUntil) ? j.autoClaimUntil : null,
      claimIntervalMin: Number.isFinite(j.claimIntervalMin) ? Number(j.claimIntervalMin) : null,
      claimWindowMin: Number.isFinite(j.claimWindowMin) ? Number(j.claimWindowMin) : null,
    };
  } catch { netPrefCache = { proxyFirst: false, proxyUrl: null, autoClaim: false, autoClaimUntil: null, claimIntervalMin: null, claimWindowMin: null }; }
  return netPrefCache;
}
function writeNetPref(p) {
  netPrefCache = p;
  fs.mkdirSync(codeHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(NET_PREFS_FILE(), JSON.stringify({ proxyFirst: p.proxyFirst, proxyUrl: p.proxyUrl, autoClaim: p.autoClaim, autoClaimUntil: p.autoClaimUntil || null, claimIntervalMin: p.claimIntervalMin ?? null, claimWindowMin: p.claimWindowMin ?? null }, null, 2), { mode: 0o600 });
}
export function proxyFirst() { return netPref().proxyFirst; }
export function proxyUrl() { return netPref().proxyUrl; }
/** 活动自动轮询领取开关（默认关：活动期前再开） */
export function autoClaimEnabled() {
  const p = netPref();
  if (p.autoClaim && p.autoClaimUntil && Date.now() >= p.autoClaimUntil) {
    writeNetPref({ ...p, autoClaim: false, autoClaimUntil: null });
    return false;
  }
  return p.autoClaim;
}
export function autoClaimUntil() { return autoClaimEnabled() ? netPref().autoClaimUntil : null; }
export function setAutoClaimEnabled(v) {
  writeNetPref({ ...netPref(), autoClaim: v === true, autoClaimUntil: null });
}
export function enableAutoClaimFor(durationMs) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('自动领取时长无效');
  writeNetPref({ ...netPref(), autoClaim: true, autoClaimUntil: Date.now() + duration });
}

// ── 自动领取计划：轮询周期 / 单次运行时长（用户可在面板弹窗里改，落 zcode-net.json） ──

/** 轮询周期（分钟）。默认 2，可配 1–720 */
export function claimIntervalMin() {
  const raw = netPref().claimIntervalMin;
  if (raw === null || raw === undefined) return 2;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 720 ? n : 2;
}
export function setClaimIntervalMin(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 720) throw new Error('轮询周期需在 1–720 分钟之间');
  writeNetPref({ ...netPref(), claimIntervalMin: n });
}

/** 单次运行时长（分钟）。默认 60；0 = 一直运行直到手动关闭 */
export function claimWindowMin() {
  const raw = netPref().claimWindowMin;
  if (raw === null || raw === undefined) return 60;
  const n = Math.round(Number(raw));
  if (n === 0) return 0;
  return n >= 5 && n <= 1440 ? n : 60;
}
export function setClaimWindowMin(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1440 || (n > 0 && n < 5)) throw new Error('运行时长需为 0（一直运行）或 5–1440 分钟');
  writeNetPref({ ...netPref(), claimWindowMin: n });
}
export function setProxyFirst(v) { writeNetPref({ ...netPref(), proxyFirst: v === true }); }
export function setProxyUrl(u) {
  const t = typeof u === 'string' ? u.trim() : '';
  if (t && !/^http:\/\/\S+/i.test(t)) throw new Error('目前只支持 http:// 代理地址');
  writeNetPref({ ...netPref(), proxyUrl: t || null });
}

const envProxy = () => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
/** 生效代理：面板保存的优先，其次环境变量 */
const effectiveProxy = () => proxyUrl() || envProxy();

/** 目标是否应绕过代理（loopback / NO_PROXY 后缀匹配） */
function proxyBypass(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  for (const pat of (process.env.NO_PROXY || process.env.no_proxy || '').split(',')) {
    const p = pat.trim().toLowerCase();
    if (!p) continue;
    const sfx = p.startsWith('.') ? p.slice(1) : p;
    if (host === sfx || host.endsWith('.' + sfx)) return true;
  }
  return false;
}

/**
 * 经 HTTP 代理访问目标（纯 node 内置模块实现，保持核心零依赖）：
 * https 目标走 CONNECT 隧道 + TLS；http 目标走绝对 URI 转发。
 * 支持代理认证（URL 内嵌 user:password → Proxy-Authorization）。
 */
function connectTunnel(proxyUrl, target) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const headers = {};
    if (p.username || p.password) {
      const auth = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    }
    const req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: target, headers, timeout: 10000 });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理隧道失败（CONNECT ${res.statusCode}）`)); return; }
      resolve(socket);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('连接代理超时')));
    req.end();
  });
}

async function fetchViaProxy(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, signal = null } = {}) {
  const proxy = effectiveProxy();
  if (!proxy || !/^http:\/\//i.test(proxy)) throw new Error('没有可用的 http 代理（面板配置或 HTTPS_PROXY 环境变量）');
  const u = new URL(url);
  const p = new URL(proxy);
  const isHttps = u.protocol === 'https:';
  let requestOpts;
  if (isHttps) {
    const socket = await connectTunnel(proxy, `${u.hostname}:443`);
    const tlsSocket = tls.connect({ socket, servername: u.hostname });
    requestOpts = {
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers: { ...headers, Host: u.host }, timeout: timeoutMs,
      createConnection: () => tlsSocket,
    };
  } else {
    requestOpts = {
      hostname: p.hostname, port: Number(p.port) || 80, path: url, method,
      headers: { ...headers, Host: u.host }, timeout: timeoutMs,
    };
  }
  return new Promise((resolve, reject) => {
    // request 的 timeout 是「无活动」超时：对端每 14 秒吐一个字节就能一直吊着请求不放。
    // 这里再补一个整条请求的墙钟上限，并接上外部 abort（客户端断开 / 上层取消）。
    const deadline = setTimeout(() => req.destroy(new Error('请求超时')), timeoutMs);
    const onAbort = () => req.destroy(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
    if (signal) {
      if (signal.aborted) { clearTimeout(deadline); reject(signal.reason || new Error('请求已取消')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const done = (fn, arg) => { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); fn(arg); };
    const req = (isHttps ? https : http).request(requestOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(resolve, new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * 统一出口：按「代理优先」开关决定请求顺序，首个成功的返回。
 * - 默认直连优先、代理兜底（无代理环境时等同纯直连，零行为变化）
 * - 代理优先适合直连不稳 / 被拦的网络
 * 返回 fetch Response；调用方按业务 code 自行判定（业务错误也算“成功送达”，不再回退）。
 */
// 测试可替换代理请求实现（生产代码不传）
let viaProxyImpl = null;
export function _setViaProxyForTests(fn) { viaProxyImpl = fn || null; }

/**
 * 组合多个 AbortSignal 成一个：任一源触发即 abort。
 * 与 AbortSignal.any 的区别——这里返回 { signal, releaseConnect }，releaseConnect()
 * 可摘掉 connectSignal 的转发监听：两段式超时里，响应头到达后连接段限时就该失效，
 * 但整墙钟（wallSignal）和外部取消（external）要继续管住流式 body。
 */
function combineSignals({ wallSignal, connectSignal, external }) {
  const ctrl = new AbortController();
  const onWall = () => ctrl.abort(wallSignal.reason);
  const onConnect = () => ctrl.abort(connectSignal.reason);
  const onExternal = () => ctrl.abort(external.reason);
  if (wallSignal.aborted) ctrl.abort(wallSignal.reason);
  else wallSignal.addEventListener('abort', onWall, { once: true });
  if (connectSignal && !ctrl.signal.aborted) {
    if (connectSignal.aborted) ctrl.abort(connectSignal.reason);
    else connectSignal.addEventListener('abort', onConnect, { once: true });
  }
  if (external && !ctrl.signal.aborted) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', onExternal, { once: true });
  }
  // 连接段成功后调用：只摘掉 connectSignal 的转发，墙钟与外部取消继续管住 body 流
  const releaseConnect = () => { connectSignal?.removeEventListener('abort', onConnect); };
  return { signal: ctrl.signal, releaseConnect };
}

/**
 * 直连 / 代理兜底的 fetch。可选 connectMs 启用两段式超时：
 *   - 拿到响应头前（DNS/TCP/TLS/首字节）限时 connectMs——上游黑洞挂死时几秒内
 *     就失败换下一条路，而不是吊满整个 timeoutMs（网关补全场景尤其重要）；
 *   - 拿到响应头后解除连接段限时，只保留 timeoutMs 整墙钟——流式补全可能合法地
 *     跑几分钟，不能因为「连接快、生成慢」被误杀。
 * 不传 connectMs 时退回单段 timeoutMs（旧行为，所有既有调用方不受影响）。
 */
export async function fetchJsonRace(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, connectMs = null, signal = null } = {}) {
  const useProxy = Boolean(effectiveProxy()) && !proxyBypass(url);
  const twoPhase = Number.isFinite(connectMs) && connectMs > 0 && connectMs < timeoutMs;
  // 超时信号必须每次尝试各建一个：共用一个的话，代理优先模式下第一条路吃完 timeoutMs，
  // 兜底那条就对着已触发的 signal 发请求，必定瞬间失败——「代理优先」就此形同虚设
  const makeAttempt = () => {
    const wallSignal = AbortSignal.timeout(timeoutMs);
    const connectSignal = twoPhase ? AbortSignal.timeout(connectMs) : null;
    const { signal: abortSignal, releaseConnect } = combineSignals({ wallSignal, connectSignal, external: signal });
    const base = { method, headers: { ...headers }, ...(body != null ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: abortSignal };
    return {
      // 响应头到达 = 连接段成功：摘掉 connectSignal 转发，此后只有墙钟/外部取消能中断流
      direct: async () => { const r = await fetch(url, base); releaseConnect(); return r; },
      viaProxy: async () => {
        const r = viaProxyImpl
          ? await viaProxyImpl(url, { method, headers, body, timeoutMs, signal: abortSignal })
          : await fetchViaProxy(url, { method, headers, body, timeoutMs, signal: abortSignal });
        releaseConnect();
        return r;
      },
    };
  };
  const order = useProxy ? (proxyFirst() ? ['viaProxy', 'direct'] : ['direct', 'viaProxy']) : ['direct'];
  let lastErr = null;
  for (const which of order) {
    const attempts = makeAttempt();
    try { return await attempts[which](); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch failed');
}

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

export async function zaiHeaders(token, deviceMid) {
  const ver = await zcodeAppVersion();
  return {
    'User-Agent': `ZCode/${ver}`,
    'HTTP-Referer': 'https://zcode.z.ai',
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': ver,
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

async function bigmodelHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'User-Agent': `ZCode/${await zcodeAppVersion()}`, 'x-request-id': crypto.randomUUID() };
}

async function getJson(url, headers) {
  const res = await fetchJsonRace(url, { headers, timeoutMs: FETCH_TIMEOUT_MS });
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

/** 领取/网关补全用的 token：zcodejwttoken 优先，其次 start-plan key（与 claim.rs claim_token 一致） */
export function claimToken(account) {
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
      const limit = await getJson(QUOTA_LIMIT_URL, await bigmodelHeaders(t));
      if (businessOk(limit)) {
        const sub = await getJson(SUBSCRIPTION_URL, await bigmodelHeaders(t)).catch(() => null);
        return { ...normalizeQuotaLimit(limit, sub), source: 'bigmodel' };
      }
      if (limit?.code === 401) authFails++;
      else lastErr = limit?.msg || lastErr;
    } catch (e) { lastErr = e.message; }
  }
  for (const t of billingTokens(account)) {
    try {
      const bal = await getJson(`${BILLING_BALANCE_URL}?app_version=${await zcodeAppVersion()}`, await zaiHeaders(t, ensureVirtualDeviceMid(account)));
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
    `${BILLING_PREVIEW_URL}?app_version=${await zcodeAppVersion()}&platform=${platform()}`,
    await zaiHeaders(token, ensureVirtualDeviceMid(account)),
  );
  if (v?.code !== 0) throw new Error(v?.msg || v?.message || `查询活动列表失败（code ${v?.code}）`);
  return { plans: normalizePlans(v), serverTime: v?.data?.server_time ? new Date(v.data.server_time * 1000).toISOString() : null };
}

/** 验证码配置（无需登录）。当前服务端未下发时返回 { enabled: false }。 */
export async function fetchCaptchaConfig() {
  // 公开端点：不带任何鉴权头（空 token 会生成畸形的 "Authorization: Bearer "，被上游判为 3001）
  const v = await getJson(CLIENT_CONFIGS_URL);
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
  const headers = await zaiHeaders(token, ensureVirtualDeviceMid(account));
  if (captchaParam && captchaParam.trim()) headers['X-Aliyun-Captcha-Verify-Param'] = captchaParam.trim();
  if (region && region.trim()) headers['X-Aliyun-Captcha-Verify-Region'] = region.trim();
  const res = await fetchJsonRace(BILLING_CLAIM_URL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: { plan_id: planId },
    timeoutMs: 25_000,
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
