/**
 * Trae 国内站浏览器登录 — 官方客户端同款 OAuth 授权码 + PKCE（S256）闭环。
 *
 * 协议（2026-09/10 社区抓包固化，workbuddy-switch / muskke trae-api-proxy / 10router#99 三方互证）：
 *   1. 客户端构造授权 URL（22 参数，内层 `${loginHost}/authorization`，外层再包一层
 *      `/login?login_platform=trae&redirect_url=<内层>`——与真机客户端逐字一致）：
 *      `client_id=ono9krqynydwx5`（TRAE 产品线固定钥匙）、`code_challenge`（PKCE S256）、
 *      `login_trace_id`（兼作 CSRF 绑定值）、`auth_callback_url=http://127.0.0.1:<port>/authorize`。
 *   2. 用户在浏览器登录并点授权 → 授权页前端调 GetPCAuthCode（绑定 challenge）→
 *      302 回 `auth_callback_url`，参数：`authCodeInfo`（URL 编码 JSON，含 AuthCode/ExpireAt）
 *      + `userInfo`（UserID/ScreenName）+ `host`（换票主机）+ `userRegion` + `loginTraceID`。
 *   3. `POST ${host}/trae/api/v3/oauth/ExchangeToken`，body
 *      `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}` 换 accessToken（Cloud-IDE-JWT）
 *      + refreshToken。AuthCode 交换**不需要私钥**（DeviceInfo.DevicePublicKey 声明设备身份，
 *      DeviceProof 是 refreshToken 刷新场景专属——本模块只管登录闭环，刷新链后续单独做）。
 *      旧端点 `/cloudide/api/v3/trae/oauth/ExchangeToken`（扁平 body）仍活着，作兜底。
 *
 * ## 设备身份：自造独立指纹（每个账号一套，不与本机 Trae 客户端共用）
 *
 * muskke 证实**自造身份可完成完整登录**（machine_id 随机 UUID + 现场生成 DevicePublicKey）。
 * workbuddy 记录的 20403「Token device not match」根因是授权 URL 与请求体**两处不同源**——
 * 本模块 device_id / machine_id / DevicePublicKey 单点生成、三处同源，不会踩它。
 * 自造还有两个好处：① 每个账号独立设备指纹，不触发共享设备风控（4017，trae2api-hub 实测）；
 * ② 不与本机 Trae 客户端抢身份。deviceId 用 16 位纯数字（签到接口风控要求，traeLocal 同款约束），
 * keypair 为 EC P-256（与客户端同款），**私钥 JWK 落进账号 meta**——本仓库凭据本就明文落本地，
 * 与现有安全姿态一致；buildExportPayload 只挑白名单字段，meta 不会跟着同步推去 10Router。
 *
 * ## ★ 回调监听的三条硬规矩（workbuddy 踩坑沉淀）
 *
 * 1. 授权页在「认证中，正在验证身份」阶段会**从浏览器侧探测本机回调端口**，探不到就不走完
 *    授权。端口跟 `auth_callback_url` 声明的一致（muskke 证实可自选；workbuddy 观察到的
 *    17388 是旧版本行为，真机 3.4.9 客户端用 3379——两处都试绑，URL 用绑上的那个）。
 * 2. 探测请求**必须回 200 + CORS 头**（授权页是 https 源，跨源探测没有 CORS 头会被浏览器拦）。
 *    端口上**第一条请求通常是探测而不是回调**，凭「是否带凭据标记」区分两者。
 * 3. 带 `error=` 的也是真回调（拒绝回调），先于「无凭据=探测」判定，否则拒绝会被误当探测、
 *    用户白等到超时。
 *
 * 与「本机导入」的关系：OAuth 登录拿到的是**独立的一条凭据链**（含 refreshToken，导入线没有），
 * 不读写 Trae 客户端的 storage.json，互不作废。
 */

import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { FETCH_TIMEOUT_MS } from './constants.js';

