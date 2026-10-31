/**
 * 科大讯飞 Loomy 桌面客户端本机凭据读取与多账号切换。
 *
 * 凭据存储（Windows）：
 *   C:\Users\Public\Loomy\<UserHash>\userData\auth-session.json
 *   UserHash = sha256(os.userInfo().username).slice(0, 12)
 *   结构：{ session, userid, phone, updatedAt }
 *
 * 账号切换：Loomy 启动时读取该文件恢复登录，写入目标账号的 session/userid/phone
 * 并重启客户端即完成换号。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const EXE_NAME = 'Loomy.exe';

function userHash() {
  const username = os.userInfo().username;
  return crypto.createHash('sha256').update(username).digest('hex').slice(0, 12);
}

export function credentialFile() {
  if (process.env.LOOMY_CREDENTIAL_FILE) return process.env.LOOMY_CREDENTIAL_FILE;
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.config', 'loomy', 'userData', 'auth-session.json');
  }
  return path.join('C:', 'Users', 'Public', 'Loomy', userHash(), 'userData', 'auth-session.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 读取本机当前登录的 Loomy 凭据 → { session, userid, phone, updatedAt }；未登录返回 null */
export function readCredential() {
  const file = credentialFile();
  const j = readJson(file);
  if (!j || !j.session || !j.userid) return null;
  return {
    session: String(j.session).trim(),
    userid: String(j.userid).trim(),
    phone: String(j.phone || '').trim(),
    updatedAt: j.updatedAt || null,
  };
}

/** 写回凭据文件（用于换号） */
export function writeCredential({ session, userid, phone = '' }) {
  const file = credentialFile();
  const existing = readJson(file) || {};
  const next = {
    ...existing,
    session: String(session).trim(),
    userid: String(userid).trim(),
    phone: String(phone || '').trim(),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 探测 Loomy 是否在运行 */
export function loomyRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist.exe',
      ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH'],
      { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    return out.toLowerCase().includes(EXE_NAME.toLowerCase()) && !/no tasks|没有找到|没有任务/i.test(out);
  } catch { return false; }
}

/** 获取本机 Loomy.exe 路径 */
export function candidateClientPath() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    'C:\\Program Files\\Loomy\\Loomy.exe',
    'C:\\Program Files (x86)\\Loomy\\Loomy.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Loomy', 'Loomy.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** 本机 Loomy 综合探测 */
export function detectLoomy() {
  const file = credentialFile();
  const cred = readCredential();
  const clientPath = candidateClientPath();
  return {
    dataDir: path.dirname(file),
    exists: fs.existsSync(file),
    signedIn: Boolean(cred),
    clientInstalled: Boolean(clientPath),
    clientPath,
    running: loomyRunning(),
    credential: cred ? {
      userid: cred.userid,
      phone: cred.phone ? `${cred.phone.slice(0, 3)}****${cred.phone.slice(-4)}` : null,
      updatedAt: cred.updatedAt,
    } : null,
  };
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function terminateLoomy({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  if (!loomyRunning()) return { closed: false, running: false };
  try { execFileSync('taskkill.exe', ['/IM', EXE_NAME, '/T'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 }); } catch {}
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && loomyRunning()) nap(250);
  if (loomyRunning()) {
    try { execFileSync('taskkill.exe', ['/IM', EXE_NAME, '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 }); } catch {}
    deadline = Date.now() + 3000;
    while (Date.now() < deadline && loomyRunning()) nap(250);
  }
  return { closed: !loomyRunning(), running: loomyRunning() };
}

/** 当前客户端登录的用户 ID（面板「客户端当前」徽章按 uid 比对——publicAccount 不下发 token，面板侧只能比 uid） */
export function currentLoomyUid() {
  try { return readCredential()?.userid || null; } catch { return null; }
}

/**
 * 读取 Loomy 客户端当前登录，返回标准化账号对象（供 addAccount / 本机导入）。
 */
export async function liveToAccount() {
  const cred = readCredential();
  if (!cred) return null;
  const phoneMasked = cred.phone ? `${cred.phone.slice(0, 3)}****${cred.phone.slice(-4)}` : null;
  return {
    provider: 'loomy',
    token: cred.session,
    refreshToken: null,
    uid: cred.userid,
    name: phoneMasked ? `Loomy (${phoneMasked})` : `Loomy (${cred.userid.slice(-6)})`,
    expiresAt: null,
    source: 'local-app',
    meta: {
      phone: cred.phone,
      capturedAt: new Date().toISOString(),
    },
  };
}

const napAsync = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 硬切换：客户端退出清理会把内存里的旧登录写回 auth-session.json（迟到写入者——
 * 「客户端没跑就直接写」的温和路径实测会被它回写冲掉，表现为「切了没生效」）。
 * 统一走：先杀客户端 → 写凭据 → 延时复核 → 发现被回写冲掉就再补写一次 → 报告是否落定。
 * 客户端重新打开时 restore() 无校验直接应用文件里的 session，落定即换号成功。
 * 注意：Loomy 客户端界面登录态真源在其渲染层 localStorage（启动时反向推给主进程），
 * 本函数落定的是主进程/opencode 侧的凭据；界面换号仍需在客户端内退出重登。
 */
export async function hardSwitchLoomy(account) {
  if (!account?.token) throw new Error('目标账号缺少 session token');
  const cred = readCredential();
  // 凭据文件缺失（未装过客户端 / 用户在客户端里退出登录把它清空）不该挡切换——
  // 目标账号的 session/userid/phone 在账号库里齐全，直接写就是
  const userid = account.uid || cred?.userid;
  if (!userid) throw new Error('目标账号缺少 userid，无法写入 Loomy 凭据（请重新登录该账号后再切换）');
  if (cred && account.token === cred.session) {
    return { switched: false, alreadyActive: true, closedClient: false, verified: true };
  }

  const wasRunning = loomyRunning();
  const t = terminateLoomy();
  const closedClient = wasRunning && t.running === false;

  const next = { session: account.token, userid, phone: account.meta?.phone || '' };
  writeCredential(next);
  await napAsync(1200);
  let verified = readCredential()?.session === account.token;
  if (!verified) {
    writeCredential(next);
    await napAsync(1200);
    verified = readCredential()?.session === account.token;
  }
  return { switched: true, alreadyActive: false, closedClient, verified };
}
