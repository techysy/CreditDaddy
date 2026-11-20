/**
 * Croli 桌面客户端本机凭据读取与多账号切换。
 *
 * 凭据存储（Windows，2026-11-20 本机实测 v0.0.17）：
 *   %APPDATA%\Croli\auth.json
 *     { access_token: <Clerk JWT>, refresh_token, expires_at: <epoch 秒> }
 *   ——明文 JSON，无加密壳（与 DuMate 的 AES-GCM 密钥罐不同），读即用。
 *   JWT claims：iss=https://clerk.croli.net，client_id=znV4SkcUsY1AektQ，
 *   scope=profile email offline_access，寿命 24h。
 *
 * 刷新：sidecar croli-server.exe 持有 refresh_token 自动轮换回写 auth.json
 * （Clerk refresh token 是轮换制——每次刷新旧 rt 即作废）。所以：
 *   - 读：随时读都是 sidecar 刚回写的新鲜 token，本机导入零续期负担；
 *   - 切：必须沿用 Loomy/DuMate 硬切纪律——切前把 live 快照回写账号库（防丢号，
 *     daemon switch 路由已做），杀 Croli.exe + croli-server.exe → 原子写目标
 *     auth.json → 延时复核（防退出清理回写）→ 面板重开客户端。
 *   注意：账号库存的 rt 是捕获时刻的快照，若客户端在库外又刷过，rt 可能已被
 *   轮换作废——切换写入后复核 access_token 是否落地即可，凭据失效时提示用户
 *   在客户端重新登录该账号后再次导入（与 Loomy 口径一致）。
 *
 * 安全纪律：token 只在本机进程内流转，不落日志、不出本机。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { t } from './i18n.js';

const EXE_NAMES = ['Croli.exe', 'croli-server.exe', 'croli-cli.exe'];

/** %APPDATA%\Croli（客户端 userData 根，auth.json 所在） */
export function croliDataDir() {
  if (process.env.CROLI_DATA_DIR) return process.env.CROLI_DATA_DIR;
  if (process.platform !== 'win32') {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(cfg, 'Croli');
  }
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Croli');
}