/** 授权页域：国内站 www.trae.cn / 国际站 www.trae.ai（#99：两站同协议同 client_id，
 *  账号不互通——站点由 GetLoginGuidance 返回的 LoginHost 权威决定）。 */
const CONSOLE_BASE_CN = 'https://www.trae.cn';
const CONSOLE_BASE_INTL = 'https://www.trae.ai';
const CLIENT_ID = 'ono9krqynydwx5';
const AUTH_FROM = 'trae';
/** 版本指纹常量：CN 来自真机客户端登录 URL 实抓样本（3.4.9 / 插件 2.3.97430）；
 *  国际版按 10R 口径（product.json 实测 3.6.4），上游更新后在此换。 */
const PLUGIN_VERSION = '2.3.97430';
const APP_VERSION_CN = '3.4.9';
const APP_VERSION_INTL = '3.6.4';
const APP_TYPE = 'stable';
/** 换票主机白名单（hostname 级）：host 参数来自回调查询串（浏览器可控），拦 SSRF。
 *  CN 族 = api.trae.cn 系；国际族 = grow-normal 系（AuthCode v3 换票主机，10R #99 实测
 *  grow-normal.trae.ai / growsg-normal.trae.ai / USTTP 账号面 grow-normal.traeapi.us）
 *  + 老族兜底。回环放行是给本仓联调 / 测试用的。 */
const EXCHANGE_HOST_ALLOW_CN = ['api.trae.cn', 'api.trae.com.cn', 'api.marscode.cn', 'www.trae.cn'];
const EXCHANGE_HOST_ALLOW_INTL = ['grow-normal.trae.ai', 'growsg-normal.trae.ai', 'grow-normal.traeapi.us', 'api.trae.ai', 'api.marscode.com', 'www.trae.ai'];
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
/** 换票回落主机：回调没带 host（上游版本差异）时用。CN 真机实测打 api.trae.cn；
 *  国际按 10R authCodeOrigins 顺序（growsg 优先，USTTP 账号面 traeapi.us 兜底）。 */
const EXCHANGE_HOST_FALLBACK_CN = 'https://api.trae.cn';
const EXCHANGE_HOST_FALLBACK_INTL = 'https://growsg-normal.trae.ai';
/** 回调端口候选：真机 3.4.9 客户端用 3379；workbuddy 钉旧版观察到 17388。 */
const CALLBACK_PORTS = [3379, 17388];
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** 单次登录会话状态（进程内；sessionId 只在 start/poll 之间传递）。 */
const sessions = new Map();

function gcSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (s.deadline < now) {
      try { s.server.close(); } catch {}
      sessions.delete(k);
    }
  }
}

/** 16 位纯数字设备号（首位 1-9；签到风控要求 x-device-id 是 16 位数字，traeLocal 同款约束）。 */
export function newDeviceId() {
  const buf = crypto.randomBytes(16);
  let out = String(1 + (buf[0] % 9));
  for (let i = 1; i < 16; i++) out += String(buf[i] % 10);
  return out;
}

/** EC P-256 设备密钥对（与客户端同款曲线）。公钥走 SPKI PEM 进 DeviceInfo；私钥 JWK 落 meta 供刷新链用。 */
export function newDeviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    deviceId: newDeviceId(),
    machineId: crypto.randomUUID(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyJwk: privateKey.export({ format: 'jwk' }),
  };
}

function osProfile() {
  const osName = os.type().replace(/_/g, ' ') || 'Windows';
  return {
    osName,
    osVersion: os.release() || '',
    deviceModel: `${os.platform()} ${os.arch()}`,
    deviceBrand: osName,
    deviceName: process.env.USERNAME || process.env.USER || os.hostname() || 'PC',
    cpu: os.cpus()[0]?.model?.trim() || '',
  };
}

/** 站点上下文：由 kind 归一（'trae'=CN / 'trae-intl'=国际），集中全部按站点分叉的常量。 */
function siteContext(kind) {
  return { intl: kind === 'trae-intl' };
}

