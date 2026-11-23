/**
 * ZCode（智谱 GLM / Z.ai 桌面客户端）本机凭据加解密 — 移植自 zcode-switch（MIT）src-tauri/src/zcrypto.rs 与 ZCode 4.0。
 *
 * 凭据文件 ~/.zcode/v2/credentials.json 里每个值可能是：
 *   - 明文字符串
 *   - "enc:v1:<nonce>.<tag>.<密文>"（URL-safe base64 无 padding），AES-256-GCM，
 *     key = SHA256(secret)，secret 默认 "zcode-credential-fallback:<平台>:<home>:<用户名>"，
 *     可用环境变量 ZCODE_CREDENTIAL_SECRET 覆盖。
 *   - "enc:v2:os:<keyFingerprint>:<nonce>.<tag>.<密文>"（ZCode 4.0 全新格式），AES-256-GCM，
 *     key 保存在 OS Keyring（Windows Credential Manager / DPAPI / Linux Secret Service），
 *     Target: "<sha256(normalizedCredentialsPath)>.ZCode Credential Encryption"，
 *     keyFingerprint = SHA256(key).slice(0, 24)。
 *   - "enc:v2:env:<keyFingerprint>:<nonce>.<tag>.<密文>"
 * 纯函数 + OS Keyring 适配，供 zcodeLocal.js 与 zcodeClient.js 调用。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const ENC_PREFIX = 'enc:v1:';
export const ENC_V1_PREFIX = 'enc:v1:';
export const ENC_V2_PREFIX = 'enc:v2:';
export const ENC_V2_OS_PREFIX = 'enc:v2:os:';
export const ENC_V2_ENV_PREFIX = 'enc:v2:env:';

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

export function keyFingerprint(keyBuf) {
  return crypto.createHash('sha256').update(keyBuf).digest('hex').slice(0, 24);
}

export function isEncrypted(v) {
  return typeof v === 'string' && (v.startsWith(ENC_V1_PREFIX) || v.startsWith(ENC_V2_PREFIX));
}

function b64u(s) {
  return Buffer.from(s, 'base64url');
}

// ── OS Keyring 读写与缓存支持（适配 ZCode 4.0 enc:v2:os:） ──

const OS_KEY_CACHE = new Map();
const TEST_OS_KEYS = new Map();

/** 测试注入或清除预设的 OS Key（抹平操作系统环境差异） */
export function _setOsKeyForTest(fingerprintOrAccount, keyBuf) {
  if (!keyBuf) {
    if (fingerprintOrAccount) {
      TEST_OS_KEYS.delete(fingerprintOrAccount);
      OS_KEY_CACHE.delete(fingerprintOrAccount);
    } else {
      TEST_OS_KEYS.clear();
      OS_KEY_CACHE.clear();
    }
    return;
  }
  const buf = Buffer.isBuffer(keyBuf) ? keyBuf : Buffer.from(keyBuf, 'base64url');
  TEST_OS_KEYS.set(fingerprintOrAccount, buf);
  OS_KEY_CACHE.set(fingerprintOrAccount, buf);
  const fp = keyFingerprint(buf);
  TEST_OS_KEYS.set(fp, buf);
  OS_KEY_CACHE.set(fp, buf);
}

export function _clearOsKeyCache() {
  OS_KEY_CACHE.clear();
}

