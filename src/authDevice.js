/**
 * Qoder 设备码登录 — 移植自 10router src/lib/oauth/services/qoder.js。
 *
 * 流程：
 *   1. 本地生成 PKCE 对 (verifier/challenge-S256) + nonce + machine_id
 *   2. 打开 verificationUriComplete（qoder.com/device/selectAccounts?challenge=...）
 *      用户在浏览器里选择账号授权
 *   3. 面板每 2s 调 /api/auth/device/poll，服务端带 nonce+verifier 轮询
 *      openapi.qoder.sh/api/v1/deviceToken/poll，202/404=等待，200=拿到 dt- token
 *
 * token 约 30 天有效；上游 refresh 对该流程 403，过期后重新走一遍登录即可。
 */

import crypto from 'node:crypto';
import {
  OPENAPI_BASE, CN_OPENAPI_BASE,
  LOGIN_URL, CN_LOGIN_URL,
  USERINFO_PATH,
  buildQoderHeaders,
} from './constants.js';
import { normalizeAccountInput, findDuplicate, loadAccounts, saveAccounts, publicAccount } from './store.js';
import { logger } from './logger.js';

const FETCH_TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 5 * 60 * 1000;   // 授权链接 5 分钟有效
const POLL_INTERVAL_MS = 2000;

// 内存会话表（不落盘：授权是短时动作，重启重来即可）
const sessions = new Map();

function base64Url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function endpointsFor(provider) {
  const cn = provider === 'qoder-cn';
  return {
    deviceTokenUrl: (cn ? CN_OPENAPI_BASE : OPENAPI_BASE) + '/api/v1/deviceToken/poll',
    loginUrl: cn ? CN_LOGIN_URL : LOGIN_URL,
    userInfoUrl: (cn ? CN_OPENAPI_BASE : OPENAPI_BASE) + USERINFO_PATH,
  };
}

/** 创建一次登录会话，返回浏览器授权地址 */
export function startDeviceFlow(provider) {
  const ep = endpointsFor(provider);
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();

  const params = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    machine_id: machineId,
    nonce,
  });

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    provider, nonce, verifier, machineId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    done: false,
  });
  logger.info('DEVICE', '发起设备码登录（' + (provider === 'qoder-cn' ? '国内版' : '国际版') + '）');

  return {
    sessionId,
    url: ep.loginUrl + '?' + params.toString(),
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
    interval: Math.floor(POLL_INTERVAL_MS / 1000),
  };
}

function gcSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expiresAt < now || s.done) sessions.delete(k);
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

/** 上游单次轮询：pending / ok(token) / throw */
async function pollUpstream(session) {
  const ep = endpointsFor(session.provider);
  const url = ep.deviceTokenUrl +
    '?nonce=' + encodeURIComponent(session.nonce) +
    '&verifier=' + encodeURIComponent(session.verifier) +
    '&challenge_method=S256';

  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' },
  });

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

  return { status: 'ok', token: body.token, userId: body.user_id || '' };
}

/** 用户资料（best-effort，失败不阻断登录） */
async function fetchProfile(provider, accessToken) {
  const ep = endpointsFor(provider);
  try {
    const res = await fetchWithTimeout(ep.userInfoUrl, {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' },
    });
    if (!res.ok) return { name: null, email: null };
    const b = await res.json();
    return { name: (b.name || b.username || '').trim() || null, email: (b.email || '').trim() || null };
  } catch { return { name: null, email: null }; }
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

  let result;
  try {
    result = await pollUpstream(session);
  } catch (err) {
    sessions.delete(sessionId);
    return { status: 'failed', error: err.message };
  }
  if (result.status === 'pending') return { status: 'pending' };

  // 拿到 token → 拉资料 → 入库
  const profile = await fetchProfile(session.provider, result.token);
  let account;
  try {
    account = normalizeAccountInput({
      provider: session.provider,
      token: result.token,
      name: profile.name || profile.email || null,
    });
  } catch (e) {
    return { status: 'failed', error: e.message };
  }

  const accounts = await loadAccounts();
  const dup = findDuplicate(accounts, account.provider, account.token);
  if (dup) {
    session.done = true;
    logger.info('DEVICE', '授权成功：账号已存在（' + (dup.name || dup.id) + '）');
    return { status: 'ok', account: publicAccount(dup), already: true };
  }

  account.verified = true;
  if (!account.name && profile.email) account.name = profile.email;
  accounts.push(account);
  await saveAccounts(accounts);
  session.done = true;
  logger.info('DEVICE', '授权登录成功：' + (account.name || account.id));
  return { status: 'ok', account: publicAccount(account), already: false };
}
