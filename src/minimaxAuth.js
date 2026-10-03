/**
 * MiniMax Code 浏览器登录 — 官方 OAuth 设备码授权（RFC 8628 + S256 PKCE），
 * 与客户端「扫码登录」同一协议，任何浏览器 / 桌面版隐私窗口都能完成，无需 zcode:// 式本地回调。
 *
 *   1. POST https://account.minimax.cn/oauth2/device/code
 *      {client_id:mcode-public, scope:agent.default, audience:agent-backend,
 *       code_challenge:<S256>, code_challenge_method:S256}
 *      → {device_code, user_code, verification_uri_complete, expires_in:300, interval:3}
 *   2. 用户在浏览器打开 verification_uri_complete（account.minimax.cn/oauth-authorize?user_code=…）登录授权
 *   3. POST https://account.minimax.cn/oauth2/token
 *      {grant_type:urn:ietf:params:oauth:grant-type:device_code, device_code, client_id, code_verifier}
 *      → 未授权时 400 authorization_pending / slow_down（继续等）；授权后 200
 *        {access_token, refresh_token, expires_in, …}
 *
 * 与「本机导入」的关键区别：设备码登录拿到的是**独立 loginEpoch** 的一条新 refresh token 链，
 * 不与本机 ~/.minimax 客户端共用凭据，因此 CreditDaddy 自行刷新不会作废客户端的 token（消除轮换互斥）。
 * 故本流程**绝不回写** auth.json，device 账号自持凭据链。
 */

import crypto from 'node:crypto';
import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { MINIMAX_ACCOUNT_BASE, fetchMiniMaxProfile } from './minimaxClient.js';

const DEVICE_CODE_URL = `${MINIMAX_ACCOUNT_BASE}/oauth2/device/code`;
const TOKEN_URL = `${MINIMAX_ACCOUNT_BASE}/oauth2/token`;
const CLIENT_ID = 'mcode-public';
const SCOPE = 'agent.default';
const AUDIENCE = 'agent-backend';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function base64Url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function postForm(url, fields) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await fetchJsonRace(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { res, body, text };
}

/** 发起设备码授权，返回浏览器授权地址与轮询参数 */
export async function startMiniMaxLogin() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const { res, body, text } = await postForm(DEVICE_CODE_URL, {
    client_id: CLIENT_ID, scope: SCOPE, audience: AUDIENCE,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  if (!res.ok || !body?.device_code || !body?.verification_uri_complete) {
    throw new Error('MiniMax 设备码初始化失败：HTTP ' + res.status + (text ? ' ' + text.slice(0, 200) : ''));
  }
  const url = String(body.verification_uri_complete);
  if (!url.startsWith('https://')) throw new Error('MiniMax 授权返回了非 https 地址');
  return {
    url,
    expiresInMs: Math.max(60e3, (Number(body.expires_in) || 300) * 1000),
    intervalMs: Math.max(2000, (Number(body.interval) || 3) * 1000),
    data: { deviceCode: body.device_code, verifier, userCode: body.user_code || null },
  };
}

/**
 * 单次轮询：{status:'pending'} | {status:'ok', input}
 * authorization_pending / slow_down 视为继续等待；其余错误抛出（终态失败）。
 */
export async function pollMiniMaxLogin(data) {
  const { res, body, text } = await postForm(TOKEN_URL, {
    grant_type: DEVICE_GRANT,
    device_code: data.deviceCode,
    client_id: CLIENT_ID,
    code_verifier: data.verifier,
  });

  const errCode = body?.error;
  if (res.status === 400 && (errCode === 'authorization_pending' || errCode === 'slow_down')) {
    return { status: 'pending' };
  }
  if (errCode === 'expired_token') throw new Error('MiniMax 授权已超时，请重新发起');
  if (errCode === 'access_denied') throw new Error('MiniMax 授权被拒绝');
  if (!res.ok || !body?.access_token) {
    throw new Error('MiniMax 授权失败：HTTP ' + res.status + (errCode ? ' ' + errCode : '') + (text ? ' ' + text.slice(0, 200) : ''));
  }

  const accessToken = String(body.access_token);
  const refreshToken = body.refresh_token ? String(body.refresh_token) : null;
  const expiresIn = Number(body.expires_in) || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // best-effort 取资料补全 uid / 昵称 / 邮箱；失败不阻断（uid 为空则按 token 去重）
  let profile = null;
  try { profile = await fetchMiniMaxProfile(accessToken); } catch {}

  const uid = profile?.userId || null;
  const name = profile?.name || (uid ? `MiniMax_${String(uid).slice(-6)}` : null);

  return {
    status: 'ok',
    input: {
      provider: 'minimax',
      token: accessToken,
      refreshToken,
      expiresAt,
      uid: uid ? String(uid) : null,
      name: name || profile?.email || null,
      email: profile?.email || null,
      source: 'browser',
      meta: {
        clientId: CLIENT_ID,
        scopes: [SCOPE],
        audience: AUDIENCE,
        loginVia: 'device-code',
        userCode: data.userCode || null,
        capturedAt: new Date().toISOString(),
      },
    },
  };
}
