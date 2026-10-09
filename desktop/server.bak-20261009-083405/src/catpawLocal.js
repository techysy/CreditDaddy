/**
 * 妙手（美团 CatPaw）桌面客户端本机凭据读取与切换。
 *
 * 凭据存储（Windows）：
 *   %APPDATA%\catpaw-moon\catx-credential.json   { ssoTokenEnc }
 *   ssoTokenEnc = base64( iv(12B) ‖ gcmTag(16B) ‖ ciphertext )，AES-256-GCM
 *   key = sha256( machineId + ":catpaw-desk-token-v2" )
 *   machineId = HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid 的值（node-machine-id 同源）
 *   明文结构 { access_token, modified_at }
 *
 * 额度 / 版本 / 用户信息走桌面网关（见 catpawClient.js）：
 *   token 以 X-Auth-Token 头发送到 https://catx.nocode.cn/api/gateway/*
 *
 * 账号切换：妙手启动时读取该文件恢复登录，因此写入目标账号的 access_token
 * 再重启客户端即为换号。切换前先把当前登录同步进 CreditDaddy 账号库（防丢号）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const EXE_NAME = '妙手.exe';

function credentialFile() {
  if (process.env.CATPAW_CREDENTIAL_FILE) return process.env.CATPAW_CREDENTIAL_FILE;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'catpaw-moon', 'catx-credential.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ── 密钥派生（MachineGuid → sha256） ──

let keyCache = null;   // Buffer | null（null = 本机不可用），false = 已尝试失败
let machineIdOverride = null;   // 测试钩子：注入固定机器 ID（null = 未注入）
let runningOverride = null;     // 测试钩子：true/false 强制运行状态（null = 真实探测）

function machineId() {
  if (machineIdOverride) return machineIdOverride;
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('REG.exe',
      ['QUERY', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, timeout: 10_000 }).toString();
    // MachineGuid    REG_SZ    {xxxxxxxx-....}（与 node-machine-id 一致：去空白 + 小写）
    return out.split('REG_SZ')[1].replace(/\r+|\n+|\s+/g, '').toLowerCase();
  } catch { return null; }
}

function tokenKey() {
  if (machineIdOverride) {
    return crypto.createHash('sha256').update(machineIdOverride + ':catpaw-desk-token-v2').digest();
  }
  if (keyCache) return keyCache;
  if (keyCache === false) return null;
  const id = machineId();
  if (!id) { keyCache = false; return null; }
  keyCache = crypto.createHash('sha256').update(id + ':catpaw-desk-token-v2').digest();
  return keyCache;
}

/** 解密本机妙手登录凭据 → { accessToken, modifiedAt }；不可用 / 未登录返回 null */
export function readCredential() {
  const file = credentialFile();
  const j = readJson(file);
  if (!j || typeof j.ssoTokenEnc !== 'string' || !j.ssoTokenEnc) return null;
  const key = tokenKey();
  if (!key) return null;
  try {
    const blob = Buffer.from(j.ssoTokenEnc, 'base64');
    if (blob.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    const plain = JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8'));
    if (!plain || typeof plain.access_token !== 'string' || !plain.access_token) return null;
    return { accessToken: plain.access_token, modifiedAt: plain.modified_at ?? null };
  } catch { return null; }
}

/** 加密写回凭据文件（保留文件其余字段；妙手重启后即为新登录） */
function writeCredential(accessToken) {
  const file = credentialFile();
  const key = tokenKey();
  if (!key) throw new Error('无法派生本机密钥（仅支持 Windows 本机）');
  const existing = readJson(file) || {};
  const plain = JSON.stringify({ access_token: accessToken, modified_at: Date.now() });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const enc = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...existing, ssoTokenEnc: enc }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── 本机探测 ──

function decodeTasklist(buf) {
  // Windows 控制台代码页（简体中文 GBK）输出，中文名需按 gbk 解码
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}

export function catpawRunning() {
  if (runningOverride !== null) return runningOverride;   // 测试钩子
  if (process.platform !== 'win32') return false;
  try {
    const out = decodeTasklist(execFileSync('tasklist.exe',
      ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH'],
      { windowsHide: true, encoding: 'buffer', timeout: 8000 }));
    // 无匹配时 tasklist 输出 INFO 行（中文系统为 GBK 代码页，见 decodeTasklist）
    return out.toLowerCase().includes(EXE_NAME.toLowerCase()) && !/no tasks|没有找到|没有任务/i.test(out);
  } catch { return false; }
}

export function candidateClientPath() {
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const p = path.join(local, '妙手', EXE_NAME);
  return fs.existsSync(p) ? p : null;
}

export function detectCatpaw() {
  const file = credentialFile();
  const cred = readCredential();
  const clientPath = candidateClientPath();
  return {
    dataDir: path.dirname(file),
    exists: fs.existsSync(file),
    signedIn: Boolean(cred),
    clientInstalled: Boolean(clientPath),
    clientPath,
    running: catpawRunning(),
  };
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function terminateCatpaw({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  if (!catpawRunning()) return { closed: false, running: false };
  try { execFileSync('taskkill.exe', ['/IM', EXE_NAME, '/T'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 }); } catch {}
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && catpawRunning()) nap(250);
  if (catpawRunning()) {
    try { execFileSync('taskkill.exe', ['/IM', EXE_NAME, '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 }); } catch {}
    deadline = Date.now() + 3000;
    while (Date.now() < deadline && catpawRunning()) nap(250);
  }
  return { closed: !catpawRunning(), running: catpawRunning() };
}

/** 当前客户端登录的 token（面板「客户端当前」标识用，避免额外网络请求） */
export function currentCatpawToken() {
  try { return readCredential()?.accessToken || null; } catch { return null; }
}

// ── 当前会话读取与切换 ──

/**
 * 读取妙手客户端当前登录，返回标准化账号对象（供 addAccount / scan）。
 * uid / name 通过网关 auth/current-user 补全（离线时降级为只带 token）。
 */
export async function liveToAccount() {
  const cred = readCredential();
  if (!cred) return null;
  const account = {
    provider: 'catpaw',
    token: cred.accessToken,
    refreshToken: null,
    uid: null,
    name: null,
    expiresAt: null,
    source: 'local-app',
    meta: { capturedAt: new Date().toISOString() },
  };
  try {
    const { fetchCatpawProfile } = await import('./catpawClient.js');
    const p = await fetchCatpawProfile(cred.accessToken);
    if (p) {
      account.uid = p.userId ? String(p.userId) : null;
      account.name = p.name || null;
      if (p.mobile) account.meta.phone = p.mobile;
      if (p.avatarUrl) account.meta.avatarUrl = p.avatarUrl;
    }
  } catch {}
  return account;
}

/**
 * 切换妙手客户端当前登录账号（写入加密凭据；客户端重启后生效）。
 * @param {object} account 目标账号
 * @param {{ force?: boolean }} opts
 */
export async function switchTo(account, { force = false } = {}) {
  const cred = readCredential();
  if (!cred) throw new Error('本机妙手客户端没有可用的登录凭据（无法派生本机密钥或未登录过）');
  if (account.token === cred.accessToken) return { switched: false, alreadyActive: true };

  if (!force && catpawRunning()) {
    const err = new Error('妙手客户端正在运行，请先退出后再切换（或强制切换，切换后自动重新拉起客户端）');
    err.catpawRunning = true;
    throw err;
  }
  writeCredential(account.token);
  return { switched: true, alreadyActive: false };
}

// ── 测试钩子（仅单元测试使用；不影响默认路径） ──

/** 注入固定机器 ID 派生密钥（null 恢复真实探测）；同时复位密钥缓存 */
export function _setMachineIdForTests(id) {
  machineIdOverride = id || null;
  keyCache = null;
}

/** 设置/复位「妙手是否正在运行」的探测结果（null = 真实探测） */
export function _setRunningForTests(running) {
  runningOverride = running === null || running === undefined ? null : Boolean(running);
}

/** 写出加密凭据（等价于切换流程里的落盘一步） */
export function _writeCredentialForTests(accessToken) {
  writeCredential(accessToken);
}
