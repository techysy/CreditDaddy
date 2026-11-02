/**
 * 本机 WorkBuddy 客户端凭据 — 读取已登录账号、切换当前账号。
 *
 * WorkBuddy（与 CodeBuddy CLI / 插件共用）把会话存成明文 JSON：
 *   Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<认证ID>.info
 *   macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/
 *   Linux:   ~/.local/share/CodeBuddyExtension/Data/Public/auth/
 * 当前会话是 workbuddy-desktop.info（国际版客户端可能用其他认证 ID），带时间戳的同名文件是客户端留下的历史会话。
 * 文件结构：{ account: { uid, nickname, phoneNumber, enterpriseId… }, auth: { accessToken, refreshToken, expiresAt, domain… }, accounts: [...] }
 *
 * 切换账号：原子写入会话文件 + 删除同目录的 "<文件>.logged-out" 登出标记；
 * WorkBuddy 监听该文件，外部改动会被直接应用（客户端日志 "External change applied to session"）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { inspectToken } from './workbuddyClient.js';

// ===================== WorkBuddy 5.6+ $wbEncrypted 信封加解密 =====================

export function isWbEncrypted(val) {
  return !!val && typeof val === 'object' && !Array.isArray(val) && val.$wbEncrypted === 1 && typeof val.envelope === 'string';
}

export function buildEnvelopeAAD(env) {
  const FRAMING_FIELD = 2, FMT_FIELD = 'WBEV1', AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
  const lp = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([
    AAD_DOMAIN, Buffer.from([1]), lp(FMT_FIELD), lp('sym-v1'), u32(env.suite || 1),
    lp(env.keyId || ''), Buffer.from([FRAMING_FIELD]), Buffer.from([0]), Buffer.from([0]),
  ]);
}

export function openEnvelope(encObj, key) {
  const env = JSON.parse(Buffer.from(encObj.envelope, 'base64').toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(buildEnvelopeAAD(env));
  decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function sealEnvelope(plaintext, key, template = {}) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  const env = {
    suite: template.suite || 1,
    keyId: template.keyId || '',
    nonce: nonce.toString('base64'),
  };
  cipher.setAAD(buildEnvelopeAAD(env));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext || ''), 'utf8'), cipher.final()]);
  env.authTag = cipher.getAuthTag().toString('base64');
  env.ciphertext = ciphertext.toString('base64');
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify(env)).toString('base64'),
  };
}

let cachedMasterKey = null;
let masterKeyFailAt = 0;
const KEY_RETRY_MS = 60000;

/**
 * 经 WorkBuddy 官方 Electron（ELECTRON_RUN_AS_NODE=1）子进程调用原生存储绑定提取密钥。
 * 内存缓存，失败 60s 内退避；绝不写盘，绝不写日志。
 */
export function getWorkbuddyMasterKey(clientPath) {
  if (cachedMasterKey) return cachedMasterKey;
  if (masterKeyFailAt && Date.now() - masterKeyFailAt < KEY_RETRY_MS) return null;
  const exe = clientPath || detectWorkbuddy().clientPath;
  if (!exe) return null;

  try {
    const code = [
      "const b = process._linkedBinding('electron_browser_workbuddy_storage');",
      "const p = JSON.parse(b.loggerGet());",
      "if (p && typeof p.atRestSecretKey === 'string') process.stdout.write(p.atRestSecretKey);",
    ].join('\n');
    const r = cp.spawnSync(exe, ['-e', code], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5000,
      encoding: 'utf8',
    });
    const keyRaw = String(r.stdout || '').trim();
    if (r.status === 0 && keyRaw.length >= 16) {
      cachedMasterKey = crypto.createHash('sha256').update(keyRaw, 'utf8').digest();
      masterKeyFailAt = 0;
      return cachedMasterKey;
    }
  } catch {
    /* 子进程执行异常，进入退避 */
  }
  masterKeyFailAt = Date.now();
  return null;
}

export function resetMasterKeyCacheForTest(key = null) {
  cachedMasterKey = key;
  masterKeyFailAt = 0;
}

/** 深度解密 JSON 中的 $wbEncrypted 信封，返回包含明文的浅拷贝/深拷贝 */
export function decryptSessionJson(session, clientPath) {
  if (!session || typeof session !== 'object') return session;
  let key = null;
  const clone = JSON.parse(JSON.stringify(session));

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (isWbEncrypted(v)) {
        if (!key) key = getWorkbuddyMasterKey(clientPath);
        if (key) {
          try {
            node[k] = openEnvelope(v, key);
          } catch {
            /* 解密失败保留原信封 */
          }
        }
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  };

  walk(clone);
  return clone;
}

