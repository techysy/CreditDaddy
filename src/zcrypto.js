/**
 * ZCode（智谱 GLM / Z.ai 桌面客户端）本机凭据加解密 — 移植自 zcode-switch（MIT）src-tauri/src/zcrypto.rs。
 *
 * 凭据文件 ~/.zcode/v2/credentials.json 里每个值可能是：
 *   - 明文字符串
 *   - "enc:v1:<nonce>.<tag>.<密文>"（均为 URL-safe base64，无 padding），AES-256-GCM，
 *     key = SHA256(secret)，secret 默认 "zcode-credential-fallback:<平台>:<home>:<用户名>"，
 *     可用环境变量 ZCODE_CREDENTIAL_SECRET 覆盖（客户端本身也读这个变量）。
 * 纯函数、无 I/O，供 zcodeLocal.js 调用，也便于单测。
 */

import crypto from 'node:crypto';

export const ENC_PREFIX = 'enc:v1:';

/** node/rust 平台名 → zcode 使用的平台标识（win32 / darwin / linux） */
export function nodePlatformFor(platform) {
  if (platform === 'windows') return 'win32';
  if (platform === 'macos') return 'darwin';
  return platform;
}

/** 未设置 ZCODE_CREDENTIAL_SECRET 时的回退密钥来源 */
export function defaultSecret(home, { platform = process.platform, username } = {}) {
  const envSecret = process.env.ZCODE_CREDENTIAL_SECRET;
  if (envSecret) return envSecret;
  const user = username || process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'unknown';
  return `zcode-credential-fallback:${platform}:${home}:${user}`;
}

function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(ENC_PREFIX);
}

function b64u(s) {
  return Buffer.from(s, 'base64url');
}

/** 解密单个 "enc:v1:…" 值；输入非该格式时报错（调用方按需 try/catch 或用 safeDecrypt） */
export function decryptWithSecret(value, secret) {
  if (!isEncrypted(value)) throw new Error('不是 enc:v1 格式');
  const parts = value.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('enc:v1 格式不正确');
  const [nonceB64, tagB64, ctB64] = parts;
  const nonce = b64u(nonceB64);
  if (nonce.length !== 12) throw new Error('nonce 长度异常');
  const tag = b64u(tagB64);
  const ct = b64u(ctB64);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('解密失败（密钥不匹配或数据损坏）');
  }
}

/** 加密占位：CreditDaddy 只读取 ZCode 凭据，不写回加密值；切换账号时原样复制账号库里保存的密文即可。 */

/** 值可能加密也可能明文，统一转明文；失败返回 null（不抛错） */
export function safeDecrypt(value, secret) {
  if (typeof value !== 'string') return null;
  if (!isEncrypted(value)) return value;
  try { return decryptWithSecret(value, secret); } catch { return null; }
}

/** 明文/加密的 JSON 字符串 → 解析后的对象；失败返回 null */
export function decryptJsonOpt(value, secret) {
  const plain = safeDecrypt(value, secret);
  if (plain === null) return null;
  try { return JSON.parse(plain); } catch { return null; }
}

/** 解码 JWT payload（不校验签名，仅用于展示/识别用户，与 zcode 客户端自身用途一致） */
export function decodeJwt(jwt) {
  try {
    const seg = String(jwt).split('.')[1];
    if (!seg) return null;
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 从凭据对象里提取账号身份：{ provider, username, displayName, email, userId }。
 * 逻辑对齐 zcrypto.rs identity_with_secret：先看 active_provider 的 user_info，
 * 找不到 user_id 时退而解码 access_token 这个 JWT。
 */
export function identityWithSecret(creds, secret) {
  const id = { provider: 'bigmodel', username: null, displayName: null, email: null, userId: null };
  if (!creds || typeof creds !== 'object') return id;
  const apRaw = creds['oauth:active_provider'];
  if (typeof apRaw === 'string') {
    const plain = isEncrypted(apRaw) ? safeDecrypt(apRaw, secret) : apRaw;
    if (plain) id.provider = plain;
  }
  const ui = decryptJsonOpt(creds[`oauth:${id.provider}:user_info`], secret);
  if (ui && typeof ui === 'object') {
    id.username = typeof ui.username === 'string' ? ui.username : null;
    id.displayName = typeof ui.displayName === 'string' ? ui.displayName : null;
    id.email = typeof ui.email === 'string' ? ui.email
      : typeof ui.rawProfile?.email === 'string' ? ui.rawProfile.email : null;
    if (ui.id !== undefined && ui.id !== null) {
      id.userId = typeof ui.id === 'string' ? ui.id : JSON.stringify(ui.id);
    }
  }
  if (!id.userId) {
    const at = creds[`oauth:${id.provider}:access_token`];
    const plain = typeof at === 'string' ? (isEncrypted(at) ? safeDecrypt(at, secret) : at) : null;
    const jwt = plain ? decodeJwt(plain) : null;
    if (jwt) id.userId = jwt.user_id ?? jwt.sub ?? null;
  }
  return id;
}

export function identityLabel(id) {
  return id.displayName || id.username || id.email || null;
}

/** 是否已登录：有任意 oauth:*:access_token，或有非空 zcodejwttoken */
export function isLoggedIn(creds) {
  if (!creds || typeof creds !== 'object') return false;
  if (Object.keys(creds).some((k) => k.startsWith('oauth:') && k.endsWith(':access_token'))) return true;
  const jwt = creds.zcodejwttoken;
  return typeof jwt === 'string' && jwt.trim().length > 0;
}

const DEVICE_KEY_PREFIX = 'web-remote-control:';

/**
 * 账号去重用的规范化哈希：剔除设备相关键（web-remote-control:…，含远程控制中继密钥，
 * 这些跟着设备走而不是账号，不能影响“是否是同一个登录”的判断）后对 JSON 取 SHA256。
 */
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function canonicalHash(creds) {
  let obj = creds;
  if (creds && typeof creds === 'object' && !Array.isArray(creds)) {
    obj = Object.fromEntries(Object.entries(creds).filter(([k]) => !k.startsWith(DEVICE_KEY_PREFIX)));
  }
  // 键序无关的稳定序列化：credentials.json 被 ZCode 重写后键序可能变，但同一登录应得同一 hash
  return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex');
}
