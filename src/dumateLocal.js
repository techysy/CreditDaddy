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
import { execFileSync } from 'node:child_process';
import { procRunningCached } from './winProc.js';
import { t } from './i18n.js';

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

/** AES-256-GCM 加密（客户端同款布局）：cookie 数组 → base64( iv(12) || authTag(16) || ciphertext ) */
export function encryptDumateCookies(cookies, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(cookies), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
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

/* ───────────────────── 账号切换（写客户端凭据，Loomy hardSwitch 同构） ─────────────────────
 *
 * 客户端切换事务（asar createSwitchAccountProfileHandler）：停运行时服务 → 解密目标
 * profile → Chromium session 清场换 Cookie → 提交 active 槽（顶层 cookies 重加密 +
 * activeProfileId/activeProviderType）。而启动路径 setCookieProvider(getDecryptedCookies)
 * —— Go 侧代理直接消费 auth.json 注入 Cookie，所以 CD 冷状态重写 auth.json 即完成切换：
 * 杀壳与全部 Go 服务 → 写文件（原子）→ 延时复核（防退出清理回写）→ 面板重开客户端。
 * 与 Loomy 同款注意：客户端窗口的 Chromium 罐残留旧账号 Cookie 时，界面身份可能仍旧，
 * 以控制台 API 实际身份为准（必要时客户端内退出重登）。
 */

const SERVICE_EXES = ['DuMate.exe', 'dumate-main-server.exe', 'dumate-base-proxy.exe', 'dumate-router.exe', 'dumate-opencode.exe', 'dumate-na.exe'];

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const napAsync = (ms) => new Promise((r) => setTimeout(r, ms));

/** 杀客户端壳 + 全部 Go 后端服务（切换期间它们缓存旧账号身份） */
export function terminateDumate({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  const anyRunning = () => SERVICE_EXES.some((exe) => {
    try {
      const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exe}`, '/NH'],
        { windowsHide: true, encoding: 'utf8', timeout: 8000 });
      return out.toLowerCase().includes(exe.toLowerCase()) && !/no tasks|没有找到|没有任务/i.test(out);
    } catch { return false; }
  });
  if (!anyRunning()) return { closed: false, running: false };
  for (const exe of SERVICE_EXES) {
    try { execFileSync('taskkill.exe', ['/IM', exe, '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 }); } catch {}
  }
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && anyRunning()) nap(250);
  return { closed: !anyRunning(), running: anyRunning() };
}

/** 按 CD 账号找目标 profile：优先 meta.dumateProfileId，回落 BDUSS + bce-user-info 值全等匹配 */
function findTargetProfile(account) {
  const j = readJson(authFile());
  if (!j) return null;
  const key = fs.readFileSync(cookieKeyFile());
  const profiles = readDumateProfiles();   // 已过滤企业版/过期 cookie
  const wantHeader = String(account?.token || '');
  const extract = (header, name) => {
    for (const seg of String(header || '').split(';')) {
      const i = seg.indexOf('=');
      if (i > 0 && seg.slice(0, i).trim() === name) return seg.slice(i + 1).trim();
    }
    return null;
  };
  const wantBduss = extract(wantHeader, 'BDUSS') || extract(wantHeader, 'BDUSS_BFESS');
  const wantUi = extract(wantHeader, 'bce-user-info');
  const byId = account?.meta?.dumateProfileId
    ? profiles.find((p) => p.profileId === account.meta.dumateProfileId)
    : null;
  if (byId) return byId;
  if (wantBduss) {
    return profiles.find((p) => {
      const bduss = extract(p.cookieHeader, 'BDUSS') || extract(p.cookieHeader, 'BDUSS_BFESS');
      if (wantUi) {
        const ui = extract(p.cookieHeader, 'bce-user-info');
        if (bduss === wantBduss && ui === wantUi) return true;
      }
      return bduss === wantBduss;
    }) || null;
  }
  return null;
}

function readAuthStore() {
  const j = readJson(authFile());
  if (!j) return null;
  let key = null;
  try { key = fs.readFileSync(cookieKeyFile()); } catch { return null; }
  return { j, key };
}

function writeAuthStore(j) {
  const tmp = `${authFile()}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, authFile());
}

/**
 * 硬切换：杀客户端 + 服务 → 重写 auth.json active 槽（顶层 cookies 重加密）→ 延时复核。
 * requireClient=false 仅供测试注入（非 Windows 验证写入/复核逻辑）。
 */
export async function hardSwitchDumate(account, { requireClient = true } = {}) {
  if (!account?.token) throw new Error(t('目标账号缺少会话 Cookie'));
  if (requireClient && !candidateClientPath()) {
    const err = new Error(process.platform === 'win32'
      ? t('本机未安装 DuMate 客户端，无法切换（切换是把登录写入客户端凭据，由客户端应用）')
      : t('DuMate 客户端仅支持 Windows，本平台无法切换'));
    err.dumateNotInstalled = true;
    throw err;
  }
  const store = readAuthStore();
  if (!store) throw new Error(t('未读到 DuMate 客户端凭据库（auth.json / .cookie-key）'));
  const { j, key } = store;

  const target = findTargetProfile(account);
  if (!target) {
    throw new Error(t('目标账号不是本机 DuMate 客户端已登录的账号，无法写入切换（请先在客户端登录该账号后本机导入）'));
  }
  if (target.active) {
    return { switched: false, alreadyActive: true, closedClient: false, verified: true };
  }
  const validCookies = filterExpiredCookies(target.cookies || []);
  if (!validCookies.length) {
    throw new Error(t('DuMate 目标账号凭据已过期（全部 Cookie 过期），请在客户端重新登录后再切换'));
  }

  const wasRunning = dumateRunningCached();
  const term = terminateDumate();
  const closedClient = wasRunning && term.running === false;

  const next = {
    ...j,
    activeProviderType: 'bce',
    activeProfileId: target.profileId,
    cookies: encryptDumateCookies(validCookies, key),
  };
  writeAuthStore(next);
  await napAsync(1200);
  let verified = readDumateCredential()?.profileId === target.profileId;
  if (!verified) {
    writeAuthStore(next);
    await napAsync(1200);
    verified = readDumateCredential()?.profileId === target.profileId;
  }
  return { switched: true, alreadyActive: false, closedClient, verified };
}