// ===================== 凭据与会话管理 =====================

export function workbuddyAuthDir() {
  const home = os.homedir();
  const tail = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), ...tail);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', ...tail);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), ...tail);
}

const CURRENT_RE = /^[a-z0-9-]+\.info$/i;           // workbuddy-desktop.info
const HISTORY_RE = /^[a-z0-9-]+\.\d{4}-.*\.info$/i;  // workbuddy-desktop.<时间戳>.<pid>.<uuid>.info

/** 会话 JSON → 账号记录（供 addAccount），不含网络请求 */
export function sessionToAccount(rawSession, source, clientPath) {
  // 如果会话包含 $wbEncrypted 信封，先进行安全解密
  const session = decryptSessionJson(rawSession, clientPath);
  const token = session?.auth?.accessToken;
  if (typeof token !== 'string' || !token) return null;
  const info = inspectToken(token);
  if (!info.provider) return null;
  const acc = session.account || {};
  const auth = session.auth || {};
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  // 手机号：优先未脱敏的 phoneNumber；若被客户端脱敏（含 *）或为空，回退到从 JWT 解析的大陆手机号
  const rawPhone = typeof acc.phoneNumber === 'string' ? acc.phoneNumber.trim() : '';
  const isRedacted = rawPhone.includes('*');
  const phone = (!rawPhone || isRedacted) ? (info.phone || rawPhone || null) : rawPhone;

  // 原 rawSession 结构原样保留在 meta.session，便于切换账号时原汁原味还原
  const rawAuth = rawSession?.auth || auth;
  const { accessToken: _a, refreshToken: _r, ...authRest } = rawAuth;
  return {
    provider: info.provider,
    token,
    refreshToken: auth.refreshToken || null,
    expiresAt: iso(auth.expiresAt) || info.expiresAt,
    uid: acc.uid || info.uid,
    name: acc.nickname || acc.name || null,
    email: acc.email || null,
    source,
    meta: {
      domain: auth.domain || info.host,
      enterpriseId: acc.enterpriseId || null,
      phone,
      refreshExpiresAt: iso(auth.refreshExpiresAt),
      session: {
        account: rawSession?.account || acc,
        auth: authRest,
        accounts: Array.isArray(rawSession?.accounts) ? rawSession.accounts : (session.accounts || []),
        ...(Array.isArray(rawSession?.allAccounts || session.allAccounts) ? { allAccounts: rawSession?.allAccounts || session.allAccounts } : {}),
      },
    },
  };
}

/**
 * 读取本机 WorkBuddy 会话：当前会话 + 历史会话（按 uid 去重，保留最新）。
 * @returns {{ dir, accounts: Array<{...账号记录, current: boolean, file, fileTime}>, errors }}
 */
export function readWorkbuddySessions(options = {}) {
  const dir = options.dir || workbuddyAuthDir();
  const clientPath = options.clientPath !== undefined ? options.clientPath : detectWorkbuddy().clientPath;
  const out = { dir, accounts: [], errors: [] };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const byUid = new Map();
  for (const name of names) {
    if (!CURRENT_RE.test(name) && !HISTORY_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const current = !HISTORY_RE.test(name);
      if (current && fs.existsSync(`${file}.logged-out`)) continue;   // 已登出
      const rec = sessionToAccount(JSON.parse(fs.readFileSync(file, 'utf8')), current ? 'WorkBuddy 当前登录' : 'WorkBuddy 历史会话', clientPath);
      if (!rec) continue;
      const fileTime = fs.statSync(file).mtimeMs;
      const item = { ...rec, current, file, fileTime };
      const prev = byUid.get(rec.uid);
      if (!prev || (current && !prev.current) || (current === prev.current && fileTime > prev.fileTime)) byUid.set(rec.uid, item);
    } catch (e) {
      out.errors.push({ file, error: e.message });
    }
  }
  out.accounts = [...byUid.values()].sort((a, b) => b.current - a.current || b.fileTime - a.fileTime);
  return out;
}

/** 当前 WorkBuddy 客户端登录的 uid（未登录返回 null） */
export function currentWorkbuddyUid() {
  return readWorkbuddySessions().accounts.find((a) => a.current)?.uid || null;
}

