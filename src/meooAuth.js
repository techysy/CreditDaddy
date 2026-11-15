/**
 * Meoo OAuth PKCE 回环登录（issue #65）—— 协议 1:1 对齐官方 CLI 0.5.8
 * （@aliyun-meoo/cli dist/lib/oauth.js 考古，2026-11-15）：
 *   client_id   meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh（production，no secret）
 *   scope       cli.compat
 *   authorize   {base}/oauth/authorize（redirect_uri = http://127.0.0.1:<随机端口>/oauth/callback）
 *   token       {base}/oauth/token（form-urlencoded；code 换票带 code_verifier，
 *               刷新 grant_type=refresh_token——均无 client secret）
 *   响应契约    access_token + refresh_token + token_type=Bearer + expires_in +
 *               scope + openid + tenant_id（缺任一 = invalid_token_response）
 *
 * 2026-11-15 实测教训：redirect_uri 的注册路径是 "/oauth/callback"——
 * 用 /callback 会被授权页拒「redirect_uri 未注册（invalid_redirect_uri）」。
 * 端口随机（CLI listen(0) 同款），服务端按 loopback host 通配放行。
 * 凭据只在本机会话内流转，日志不落 token。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { fetchMeooIdentity } from './meooClient.js';

export const MEOO_CLIENT_ID = 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh';
export const MEOO_SCOPE = 'cli.compat';
export const MEOO_AUTHORIZE_URL = 'https://meoo.com/oauth/authorize';
export const MEOO_TOKEN_URL = 'https://meoo.com/oauth/token';
const CALLBACK_PATH = '/oauth/callback';

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

const callbackHtml = (title, body, ok) => `<!doctype html><meta charset="utf-8"><title>${title}</title>`
  + '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">'
  + `<div style="text-align:center"><div style="font-size:42px">${ok ? '✅' : '⚠️'}</div>`
  + `<p style="font-weight:600">${title}</p><p style="color:#666">${body}</p></div></body>`;

/** 回调监听：只绑 127.0.0.1 随机端口；响应纪律照抄 CLI（404/400/200 + no-store） */
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
    res.end(callbackHtml('授权成功', '你可以关闭此页面并回到 CreditDaddy。', true));
  });
  return server;
}

function finish(session) {
  session.settledAt = Date.now();
  setTimeout(() => { try { session.server.close(); } catch {} }, 500).unref();
}

/** 随机回环端口（CLI listen(0) 同款） */
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
export async function startMeooLogin(_kind) {
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
  const url = MEOO_AUTHORIZE_URL + '?' + new URLSearchParams({
    client_id: MEOO_CLIENT_ID,
    redirect_uri: session.redirectUri,
    response_type: 'code',
    scope: MEOO_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url, expiresInMs: LOGIN_TIMEOUT_MS, intervalMs: 1500, data: { loginId } };
}

/** token 响应契约校验（CLI requestToken 同款，缺任一字段即拒） */
function validateTokenResponse(result) {
  if (typeof result?.access_token !== 'string'
    || typeof result?.refresh_token !== 'string'
    || result?.token_type !== 'Bearer'
    || !Number.isFinite(Number(result?.expires_in))
    || Number(result.expires_in) <= 0
    || typeof result?.scope !== 'string'
    || typeof result?.openid !== 'string'
    || typeof result?.tenant_id !== 'string') {
    const err = new Error('Meoo OAuth Token 响应格式无效');
    err.oauth = true;
    throw err;
  }
}

/** OAuth 换票 / 刷新（form-urlencoded，无 secret——CLI 同款） */
export async function meooTokenRequest(parameters, { fetchImpl } = {}) {
  let res;
  try {
    res = await (fetchImpl || fetch)(MEOO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(parameters).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Meoo OAuth 请求失败：${e?.cause?.code || e.message}`);
  }
  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Meoo OAuth 失败：${result.error_description || result.error || `HTTP ${res.status}`}`);
  }
  validateTokenResponse(result);
  return result;
}

/** 刷新令牌（签到触发动作 / 凭据续期共用） */
export async function refreshMeooToken(refreshToken, { fetchImpl } = {}) {
  return meooTokenRequest({
    grant_type: 'refresh_token',
    client_id: MEOO_CLIENT_ID,
    refresh_token: refreshToken,
  }, { fetchImpl });
}

/**
 * 轮询登录结果（authDevice 骨架约定）：
 *   {status:'pending'} | {status:'ok', input}；终态失败抛错。
 */
export async function pollMeooLogin(data) {
  const session = sessions.get(data?.loginId);
  if (!session) throw new Error('Meoo 登录会话不存在或已超时，请重新发起');
  if (session.error) {
    sessions.delete(data.loginId);
    throw new Error(session.error);
  }
  if (!session.result) {
    if (Date.now() > session.deadline) {
      sessions.delete(data.loginId);
      try { session.server.close(); } catch {}
      throw new Error('Meoo 授权超时（5 分钟未完成），请重新发起');
    }
    return { status: 'pending' };
  }

  const params = session.result;
  sessions.delete(data.loginId);
  const tok = await meooTokenRequest({
    grant_type: 'authorization_code',
    client_id: MEOO_CLIENT_ID,
    code: params.code,
    redirect_uri: session.redirectUri,
    code_verifier: session.verifier,
  });

  const accessToken = tok.access_token;
  const refreshToken = tok.refresh_token;
  const expiresAt = new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString();

  // 身份读补 uid/昵称（失败重试两次——uid 决定账号归户，首次读挂会落到 openid
  // 造成同账号两行漂移；仍失败才回落 openid，addAccount 侧 verify 再补一次）
  let uid = tok.openid || null, name = null;
  for (let attempt = 0; attempt < 3 && !name; attempt++) {
    try {
      const ident = await fetchMeooIdentity(accessToken);
      if (ident.ok && ident.uid) { uid = ident.uid; name = ident.name; break; }
    } catch { /* 瞬时抖动重试 */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
  }

  return {
    status: 'ok',
    input: {
      provider: 'meoo',
      token: accessToken,
      refreshToken,
      expiresAt,
      uid,
      name: name ? `Meoo (${name})` : null,
      email: null,
      source: 'browser',
      meta: {
        loginVia: 'oauth-authcode',
        openid: tok.openid || null,
        tenantId: tok.tenant_id || null,
        scope: tok.scope || MEOO_SCOPE,
      },
    },
  };
}
