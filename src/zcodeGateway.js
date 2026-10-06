/**
 * ZCode 免费额度网关 — Start Plan 体验包（GLM-5.3-Flash）的本地补全代理。
 *
 * 数据面：POST /gateway/zcode/v1/messages（Anthropic /v1/messages 形态，10router
 * 建一个 anthropic-compatible 自定义节点指向这里即可）。
 *
 * 链路：账号轮换（store 里 provider=zcode、可解析出 zcodejwttoken 的账号）
 *   → 验证码（复用桌面版注册的隐藏窗口 provider，与活动领取共用同一个求解器）
 *   → POST zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 *   → SSE / JSON 原样流式回传。
 *
 * 失败分类：3007/3012（验证码）→ 作废 token 重解重试；401（JWT 失效）→ 拉黑账号；
 * 402/额度不足 → 标记耗尽；429 → 冷却 5 分钟。全部失败返回 502 + 各账号结论。
 *
 * 仅限本机回路使用：daemon 只绑 127.0.0.1，网关不做鉴权（跨机场景需要先给
 * daemon 加绑定/密钥，见 README）。NAS/纯 CLI 环境没有验证码提供者，网关开不了。
 */

import { claimToken, fetchCaptchaConfig, fetchJsonRace, fetchZcodeQuota } from './zcodeClient.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ZCode 客户端 plan 请求形状（从本机客户端真实流量捕获的载荷模板：系统提示词数组 +
// currentDate 提醒块 + metadata 会话形状）。网关请求镜像此形状——这就是 405/3012 风控的通过票。
// 提示词已脱敏（去掉抓包来源的用户路径/会话 id），避免把第三方隐私随请求外发（见 issue #16）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let PLAN_SHAPE = null;
try { PLAN_SHAPE = JSON.parse(readFileSync(path.join(__dirname, 'zcodePlanShape.json'), 'utf8')); } catch {}

import { getZcodeCaptchaProvider } from './zcodeAutoClaim.js';
import { gatewayHostSuggestion } from './tenrouter.js';

// 整链补全提供者（桌面版注册）：隐藏窗口内「真 Chromium 求解验证码 + 同源发起补全」，
// 规避 Node fetch 的 TLS 指纹风控。签名 ({ captchaCfg, jwt, rawBody }) → { status, contentType, body }。
let completionProvider = null;
export function setZcodeCompletionProvider(fn) { completionProvider = typeof fn === 'function' ? fn : null; }
export function getZcodeCompletionProvider() { return completionProvider; }
import { loadAccounts, loadSettings, saveSettings, loadState, withState } from './store.js';
import crypto from 'node:crypto';
import os from 'node:os';
import { logger } from './logger.js';

const PLAN_MESSAGES_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages';
const CAPTCHA_CACHE_TTL_MS = 30_000;
const ACCOUNT_COOLING_MS = 5 * 60_000;
const MAX_ATTEMPTS = 6;
// 上游补全墙钟上限（响应头到齐后 body 仍可流式跑这么久）
const UPSTREAM_TIMEOUT_MS = 600_000;
// 连接段（DNS/TCP/TLS/首字节）限时：上游黑洞挂死时几秒内换下一条路 / 代理兜底，
// 而不是吊满 10 分钟——这是「网关很慢 / 卡住」体感的主要来源
const UPSTREAM_CONNECT_MS = 15_000;

// ── 开关（持久化在 settings.zcodeGateway） ──

export async function gatewayEnabled() {
  return (await loadSettings()).zcodeGateway === true;
}

export async function setGatewayEnabled(v) {
  const on = v === true;
  await saveSettings({ zcodeGateway: on });
  // 开启网关视为「重新开始」：清掉进程内的拉黑/冷却状态，
  // 否则重新登录导入后旧黑名单仍会把账号挡在轮换队列外（与 MiniMax 网关同款 bug）。
  if (on) {
    dead.clear();
    cooling.clear();
  }
}

// ── 账号轮换状态（进程内；重启即清零） ──

let rrIndex = 0;
const cooling = new Map();  // accountId → 冷却截止(ms)
const dead = new Map();     // accountId → 拉黑时的凭据指纹（指纹变化 = 已重新登录导入，自动复活）

