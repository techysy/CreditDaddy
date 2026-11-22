/**
 * 浏览器登录（统一入口）：面板发起 → 浏览器 / 隐私窗口里授权 → 面板轮询 → 自动入库。
 *
 *   qoder / qoder-cn            Qoder 设备码登录（PKCE + nonce，与官方 qodercli 同流程，移植自 10router）
 *   workbuddy / workbuddy-intl  WorkBuddy / CodeBuddy 登录（state 轮询，见 workbuddyAuth.js）
 *   zcode-bigmodel / zcode-zai  ZCode 登录（客户端 CLI 轮询流程，见 zcodeAuth.js）
 *   minimax                     MiniMax Code 登录（OAuth 设备码 + S256 PKCE，见 minimaxAuth.js）
 *   trae                        Trae 登录（官方同款授权码 + PKCE + 本机回调监听，见 traeAuth.js）
 *
 * Qoder 流程：
 *   1. 本地生成 PKCE 对 (verifier/challenge-S256) + nonce + machine_id
 *   2. 打开 verificationUriComplete（qoder.com/device/selectAccounts?challenge=...）选择账号授权
 *   3. 带 nonce+verifier 轮询 openapi.qoder.sh/api/v1/deviceToken/poll，202/404=等待，200=拿到 dt- token
 *   token 约 30 天有效；上游 refresh 对该流程 403，过期后重新走一遍登录即可。
 *
 * 会话只存在内存里（授权是短时动作，重启重来即可）；面板每 2s 轮询一次，
 * 各流程按自己的上游间隔节流，未到时间直接回 pending。
 */

import crypto from 'node:crypto';
import {
  OPENAPI_BASE, CN_OPENAPI_BASE,
  LOGIN_URL, CN_LOGIN_URL,
  USERINFO_PATH, PROVIDER_LABEL,
  QWENWORK_GATEWAY_BASE, QWENWORK_CLIENT_ID, QWENWORK_REDIRECT_URI,
  CN_QWENWORK_GATEWAY_BASE, CN_QWENWORK_CLIENT_ID, CN_QWENWORK_REDIRECT_URI,
  QWENWORK_DEVICE_TOKEN_POLL_PATH,
} from './constants.js';
import { publicAccount, normalizeExpiry } from './store.js';
import { addAccount } from './accounts.js';
import { logger } from './logger.js';
import { t } from './i18n.js';
import { startWorkbuddyLogin, pollWorkbuddyLogin } from './workbuddyAuth.js';
import { startZcodeLogin, pollZcodeLogin } from './zcodeAuth.js';
import { startMiniMaxLogin, pollMiniMaxLogin } from './minimaxAuth.js';
import { startTraeLogin, pollTraeLogin } from './traeAuth.js';
import { startCroliLogin, pollCroliLogin } from './croliAuth.js';
import { buildAuthSnapshot } from './qwenworkApp.js';
import { fetchUserinfo as fetchQwenworkProfile } from './qwenworkClient.js';

const FETCH_TIMEOUT_MS = 15000;
const QODER_TTL_MS = 5 * 60 * 1000;   // Qoder 授权链接 5 分钟有效
const QODER_POLL_MS = 2000;

const sessions = new Map();

function base64Url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Qoder ──
export function endpointsFor(provider) {
  const cn = provider === 'qoder-cn';
  return {
    deviceTokenUrl: (cn ? CN_OPENAPI_BASE : OPENAPI_BASE) + '/api/v1/deviceToken/poll',
    loginUrl: cn ? CN_LOGIN_URL : LOGIN_URL,
    userInfoUrl: (cn ? CN_OPENAPI_BASE : OPENAPI_BASE) + USERINFO_PATH,
  };
}

function startQoderLogin(provider) {
  const ep = endpointsFor(provider);
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({ challenge, challenge_method: 'S256', machine_id: crypto.randomUUID(), nonce });
  return {
    url: ep.loginUrl + '?' + params.toString(),
    expiresInMs: QODER_TTL_MS,
    intervalMs: QODER_POLL_MS,
    data: { provider, nonce, verifier },
  };
}

/** 用户资料（best-effort，失败不阻断登录） */
async function fetchQoderProfile(provider, accessToken) {
  try {
    const res = await fetchWithTimeout(endpointsFor(provider).userInfoUrl, {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' },
    });
    if (!res.ok) return { name: null, email: null };
    const b = await res.json();
    return { name: (b.name || b.username || '').trim() || null, email: (b.email || '').trim() || null };
  } catch { return { name: null, email: null }; }
}

