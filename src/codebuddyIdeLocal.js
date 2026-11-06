/**
 * CodeBuddy IDE（桌面客户端）账号读取与切换 —— issue #51。
 *
 * 与 WorkBuddy 的关系：**账号体系同源**（token 都由 `www.codebuddy.cn` / `codebuddy.ai`
 * 的同一个 realm 签发，`inspectToken` 识别为 workbuddy / workbuddy-intl），
 * 所以额度查询、签到、10Router 推送全部复用既有链路，本模块只负责「读写 IDE 自己的存储」。
 *
 * 但**存储位置完全不同**：
 *   WorkBuddy：%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info（明文/信封 JSON）
 *   CodeBuddy IDE：%APPDATA%\CodeBuddy CN\User\globalStorage\state.vscdb（SQLite）
 *     ItemTable 的 key = secret://{"extensionId":"tencent-cloud.coding-copilot","key":"<secretKey>"}
 *     value = JSON { type:"Buffer", data:[...] } —— Chromium Safe Storage 加密的密文
 *
 * 加解密（Windows）：
 *   Local State 的 os_crypt.encrypted_key（base64，前缀 "DPAPI"）
 *     → 去前缀 → DPAPI 解密 → 32 字节 AES-256 密钥
 *     → 密文格式 v10 | 12B nonce | ciphertext | 16B GCM tag
 *
 * 国内版 / 国际版：目录 CodeBuddy CN / CodeBuddy，secretKey ...accessTokencn / ...accessToken。
 *
 * ⚠️ 性能铁律（1.6.6 白屏事故）：DPAPI 要走 PowerShell 子进程。
 * 本模块**所有导出都是 async**，只允许在用户显式操作（本机导入 / 切换账号）时调用，
 * 绝不能挂进 /api/status 状态轮询（那会把子进程塞进 Electron 主进程热路径）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const SECRET_EXTENSION_ID = 'tencent-cloud.coding-copilot';
const SECRET_KEY_CN = 'planning-genie.new.accessTokencn';
const SECRET_KEY_INTL = 'planning-genie.new.accessToken';

/** 两个档位：国内 CN / 国际版 */
export const CODEBUDDY_IDE_FLAVORS = {
  cn: { dataDirName: 'CodeBuddy CN', secretKey: SECRET_KEY_CN, provider: 'workbuddy', label: 'CodeBuddy CN' },
  intl: { dataDirName: 'CodeBuddy', secretKey: SECRET_KEY_INTL, provider: 'workbuddy-intl', label: 'CodeBuddy' },
};

/** Electron/VS Code 系客户端的数据根目录（Windows 是 %APPDATA%，不是 %LOCALAPPDATA%） */
function appDataRoot() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** 某档位的数据根目录（Custom 目录可经 env 覆盖，供测试注入） */
export function codebuddyIdeDataDir(flavor = 'cn') {
  const f = CODEBUDDY_IDE_FLAVORS[flavor];
  if (!f) throw new Error(`未知的 CodeBuddy IDE 档位：${flavor}`);
  const override = flavor === 'cn' ? process.env.CODEBUDDY_IDE_DIR_CN : process.env.CODEBUDDY_IDE_DIR_INTL;
  return override || path.join(appDataRoot(), f.dataDirName);
}