/** 站点权威判定：LoginHost / 回调 host 反推（10R traeRegionFromHost 同款后缀表）。 */
function isIntlHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!h) return null;
  if (/(^|\.)trae\.cn$|(^|\.)trae\.com\.cn$|(^|\.)marscode\.cn$/.test(h)) return false;
  if (/(^|\.)trae\.ai$|(^|\.)marscode\.com$|(^|\.)traeapi\.us$/.test(h)) return true;
  return null;
}

/** 拼内层授权 URL（22 参数，顺序与真机客户端抓包逐字一致——不要按语义重排）。 */
export function buildAuthorizeUrl({ port, traceId, challenge, identity, intl = false }) {
  const system = osProfile();
  const callback = `http://127.0.0.1:${port}/authorize`;
  const enc = encodeURIComponent;
  const appVersion = intl ? APP_VERSION_INTL : APP_VERSION_CN;
  const consoleBase = intl ? CONSOLE_BASE_INTL : CONSOLE_BASE_CN;
  const inner = `${consoleBase}/authorization`
    + `?login_version=1`
    + `&auth_from=${AUTH_FROM}`
    + `&login_channel=native_ide`
    + `&plugin_version=${PLUGIN_VERSION}`
    + `&auth_type=local`
    + `&client_id=${CLIENT_ID}`
    + `&redirect=0`
    + `&login_trace_id=${traceId}`
    + `&auth_callback_url=${enc(callback)}`
    + `&machine_id=${identity.machineId}`
    + `&device_id=${identity.deviceId}`
    + `&x_device_id=${identity.deviceId}`
    + `&x_machine_id=${identity.machineId}`
    + `&x_device_brand=${enc(system.deviceModel)}`
    + `&x_device_type=${enc(process.platform)}`
    + `&x_os_version=${enc(system.osVersion)}`
    + `&x_env=`
    + `&x_app_version=${appVersion}`
    + `&x_app_type=${APP_TYPE}`
    + `&code_challenge=${challenge}`
    + `&code_challenge_method=S256`
    + `&channel_name=common`;
  // 外层包装与真机客户端一致（/login?login_platform=trae&redirect_url=<内层>）
  return `${consoleBase}/login?login_platform=trae&redirect_url=${enc(inner)}`;
}

/** 回调查询解析：先剥到 ? 后（req.url 带着路径前缀）、按 & 切 → 整体反复解码（浏览器/页面
 *  可能二次编码）→ 第一个 = 切键值。JWT / refresh_token 的值里合法含 =（base64url 填充），
 *  必须 split_once 而非按全部 = 切。 */
