/**
 * 账号导入 / 导出 — 与 10router 的 OAuth 迁移文件互通。
 *
 * 加密信封与 10router src/lib/auth/secureTransfer.js 逐字节一致（10router-oauth-secure-v1）：
 *   scrypt(N=16384, r=8, p=1, 32B) 由口令派生密钥 → AES-256-GCM；salt/iv/tag/payload 均为标准 base64
 *
 * 解密后的载荷（两边通用）：
 *   { provider, exportedAt, accounts: [{ provider, name, email, uid, accessToken, refreshToken, expiresAt, providerSpecificData }] }
 * CreditDaddy 另写入 format/version，并保留旧字段 token 以兼容 v0.1.x 的导入。
 *
 * 能导入：CreditDaddy（含更名前的 QoderDaddy）明文/加密导出、10router 加密导出（取 qoder / qoder-cn / codebuddy-cn / codebuddy-intl 账号）、
 * [{name,provider,token}] 数组。10router 的 codebuddy-* 映射为 WorkBuddy。
 */

import crypto from 'node:crypto';
import { PROVIDERS, productOf } from './constants.js';

export const TRANSFER_FORMAT = '10router-oauth-secure-v1';
export const EXPORT_FORMAT = 'creditdaddy-accounts';
const OWN_FORMATS = new Set([EXPORT_FORMAT, 'qoderdaddy-accounts']);   // 兼容更名前的 QoderDaddy 导出
const KDF = { alg: 'scrypt', N: 16384, r: 8, p: 1, keyLen: 32 };

// 10router 的提供商 ID → 本工具 provider
const PROVIDER_ALIASES = { 'codebuddy-cn': 'workbuddy', 'codebuddy-intl': 'workbuddy-intl', codebuddy: 'workbuddy' };
const toProvider = (p) => (PROVIDERS.includes(p) ? p : PROVIDER_ALIASES[p] || null);

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');

export class TransferError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function deriveKey(password, salt, kdf = KDF) {
  return crypto.scryptSync(String(password), salt, kdf.keyLen || 32, {
    N: kdf.N || KDF.N, r: kdf.r || KDF.r, p: kdf.p || KDF.p, maxmem: 64 * 1024 * 1024,
  });
}

/**
 * 导入文件里的 kdf 参数不可信：文件自报 {N:2,r:1,p:1} 会让 scrypt 瞬间算完（0ms vs 42ms），
 * 密钥强度被文件作者单方面降级，而且没有任何地方会提示。KDF 是本格式的固定契约（见文件头），
 * 不一致就拒收。注意 kdf 整个对象缺失时要报「参数不对」而不是「口令错误」——后者会把
 * 用户的排查方向带偏。
 */
function checkKdf(blob) {
  const k = blob?.kdf;
  if (!k || typeof k !== 'object') {
    throw new TransferError('BAD_KDF', '迁移文件缺少 KDF 参数，可能不是本工具导出的文件');
  }
  if (k.alg !== KDF.alg) {
    throw new TransferError('BAD_KDF', `不支持的 KDF 算法：${k.alg}`);
  }
  for (const f of ['N', 'r', 'p', 'keyLen']) {
    if (k[f] !== KDF[f]) {
      throw new TransferError('BAD_KDF', `KDF 参数 ${f} 与本工具不一致（文件 ${k[f]}，期望 ${KDF[f]}）：为避免密钥强度被文件单方面降级，已拒绝导入`);
    }
  }
  return k;
}