function findZcodeKeyringNode() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node'),
    path.join(process.env.ProgramFiles || '', 'ZCode/resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'ZCode/resources/app.asar.unpacked/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

let nativeKeyringModule = null;
let nativeKeyringTried = false;

function getNativeKeyring() {
  if (nativeKeyringTried) return nativeKeyringModule;
  nativeKeyringTried = true;
  const p = findZcodeKeyringNode();
  if (p) {
    try {
      nativeKeyringModule = require(p);
    } catch {}
  }
  return nativeKeyringModule;
}

const PS_READ_CRED_SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ZCodeCred {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try {
            var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            return System.Text.Encoding.Unicode.GetString(bytes);
        } finally {
            CredFree(ptr);
        }
    }
}
'@
$r = [ZCodeCred]::Read($args[0])
if ($r) { [Console]::Out.Write($r) }
`;

function readCredentialViaPowerShell(target) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_READ_CRED_SCRIPT, target], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    return out && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

/** 获取 ZCode 4.0 当前系统的凭据加密主密钥（32 字节 AES-256 Key Buffer） */
export function resolveOsKey({ credentialsPath, fingerprint } = {}) {
  if (fingerprint && TEST_OS_KEYS.has(fingerprint)) return TEST_OS_KEYS.get(fingerprint);
  if (fingerprint && OS_KEY_CACHE.has(fingerprint)) return OS_KEY_CACHE.get(fingerprint);

  const credPath = credentialsPath
    ? path.normalize(credentialsPath)
    : path.normalize(path.join(process.env.ZCODE_HOME || os.homedir(), '.zcode', 'v2', 'credentials.json'));
  const account = crypto.createHash('sha256').update(credPath).digest('hex');

  if (TEST_OS_KEYS.has(account)) return TEST_OS_KEYS.get(account);
  if (OS_KEY_CACHE.has(account)) return OS_KEY_CACHE.get(account);

  if (process.platform !== 'win32') return null;

  const service = 'ZCode Credential Encryption';
  let rawPassword = null;

  // 1. 优先尝试 ZCode 内置的 @napi-rs/keyring 原生模块
  const mod = getNativeKeyring();
  if (mod) {
    try {
      if (mod.Entry) {
        const entry = new mod.Entry(service, account);
        rawPassword = entry.getPassword();
      } else if (mod.getPassword) {
        rawPassword = mod.getPassword(service, account);
      }
    } catch {}
  }

  // 2. 原生模块不可用时走 Windows advapi32.dll CredReadW (DPAPI)
  if (!rawPassword) {
    rawPassword = readCredentialViaPowerShell(`${account}.${service}`);
  }

  if (!rawPassword || typeof rawPassword !== 'string') return null;

  const keyBuf = Buffer.from(rawPassword.trim(), 'base64url');
  if (keyBuf.length !== 32) return null;

  const fp = keyFingerprint(keyBuf);
  OS_KEY_CACHE.set(account, keyBuf);
  OS_KEY_CACHE.set(fp, keyBuf);

  if (fingerprint && fp !== fingerprint) return null;

  return keyBuf;
}

/** 解密单个凭据值（支持 enc:v1、enc:v2:os 与 enc:v2:env） */
export function decryptWithSecret(value, secret, opts = {}) {
  if (typeof value !== 'string') throw new Error('密文必须是字符串');

  // enc:v1:
  if (value.startsWith(ENC_V1_PREFIX)) {
    const parts = value.slice(ENC_V1_PREFIX.length).split('.');
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

  // enc:v2:os:<keyFingerprint>:<nonce>.<tag>.<ct>
  if (value.startsWith(ENC_V2_OS_PREFIX)) {
    const rest = value.slice(ENC_V2_OS_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) throw new Error('enc:v2:os 格式不正确');
    const fingerprint = rest.slice(0, colonIdx);
    const payload = rest.slice(colonIdx + 1);
    const parts = payload.split('.');
    if (parts.length !== 3) throw new Error('enc:v2:os 格式不正确');
    const [nonceB64, tagB64, ctB64] = parts;
    const nonce = b64u(nonceB64);
    if (nonce.length !== 12) throw new Error('nonce 长度异常');
    const tag = b64u(tagB64);
    const ct = b64u(ctB64);

    const keyBuf = opts.osKey || resolveOsKey({ ...opts, fingerprint });
    if (!keyBuf) throw new Error('OS 凭据密钥未找到或系统密钥库不可用');
    if (fingerprint && keyFingerprint(keyBuf) !== fingerprint) {
      throw new Error('OS 凭据密钥指纹不匹配');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('解密失败（OS 密钥不匹配或数据损坏）');
    }
  }

  // enc:v2:env:<keyFingerprint>:<nonce>.<tag>.<ct>
  if (value.startsWith(ENC_V2_ENV_PREFIX)) {
    const rest = value.slice(ENC_V2_ENV_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    const payload = colonIdx === -1 ? rest : rest.slice(colonIdx + 1);
    const parts = payload.split('.');
    if (parts.length !== 3) throw new Error('enc:v2:env 格式不正确');
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
      throw new Error('解密失败（环境变量密钥不匹配或数据损坏）');
    }
  }

  throw new Error('不是 enc: 格式');
}

/** 加密凭据值（默认 enc:v1，支持 opts.format === 'v2:os'） */
export function encryptWithSecret(plain, secret, opts = {}) {
  if (opts.format === 'v2:os' || opts.useOsKey) {
    const keyBuf = opts.osKey || resolveOsKey(opts);
    if (keyBuf) {
      const fp = keyFingerprint(keyBuf);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, nonce);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return ENC_V2_OS_PREFIX + fp + ':' + [nonce, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
    }
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), nonce);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ENC_V1_PREFIX + [nonce, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

/** 值可能加密也可能明文，统一转明文；失败返回 null（不抛错） */
export function safeDecrypt(value, secret, opts = {}) {
  if (typeof value !== 'string') return null;
  if (!isEncrypted(value)) return value;
  try { return decryptWithSecret(value, secret, opts); } catch { return null; }
}

/** 明文/加密的 JSON 字符串 → 解析后的对象；失败返回 null */
export function decryptJsonOpt(value, secret, opts = {}) {
  const plain = safeDecrypt(value, secret, opts);
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
 * 从凭据对象里提取账号身份：{ provider, username, displayName, email, userId, linkedBigModel }。
 * 适配 ZCode 4.0：
 *   - 支持 active_provider 为 zai_cn / zai / bigmodel
 *   - 支持 oauth:linked_bigmodel 关联账户提取
 *   - 支持从 account-provider:account:*:identity 兜底识别
 */
export function identityWithSecret(creds, secret, opts = {}) {
  const id = { provider: 'bigmodel', username: null, displayName: null, email: null, userId: null, linkedBigModel: null };
  if (!creds || typeof creds !== 'object') return id;

  const apRaw = creds['oauth:active_provider'];
  if (typeof apRaw === 'string') {
    const plain = isEncrypted(apRaw) ? safeDecrypt(apRaw, secret, opts) : apRaw;
    if (plain) id.provider = plain;
  } else {
    // 自动推断 provider
    if (creds['oauth:zai_cn:access_token'] || creds['oauth:zai_cn:user_info']) {
      id.provider = 'zai_cn';
    } else if (creds['oauth:zai:access_token'] || creds['oauth:zai:user_info']) {
      id.provider = 'zai';
    } else if (creds['account-provider:account:zai-start-plan:identity'] || creds['account-provider:account:zai-individual-coding-plan:identity']) {
      id.provider = 'zai_cn';
    } else if (creds['oauth:bigmodel:access_token'] || creds['oauth:bigmodel:user_info'] || creds['account-provider:account:bigmodel-individual-coding-plan:identity']) {
      id.provider = 'bigmodel';
    }
  }

  // 1. 读取当前 provider 的 user_info
  const ui = decryptJsonOpt(creds[`oauth:${id.provider}:user_info`], secret, opts);
  if (ui && typeof ui === 'object') {
    id.username = typeof ui.username === 'string' ? ui.username : null;
    id.displayName = typeof ui.displayName === 'string' ? ui.displayName : null;
    id.email = typeof ui.email === 'string' ? ui.email
      : typeof ui.rawProfile?.email === 'string' ? ui.rawProfile.email : null;
    if (ui.id !== undefined && ui.id !== null) {
      id.userId = typeof ui.id === 'string' ? ui.id : JSON.stringify(ui.id);
    } else if (ui.user_id !== undefined && ui.user_id !== null) {
      id.userId = typeof ui.user_id === 'string' ? ui.user_id : JSON.stringify(ui.user_id);
    }
  }

  // 2. 读取 linked_bigmodel
  const linkedRaw = creds['oauth:linked_bigmodel'];
  if (linkedRaw) {
    const linked = decryptJsonOpt(linkedRaw, secret, opts);
    if (linked && typeof linked === 'object') {
      const custId = linked.customerId ?? linked.customer_id ?? null;
      const at = linked.accessToken ?? linked.access_token ?? null;
      id.linkedBigModel = {
        customerId: custId ? String(custId) : null,
        accessToken: at ? String(at) : null,
      };
    }
  }

  // 3. 兜底提取 userId
  if (!id.userId) {
    const at = creds[`oauth:${id.provider}:access_token`];
    const plain = typeof at === 'string' ? (isEncrypted(at) ? safeDecrypt(at, secret, opts) : at) : null;
    const jwt = plain ? decodeJwt(plain) : null;
    if (jwt) id.userId = jwt.user_id ?? jwt.sub ?? null;
  }
  if (!id.userId && creds.zcodejwttoken) {
    const plain = typeof creds.zcodejwttoken === 'string' ? (isEncrypted(creds.zcodejwttoken) ? safeDecrypt(creds.zcodejwttoken, secret, opts) : creds.zcodejwttoken) : null;
    const jwt = plain ? decodeJwt(plain) : null;
    if (jwt) id.userId = jwt.user_id ?? jwt.sub ?? null;
  }
  if (!id.userId && id.linkedBigModel?.customerId) {
    id.userId = id.linkedBigModel.customerId;
  }
  if (!id.userId) {
    // 从 account-provider:account:*:identity 提取
    for (const [k, v] of Object.entries(creds)) {
      if (k.startsWith('account-provider:account:') && k.endsWith(':identity')) {
        const plain = typeof v === 'string' ? (isEncrypted(v) ? safeDecrypt(v, secret, opts) : v) : null;
        if (plain && plain.trim()) {
          id.userId = plain.trim();
          break;
        }
      }
    }
  }
  if (!id.userId) {
    // 从 project-key-location 中寻找 customerId/userId
    for (const k of Object.keys(creds)) {
      if (k.startsWith('project-key-location:')) {
        const m = k.match(/%22(\d{10,25})%22/);
        if (m) {
          id.userId = m[1];
          break;
        }
      }
    }
  }

  return id;
}

export function identityLabel(id) {
  return id.displayName || id.username || id.email || null;
}

/** 是否已登录：有任意 oauth:*:access_token，或有非空 zcodejwttoken，或有套餐 identity */
export function isLoggedIn(creds) {
  if (!creds || typeof creds !== 'object') return false;
  if (Object.keys(creds).some((k) => k.startsWith('oauth:') && k.endsWith(':access_token'))) return true;
  if (Object.keys(creds).some((k) => k.startsWith('account-provider:account:') && k.endsWith(':identity'))) return true;
  if (creds['oauth:linked_bigmodel']) return true;
  const jwt = creds.zcodejwttoken;
  return typeof jwt === 'string' && jwt.trim().length > 0;
}

const DEVICE_KEY_PREFIX = 'web-remote-control:';

/**
 * 账号去重用的规范化哈希：剔除设备相关键（web-remote-control:…）后对 JSON 取 SHA256。
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
  return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex');
}