/** state.vscdb 路径（只读探测用：不做 create 副作用，见参考实现 issue #91 的教训） */
export function codebuddyIdeStateDbPath(flavor = 'cn') {
  const root = codebuddyIdeDataDir(flavor);
  const candidates = [
    path.join(root, 'User', 'globalStorage', 'state.vscdb'),
    path.join(root, 'globalStorage', 'state.vscdb'),
    path.join(root, 'state.vscdb'),
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || candidates[0];
}

/** 同步探测「有没有装」——只做文件存在性判断，不起子进程，可安全用于状态展示 */
export function detectCodeBuddyIde(flavor = 'cn') {
  const dbPath = codebuddyIdeStateDbPath(flavor);
  let exists = false;
  try { exists = fs.existsSync(dbPath); } catch { /* ignore */ }
  return { flavor, dataDir: codebuddyIdeDataDir(flavor), dbPath, installed: exists };
}

let cachedActiveUid = null;
let cachedActiveMtime = 0;

/**
 * 快速读取当前 CodeBuddy IDE 激活的账号 UID（纯本地文件 mtime 缓存，零子进程开销）
 */
export async function getActiveCodeBuddyIdeUid(flavor = 'cn') {
  const det = detectCodeBuddyIde(flavor);
  if (!det.installed) return null;
  try {
    const stat = fs.statSync(det.dbPath);
    if (cachedActiveUid !== null && stat.mtimeMs === cachedActiveMtime) {
      return cachedActiveUid;
    }
    const s = await readCodeBuddyIdeSession(flavor);
    cachedActiveMtime = stat.mtimeMs;
    cachedActiveUid = s?.account?.uid || null;
    return cachedActiveUid;
  } catch {
    return null;
  }
}

/** 同时探测两个档位（面板展示用，纯同步） */
export function detectCodeBuddyIdeAll() {
  return { cn: detectCodeBuddyIde('cn'), intl: detectCodeBuddyIde('intl') };
}

// ── SQLite 读取（node:sqlite，Node 22.5+ 内置；Electron 37 自带 Node 22） ──
// 没装 sqlite 的环境（如 Node 20 的 CLI）给出明确错误，而不是抛一个看不懂的 MODULE_NOT_FOUND
async function openDb(dbPath, { readOnly }) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('当前运行环境不支持 node:sqlite（需要 Node 22.5+ 或桌面版），无法读写 CodeBuddy IDE 存储');
  }
  return new DatabaseSync(dbPath, { readOnly });
}

// ── Windows 密钥：Local State → DPAPI → 32B AES key ──
function dpapiUnprotect(cipherB64) {
  return new Promise((resolve, reject) => {
    // PowerShell 5 的 System.Security.Cryptography.ProtectedData 就是 DPAPI（CurrentUser 范围）
    const script =
      'Add-Type -AssemblyName System.Security; ' +
      `$b=[Convert]::FromBase64String('${cipherB64}'); ` +
      "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); " +
      '[Convert]::ToBase64String($d)';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(new Error('DPAPI 解密失败：' + (err.message || err)));
        const out = String(stdout || '').trim();
        if (!out) return reject(new Error('DPAPI 返回空结果'));
        try { resolve(Buffer.from(out, 'base64')); } catch (e) { reject(e); }
      });
  });
}

/** macOS Keychain 里该应用的 Safe Storage 密码（PBKDF2-SHA1 派生 AES-128 密钥用） */
function macSafeStoragePassword(flavor) {
  const service = flavor === 'cn' ? 'CodeBuddy CN Safe Storage' : 'CodeBuddy Safe Storage';
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-w', '-s', service],
      { encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
        if (err) return reject(new Error(`无法从 Keychain 读取「${service}」密码（请先打开该应用并登录一次）`));
        const v = String(stdout || '').trim();
        if (!v) return reject(new Error(`Keychain 中「${service}」为空`));
        resolve(v);
      });
  });
}

/**
 * 取本档位的解密密钥。Windows 返回 32 字节 AES-256；macOS 返回 PBKDF2 派生的 16 字节 AES-128。
 * @returns {Promise<{alg:'aes-256-gcm'|'aes-128-cbc', key: Buffer}>}
 */
async function loadCryptoKey(flavor) {
  if (process.platform === 'win32') {
    const localStatePath = path.join(codebuddyIdeDataDir(flavor), 'Local State');
    let json;
    try { json = JSON.parse(fs.readFileSync(localStatePath, 'utf8')); }
    catch { throw new Error(`读取 Local State 失败（${localStatePath}）——请先打开 CodeBuddy 客户端并登录一次`); }
    const b64 = json?.os_crypt?.encrypted_key;
    if (!b64) throw new Error('Local State 缺少 os_crypt.encrypted_key');
    const raw = Buffer.from(b64, 'base64');
    if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('encrypted_key 前缀不是 DPAPI');
    const key = await dpapiUnprotect(raw.subarray(5).toString('base64'));
    if (key.length !== 32) throw new Error(`DPAPI 解出的密钥长度是 ${key.length}，期望 32（AES-256）`);
    return { alg: 'aes-256-gcm', key };
  }
  if (process.platform === 'darwin') {
    const pw = await macSafeStoragePassword(flavor);
    const key = crypto.pbkdf2Sync(pw, Buffer.from('saltysalt'), 1003, 16, 'sha1');
    return { alg: 'aes-128-cbc', key };
  }
  throw new Error('CodeBuddy IDE 凭据读取目前只支持 Windows / macOS');
}

