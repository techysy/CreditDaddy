/**
 * ZCode 浏览器登录 — 与 ZCode 客户端的「CLI 轮询登录」同一协议（无需 zcode:// 回调，任何浏览器都能用）：
 *
 *   1. POST https://zcode.z.ai/api/v1/oauth/cli/init   Authorization: Bearer <本地随机 poll token>
 *      {provider: 'bigmodel' | 'zai'} → {flow_id, authorize_url, expires_at, poll_interval_sec}
 *      authorize_url 的回调指向 zcode.z.ai 自己的 /oauth/cli/callback，由服务端完成换 token
 *   2. 用户在浏览器（桌面版为隐私窗口）打开 authorize_url 登录授权
 *   3. GET /api/v1/oauth/cli/poll/{flow_id}（同一 poll token）→ status pending / ready / failed
 *      ready 时带 token（zcode JWT）、user、bigmodel{access_token, refresh_token} 或 zai{access_token}
 *   4. Z.ai 的 access_token 还要换一次业务 token：POST https://api.z.ai/api/auth/z/login {token}
 *
 * 拿到的凭据按客户端 credentials.json 的格式（enc:v1 加密）组装，存进账号 meta，
 * 之后与「本机导入」的账号完全一样：可查额度、可一键切换到 ZCode 客户端。
 */

import crypto from 'node:crypto';
import * as zc from './zcrypto.js';
import { zcodePaths } from './zcodeLocal.js';
import { FETCH_TIMEOUT_MS } from './constants.js';

const API_BASE = 'https://zcode.z.ai';
const ZAI_BUSINESS_LOGIN_URL = 'https://api.z.ai/api/auth/z/login';

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { res, body };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** kind: 'zcode-bigmodel'（智谱 BigModel）| 'zcode-zai'（Z.ai 国际） */
export async function startZcodeLogin(kind) {
  const provider = kind === 'zcode-zai' ? 'zai' : 'bigmodel';
  const pollToken = crypto.randomBytes(32).toString('hex');
  const { res, body } = await fetchJson(API_BASE + '/api/v1/oauth/cli/init', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pollToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ provider }),
  });
  const d = body?.data;
  if (!res.ok || body?.code !== 0 || !str(d?.flow_id) || !str(d?.authorize_url)) {
    throw new Error('ZCode 登录初始化失败：' + (body?.msg || 'HTTP ' + res.status));
  }
  if (!d.authorize_url.startsWith('https://')) throw new Error('ZCode 登录初始化返回了非 https 授权地址');
  const expiresInMs = Number.isFinite(d.expires_at) ? d.expires_at * 1000 - Date.now() : 5 * 60e3;
  return {
    url: d.authorize_url,
    expiresInMs: Math.max(60e3, Math.min(expiresInMs, 15 * 60e3)),
    intervalMs: Math.max(1000, (Number(d.poll_interval_sec) || 2) * 1000),
    data: { provider, flowId: d.flow_id, pollToken },
  };
}

/** 单次轮询：{status:'pending'} | {status:'ok', input}；失败抛错 */
export async function pollZcodeLogin(data) {
  const { res, body } = await fetchJson(API_BASE + '/api/v1/oauth/cli/poll/' + encodeURIComponent(data.flowId), {
    headers: { Authorization: 'Bearer ' + data.pollToken, Accept: 'application/json' },
  });
  if (res.status >= 500 || res.status === 408 || res.status === 429) return { status: 'pending' };
  if (!res.ok || body?.code !== 0) throw new Error('ZCode 授权失败：' + (body?.msg || 'HTTP ' + res.status));
  const d = body.data || {};
  if (d.status === 'pending') return { status: 'pending' };
  if (d.status === 'failed') throw new Error('ZCode 授权失败（用户取消或授权被拒绝）');
  if (d.status !== 'ready') throw new Error('ZCode 授权返回未知状态：' + d.status);

  const jwt = str(d.token);
  const user = d.user && typeof d.user === 'object' ? d.user : {};
  const userId = user.user_id !== undefined && user.user_id !== null ? String(user.user_id) : null;
  let accessToken = data.provider === 'zai' ? str(d.zai?.access_token) : str(d.bigmodel?.access_token) || str(d.bigmodel?.accessToken);
  const refreshToken = data.provider === 'bigmodel' ? str(d.bigmodel?.refresh_token) || str(d.bigmodel?.refreshToken) : null;
  if (!jwt || !accessToken || !userId) throw new Error('ZCode 授权返回缺少 token / 用户信息（上游结构可能变化）');
  if (data.provider === 'zai') accessToken = await resolveZaiBusinessToken(accessToken);

  return { status: 'ok', input: buildAccountInput({ provider: data.provider, jwt, accessToken, refreshToken, user, userId }) };
}

/** Z.ai OAuth token → 业务 access token（与客户端 ZaiBusinessTokenResolver 一致） */
async function resolveZaiBusinessToken(oauthToken) {
  const { res, body } = await fetchJson(ZAI_BUSINESS_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token: oauthToken }),
  });
  const ok = res.ok && (body?.code === undefined || body.code === 0 || body.code === 200) && body?.success !== false;
  const t = str(body?.data?.access_token) || str(body?.data?.accessToken);
  if (!ok || !t) throw new Error('Z.ai 业务 token 交换失败：' + (body?.msg || 'HTTP ' + res.status));
  return t;
}

/** 按 ZCode credentials.json 的键名组装并用本机密钥加密（与客户端写出的格式一致） */
export function buildCredentials({ provider, jwt, accessToken, refreshToken, user, userId }, secret) {
  const label = str(user.name) || str(user.email) || userId;
  const userInfo = {
    id: userId, username: label, displayName: label,
    ...(str(user.avatar) ? { avatarUrl: user.avatar } : {}),
    rawProfile: user,
  };
  const enc = (v) => zc.encryptWithSecret(v, secret);
  const creds = {
    'oauth:active_provider': enc(provider),
    [`oauth:${provider}:access_token`]: enc(accessToken),
    [`oauth:${provider}:user_info`]: enc(JSON.stringify(userInfo)),
    zcodejwttoken: enc(jwt),
  };
  if (refreshToken) creds[`oauth:${provider}:refresh_token`] = enc(refreshToken);
  return creds;
}

function buildAccountInput(parts) {
  const secret = zc.defaultSecret(zcodePaths().home);
  const credentials = buildCredentials(parts, secret);
  const id = zc.identityWithSecret(credentials, secret);
  return {
    provider: 'zcode',
    token: `zcode-creds:${parts.userId}`,   // 与本机导入同一标记，同一用户自动去重 / 续期
    uid: parts.userId,
    name: zc.identityLabel(id),
    email: str(parts.user.email),
    source: 'browser',
    // 不带 config / deviceMid：同一账号再次登录时保留已保存的客户端配置与虚拟设备 ID
    meta: {
      credentials,
      canonicalHash: zc.canonicalHash(credentials),
      capturedAt: new Date().toISOString(),
      loginProvider: parts.provider,
    },
  };
}