export function parseCallbackQuery(rawQuery) {
  const out = {};
  const raw = String(rawQuery || '');
  const qi = raw.indexOf('?');
  const qs = qi === -1 ? raw : raw.slice(qi + 1);
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    let decoded = pair;
    for (let i = 0; i < 3; i++) {
      const next = decoded.includes('%') ? decodeURIComponentSafe(decoded) : decoded;
      if (next === decoded) break;
      decoded = next;
    }
    const eq = decoded.indexOf('=');
    if (eq === -1) out[decoded] = '';
    else out[decoded.slice(0, eq)] = decoded.slice(eq + 1);
  }
  return out;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function jsonStringField(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function jsonIntField(obj, keys) {
  for (const k of keys) {
    const v = Number(obj?.[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** 解析回调参数 → {authCode, userInfo, host, region, intl, traceId, error}（muskke parseCallback 同款容错）。 */
export function parseCallbackParams(params) {
  const raw = params.authCodeInfo || params.auth_code_info || params.AuthCodeInfo || '';
  let authCode = jsonStringField(params, ['authCode', 'auth_code', 'AuthCode', 'authorization_code', 'code']);
  let codeExpireAt = 0;
  if (raw) {
    let info = null;
    try { info = JSON.parse(raw); } catch { /* 不是合法 JSON——按缺 AuthCode 走 */ }
    authCode = authCode || jsonStringField(info, ['AuthCode', 'authCode', 'auth_code', 'code']);
    codeExpireAt = jsonIntField(info, ['ExpireAt', 'expireAt', 'expiresAt']);
  }
  let user = null;
  try { user = params.userInfo ? JSON.parse(params.userInfo) : null; } catch {}
  const host = jsonStringField(params, ['host', 'apiHost', 'APIHost']);
  const region = (jsonStringField(params, ['userRegion', 'user_region', 'LoginRegion', 'loginRegion']) || '').toLowerCase();
  return {
    authCode,
    codeExpireAt,
    // 旧契约兜底：部分版本直接在回调里带 token（muskke 同款容错）
    directAccessToken: jsonStringField(params, ['accessToken', 'access_token', 'token']),
    directRefreshToken: jsonStringField(params, ['refreshToken', 'refresh_token', 'RefreshToken']),
    uid: user ? jsonStringField(user, ['UserID', 'userId', 'uid']) : null,
    name: user ? jsonStringField(user, ['ScreenName', 'screenName', 'nickname']) : null,
    host,
    region,
    // 站点权威判定：回调 host 反推（LoginHost 由 GetLoginGuidance 下发并跟 authorize 全程）
    intl: isIntlHost(host),
    traceId: jsonStringField(params, ['loginTraceID', 'loginTraceId', 'login_trace_id']),
    error: jsonStringField(params, ['error', 'error_description']),
  };
}

/** 换票主机白名单校验（hostname 级；按站点族放行，跨族一律回落本族 fallback——拦 SSRF
 *  也拦「国内回调拿去国际端点换票」这类站错队）。回环放行给联调 / 测试。 */
export function resolveExchangeHost(host, { intl = false } = {}) {
  const raw = String(host || '').trim().replace(/\/+$/, '');
  const name = raw.split('://').pop()?.split('/')[0]?.split(':')[0]?.toLowerCase() || '';
  const allow = intl ? EXCHANGE_HOST_ALLOW_INTL : EXCHANGE_HOST_ALLOW_CN;
  const fallback = intl ? EXCHANGE_HOST_FALLBACK_INTL : EXCHANGE_HOST_FALLBACK_CN;
  if (!name) return { host: fallback, usedFallback: 'missing' };
  if (LOOPBACK_HOSTS.includes(name)) return { host: raw, usedFallback: null };
  if (allow.includes(name)) return { host: raw.startsWith('http') ? raw : `https://${raw}`, usedFallback: null };
  return { host: fallback, usedFallback: 'rejected' };
}

function deviceInfoPayload(identity, appVersion) {
  const system = osProfile();
  return {
    DeviceID: identity.deviceId,
    MachineID: identity.machineId,
    PlatformCode: 'IDE_PC',
    DeviceType: 'PC',
    DeviceName: system.deviceName,
    DeviceModel: system.deviceModel,
    ClientVersion: appVersion,
    DevicePublicKey: identity.publicKeyPem,
    DeviceBrand: system.deviceBrand,
    DeviceCPU: system.cpu,
    OSInfo: system.osName,
    OSVersion: system.osVersion,
  };
}

/** 响应字段容错：v3 端点的真机契约是**嵌套 Result.***（10Router #99 换票对照实验：
 *  Result.Token / Result.RefreshToken / Result.RefreshExpireAt 毫秒）——HTTP 200 却按
 *  扁平字段读会解析成「无 token」，误判失败降级旧端点吃 10101（2026-11-11 用户实测：
 *  授权页成功、面板报 ExchangeToken/DeviceInfo: HTTP 200）。扁平形态保留兜底
 *  （更老的回调/端点形态，muskke TokenData 同款）。 */
function pickToken(body) {
  const nested = (body?.Result && typeof body.Result === 'object') ? body.Result
    : (body?.result && typeof body.result === 'object') ? body.result
    : (body?.data && typeof body.data === 'object') ? body.data
    : {};
  return {
    accessToken: jsonStringField(body, ['accessToken', 'access_token'])
      || jsonStringField(nested, ['AccessToken', 'Token', 'accessToken', 'token']),
    refreshToken: jsonStringField(body, ['refreshToken', 'refresh_token', 'RefreshToken'])
      || jsonStringField(nested, ['RefreshToken', 'refreshToken', 'refresh_token']),
    // RefreshExpireAt（毫秒）优先——v3 契约的 refresh 寿命字段；ExpiresAt 系兜底
    expiresAtMs: jsonIntField(nested, ['RefreshExpireAt', 'ExpiresAt', 'expiresAt', 'expire_at'])
      || jsonIntField(body, ['expiresAt', 'expires_at', 'ExpireAt', 'expireAt']),
    expiresInSec: jsonIntField(body, ['expiresIn', 'expires_in'])
      || jsonIntField(nested, ['ExpiresIn', 'expiresIn']),
  };
}

async function postJson(url, payload, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // 客户端原样带着的空 token 头（workbuddy 抓包：缺失会被上游当非客户端流量）
      'x-cloudide-token': '',
      'X-App-Id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
      'x-plugin-channel': 'icube-ai',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { res, body, text };
}

/** AuthCode 换 token：CN 真机验证的三段降级（新端点带 DeviceInfo → 旧端点扁平体 AuthCode/Code）；
 *  国际线保持 10R 实测的单段 v3（grow-normal 族未观察到需要降级，#99 全链验证）。 */
export async function exchangeAuthCode({ host, authCode, codeVerifier, identity, intl = false }) {
  const appVersion = intl ? APP_VERSION_INTL : APP_VERSION_CN;
  const attempts = intl
    ? [
      {
        tag: 'ExchangeToken/DeviceInfo',
        url: `${host}/trae/api/v3/oauth/ExchangeToken`,
        payload: {
          ClientID: CLIENT_ID,
          AuthCode: authCode,
          CodeVerifier: codeVerifier,
          DeviceInfo: deviceInfoPayload(identity, appVersion),
          IDEVersion: appVersion,
        },
      },
    ]
    : [
      {
        tag: 'ExchangeToken/DeviceInfo',
        url: `${host}/trae/api/v3/oauth/ExchangeToken`,
        payload: {
          ClientID: CLIENT_ID,
          AuthCode: authCode,
          CodeVerifier: codeVerifier,
          DeviceInfo: deviceInfoPayload(identity, appVersion),
          IDEVersion: appVersion,
        },
      },
      {
        tag: 'ExchangeToken/AuthCode',
        url: `${host}/cloudide/api/v3/trae/oauth/ExchangeToken`,
        payload: { ClientID: CLIENT_ID, AuthCode: authCode, CodeVerifier: codeVerifier, DeviceID: identity.deviceId, PlatformCode: 'IDE_PC' },
      },
      {
        tag: 'ExchangeToken/Code',
        url: `${host}/cloudide/api/v3/trae/oauth/ExchangeToken`,
        payload: { ClientID: CLIENT_ID, Code: authCode, CodeVerifier: codeVerifier, DeviceID: identity.deviceId, PlatformCode: 'IDE_PC' },
      },
    ];
  const errors = [];
  for (const a of attempts) {
    let r;
    try {
      r = await postJson(a.url, a.payload);
    } catch (e) {
      errors.push(`${a.tag}: ${e.cause?.code || e.message}`);
      continue;
    }
    const t = pickToken(r.body);
    if (r.res.ok && t.accessToken) return { ...t, via: a.tag };
    const msg = r.body?.message || r.body?.error || r.body?.msg || (r.text ? r.text.slice(0, 160) : '');
    errors.push(`${a.tag}: HTTP ${r.res.status}${msg ? ' ' + msg : ''}`);
  }
  throw new Error('Trae 换票失败：' + errors.join(' | '));
}

/** 回调监听：只绑 127.0.0.1；探测回 200+CORS，凭据回调进会话后立刻收摊。 */
function startCallbackServer(session) {
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const params = parseCallbackQuery(req.url || '');
    const hasCredential = ['authCodeInfo', 'code', 'AuthCode', 'accessToken', 'refreshToken', 'userJwt'].some((k) => params[k]);
    if (session.error || session.result) {
      // 已收摊的迟到请求（探测重复触发等）：只应答不处理
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (!hasCredential) {
      if (params.error) {
        // 拒绝回调也是真回调：必须先于「无凭据=探测」判定，否则用户白等到超时
        session.error = `授权被拒绝或失败（${params.error}）`;
        finish(session);
      }
      // 在线探测：200 + CORS，响应体不含任何凭据
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    session.result = params;
    finish(session);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Trae 登录</title>'
      + '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">'
      + '<div style="text-align:center"><div style="font-size:42px">✅</div>'
      + '<p>授权成功，回到 CreditDaddy 面板即可（此页可以关掉）。</p></div></body>');
  });
  return server;
}

function finish(session) {
  session.settledAt = Date.now();
  // 拿到终态立即释放端口；稍等一拍再 close，给响应体留出发送时间
  setTimeout(() => {
    try { session.server.close(); } catch {}
  }, 500).unref();
}

async function bindCallbackServer(session, ports) {
  const errors = [];
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        const server = session.server;
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (e) {
      errors.push(`${port}: ${e.code || e.message}`);
    }
  }
  throw new Error(`Trae 回调端口都被占用（${errors.join('；')}）——请关掉占用 3379/17388 的程序（可能是正在登录的 Trae 客户端）后重试`);
}

/** 发起一次浏览器授权登录。kind：'trae'（国内站）/ 'trae-intl'（国际站，10R #99 同协议）。
 *  授权 URL 直接用本站 console 域（与真机客户端一致——客户端不打 GetLoginGuidance 拿
 *  授权域，回调里的换票 host 由授权页下发，按站点白名单放行）。 */
export async function startTraeLogin(kind, { ports = CALLBACK_PORTS } = {}) {
  const site = siteContext(kind === 'trae-intl' ? 'trae-intl' : 'trae');
  gcSessions();
  const identity = newDeviceIdentity();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const traceId = crypto.randomUUID();
  const session = {
    identity, verifier, traceId,
    intl: site.intl,
    result: null, error: null, settledAt: 0,
    deadline: Date.now() + LOGIN_TIMEOUT_MS,
  };
  session.server = startCallbackServer(session);
  const port = await bindCallbackServer(session, ports);
  session.port = port;
  const loginId = crypto.randomUUID();
  sessions.set(loginId, session);
  const url = buildAuthorizeUrl({ port, traceId, challenge, identity, intl: site.intl });
  return {
    url,
    expiresInMs: LOGIN_TIMEOUT_MS,
    intervalMs: 1500,
    data: { loginId },
  };
}

/**
 * 轮询登录结果（authDevice 骨架约定）：
 *   {status:'pending'} | {status:'ok', input} ；终态失败抛错。
 * 成功后回调服务器与本地会话状态一并清理；authDevice 侧的 300s 会话过期自己兜底。
 */
export async function pollTraeLogin(data) {
  const session = sessions.get(data?.loginId);
  if (!session) throw new Error('Trae 登录会话不存在或已超时，请重新发起');
  if (session.error) {
    sessions.delete(data.loginId);
    throw new Error(session.error);
  }
  if (!session.result) {
    if (Date.now() > session.deadline) {
      sessions.delete(data.loginId);
      try { session.server.close(); } catch {}
      throw new Error('Trae 授权超时（5 分钟未完成），请重新发起');
    }
    return { status: 'pending' };
  }

  const params = session.result;
  sessions.delete(data.loginId);
  const info = parseCallbackParams(params);
  if (info.error) throw new Error(`授权被拒绝：${info.error}`);
  if (info.traceId && info.traceId !== session.traceId) {
    throw new Error('回调 loginTraceID 与本次登录不匹配（CSRF 防护），请重新发起');
  }
  if (info.codeExpireAt) {
    const expMs = info.codeExpireAt < 1e12 ? info.codeExpireAt * 1000 : info.codeExpireAt;
    if (expMs <= Date.now()) throw new Error('回调里的 AuthCode 已过期，请重新发起');
  }

  // 旧契约直接带 token 的版本：跳过换票
  if (info.directAccessToken && !info.authCode) {
    const intlDirect = info.intl !== null ? info.intl : Boolean(session.intl);
    return buildLoginResult({
      accessToken: info.directAccessToken,
      refreshToken: info.directRefreshToken,
      identity: session.identity,
      host: info.host,
      region: info.region,
      intl: intlDirect,
      uid: info.uid,
      name: info.name,
      expiresAtMs: 0,
    });
  }
  if (!info.authCode) throw new Error('回调里没有 AuthCode（授权页协议可能又变了），请重新发起或更新 CreditDaddy');

  // 站点裁决：回调 host 反推 → 缺失/判不出时用本次登录的发起站点（startTraeLogin 定）
  const intl = info.intl !== null ? info.intl : Boolean(session.intl);
  const resolved = resolveExchangeHost(info.host, { intl });
  const t = await exchangeAuthCode({ host: resolved.host, authCode: info.authCode, codeVerifier: session.verifier, identity: session.identity, intl });
  return buildLoginResult({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    identity: session.identity,
    host: info.host || resolved.host,
    region: info.region,
    intl,
    uid: info.uid,
    name: info.name,
    expiresAtMs: t.expiresAtMs,
    expiresInSec: t.expiresInSec,
    exchangeFallback: resolved.usedFallback,
  });
}

function uidFromJwt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return { uid: payload?.data?.id ? String(payload.data.id) : null, exp: Number(payload?.exp) || 0 };
  } catch { return { uid: null, exp: 0 }; }
}

function buildLoginResult({ accessToken, refreshToken, identity, host, region, intl = false, uid, name, expiresAtMs, expiresInSec = 0, exchangeFallback }) {
  const jwt = uidFromJwt(accessToken);
  const finalUid = uid || jwt.uid || null;
  let expiresAt = null;
  if (expiresAtMs) expiresAt = new Date(expiresAtMs < 1e12 ? expiresAtMs * 1000 : expiresAtMs).toISOString();
  else if (expiresInSec) expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  else if (jwt.exp) expiresAt = new Date(jwt.exp * 1000).toISOString();

  const device = {
    deviceId: identity.deviceId,
    machineId: identity.machineId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyJwk: identity.privateKeyJwk,
  };
  return {
    status: 'ok',
    input: {
      provider: 'trae',
      token: accessToken,
      refreshToken: refreshToken || null,
      expiresAt,
      uid: finalUid,
      name: name || (finalUid ? `Trae_${String(finalUid).slice(-6)}` : null),
      email: null,
      source: 'browser',
      meta: {
        loginVia: 'oauth-authcode',
        traeDevice: device,
        traeHost: host || null,
        traeRegion: region || null,
        // 国际账号标记（切客户端选 exe / 10R 推送护栏 / 签到额度跳过口径都读它）
        ...(intl ? { isIntl: true } : {}),
        traeExchangeFallback: exchangeFallback || undefined,
        clientVersion: intl ? APP_VERSION_INTL : APP_VERSION_CN,
        pluginVersion: PLUGIN_VERSION,
        capturedAt: new Date().toISOString(),
      },
    },
  };
}

/** 测试辅助：清空进程内会话（含关闭监听与 keep-alive 连接）。 */
export function _resetForTests() {
  for (const [, s] of sessions) {
    try { s.server.closeAllConnections?.(); } catch {}
    try { s.server.close(); } catch {}
  }
  sessions.clear();
}
