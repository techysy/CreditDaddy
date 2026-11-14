/**
 * Meoo OAuth PKCE 回环登录（issue #65 推荐线）—— 官方 CLI 同款公开客户端：
 *   client_id  meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh（no secret，PKCE S256，scope cli.compat）
 *   authorize  https://meoo.com/oauth/authorize
 *   token      https://meoo.com/oauth/token
 *   redirect   http://127.0.0.1:<port>/callback（CD 是桌面托盘应用，与官方 CLI 同款合法）
 *
 * 骨架与 traeAuth 同构：本机回环监听抓授权码 → code + verifier 换令牌 →
 * 身份读补 uid/昵称。凭据只在本机会话内流转，日志不落 token。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { fetchMeooIdentity } from './meooClient.js';

export const MEOO_CLIENT_ID = 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh';
export const MEOO_AUTHORIZE_URL = 'https://meoo.com/oauth/authorize';
export const MEOO_TOKEN_URL = 'https://meoo.com/oauth/token';
export const MEOO_SCOPE = 'cli.compat';

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_PORTS = [17480, 17481, 17482, 17483];   // 与 trae 的 3379/17388 错开

const sessions = new Map();

function gcSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expiresAt < now || s.done) sessions.delete(k);
}

/** 解析回调 query（无依赖 URL 解析） */
function parseCallbackQuery(raw) {
  try {
    const u = new URL(raw, 'http://127.0.0.1');
    const out = {};
    for (const [k, v] of u.searchParams) out[k] = v;
    return out;
  } catch { return {}; }
}

/** 回调监听：只绑 127.0.0.1；探测请求 200+CORS，凭据回调进会话后立刻收摊 */
function startCallbackServer(session) {
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const params = parseCallbackQuery(req.url || '');
    if (session.error || session.result) {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (!params.code) {
      if (params.error) {
        session.error = `授权被拒绝或失败（${params.error}）`;
        finish(session);
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    session.result = params;
    finish(session);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Meoo 登录</title>'
      + '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">'
      + '<div style="text-align:center"><div style="font-size:42px">✅</div>'
      + '<p>授权成功，回到 CreditDaddy 面板即可（此页可以关掉）。</p></div></body>');
  });
  return server;
}

function finish(session) {
  session.settledAt = Date.now();
  setTimeout(() => { try { session.server.close(); } catch {} }, 500).unref();
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
  throw new Error(`Meoo 回调端口都被占用（${errors.join('；')}），请稍后重试`);
}

/** 发起一次 OAuth PKCE 授权登录 */
export async function startMeooLogin(_kind, { ports = CALLBACK_PORTS } = {}) {
  gcSessions();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(12).toString('base64url');
  const session = { verifier, state, result: null, error: null, settledAt: 0, deadline: Date.now() + LOGIN_TIMEOUT_MS };
  session.server = startCallbackServer(session);
  const port = await bindCallbackServer(session, ports);
  session.port = port;
  session.redirectUri = `http://127.0.0.1:${port}/callback`;
  const loginId = crypto.randomUUID();
  sessions.set(loginId, session);
  const url = MEOO_AUTHORIZE_URL + '?' + new URLSearchParams({
    client_id: MEOO_CLIENT_ID,
    response_type: 'code',
    redirect_uri: session.redirectUri,
    scope: MEOO_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return { url, expiresInMs: LOGIN_TIMEOUT_MS, intervalMs: 1500, data: { loginId } };
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
  if (params.state && session.state && params.state !== session.state) {
    throw new Error('回调 state 与本次登录不匹配（CSRF 防护），请重新发起');
  }
  if (!params.code) throw new Error('回调里没有授权码，请重新发起');

  // code + verifier → 令牌
  let res;
  try {
    res = await fetch(MEOO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: MEOO_CLIENT_ID,
        code: params.code,
        redirect_uri: session.redirectUri,
        code_verifier: session.verifier,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`Meoo 换票失败：${e?.cause?.code || e.message}`);
  }
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok || !body?.access_token) {
    const msg = body?.error_description || body?.error || body?.message || `HTTP ${res.status}`;
    throw new Error(`Meoo 换票失败：${msg}`);
  }

  const accessToken = String(body.access_token);
  const refreshToken = body.refresh_token ? String(body.refresh_token) : null;
  const expiresIn = Number(body.expires_in) || 0;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  // 身份读补 uid/昵称（失败不阻断入库——addAccount 侧 verify 会再补一次）
  let uid = null, name = null;
  try {
    const ident = await fetchMeooIdentity(accessToken);
    if (ident.ok) { uid = ident.uid; name = ident.name; }
  } catch { /* verify 兜底 */ }

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
      meta: { loginVia: 'oauth-authcode' },
    },
  };
}
