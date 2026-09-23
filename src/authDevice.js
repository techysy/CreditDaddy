/**
 * 浏览器登录（统一入口）：面板发起 → 浏览器 / 隐私窗口里授权 → 面板轮询 → 自动入库。
 *
 *   qoder / qoder-cn            Qoder 设备码登录（PKCE + nonce，与官方 qodercli 同流程，移植自 10router）
 *   workbuddy / workbuddy-intl  WorkBuddy / CodeBuddy 登录（state 轮询，见 workbuddyAuth.js）
 *   zcode-bigmodel / zcode-zai  ZCode 登录（客户端 CLI 轮询流程，见 zcodeAuth.js）
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
} from './constants.js';
import { publicAccount } from './store.js';
import { addAccount } from './accounts.js';
import { logger } from './logger.js';
import { startWorkbuddyLogin, pollWorkbuddyLogin } from './workbuddyAuth.js';
import { startZcodeLogin, pollZcodeLogin } from './zcodeAuth.js';

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

// ── 统一入口 ──
const FLOWS = {
  qoder: { start: startQoderLogin, poll: pollQoderLogin },
  'qoder-cn': { start: startQoderLogin, poll: pollQoderLogin },
  workbuddy: { start: startWorkbuddyLogin, poll: pollWorkbuddyLogin },
  'workbuddy-intl': { start: startWorkbuddyLogin, poll: pollWorkbuddyLogin },
  'zcode-bigmodel': { start: startZcodeLogin, poll: pollZcodeLogin },
  'zcode-zai': { start: startZcodeLogin, poll: pollZcodeLogin },
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
  logger.info('DEVICE', '发起浏览器登录（' + labelOf(kind) + '）');
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
    logger.warn('DEVICE', labelOf(session.kind) + ' 登录失败：' + err.message);
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
    ? labelOf(session.kind) + ' 登录成功：账号已存在，已更新凭据（' + (account.name || account.id) + '）'
    : labelOf(session.kind) + ' 登录成功：' + (account.name || account.id));
  return { status: 'ok', account: publicAccount(account), already: duplicate };
}
