/**
 * DuMate 百度搭子（个人版）桌面客户端本机凭据读取。
 *
 * 凭据存储（Windows，2026-11-13 本机实测 v1.0.91/1.0.92）：
 *   %APPDATA%\qianfan-desktop-app\auth.json
 *     { cookies: <base64 密文>, activeProviderType: 'bce'|'enterprise',
 *       accountProfiles: [{ profileId, loginType, bceUserId, bceAccountId, displayName, encryptedCookies }],
 *       activeProfileId }
 *   %APPDATA%\qianfan-desktop-app\.cookie-key   32 字节 AES-256-GCM 密钥（0600）
 *   密文格式（app.asar 注释定版）：base64( iv(12) || authTag(16) || ciphertext )
 *   明文 = Electron cookie 数组 [{ name, value, domain, hostOnly, path, secure, httpOnly, expirationDate, … }]
 *
 * 个人版（loginType=bce）会话即 console.bce.baidu.com 的浏览器 Cookie 罐（BDUSS / bce-user-info 等），
 * 与 10Router dumate 渠道（PR #113）消费的凭据同形——导入后直接可同步。
 * 企业版（enterprise）凭据形状不同，首版不导入。
 *
 * 安全纪律：密钥与明文 Cookie 只在本机进程内流转，不落日志、不出本机。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { procRunningCached } from './winProc.js';

const EXE_NAMES = ['DuMate.exe'];

export function dumateDataDir() {
  if (process.env.DUMATE_DATA_DIR) return process.env.DUMATE_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'qianfan-desktop-app');
  }
  // Linux 侧 Go 后端用 $HOME/.config 承载（app.asar 注释口径）；mac 未实测
  return path.join(os.homedir(), '.config', 'qianfan-desktop-app');
}

export function authFile() { return path.join(dumateDataDir(), 'auth.json'); }
export function cookieKeyFile() { return path.join(dumateDataDir(), '.cookie-key'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** AES-256-GCM 解密：base64( iv(12) || authTag(16) || ciphertext ) → cookie 数组 */
export function decryptDumateCookies(encrypted, key) {
  const raw = Buffer.from(String(encrypted || ''), 'base64');
  if (raw.length < 28 || !key || key.length !== 32) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

/** 过滤已过期 cookie（expirationDate 为秒级 unix；session cookie 无该字段） */
export function filterExpiredCookies(cookies, nowSec = Date.now() / 1000) {
  return (cookies || []).filter((c) => c && c.name && (!c.expirationDate || c.expirationDate > nowSec));
}

/**
 * 读本机全部个人版（bce）账号凭据 → [{ uid, displayName, cookies, cookieHeader, profileId, active }]
 * 未安装 / 未登录 / 解密失败返回 []。
 */
export function readDumateProfiles() {
  const j = readJson(authFile());
  if (!j) return [];
  let key = null;
  try { key = fs.readFileSync(cookieKeyFile()); } catch { return []; }
  const profiles = Array.isArray(j.accountProfiles) && j.accountProfiles.length
    ? j.accountProfiles
    : (j.cookies ? [{ profileId: j.activeProfileId || 'legacy', loginType: j.activeProviderType || 'bce', bceUserId: null, displayName: null, encryptedCookies: j.cookies }] : []);
  const out = [];
  for (const p of profiles) {
    if (!p || (p.loginType && p.loginType !== 'bce')) continue;   // 企业版首版不导入
    const cookies = filterExpiredCookies(decryptDumateCookies(p.encryptedCookies, key));
    if (!cookies || !cookies.length) continue;
    // 个人版会话必须含 BDUSS 与 bce-user-info（10R dumate 同款判定）
    if (!cookies.some((c) => c.name === 'bce-user-info') || !cookies.some((c) => String(c.name).startsWith('BDUSS'))) continue;
    out.push({
      profileId: p.profileId || null,
      uid: p.bceUserId || p.bceAccountId || null,
      displayName: p.displayName || null,
      active: p.profileId === j.activeProfileId,
      cookies,
      cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    });
  }
  return out;
}

/** 当前激活的个人版账号（无则 null） */
export function readDumateCredential() {
  const list = readDumateProfiles();
  return list.find((p) => p.active) || list[0] || null;
}

export function dumateRunningCached() {
  return procRunningCached(EXE_NAMES);
}

export function candidateClientPath() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DuMate', 'DuMate.exe'),
    'C:\\Program Files\\DuMate\\DuMate.exe',
    'C:\\Program Files (x86)\\DuMate\\DuMate.exe',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** 本机 DuMate 综合探测（/api/status 用） */
export function detectDumate() {
  const cred = readDumateCredential();
  const clientPath = candidateClientPath();
  return {
    dataDir: dumateDataDir(),
    exists: fs.existsSync(authFile()),
    signedIn: Boolean(cred),
    clientInstalled: Boolean(clientPath),
    clientPath,
    running: dumateRunningCached(),
    credential: cred ? {
      uid: cred.uid,
      displayName: cred.displayName,
      profiles: readDumateProfiles().length,
    } : null,
  };
}

/**
 * 本机当前登录 → 标准化账号对象（供「添加账号 → 本机导入」）。
 * token = 全量 Cookie 串（10R dumate 渠道 apiKey 同形）。
 */
export async function liveToAccount() {
  const cred = readDumateCredential();
  if (!cred) return null;
  const name = cred.displayName
    ? `DuMate (${cred.displayName})`
    : (cred.uid ? `DuMate (${String(cred.uid).slice(0, 6)}…)` : 'DuMate (本机)');
  return {
    provider: 'dumate',
    token: cred.cookieHeader,
    refreshToken: null,
    uid: cred.uid,
    name,
    expiresAt: null,
    source: 'local-app',
    meta: {
      dumateProfileId: cred.profileId,
      displayName: cred.displayName,
      capturedAt: new Date().toISOString(),
    },
  };
}
