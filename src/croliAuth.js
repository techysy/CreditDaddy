/**
 * Croli OAuth PKCE 回环登录——协议 1:1 对齐桌面端 croli-server.exe（Rust
 * desktop_auth.rs，2026-11-20 二进制考古 + authorize 端点实测）：
 *   client_id   znV4SkcUsY1AektQ（Clerk OAuth application，no secret）
 *   issuer      https://clerk.croli.net
 *   authorize   {issuer}/oauth/authorize（302 → /oauth/authorize/continue，参数透传；
 *               redirect_uri = http://127.0.0.1:<随机端口>/callback，loopback 通配放行）
 *   token       {issuer}/oauth/token（form-urlencoded；code 换票带 code_verifier，
 *               刷新 grant_type=refresh_token + client_id——均无 client secret）
 *   scope       profile email offline_access（offline_access 才发 refresh_token）
 *   userinfo    {issuer}/oauth/userinfo（sidecar 登录后校验用，CD 侧可选）
 *
 * JWT 契约：iss=clerk.croli.net，sub=user_…，24h 短命 + refresh 轮换。
 * 与 meooAuth 同款骨架：回环服务器收 code → token 换票 → 读身份 → 落账号。
 * token 响应契约比 meoo 宽（Clerk 字段集不同）：access_token/refresh_token/
 * token_type=Bearer/expires_in 四项缺一即拒。
 *
 * 凭据只在本机会话内流转，日志不落 token。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { verifyCroliAccount } from './croliClient.js';

export const CROLI_CLERK_ISSUER = 'https://clerk.croli.net';
export const CROLI_CLIENT_ID = 'znV4SkcUsY1AektQ';
export const CROLI_OAUTH_AUTHORIZE_URL = `${CROLI_CLERK_ISSUER}/oauth/authorize`;
export const CROLI_OAUTH_TOKEN_URL = `${CROLI_CLERK_ISSUER}/oauth/token`;
export const CROLI_OAUTH_SCOPE = 'profile email offline_access';
const CALLBACK_PATH = '/callback';

const LOGIN_TIMEOUT_MS = 5 * 60_000;

const sessions = new Map();

function gcSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expiresAt < now || s.done) sessions.delete(k);
}

const securityHeaders = (type) => ({
  'Content-Type': `${type || 'text/plain'}; charset=utf-8`,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

// 回调页：Croli 官方成功页口径（「登录成功 / 桌面会话已就绪，现在可以回到 Croli」）
const ICON_OK = '<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="34" fill="#22c55e"/><path d="M22 37.5 31.5 47 50 27" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARN = '<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="34" fill="#f59e0b"/><path d="M36 20v22" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="36" cy="50" r="3.5" fill="#fff"/></svg>';
const callbackHtml = (title, body, ok) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
  + '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif">'
  + '<div style="text-align:center;padding:36px 44px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06)">'
  + (ok ? ICON_OK : ICON_WARN)
  + `<p style="margin:18px 0 6px;font-size:17px;font-weight:600;color:#111827">${title}</p>`
  + `<p style="margin:0;font-size:14px;color:#6b7280">${body}</p></div></body>`;

/** 回调监听：只绑 127.0.0.1 随机端口（sidecar 同款 loopback 通配） */
function startCallbackServer(session) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, securityHeaders('text/plain'));
      res.end('Not Found');
      return;
    }
    if (session.error || session.result) {
      res.writeHead(200, securityHeaders('text/plain'));
      res.end('ok');
      return;
    }
    const callbackState = url.searchParams.get('state') || '';
    if (!callbackState || callbackState !== session.state) {
      res.writeHead(400, securityHeaders('text/html'));
      res.end(callbackHtml('授权请求校验失败', '请回到 CreditDaddy 重新发起登录。', false));
      return;
    }
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      session.error = `授权被拒绝或失败（${url.searchParams.get('error_description') || oauthError}）`;
      finish(session);
      res.writeHead(400, securityHeaders('text/html'));
      res.end(callbackHtml('未完成授权', '你可以关闭此页面。', false));
      return;
    }
    const code = url.searchParams.get('code') || '';
    if (!code) {
      res.writeHead(400, securityHeaders('text/html'));
      res.end(callbackHtml('授权回调无效', '未收到授权码，请回到 CreditDaddy 重试。', false));
      return;
    }
    session.result = { code };
    finish(session);
    res.writeHead(200, securityHeaders('text/html'));
    res.end(callbackHtml('授权成功', '桌面会话已就绪，现在可以回到 CreditDaddy。', true));
  });
  return server;
}

