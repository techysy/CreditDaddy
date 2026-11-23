/**
 * ZCode 浏览器登录 — 与 ZCode 客户端的「CLI 轮询登录」同一协议（无需 zcode:// 回调，任何浏览器都能用）：
 *
 *   1. POST https://zcode.z.ai/api/v1/oauth/cli/init   Authorization: Bearer <本地随机 poll token>
 *      {provider: 'bigmodel' | 'zai' | 'zai_cn'} → {flow_id, authorize_url, expires_at, poll_interval_sec}
 *      - bigmodel: 智谱老平台登录（蓝白页）
 *      - zai: Z.ai 国际版
 *      - zai_cn: ZCode 4.0 全新国内渠道（zchat.z.ai，黑白 Z 手机号验证码）
 *      authorize_url 的回调指向 zcode.z.ai 自己的 /oauth/cli/callback，由服务端完成换 token
 *   2. 用户在浏览器（桌面版为隐私窗口）打开 authorize_url 登录授权
 *   3. GET /api/v1/oauth/cli/poll/{flow_id}（同一 poll token）→ status pending / ready / failed
 *      ready 时带 token（zcode JWT）、user、bigmodel / zai / zai_cn 凭据与 linked_bigmodel
 *   4. Z.ai 国际版的 access_token 还要换一次业务 token：POST https://api.z.ai/api/auth/z/login {token}
 *      国内版 zai_cn 则直接使用服务端下发的 token
 *
 * 拿到的凭据按客户端 credentials.json 的格式组装，存进账号 meta，
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

/** kind: 'zcode-bigmodel'（智谱 BigModel）| 'zcode-zai'（Z.ai 国际）| 'zcode-zai-cn' / 'zcode-zai_cn'（ZCode 4.0 官方国内版） */
export async function startZcodeLogin(kind) {
  const provider = (kind === 'zcode-zai' || kind === 'zai')
    ? 'zai'
    : (kind === 'zcode-zai-cn' || kind === 'zcode-zai_cn' || kind === 'zai_cn')
      ? 'zai_cn'
      : 'bigmodel';
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
  const userId = user.user_id !== undefined && user.user_id !== null
    ? String(user.user_id)
    : (user.id !== undefined && user.id !== null ? String(user.id) : null);

  let accessToken;
  if (data.provider === 'zai') {
    accessToken = str(d.zai?.access_token) || str(d.zai?.accessToken);
  } else if (data.provider === 'zai_cn') {
    accessToken = str(d.zai?.access_token) || str(d.zai_cn?.access_token) || str(d.zai?.accessToken) || str(d.zai_cn?.accessToken);
  } else {
    accessToken = str(d.bigmodel?.access_token) || str(d.bigmodel?.accessToken);
  }

  let refreshToken = null;
  if (data.provider === 'bigmodel') {
    refreshToken = str(d.bigmodel?.refresh_token) || str(d.bigmodel?.refreshToken);
  } else {
    refreshToken = str(d.zai?.refresh_token) || str(d.zai_cn?.refresh_token) || str(d.zai?.refreshToken) || str(d.zai_cn?.refreshToken);
  }

  if (!jwt || !accessToken || !userId) throw new Error('ZCode 授权返回缺少 token / 用户信息（上游结构可能变化）');
  if (data.provider === 'zai') accessToken = await resolveZaiBusinessToken(accessToken);

  // 提取 linkedBigModel（ZCode 4.0 中 Z.ai 账号绑定的 BigModel 资产）
  let linkedBigModel = null;
  if (d.bigmodel && typeof d.bigmodel === 'object') {
    const custId = str(d.bigmodel.customer_id) || str(d.bigmodel.customerId);
    const at = str(d.bigmodel.access_token) || str(d.bigmodel.accessToken);
    if (custId && at) {
      linkedBigModel = { customerId: custId, accessToken: at };
    }
  }

  return {
    status: 'ok',
    input: buildAccountInput({
      provider: data.provider,
      jwt,
      accessToken,
      refreshToken,
      user,
      userId,
      linkedBigModel,
    }),
  };
}

/** Z.ai 国际版 OAuth token → 业务 access token（与客户端 ZaiBusinessTokenResolver 一致） */
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
export function buildCredentials({ provider, jwt, accessToken, refreshToken, user, userId, linkedBigModel }, secret) {
  const label = str(user.name) || str(user.email) || str(user.username) || userId;
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
  if (linkedBigModel) {
    creds['oauth:linked_bigmodel'] = enc(JSON.stringify({ userId, ...linkedBigModel }));
  }

  // 为客户端冷切后直接生效预填充 coding-plan identity
  if (provider === 'zai_cn' || provider === 'zai') {
    creds['account-provider:account:zai-start-plan:identity'] = enc(userId);
    creds['account-provider:account:zai-individual-coding-plan:identity'] = enc(userId);
    creds['account-provider:account:zai-team-coding-plan:identity'] = enc(userId);
    if (linkedBigModel?.customerId) {
      creds['account-provider:account:bigmodel-individual-coding-plan:identity'] = enc(String(linkedBigModel.customerId));
      creds['account-provider:account:bigmodel-team-coding-plan:identity'] = enc(String(linkedBigModel.customerId));
    }
  } else if (provider === 'bigmodel') {
    creds['account-provider:account:bigmodel-individual-coding-plan:identity'] = enc(userId);
    creds['account-provider:account:bigmodel-team-coding-plan:identity'] = enc(userId);
  }

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
    meta: {
      credentials,
      canonicalHash: zc.canonicalHash(credentials),
      capturedAt: new Date().toISOString(),
      loginProvider: parts.provider,
      ...(parts.linkedBigModel ? { linkedBigModel: parts.linkedBigModel } : {}),
    },
  };
}