async function pollQoderLogin(data) {
  const url = endpointsFor(data.provider).deviceTokenUrl
    + '?nonce=' + encodeURIComponent(data.nonce)
    + '&verifier=' + encodeURIComponent(data.verifier)
    + '&challenge_method=S256';
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' } });
  if (res.status === 202 || res.status === 404) return { status: 'pending' };

  const text = await res.text();
  if (!res.ok) {
    let msg = '轮询失败 HTTP ' + res.status;
    try { const b = JSON.parse(text); if (b.message) msg += '：' + b.message; } catch {}
    throw new Error(msg);
  }
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error('轮询返回非 JSON：' + e.message); }
  if (!body.token) throw new Error('轮询返回 200 但没有 token（上游结构可能变化）');

  const profile = await fetchQoderProfile(data.provider, body.token);
  return {
    status: 'ok',
    input: {
      provider: data.provider,
      token: body.token,
      name: profile.name || profile.email || null,
      email: profile.email,
      uid: body.user_id || null,
      refreshToken: body.refresh_token || body.refreshToken || null,
      expiresAt: body.expires_at || (body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null),
      source: 'device',
    },
  };
}

// ── 千问办公：Qoder 同款设备码流，差异两处（10router 已全链验证 + 本机真机日志一致）──
//   1. 授权 URL 要带 client_id + redirect_uri（Qoder 的落地页自带 client，千问的网关页是双版共用的）
//   2. poll 200 但没 token = "已登记还在等用户授权"，算 pending 不算错
function qwenworkEndpoints(provider) {
  const cn = provider === 'qwenwork-cn';
  return {
    gateway: cn ? CN_QWENWORK_GATEWAY_BASE : QWENWORK_GATEWAY_BASE,
    clientId: cn ? CN_QWENWORK_CLIENT_ID : QWENWORK_CLIENT_ID,
    redirectUri: cn ? CN_QWENWORK_REDIRECT_URI : QWENWORK_REDIRECT_URI,
  };
}

function startQwenworkLogin(provider) {
  const ep = qwenworkEndpoints(provider);
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge, challenge_method: 'S256', machine_id: machineId, nonce,
    client_id: ep.clientId, redirect_uri: ep.redirectUri,
  });
  return {
    url: `${ep.gateway}/device/selectAccounts?${params.toString()}`,
    expiresInMs: QODER_TTL_MS,
    intervalMs: QODER_POLL_MS,
    data: { provider, nonce, verifier, machineId },
  };
}

async function pollQwenworkLogin(data) {
  const ep = qwenworkEndpoints(data.provider);
  const url = `${ep.gateway}${QWENWORK_DEVICE_TOKEN_POLL_PATH}`
    + '?nonce=' + encodeURIComponent(data.nonce)
    + '&verifier=' + encodeURIComponent(data.verifier)
    + '&challenge_method=S256';
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' } });
  if (res.status === 202 || res.status === 404) return { status: 'pending' };

  const text = await res.text();
  if (!res.ok) {
    let msg = '轮询失败 HTTP ' + res.status;
    try { const b = JSON.parse(text); if (b.errorMessage || b.message) msg += '：' + (b.errorMessage || b.message); } catch {}
    throw new Error(msg);
  }
  // 200 空 body / 非 JSON / 没 token：网关说「已登记，等用户在浏览器里完成授权」
  //（线上网关实测会出现 200 空 body，10R 同款口径）——一律视为 pending，不中止轮询
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (!body?.token) return { status: 'pending' };

  const profile = await fetchQwenworkProfile({ provider: data.provider, token: body.token }).catch(() => null);
  // expires_at 可能是毫秒数字（Qoder 同源协议）：归一化成 ISO——原样进 auth-v2 快照
  // 会被 isValidAuthSnapshot 的 Date.parse 判 NaN，账号永远切不进客户端
  const expiresAt = normalizeExpiry(body.expires_at)
    || (body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString() : null);
  return {
    status: 'ok',
    input: {
      provider: data.provider,
      token: body.token,
      name: (profile?.name || profile?.email) || null,
      email: profile?.email || null,
      uid: body.user_id || profile?.id || null,
      refreshToken: body.refresh_token || body.refreshToken || null,
      expiresAt,
      source: 'device',
      meta: {
        // 登录即带完整 auth-v2 快照：账号立刻可切换进客户端（不用再本机导入）
        qwenworkAuth: buildAuthSnapshot(data.provider, {
          token: body.token,
          refreshToken: body.refresh_token || body.refreshToken,
          expiresAt,
          refreshTokenExpiresAt: normalizeExpiry(body.refresh_token_expires_at),
          user: profile ? { id: profile.id, name: profile.name, email: profile.email, username: profile.username } : null,
          loginDeviceId: data.machineId,
        }),
      },
    },
  };
}