function finish(session) {
  session.settledAt = Date.now();
  setTimeout(() => { try { session.server.close(); } catch {} }, 500).unref();
}

/** 随机回环端口（sidecar bindLoopback 同款 listen(0)） */
async function bindLoopback(server) {
  await new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(0, '127.0.0.1');
  });
  return server.address().port;
}

/** 发起一次 OAuth PKCE 授权登录 */
export async function startCroliLogin(_kind) {
  gcSessions();
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const session = { verifier, state, result: null, error: null, settledAt: 0, deadline: Date.now() + LOGIN_TIMEOUT_MS };
  session.server = startCallbackServer(session);
  const port = await bindLoopback(session.server);
  session.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const loginId = crypto.randomUUID();
  sessions.set(loginId, session);
  const url = CROLI_OAUTH_AUTHORIZE_URL + '?' + new URLSearchParams({
    response_type: 'code',
    client_id: CROLI_CLIENT_ID,
    redirect_uri: session.redirectUri,
    scope: CROLI_OAUTH_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url, expiresInMs: LOGIN_TIMEOUT_MS, intervalMs: 1500, data: { loginId } };
}

/** token 响应契约校验（Clerk 字段集：四项缺一即拒） */
function validateTokenResponse(result) {
  if (typeof result?.access_token !== 'string'
    || typeof result?.refresh_token !== 'string'
    || result?.token_type !== 'Bearer'
    || !Number.isFinite(Number(result?.expires_in))
    || Number(result.expires_in) <= 0) {
    const err = new Error('Croli OAuth Token 响应格式无效');
    err.oauth = true;
    throw err;
  }
}

/** OAuth 换票 / 刷新（form-urlencoded，无 secret——sidecar 同款） */
export async function croliTokenRequest(parameters, { fetchImpl } = {}) {
  let res;
  try {
    res = await (fetchImpl || fetchJsonRace)(CROLI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(parameters).toString(),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (e) {
    throw new Error(`Croli OAuth 请求失败：${e?.cause?.code || e.message}`);
  }
  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Croli OAuth 失败：${result.error_description || result.error || `HTTP ${res.status}`}`);
  }
  validateTokenResponse(result);
  return result;
}

/** 刷新令牌（凭据续期共用；Clerk refresh 是轮换制——响应里的新 rt 替换旧值） */
export async function refreshCroliToken(refreshToken, { fetchImpl } = {}) {
  return croliTokenRequest({
    grant_type: 'refresh_token',
    client_id: CROLI_CLIENT_ID,
    refresh_token: refreshToken,
  }, { fetchImpl });
}

/**
 * 轮询登录结果（authDevice 骨架约定）：
 *   {status:'pending'} | {status:'ok', input}；终态失败抛错。
 */
export async function pollCroliLogin(data) {
  const session = sessions.get(data?.loginId);
  if (!session) throw new Error('Croli 登录会话不存在或已超时，请重新发起');
  if (session.error) {
    sessions.delete(data.loginId);
    throw new Error(session.error);
  }
  if (!session.result) {
    if (Date.now() > session.deadline) {
      sessions.delete(data.loginId);
      try { session.server.close(); } catch {}
      throw new Error('Croli 授权超时（5 分钟未完成），请重新发起');
    }
    return { status: 'pending' };
  }

  const params = session.result;
  sessions.delete(data.loginId);
  const tok = await croliTokenRequest({
    grant_type: 'authorization_code',
    code: params.code,
    client_id: CROLI_CLIENT_ID,
    redirect_uri: session.redirectUri,
    code_verifier: session.verifier,
  });

  const accessToken = tok.access_token;
  const refreshToken = tok.refresh_token;
  const expiresAt = new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString();

  // 身份读补 uid/昵称（uid = Clerk JWT sub；verify 走 balance 探测）
  let uid = null, name = null;
  try {
    const v = await verifyCroliAccount({ token: accessToken });
    if (v.auth && v.ok) { uid = v.uid || null; }
  } catch { /* 身份读失败不阻断入库（addAccount verify 再补） */ }

  return {
    status: 'ok',
    input: {
      provider: 'croli',
      token: accessToken,
      refreshToken,
      expiresAt,
      uid,
      name: null,
      email: null,
      source: 'browser',
      meta: {
        loginVia: 'oauth-authcode-pkce',
        scope: tok.scope || CROLI_OAUTH_SCOPE,
      },
    },
  };
}