// 客户端可执行文件候选（VS Code 系安装惯例：%LOCALAPPDATA%\Programs\<名>\<名>.exe）。
// 「已安装」只认 exe：凭据目录不能当依据——CreditDaddy 自己切换时 mkdir 也会把目录建出来
// （无客户端时静默切换留下的空壳目录），拿目录判断会把没装客户端的机器误报成已安装。
const CLIENT_CANDIDATES = process.platform === 'win32'
  ? [
      ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
      ['Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'],
      ['Programs', 'CodeBuddy CN', 'CodeBuddy CN.exe'],
      ['Programs', 'CodeBuddy', 'CodeBuddy.exe'],
      ['WorkBuddy', 'WorkBuddy.exe'],
      ['WorkBuddyAI', 'WorkBuddyAI.exe'],
      ['CodeBuddy CN', 'CodeBuddy CN.exe'],
      ['CodeBuddy', 'CodeBuddy.exe'],
    ]
  : process.platform === 'darwin'
    ? [
        '/Applications/WorkBuddy.app',
        '/Applications/WorkBuddy AI.app',
        '/Applications/CodeBuddy CN.app',
        '/Applications/CodeBuddy.app',
      ]
    : [];

/**
 * 本机 WorkBuddy / CodeBuddy 客户端探测（面板「客户端：未安装」提示与切换拦截用）。
 * Linux / NAS 没有已知安装路径，退而用「凭据目录里有会话文件」判定——
 * 会话文件只有客户端登录后才写，纯 Token 导入的机器不会产生。
 */
export function detectWorkbuddy() {
  const dir = workbuddyAuthDir();
  let dirExists = false;
  try { dirExists = fs.statSync(dir).isDirectory(); } catch { /* 未安装 / 从未登录 */ }
  let clientPath = null;
  for (const cand of CLIENT_CANDIDATES) {
    const p = process.platform === 'win32' && Array.isArray(cand)
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), ...cand)
      : cand;
    try { if (fs.existsSync(p)) { clientPath = p; break; } } catch { /* 下一个候选 */ }
  }
  const sessions = dirExists ? readWorkbuddySessions({ dir, clientPath }) : { accounts: [] };
  return {
    dir,
    dirExists,
    clientPath,
    installed: Boolean(clientPath) || (CLIENT_CANDIDATES.length === 0 && sessions.accounts.length > 0),
    signedIn: sessions.accounts.some((a) => a.current),
  };
}

/**
 * 把账号写成 WorkBuddy 当前会话（切换账号）。需要账号带有导入时保存的会话信息。
 * 如果原模板是 $wbEncrypted 信封格式，写回时将自动封包为合法信封。
 * @returns {{ file, previousUid }}
 */
export function writeWorkbuddySession(account, { clientPath } = {}) {
  const s = account.meta?.session;
  if (!s?.account) throw new Error('该账号缺少 WorkBuddy 会话信息，请从本机重新导入后再切换');
  const dir = workbuddyAuthDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'workbuddy-desktop.info');
  let previousUid = null;
  try { previousUid = JSON.parse(fs.readFileSync(file, 'utf8'))?.account?.uid || null; } catch {}

  const ms = (iso) => (iso ? new Date(iso).getTime() : undefined);
  const rawAuth = s.auth || {};

  // 判断是否需要信封封包写入（原会话 auth 字段包含 $wbEncrypted）
  let isEncryptedTemplate = isWbEncrypted(rawAuth.accessToken) || isWbEncrypted(rawAuth.refreshToken);
  let masterKey = null;
  if (isEncryptedTemplate) {
    masterKey = getWorkbuddyMasterKey(clientPath);
    if (!masterKey) {
      throw new Error('无法切换账号：目标账号为 WorkBuddy 5.6+ 加密凭据，但未能获取客户端解密密钥');
    }
  }

  const accessPayload = isEncryptedTemplate
    ? sealEnvelope(account.token, masterKey, isWbEncrypted(rawAuth.accessToken) ? JSON.parse(Buffer.from(rawAuth.accessToken.envelope, 'base64').toString('utf8')) : {})
    : account.token;

  const refreshVal = account.refreshToken || rawAuth.refreshToken;
  const refreshPayload = isEncryptedTemplate && refreshVal
    ? sealEnvelope(refreshVal, masterKey, isWbEncrypted(rawAuth.refreshToken) ? JSON.parse(Buffer.from(rawAuth.refreshToken.envelope, 'base64').toString('utf8')) : {})
    : refreshVal;

  const session = {
    account: s.account,
    auth: {
      ...s.auth,
      accessToken: accessPayload,
      refreshToken: refreshPayload,
      expiresAt: ms(account.expiresAt) ?? s.auth?.expiresAt,
      lastRefreshTime: Date.now(),
    },
    accounts: s.accounts || [],
    ...(Array.isArray(s.allAccounts) ? { allAccounts: s.allAccounts } : {}),
  };
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.unlinkSync(`${file}.logged-out`); } catch {}
  return { file, previousUid };
}