// ── 统一入口 ──
const FLOWS = {
  qoder: { start: startQoderLogin, poll: pollQoderLogin },
  'qoder-cn': { start: startQoderLogin, poll: pollQoderLogin },
  qwenwork: { start: startQwenworkLogin, poll: pollQwenworkLogin },
  'qwenwork-cn': { start: startQwenworkLogin, poll: pollQwenworkLogin },
  workbuddy: { start: startWorkbuddyLogin, poll: pollWorkbuddyLogin },
  'workbuddy-intl': { start: startWorkbuddyLogin, poll: pollWorkbuddyLogin },
  'zcode-bigmodel': { start: startZcodeLogin, poll: pollZcodeLogin },
  'zcode-zai': { start: startZcodeLogin, poll: pollZcodeLogin },
  minimax: { start: startMiniMaxLogin, poll: pollMiniMaxLogin },
  'minimax-global': { start: (kind) => startMiniMaxLogin('global'), poll: pollMiniMaxLogin },
  // Trae：授权码 + PKCE 的本地回调流（与设备码轮询不同，poll 查的是本机回调监听抓没抓到）；
  // trae-intl 走国际站（www.trae.ai，同协议同 client_id，#99 10R 侧全链验证）
  trae: { start: startTraeLogin, poll: pollTraeLogin },
  'trae-intl': { start: startTraeLogin, poll: pollTraeLogin },
  // Croli：授权码 + PKCE 的本地回调流（协议同桌面端 croli-server，clerk.croli.net，
  // redirect_uri=/callback loopback 通配；凭据 = Clerk JWT + refresh 轮换）
  croli: { start: startCroliLogin, poll: pollCroliLogin },
};
export const LOGIN_KINDS = Object.keys(FLOWS);
const KIND_LABEL = { 'zcode-bigmodel': 'ZCode（BigModel）', 'zcode-zai': 'ZCode（Z.ai）' };
const labelOf = (kind) => KIND_LABEL[kind] || PROVIDER_LABEL[kind] || kind;

function gcSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expiresAt < now || s.done) sessions.delete(k);
}

/** 创建一次登录会话，返回浏览器授权地址 */
export async function startDeviceFlow(kind) {
  const flow = FLOWS[kind];
  if (!flow) throw new Error('不支持的登录类型：' + kind);
  gcSessions();
  const r = await flow.start(kind);
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    kind, data: r.data,
    expiresAt: Date.now() + r.expiresInMs,
    intervalMs: r.intervalMs, nextPollAt: 0,
    done: false, busy: false,
  });
    logger.info('DEVICE', '发起浏览器登录({kind})', { kind: labelOf(kind) });
  return {
    sessionId,
    url: r.url,
    expiresIn: Math.floor(r.expiresInMs / 1000),
    interval: Math.max(1, Math.floor(r.intervalMs / 1000)),
  };
}

/**
 * 面板侧轮询入口。返回：
 *   { status: 'pending' }                                  继续等
 *   { status: 'ok', account, already }                     成功（already=账号已存在）
 *   { status: 'expired' }                                  会话过期，重新发起
 *   { status: 'failed', error }                            终态失败
 */
export async function pollDeviceFlow(sessionId) {
  gcSessions();
  const session = sessions.get(sessionId);
  if (!session) return { status: 'expired' };
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return { status: 'expired' };
  }
  // 节流：未到上游轮询间隔、或上一轮还在进行，直接回 pending
  if (session.busy || Date.now() < session.nextPollAt) return { status: 'pending' };
  session.busy = true;
  session.nextPollAt = Date.now() + session.intervalMs;

  let result;
  try {
    result = await FLOWS[session.kind].poll(session.data);
  } catch (err) {
    sessions.delete(sessionId);
        logger.warn('DEVICE', '{kind} 登录失败:{err}', { kind: labelOf(session.kind), err: err.message });
    return { status: 'failed', error: err.message };
  } finally {
    session.busy = false;
  }
  if (result.status === 'pending') return { status: 'pending' };

  let added;
  try {
    added = await addAccount(result.input, { trusted: true });
  } catch (e) {
    sessions.delete(sessionId);
    return { status: 'failed', error: e.message };
  }
  session.done = true;
  const { account, duplicate } = added;
  logger.info('DEVICE', duplicate
    ? t('{kind} 登录成功:账号已存在,已更新凭据({name})', { kind: labelOf(session.kind), name: account.name || account.id })
    : t('{kind} 登录成功:{name}', { kind: labelOf(session.kind), name: account.name || account.id }));
  return { status: 'ok', account: publicAccount(account), already: duplicate };
}