/** 解密 v10 密文 → 明文 */
function decryptSecretPayload(buf, { alg, key }) {
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10') throw new Error(`密文前缀不是 v10（实际 "${prefix}"）`);
  if (alg === 'aes-256-gcm') {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(15, buf.length - 16)), d.final()]);
  }
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20)); // CBC IV 为 16 个空格
  return Buffer.concat([d.update(buf.subarray(3)), d.final()]);
}

/** 明文 → v10 密文（每次随机 nonce，与 Chromium 行为一致） */
function encryptSecretPayload(plain, { alg, key }) {
  if (alg === 'aes-256-gcm') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from('v10'), iv, ct, c.getAuthTag()]);
  }
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]);
}

function secretRowKey(flavor) {
  return `secret://{"extensionId":"${SECRET_EXTENSION_ID}","key":"${CODEBUDDY_IDE_FLAVORS[flavor].secretKey}"}`;
}

/** 把 ItemTable 的 value（string 或 Buffer）解析成密文字节 */
function parseBufferValue(value) {
  const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  const parsed = JSON.parse(text);
  if (parsed?.type !== 'Buffer' || !Array.isArray(parsed.data)) throw new Error('secret 值不是 Buffer 结构');
  return { bytes: Buffer.from(parsed.data), raw: parsed };
}

/**
 * 读取 CodeBuddy IDE 当前登录的会话（解密后的完整 JSON）。
 * @returns {Promise<null | { flavor, session, accessToken, refreshToken, account, auth }>}
 */