function markCooling(id, ms = ACCOUNT_COOLING_MS) { cooling.set(id, Date.now() + ms); }

/** 测试专用：清空进程内轮换/冷却/拉黑/验证码缓存/统计状态 */
export function __resetForTests() {
  rrIndex = 0;
  cooling.clear();
  dead.clear();
  quotaCache.clear();
  marksHydrated = false;
  captchaCache = null;
  stats.lastCallAt = null;
  stats.calls = 0;
  stats.lastAccount = null;
}
function markDead(account) {
  dead.set(account.id, credFingerprint(account));
  cooling.set(account.id, Number.MAX_SAFE_INTEGER);
}

/** 拉黑时的凭据指纹：重新登录/重新导入会整体替换 meta.credentials，指纹变化即可复活 */
function credFingerprint(a) {
  return `${a.meta?.credentials?.zcodejwttoken || ''}|${a.token || ''}`;
}

/**
 * 账号是否仍处于拉黑状态。拉黑记的是「当时那份凭据」的指纹：
 * 重新登录导入换了 JWT 后指纹不匹配 → 自动复活（清黑名单与冷却）。
 */
function isDead(account) {
  const fp = dead.get(account.id);
  if (fp === undefined) return false;
  if (fp === credFingerprint(account)) return true;
  dead.delete(account.id);
  cooling.delete(account.id);
  logger.info('ZCODE-GW', `${account.name || account.uid || account.id} 凭据已更新，解除拉黑`);
  return false;
}

/** 可参与轮换的账号（有可解析 plan JWT、未冷却/未拉黑），按轮转序排列 */
async function rotationQueue() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'zcode');
  await hydrateMarks();
  const now = Date.now();
  const ready = [];
  for (const a of all) {
    if (isDead(a)) continue;
    if (isQuotaExhausted(a.id)) continue; // 0 额度打标，不再轮换
    if ((cooling.get(a.id) || 0) > now) continue;
    try { claimToken(a); ready.push(a); } catch { /* 快照里没有 plan JWT，跳过 */ }
  }
  if (!ready.length) return [];
  rrIndex = ((rrIndex % ready.length) + ready.length) % ready.length;
  return [...ready.slice(rrIndex), ...ready.slice(0, rrIndex)];
}

/** 队列为空时说清原因（与 rotationQueue 同序分类）——额度耗尽不该提示「重新登录导入」 */
async function unavailableReason() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'zcode');
  if (!all.length) return '没有 ZCode 账号：请在 ZCode 登录后本机导入';
  const now = Date.now();
  const n = { dead: 0, exhausted: 0, cooling: 0, noJwt: 0 };
  for (const a of all) {
    if (isDead(a)) n.dead++;
    else if (isQuotaExhausted(a.id)) n.exhausted++;
    else if ((cooling.get(a.id) || 0) > now) n.cooling++;
    else n.noJwt++; // 未拉黑/未打标/未冷却却不在队列 → 快照里没有可解析的 plan JWT
  }
  if (n.noJwt === all.length) {
    return '没有可用的 ZCode 账号（需要账号快照里有 zcodejwttoken：在 ZCode 重新登录后本机导入）';
  }
  const parts = [];
  if (n.exhausted) parts.push(`${n.exhausted} 个额度耗尽（${Math.round(QUOTA_TTL_MS / 60_000)} 分钟内自动重探，无需重新登录）`);
  if (n.cooling) parts.push(`${n.cooling} 个临时冷却中（稍后自动恢复）`);
  if (n.dead) parts.push(`${n.dead} 个 JWT 已失效（需在 ZCode 重新登录后本机导入）`);
  if (n.noJwt) parts.push(`${n.noJwt} 个缺少 zcodejwttoken（需在 ZCode 重新登录后本机导入）`);
  return `没有可用的 ZCode 账号：${parts.join('；')}`;
}

// ── 验证码（与活动领取共用桌面版隐藏窗口求解器；30s 内复用同一 token） ──

let captchaCache = null; // { param, region, at }

// 调用统计（进程内）：面板「10Router 已接入」活标签的数据源
const stats = { lastCallAt: null, calls: 0, lastAccount: null };