export function authFile() {
  return path.join(croliDataDir(), 'auth.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 读取本机当前登录凭据 → { accessToken, refreshToken, expiresAt(ms), expired }
 * 未登录 / 文件缺失返回 null。expires_at 是秒级 epoch。
 */
export function readCroliCredential() {
  const j = readJson(authFile());
  if (!j?.access_token) return null;
  const expSec = Number(j.expires_at) || 0;
  return {
    accessToken: String(j.access_token),
    refreshToken: j.refresh_token ? String(j.refresh_token) : null,
    expiresAt: expSec > 0 ? expSec * 1000 : null,
    expired: expSec > 0 && expSec * 1000 < Date.now(),
  };
}

/** Clerk JWT 的 sub（user_…）——归户 uid；解析失败返回 null */
export function croliSubOf(jwt) {
  try {
    const seg = String(jwt || '').split('.');
    if (seg.length !== 3) return null;
    return JSON.parse(Buffer.from(seg[1], 'base64url').toString('utf8'))?.sub || null;
  } catch { return null; }
}

function procRunningCached(exeNames) {
  // 轻量判定：tasklist 查主壳即可（croli-server 随壳起）
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exeNames[0]}`, '/NH'],
      { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    return out.toLowerCase().includes(exeNames[0].toLowerCase()) && !/no tasks|没有找到|没有任务/i.test(out);
  } catch { return false; }
}

/** 客户端可执行文件候选路径（与 desktop/main.js open-croli-client 同口径） */
export function candidateClientPath() {
  if (process.env.CROLI_CLIENT_PATH) return process.env.CROLI_CLIENT_PATH;
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cands = [
    path.join(local, 'Programs', 'Croli', 'Croli.exe'),
    'C:\\Program Files\\Croli\\Croli.exe',
    'C:\\Program Files (x86)\\Croli\\Croli.exe',
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略不可读候选 */ }
  }
  return null;
}

/** 本机安装/登录态盘点（detect* 家族口径）：installed / signedIn / running / expired */
export function detectCroli() {
  const clientPath = candidateClientPath();
  const cred = readCroliCredential();
  return {
    installed: Boolean(clientPath),
    clientPath,
    signedIn: Boolean(cred),
    running: process.platform === 'win32' ? procRunningCached(EXE_NAMES) : false,
    expired: cred ? cred.expired : false,
  };
}

/** 本机当前登录 → CD 账号记录（本机导入线 liveToAccount 同构） */
export async function liveToAccount() {
  const cred = readCroliCredential();
  if (!cred) return null;
  const uid = croliSubOf(cred.accessToken);
  const masked = uid ? `${uid.slice(0, 5)}…` : null;
  const name = uid ? `Croli (${masked})` : 'Croli (本机)';
  return {
    provider: 'croli',
    token: cred.accessToken,
    refreshToken: cred.refreshToken,
    uid,
    name,
    expiresAt: cred.expiresAt ? new Date(cred.expiresAt).toISOString() : null,
    source: 'local-app',
    meta: {
      croliAuthFile: authFile(),
      capturedAt: new Date().toISOString(),
    },
  };
}

/* ───────────────────── 账号切换（写客户端凭据，Loomy/DuMate hardSwitch 同构） ─────────────────────
 *
 * Croli 启动路径：Electron 壳拉起 croli-server.exe（sidecar），sidecar 读
 * %APPDATA%\Croli\auth.json 恢复登录并持有 refresh_token 自动轮换。CD 冷状态
 * 重写 auth.json 即完成切换：杀壳与 sidecar → 原子写文件 → 延时复核（防退出
 * 清理回写）→ 面板重开客户端。refresh_token 轮换制意味着写入的 rt 快照可能是
 * 已轮换的旧值——sidecar 刷新失败时会退回登录态，凭据失效按客户端内重登处理。
 */

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const napAsync = (ms) => new Promise((r) => setTimeout(r, ms));

/** 杀客户端壳 + sidecar + CLI（切换期间它们缓存旧账号身份、可能回写凭据） */
export function terminateCroli({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  const anyRunning = () => EXE_NAMES.some((exe) => {
    try {
      const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exe}`, '/NH'],
        { windowsHide: true, encoding: 'utf8', timeout: 8000 });
      return out.toLowerCase().includes(exe.toLowerCase()) && !/no tasks|没有找到|没有任务/i.test(out);
    } catch { return false; }
  });
  if (!anyRunning()) return { closed: false, running: false };
  for (const exe of EXE_NAMES) {
    try { execFileSync('taskkill.exe', ['/IM', exe, '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 }); } catch {}
  }
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && anyRunning()) nap(250);
  return { closed: !anyRunning(), running: anyRunning() };
}

function writeAuthJson(next) {
  const tmp = `${authFile()}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, authFile());
}

/** 按 CD 账号匹配目标凭据：优先 meta.croliRefreshToken 全等，回落 uid（JWT sub）全等 */
function matchesTarget(account, cred) {
  if (account?.meta?.croliRefreshToken && cred.refreshToken
    && account.meta.croliRefreshToken === cred.refreshToken) return true;
  const wantUid = account?.uid || croliSubOf(account?.token);
  if (!wantUid) return false;
  return croliSubOf(cred.accessToken) === wantUid;
}

/**
 * 硬切换：杀客户端 + sidecar → 重写 auth.json → 延时复核。
 * requireClient=false 仅供测试注入（非 Windows 验证写入/复核逻辑）。
 */
export async function hardSwitchCroli(account, { requireClient = true } = {}) {
  if (!account?.token) throw new Error(t('目标账号缺少 Croli 凭据'));
  const current = readCroliCredential();
  if (!current) {
    const err = new Error(t('未读到 Croli 客户端凭据库（%APPDATA%\\Croli\\auth.json）——请先安装客户端并登录任一账号'));
    err.croliNotInstalled = true;
    throw err;
  }
  if (matchesTarget(account, current)) {
    return { switched: false, alreadyActive: true, closedClient: false, verified: true };
  }
  if (requireClient && process.platform !== 'win32') {
    const err = new Error(t('Croli 客户端仅支持 Windows，本平台无法切换'));
    err.croliNotInstalled = true;
    throw err;
  }

  const wasRunning = procRunningCached(EXE_NAMES);
  const term = terminateCroli();
  const closedClient = wasRunning && term.running === false;

  // 客户端凭据形状就是 auth.json 三键——目标账号存的捕获快照原样写回
  const next = {
    access_token: account.token,
    ...(account.refreshToken ? { refresh_token: account.refreshToken } : {}),
    ...(account.expiresAt ? { expires_at: Math.floor(new Date(account.expiresAt).getTime() / 1000) } : {}),
  };
  writeAuthJson(next);
  await napAsync(1200);
  let verified = matchesTarget(account, readCroliCredential());
  if (!verified) {
    writeAuthJson(next);
    await napAsync(1200);
    verified = matchesTarget(account, readCroliCredential());
  }
  return { switched: true, alreadyActive: false, closedClient, verified };
}