export async function readCodeBuddyIdeSession(flavor = 'cn') {
  const det = detectCodeBuddyIde(flavor);
  if (!det.installed) return null;
  const keyInfo = await loadCryptoKey(flavor);
  const db = await openDb(det.dbPath, { readOnly: true });
  let row;
  try {
    row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(secretRowKey(flavor));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  if (!row) return null;
  const { bytes } = parseBufferValue(row.value);
  const plain = decryptSecretPayload(bytes, keyInfo).toString('utf8');
  let session;
  try { session = JSON.parse(plain); } catch { throw new Error('解密成功但内容不是 JSON（存储格式可能已变）'); }
  const auth = session.auth || {};
  const account = session.account || {};
  return {
    flavor,
    session,
    accessToken: auth.accessToken || session.token || null,
    refreshToken: auth.refreshToken || session.refreshToken || null,
    account,
    auth,
  };
}

/**
 * 把一份会话写回 CodeBuddy IDE（切换账号）。
 * 写前强制备份 state.vscdb → state.vscdb.bak-<时间戳>。
 * @returns {Promise<{ dbPath, backup, uid }>}
 */
export async function writeCodeBuddyIdeSession(flavor, session) {
  if (!session || typeof session !== 'object') throw new Error('会话内容为空');
  const det = detectCodeBuddyIde(flavor);
  if (!det.installed) throw new Error(`未找到 ${CODEBUDDY_IDE_FLAVORS[flavor].label} 的存储（${det.dbPath}）`);
  const keyInfo = await loadCryptoKey(flavor);
  const plain = Buffer.from(JSON.stringify(session), 'utf8');
  const cipher = encryptSecretPayload(plain, keyInfo);

  // 备份：写坏了能立刻还原，这是改用户主工作环境的最低保障
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${det.dbPath}.bak-${stamp}`;
  fs.copyFileSync(det.dbPath, backup);

  const db = await openDb(det.dbPath, { readOnly: false });
  try {
    // upsert 而非裸 UPDATE：IDE 装了但从没登录时 secret 行不存在，裸 UPDATE 影响 0 行
    // 却不报错 → 切号返回 ok 但用户重启 IDE 后什么都没变（「硬写后假成功」同款问题）
    const changes = db.prepare(
      `INSERT INTO ItemTable (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(secretRowKey(flavor), JSON.stringify({ type: 'Buffer', data: Array.from(cipher) }));
    if (!Number(changes.changes)) throw new Error('写入 CodeBuddy IDE 存储失败（0 行受影响）');
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return { dbPath: det.dbPath, backup, uid: session.account?.uid || null };
}

/**
 * 构造注入到 CodeBuddy IDE 的会话 JSON（与 workbuddy-switch 的 build_session_json 规范一致）。
 * 任何 WorkBuddy 系账号（只要有 token、refreshToken 或会话数据）都可以合成为合法的 IDE 会话。
 */
export function buildCodeBuddyIdeSession(account, flavor = 'cn') {
  const isIntl = account.provider === 'workbuddy-intl' || flavor === 'intl';
  const domain = account.meta?.domain || (isIntl ? 'www.codebuddy.ai' : 'www.codebuddy.cn');
  const id = isIntl ? 'Tencent-Cloud.genie-ide' : 'Tencent-Cloud.genie-ide-cn';
  const uid = String(account.uid || '');
  const nickname = account.name || account.meta?.phone || 'User';
  const phone = account.meta?.phone ? String(account.meta.phone) : '';
  const phoneMasked = phone ? phone.slice(0, 3) + '****' + phone.slice(-4) : '';
  const accessToken = String(account.token || '');
  const refreshToken = String(account.refreshToken || '');
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : Date.now() + 30 * 86400e3;
  const now = Date.now();

  const origAccount = account.meta?.session?.account || {};
  const accountObj = {
    uid,
    nickname,
    uin: origAccount.uin || '',
    type: origAccount.type || 'personal',
    lastLogin: true,
    isCreator: false,
    isAdmin: false,
    pluginEnabled: true,
    deployStatus: { statusCode: 0, statusMsg: '', detailMsg: '' },
    accountType: '',
    sso: { domain: '', domainModifiedTimes: 0 },
    idp: '',
    areaInfoComplete: false,
    oneidAccountId: '',
    isCurrentOneIdEnterprise: false,
    isCurrentOneIdPersonal: false,
    isFirstLogin: false,
    phoneNumber: origAccount.phoneNumber || phoneMasked,
    wechatOpenId: origAccount.wechatOpenId || '',
    mpOpenId: origAccount.mpOpenId || '',
    logOutEnable: false,
    id: uid,
    label: nickname,
  };

  const authObj = {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    sessionState: account.meta?.session?.auth?.sessionState || '',
    scope: 'acr offline_access profile basic roles email web-origins',
    domain,
    lastRefreshTime: now,
    expiresAt,
    expiresIn: Math.round((expiresAt - now) / 1000),
    refreshExpiresIn: 5183999,
    refreshExpiresAt: expiresAt + 30 * 86400e3,
  };

  return {
    id,
    token: accessToken,
    refreshToken,
    expiresAt,
    domain,
    accessToken: `${uid}+${accessToken}`,
    converted: true,
    account: accountObj,
    auth: authObj,
    accounts: [accountObj],
  };
}

/**
 * 读到的会话 → CreditDaddy 账号记录（不直接落库，交给调用方的 addRecord）。
 * provider 由 token 的 iss 决定（workbuddy / workbuddy-intl），与 WorkBuddy 完全同源。
 */
export function codebuddySessionToAccount(flavor, read, inspectToken) {
  const info = inspectToken(read.accessToken || '');
  if (!info.provider) return null;
  const acc = read.account || {};
  const auth = read.auth || {};
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const rawPhone = typeof acc.phoneNumber === 'string' ? acc.phoneNumber.trim() : '';
  const phone = (!rawPhone || rawPhone.includes('*')) ? (info.phone || rawPhone || null) : rawPhone;
  return {
    provider: info.provider,
    token: read.accessToken,
    refreshToken: read.refreshToken || null,
    expiresAt: iso(auth.expiresAt) || info.expiresAt,
    uid: acc.uid || info.uid,
    name: acc.nickname || acc.name || acc.label || info.name || null,
    email: acc.email || info.email || null,
    source: 'codebuddy-ide',
    meta: {
      domain: auth.domain || info.host,
      phone,
      refreshExpiresAt: iso(auth.refreshExpiresAt),
      // 记录来源档位，切换时据此写回正确的库
      codebuddyIdeFlavor: flavor,
      // 整份会话留着，切换时原样（重新加密）写回
      cbIdeSession: read.session,
    },
  };
}