// 额度打标：0 额度账号不再轮换（额度缓存 10 分钟，到期自动重探；
// 1005/1113 失败时也会即时探测确认——剩余>0 视为瞬时错误继续用）
const QUOTA_TTL_MS = 10 * 60_000;
const quotaCache = new Map(); // accountId → { remaining, at }

let marksHydrated = false;
async function hydrateMarks() {
  if (marksHydrated) return;
  marksHydrated = true;
  try {
    const st = await loadState();
    const saved = st?.zcodeGatewayExhausted || {};
    for (const [id, e] of Object.entries(saved)) {
      if (e && Date.now() - e.at < QUOTA_TTL_MS && !quotaCache.has(id)) quotaCache.set(id, e);
    }
  } catch { /* 状态读不到就从零开始 */ }
}

async function persistMark(accountId, entry) {
  try {
    await withState((st) => {
      st.zcodeGatewayExhausted = { ...(st.zcodeGatewayExhausted || {}), [accountId]: entry };
    });
  } catch { /* 持久化失败不影响内存态 */ }
}

/**
 * 账号刚领到新额度（活动领取成功）：清掉耗尽打标（内存 + state.json）和额度不足导致的冷却，
 * 让它立刻回到轮换——否则要等打标 10 分钟 / 冷却 30 分钟到期。JWT 拉黑不受影响。
 */
export async function clearQuotaMark(accountId) {
  quotaCache.delete(accountId);
  if (!dead.has(accountId)) cooling.delete(accountId);
  try {
    await withState((st) => {
      if (st?.zcodeGatewayExhausted?.[accountId]) delete st.zcodeGatewayExhausted[accountId];
    });
  } catch { /* 持久化失败不影响内存态 */ }
}

function isQuotaExhausted(id) {
  const q = quotaCache.get(id);
  return Boolean(q && Date.now() - q.at < QUOTA_TTL_MS && q.remaining <= 0);
}

async function probeQuota(account) {
  const r = await fetchZcodeQuota(account).catch(() => null);
  const remaining = Number(r?.remaining);
  if (Number.isFinite(remaining)) {
    quotaCache.set(account.id, { remaining, at: Date.now() });
    return remaining;
  }
  return null;
}

async function ensureCaptcha(force = false) {
  if (!force && captchaCache && Date.now() - captchaCache.at < CAPTCHA_CACHE_TTL_MS) return captchaCache;
  const provider = getZcodeCaptchaProvider();
  if (!provider) {
    throw Object.assign(new Error('本环境没有验证码提供者（网关补全需要桌面版 CreditDaddy 运行）'), { code: 'NO_CAPTCHA_PROVIDER' });
  }
  const cfg = await fetchCaptchaConfig();
  if (!cfg.enabled || !cfg.sceneId) {
    throw Object.assign(new Error('验证码配置不可用'), { code: 'NO_CAPTCHA_CONFIG' });
  }
  const { captchaParam, region } = await provider(cfg);
  captchaCache = { param: captchaParam, region, at: Date.now() };
  return captchaCache;
}

function invalidateCaptcha() { captchaCache = null; }

// ── 数据面 ──

/** 友好化上游错误描述 */
function formatUpstreamError(status, text) {
  const content = String(text || '').trim();

  // HTML 错误页面 → 提取关键信息
  if (content.includes('<html>') || content.includes('<h1>')) {
    const titleMatch = content.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (titleMatch) return `HTML 错误页：${titleMatch[1].trim()}`;
    return 'HTML 错误页（上游服务异常）';
  }

  // JSON 错误 → 提取业务码和消息
  try {
    const json = JSON.parse(content);
    const codes = [json.code, json.status, json.error?.code];
    const codeStr = codes.find(c => typeof c === 'number');
    const msg = json.message || json.error?.message || '';
    return codeStr ? (msg ? `[code:${codeStr}] ${msg}` : `[code:${codeStr}]`) : '未知错误';
  } catch {
    // 普通文本错误 → 截断显示
    const preview = content.length > 60 ? `${content.slice(0, 60)}...` : content;
    return preview || '(无响应内容)';
  }
}

function readRawBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        // 只 pause 不 destroy：destroy 会把 socket 打死，调用方随后写的 413 就发不出去，
        // 客户端只看到 ECONNRESET，分不清「自己请求体写太大」和「网络断了」。
        // 响应写完（res 'finish'）再由调用方收尾断开。
        req.pause();
        reject(Object.assign(new Error(`request body too large (limit ${Math.floor(limitBytes / 1024 / 1024)}MB)`), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 业务码可能包在 HTTP 200 里（上游对部分错误回 200 + {code}），两类都要看。
// 裸数字必须加 \b 词边界：否则 "code":4010 会被当成 401 认证失败（→ 账号被永久拉黑），
// 耗时 10050ms / request-id=11137 / 30071 也会被当成额度耗尽或验证码（→ 冷却 30 分钟 / 空跑一次验证码）。
const isCaptchaError = (status, text) =>
  status === 405 || /"code"\s*:\s*(3007|3012)\b|\b(3007|3012)\b|captcha|unusual activity/i.test(text);

const isAuthError = (status, text) =>
  status === 401 || /"code"\s*:\s*401\b|\b401\b|令牌已过期|验证不正确/.test(text);

const isExhausted = (status, text) =>
  status === 402 || /"code"\s*:\s*(1005|1113)\b|\b(1113|1005)\b|余额不足|无可用资源包|exceed quota|insufficient/i.test(text);

// 上游成功也会带 code（0 / 200），别把它们当业务错误——与 zcodeClient.businessOk 同一口径
const BUSINESS_OK = new Set([0, 200]);
/** 从上游 JSON 信封里取业务码；字符串数字（"3007"）也认，取不到返回 null */
function businessCode(v) {
  if (!v || typeof v !== 'object' || v.code === undefined || v.code === null) return null;
  const n = Number(v.code);
  return Number.isFinite(n) ? n : null;
}
// 组装与 ZCode 客户端真实流量一致的 plan 请求（镜像 R1 捕获，2026-09-29）
function buildPlanRequest(rawBody, { token, userId }) {
  const ver = '3.14.3';
  let bodyObj;
  try { bodyObj = JSON.parse(rawBody); } catch { bodyObj = null; }
  if (!bodyObj || typeof bodyObj !== 'object') bodyObj = { model: 'glm-5.3-flash', messages: [] };
  // 客户端形状：system = ZCode 系统提示词数组；首条 user 消息前插 currentDate 提醒块；
  // metadata.user_id = 会话形状字符串
  if (PLAN_SHAPE) {
    bodyObj.system = PLAN_SHAPE.system;
    const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const reminderText = PLAN_SHAPE.reminderText
      ? PLAN_SHAPE.reminderText.replace(/Today's date is [^.]+\./, `Today's date is ${new Date().toISOString().slice(0, 10)}.`)
      : null;
    if (reminderText) {
      const first = msgs[0];
      const firstIsUser = first?.role === 'user';
      const already = firstIsUser && typeof first.content === 'string' && first.content.includes('<system-reminder>');
      if (!already) {
        const block = { type: 'text', text: reminderText };
        if (firstIsUser && Array.isArray(first.content)) first.content = [block, ...first.content];
        else if (firstIsUser) first.content = [block, { type: 'text', text: String(first.content ?? '') }];
        else msgs.unshift({ role: 'user', content: [block, { type: 'text', text: '.' }] });
      }
      bodyObj.messages = msgs;
    }
    bodyObj.metadata = { user_id: JSON.stringify({ account_uuid: '', session_id: 'ses_' + crypto.randomUUID().slice(0, 16) }) };
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'accept-encoding': 'identity', // 网关不做压缩透传——转发链上有字符串化环节，gzip 字节会损坏
    'User-Agent': `ZCode/${ver} ai-sdk/anthropic/3.0.81`,
    'X-ZCode-App-Version': ver,
    'X-ZCode-Agent': 'glm',
    'X-Title': 'Z Code@cli',
    'HTTP-Referer': 'https://zcode.z.ai',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    'X-Platform': 'win32-x64',
    'X-Os-Category': 'windows',
    'X-Os-Version': os.release?.() || '10.0.19045',
    'X-Release-Channel': 'production',
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-request-id': crypto.randomUUID(),
    'anthropic-version': '2023-06-01',
    Authorization: `Bearer ${token}`,
  };
  return { headers, body: JSON.stringify(bodyObj) };
}

const LOOPBACK_RE = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/;
function isLoopbackRemote(remote) {
  return !remote || LOOPBACK_RE.test(String(remote));
}

/** 规范化远端地址（剥 IPv4-mapped IPv6 前缀），与白名单条目比对 */
export function remoteHost(remote) {
  return String(remote || '').replace(/^::ffff:/i, '').trim();
}

/** 白名单匹配：精确 IP / 主机名，或 `*` 结尾的前缀通配（如 192.168.31.*） */
export function remoteAllowed(remote, allowList) {
  const host = remoteHost(remote);
  if (!host) return false;
  return (Array.isArray(allowList) ? allowList : []).some((entry) => {
    const e = String(entry || '').trim();
    if (!e) return false;
    if (e.endsWith('*')) return host.toLowerCase().startsWith(e.slice(0, -1).toLowerCase());
    return host.toLowerCase() === e.toLowerCase();
  });
}

/**
 * 网关数据面入口。返回 true 表示响应已写出（含失败结论）。
 *
 * 访问控制：本机回环始终放行；开局域网后仅 IP 白名单内的机器可访问——
 * zcode-free 本就是 10Router 侧免授权供应商，10Router 所在机器加白即可，不再保留虚拟 key 鉴权。
 */
export async function handleGateway(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'POST /gateway/zcode/v1/messages（Anthropic /v1/messages 形态）' }));
  }
  // settings 一次读齐：开关 + 局域网鉴权共用，省掉一次 settings.json 磁盘读（热路径每请求都走）
  const settings = await loadSettings();
  if (settings.zcodeGateway !== true) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'ZCode 免费额度网关未开启（面板 → ZCode → 网关开关）' }));
  }
  // 首发不带验证码（客户端真实流量多数直过），所以纯 daemon / NAS 也能用；
  // 只有当上游索要验证码且本环境没有求解提供者时才失败（见 attempts 汇总）。

  // 鉴权：本机回环免密；开局域网后仅白名单内 IP 免密直连（如 10Router 所在机器——zcode-free 本就是免授权供应商）
  const remote = (req.socket && req.socket.remoteAddress) || '';
  if (!isLoopbackRemote(remote)) {
    if (settings.zcodeGatewayLan !== true) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '网关未允许局域网访问（面板 → ZCode → 接口设置）' }));
    }
    if (!remoteAllowed(remote, settings.zcodeGatewayAllow)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `来源 ${remoteHost(remote) || '未知'} 不在网关 IP 白名单内（面板 → ZCode → 接口设置里添加）` }));
    }
  }

  let rawBody;
  try { rawBody = await readRawBody(req); } catch (e) {
    res.writeHead(e.status || 400, { 'Content-Type': 'application/json' });
    // 超限时请求体还没读完：先把 413 发出去，发完再断开，避免客户端继续往这灌数据
    res.on('finish', () => req.destroy());
    return res.end(JSON.stringify({ error: e.message }));
  }

  const queue = await rotationQueue();
  if (!queue.length) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: await unavailableReason() }));
  }

  stats.lastCallAt = new Date().toISOString();
  stats.calls += 1;

  const attempted = [];
  // 客户端断开 → 取消当前上游请求。整个重试循环共用一个 controller/listener：
  // 放在循环里每轮 new + req.on('close') 会在同一 req 上累积最多 MAX_ATTEMPTS 个监听器
  // （MaxListenersExceededWarning + 泄漏）。
  const clientAbort = new AbortController();
  req.once('close', () => { if (!res.writableEnded) clientAbort.abort(); });
  // 首发不带验证码（客户端真实流量多数直过）；上游 3007/403 时求解并在此后的
  // 尝试上挂新 token（zcode-api 同策略）。provider 为 null（NAS/CLI）时首过路径依然可用。
  let captcha = null;
  for (let i = 0; i < Math.min(MAX_ATTEMPTS, queue.length * 2); i++) {
    const account = queue[i % queue.length];
    // 本轮已被打标/冷却/拉黑的号不再重打（第二圈只为验证码重试准备）
    if (isDead(account) || isQuotaExhausted(account.id) || (cooling.get(account.id) || 0) > Date.now()) continue;
    const label = account.name || account.uid || account.id;
    let token;
    try { token = claimToken(account); } catch (e) {
      attempted.push({ account: label, ok: false, error: e.message });
      markDead(account);
      continue;
    }

    let upstream;
    try {
      // 请求面完全镜像 ZCode 客户端真实流量（R1 捕获）：全套 identity 头 + 客户端
      // 系统提示词/提醒块/metadata 形状。验证码不预挂——服务端未风控时直过；
      // 返回 3007/403 再求解挂上重试（zcode-api 同策略）。
      const built = buildPlanRequest(rawBody, { token, userId: account.uid });
      const headers = captcha
        ? { ...built.headers, 'X-Aliyun-Captcha-Verify-Param': captcha.param, 'X-Aliyun-Captcha-Verify-Region': captcha.region }
        : built.headers;
      upstream = await fetchJsonRace(PLAN_MESSAGES_URL, {
        method: 'POST',
        headers,
        body: built.body,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        connectMs: UPSTREAM_CONNECT_MS,
        signal: clientAbort.signal,
      });
    } catch (e) {
      if (clientAbort.signal.aborted) return; // 客户端先断了
      attempted.push({ account: label, ok: false, error: e.message });
      continue;
    }

    if (upstream.ok) {
      // 上游会把业务错误包在 HTTP 200 + application/json 里（非 SSE）——先验形再转发，
      // 否则客户端拿到「200 但不是 Message」的假成功（cc CLI 的 StreamNoEventsError 就是它）
      const ct = (upstream.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        const text = await upstream.text().catch(() => '');
        let v;
        try { v = JSON.parse(text); } catch { v = null; }
        const code = businessCode(v);
        // 上游成功信封也可能带 code（0 / 200），那不是业务错误；字符串数字（"3007"）同样要拦
        if (code !== null && !BUSINESS_OK.has(code)) {
          if (isCaptchaError(200, text)) {
            invalidateCaptcha();
            attempted.push({ account: label, ok: false, error: '验证码被拒（200 业务码）', captcha: true });
            try { captcha = await ensureCaptcha(true); } catch { captcha = null; }
            continue;
          }
          if (isAuthError(200, text)) {
            markDead(account);
            attempted.push({ account: label, ok: false, error: 'JWT 已失效，账号拉黑' });
            logger.info('ZCODE-GW', `${label} JWT 失效（200 业务码）`);
            continue;
          }
          if (isExhausted(200, text)) {
            const remaining = await probeQuota(account).catch(() => null);
            if (remaining === null) {
              // 探不到额度 ≠ 确认耗尽：不打标（否则一次查询失败就把号挡 10 分钟），只短冷却
              markCooling(account.id, 2 * 60_000);
              attempted.push({ account: label, ok: false, error: '额度被拒且额度查询失败，短冷却' });
            } else if (remaining <= 0) {
              // 确认 0 额度 → 打标（持久化到 state.json，重启不复轮换）
              const entry = { remaining, at: Date.now() };
              quotaCache.set(account.id, entry);
              await persistMark(account.id, entry);
              attempted.push({ account: label, ok: false, error: `额度耗尽（剩余 ${remaining}），已打标` });
            } else {
              // 还有额度却被拒 → 瞬时错误，短冷却继续用
              markCooling(account.id, 2 * 60_000);
              attempted.push({ account: label, ok: false, error: `额度接口瞬时拒绝（剩余 ${remaining}）` });
            }
            continue;
          }
          logger.warn('ZCODE-GW', `${label} 上游 200 业务错误：${formatUpstreamError(200, text)} (${text.slice(0, 80)})`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(text);
          return true;
        }
        // 真 Message（非流式）——原样转发
        logger.debug('ZCODE-GW', `${label} 补全成功 (${upstream.status})`);
        stats.lastAccount = label;
        cooling.delete(account.id);
        res.writeHead(upstream.status, { 'Content-Type': ct || 'application/json', 'Cache-Control': 'no-cache' });
        res.end(text);
        return true;
      }
      logger.debug('ZCODE-GW', `${label} 补全成功 (${upstream.status})`);
      stats.lastAccount = label;
      cooling.delete(account.id);
      // 注意：undici 已自动解压上游 gzip——body 是明文，绝不能再带 content-encoding 头
      // （带着会让客户端对明文做 gunzip → 乱码）
      const out = {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-cache',
      };
      res.writeHead(upstream.status, out);
      try {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise((r) => res.once('drain', r));
          }
        }
      } catch (e) {
        logger.warn('ZCODE-GW', `流式转发中断：${e.message}`);
      }
      res.end();
      return true;
    }

    const text = await upstream.text().catch(() => '');
    // 验证码类失败：作废 token 并强制重解（有提供者时下一次尝试带上新 token）
    if (isCaptchaError(upstream.status, text)) {
      invalidateCaptcha();
      attempted.push({ account: label, ok: false, error: `验证码被拒（${upstream.status}）`, captcha: true });
      logger.info('ZCODE-GW', `${label} 验证码被拒 (${formatUpstreamError(upstream.status, text)})`);
      try { captcha = await ensureCaptcha(true); } catch (e) {
        logger.info('ZCODE-GW', `验证码重解失败：${e.message}`);
        captcha = null;
      }
      continue;
    }
    if (isAuthError(upstream.status, text)) {
      markDead(account);
      attempted.push({ account: label, ok: false, error: 'JWT 已失效，账号拉黑（重新登录后再导入）' });
      logger.debug('ZCODE-GW', `${label} JWT 失效，拉黑`);
      continue;
    }
    if (isExhausted(upstream.status, text)) {
      markCooling(account.id, 30 * 60_000);
      attempted.push({ account: label, ok: false, error: '额度不足/无资源包' });
      logger.debug('ZCODE-GW', `${label} 额度不足 (${upstream.status})`);
      continue;
    }
    if (upstream.status === 429) {
      markCooling(account.id);
      attempted.push({ account: label, ok: false, error: '429 限流，冷却 5 分钟' });
      logger.debug('ZCODE-GW', `${label} 429 限流，冷却 5 分钟`);
      continue;
    }
    // 其他错误：友好化展示 + 原样透传给客户端
    const errorSummary = formatUpstreamError(upstream.status, text);
    logger.warn('ZCODE-GW', `${label} 上游错误 ${upstream.status} — ${errorSummary}`);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(text);
    return true;
  }

  logger.warn('ZCODE-GW', `全部 ${attempted.length} 次尝试失败`);
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'ZCode 网关：所有账号尝试均失败', attempts: attempted }));
  return true;
}

// ── 面板状态 ──

export async function gatewayStatus() {
  const enabled = await gatewayEnabled();
  const hasCaptcha = Boolean(getZcodeCaptchaProvider());
  const all = (await loadAccounts()).filter((a) => a.provider === 'zcode');
  let withJwt = 0;
  for (const a of all) { try { claimToken(a); withJwt++; } catch { /* 无 plan JWT */ } }
  const now = Date.now();
  const settings = await loadSettings();
  return {
    enabled,
    hasCaptcha,
    lan: settings.zcodeGatewayLan === true,
    allow: Array.isArray(settings.zcodeGatewayAllow) ? settings.zcodeGatewayAllow : [],
    suggestAllow: gatewayHostSuggestion(),
    stats: {
      lastCallAt: stats.lastCallAt,
      calls: stats.calls,
      lastAccount: stats.lastAccount,
    },
    exhausted: all
      .filter((a) => isQuotaExhausted(a.id))
      .map((a) => ({ id: a.id, name: a.name || a.uid || a.id, remaining: quotaCache.get(a.id)?.remaining ?? 0 })),
    accounts: all.length,
    accountsWithJwt: withJwt,
    cooling: all.filter((a) => !isDead(a) && (cooling.get(a.id) || 0) > now).map((a) => a.name || a.uid || a.id),
    dead: all.filter((a) => isDead(a)).map((a) => a.name || a.uid || a.id),
    endpoint: '/gateway/zcode/v1/messages',
    note: hasCaptcha ? null : '需要桌面版 CreditDaddy（隐藏窗口验证码），纯 CLI / NAS 环境不可用',
  };
}