export function sealTransfer(payload, password) {
  if (typeof password !== 'string' || password.length < 4) {
    throw new TransferError('PASSPHRASE_TOO_SHORT', '加密口令至少 4 个字符');
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return {
    format: TRANSFER_FORMAT,
    kdf: { ...KDF, salt: b64(salt) },
    cipher: 'aes-256-gcm',
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    payload: b64(ct),
  };
}

export function openTransfer(blob, password) {
  if (blob?.format !== TRANSFER_FORMAT) throw new TransferError('UNSUPPORTED_FORMAT', '不是加密迁移文件');
  if (!password) throw new TransferError('NEED_PASSWORD', '该文件已加密，请输入导出时设置的口令');
  const kdf = checkKdf(blob);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, unb64(kdf.salt), kdf), unb64(blob.iv));
    decipher.setAuthTag(unb64(blob.tag));
    const plain = Buffer.concat([decipher.update(unb64(blob.payload)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new TransferError('WRONG_PASSWORD', '口令错误或文件已损坏');
  }
}

/** 构造导出载荷（10router 兼容字段 + CreditDaddy 旧字段） */
export function buildExportPayload(accounts, { provider, product } = {}) {
  const list = accounts.filter((a) => (!provider || a.provider === provider) && (!product || productOf(a.provider) === product));
  const providers = [...new Set(list.map((a) => a.provider))];
  return {
    format: EXPORT_FORMAT,
    version: 2,
    provider: providers.length === 1 ? providers[0] : (provider || null),
    exportedAt: new Date().toISOString(),
    accounts: list.map((a) => ({
      provider: a.provider,
      name: a.name || a.email || null,
      email: a.email || null,
      uid: a.uid || null,
      accessToken: a.token,
      token: a.token,
      refreshToken: a.refreshToken || null,
      expiresAt: a.expiresAt || null,
      createdAt: a.createdAt,
      providerSpecificData: {
        authMethod: a.token.startsWith('pt-') ? 'pat' : 'device',
        userId: a.uid || null,
        // Qoder 网页会话随账号一起同步：10Router 的逐资源包明细接口只认这个 Cookie
        // （openapi 只有聚合值）。userId 供接收方核对会话归属，防止张冠李戴。
        ...(a.meta?.qoderWebSession?.cookie && String(a.provider).startsWith('qoder')
          ? { creditDaddyWebSession: { cookie: a.meta.qoderWebSession.cookie, capturedAt: a.meta.qoderWebSession.capturedAt || null, userId: a.uid || null } }
          : {}),
      },
      ...(a.meta && Object.keys(a.meta).length ? { meta: a.meta } : {}),
    })),
  };
}

/**
 * 导出：只输出 10router 兼容的加密信封（scrypt + AES-256-GCM）。
 * 账号含 token，导出必须设置口令——不再提供明文导出路径；口令校验复用 sealTransfer。
 */
export function exportAccounts(accounts, { password, provider, product } = {}) {
  if (typeof password !== 'string' || !password) {
    throw new TransferError('PASSWORD_REQUIRED', '导出账号必须设置加密口令（至少 4 个字符）');
  }
  return sealTransfer(buildExportPayload(accounts, { provider, product }), password);
}

/**
 * 解析任意支持的导入文件，统一成 normalizeAccountInput 可接受的记录。
 * @returns {{ accounts: Array, skipped: number, source: string }}
 */
export function parseImport(data, { password } = {}) {
  let source = 'creditdaddy';
  let payload = data;
  if (data?.format === TRANSFER_FORMAT) {
    payload = openTransfer(data, password);
    source = OWN_FORMATS.has(payload?.format) ? 'creditdaddy' : '10router';
  }
  const list = Array.isArray(payload) ? payload : payload?.accounts;
  if (!Array.isArray(list)) {
    throw new TransferError('BAD_FORMAT', '无法识别的文件：应为 CreditDaddy 或 10router 导出的 JSON');
  }
  const fallbackProvider = toProvider(payload?.provider);

  const accounts = [];
  let skipped = 0;
  for (const item of list) {
    // 显式标注了其他提供商（如 10router 的 cursor 账号）→ 跳过；未标注才用文件级 provider
    const provider = item?.provider ? toProvider(item.provider) : fallbackProvider;
    const token = item?.accessToken || item?.access_token || item?.token || item?.apiKey;
    if (!provider || typeof token !== 'string' || !token.trim()) { skipped++; continue; }
    const psd = item.providerSpecificData || {};
    const email = typeof item.email === 'string' && item.email.includes('@') && !/^qoder(-cn)?-user-/.test(item.email) ? item.email : null;
    // 10Router 侧保留的网页会话（psd.creditDaddyWebSession）回导入时捡回 meta，双向闭环
    const webSession = psd.creditDaddyWebSession && typeof psd.creditDaddyWebSession === 'object'
      && typeof psd.creditDaddyWebSession.cookie === 'string' && psd.creditDaddyWebSession.cookie
      ? { cookie: psd.creditDaddyWebSession.cookie, capturedAt: psd.creditDaddyWebSession.capturedAt || null } : null;
    const meta = { ...(item.meta && typeof item.meta === 'object' ? item.meta : {}) };
    if (webSession && !meta.qoderWebSession) meta.qoderWebSession = webSession;
    accounts.push({
      provider,
      token,
      name: item.name || item.nickname || email || null,
      email,
      uid: item.uid || psd.userId || null,
      refreshToken: item.refreshToken || item.refresh_token || null,
      expiresAt: item.expiresAt ?? (item.expiresIn ? Date.now() + Number(item.expiresIn) * 1000 : null),
      source: source === '10router' ? '10router' : 'import',
      ...(Object.keys(meta).length ? { meta } : {}),
    });
  }
  return { accounts, skipped, source };
}
