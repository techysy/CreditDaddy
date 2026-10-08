/**
 * MiniMax Code 本机客户端探测与凭据自动读取。
 *
 * MiniMax Code 客户端文件路径：
 *   - 配置与模型: ~/.minimax/config.yaml
 *   - 凭据存储: ~/.minimax/auth/prod/cn/mcode-public/auth.json
 *   - 凭据状态: ~/.minimax/auth/prod/cn/mcode-public/auth-state.json
 *   - 可执行程序（Windows）: %LOCALAPPDATA%\Programs\MiniMax Code\MiniMax Code.exe
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fetchMiniMaxProfile } from './minimaxClient.js';

export function minimaxHome() {
  return process.env.MINIMAX_HOME || path.join(os.homedir(), '.minimax');
}

export function minimaxAuthPath() {
  return path.join(minimaxHome(), 'auth', 'prod', 'cn', 'mcode-public', 'auth.json');
}

export function minimaxAuthStatePath() {
  return path.join(minimaxHome(), 'auth', 'prod', 'cn', 'mcode-public', 'auth-state.json');
}

export function minimaxConfigPath() {
  return path.join(minimaxHome(), 'config.yaml');
}

export function minimaxUidCachePath() {
  const authDir = path.dirname(minimaxAuthPath());
  return path.join(authDir, 'uid-cache.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * recordKey → uid 的小缓存。
 *
 * 为什么需要：auth.json 的 record 只有 accessToken / refreshToken / clientId 这些，
 * 稳定 uid 只能靠 profile 接口拿；profile 偶发失败时（离线 / 接口抖动），
 * 「客户端当前是哪个账号」就没法判断了，缓存一份兜底。
 *
 * 注意：缓存**只对 auth.json 里仍然存在的 record 生效**（见 currentMiniMaxUid）。
 * 客户端登出后 records 为空，此时若还回落到缓存，面板会把某个账号一直标成
 * 「客户端当前」——这正是「客户端明明没登录却显示已登录」的来源，所以读的时候必须
 * 与当前 record 集合求交集，不能无条件回落。
 */
function readUidCache() {
  return readJson(minimaxUidCachePath()) || {};
}

/** 写入 uid 缓存，并顺手丢掉 auth.json 里已经不存在的 record（防止缓存无限膨胀 / 陈旧） */
function writeUidCache(recordKey, uid) {
  if (!recordKey || !uid) return;
  try {
    const cache = readUidCache();
    if (cache[recordKey] === String(uid)) return;
    cache[recordKey] = String(uid);
    const live = liveRecordKeys();
    if (live) for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];
    writeJson(minimaxUidCachePath(), cache);
  } catch {
    // 缓存写失败不影响调用方
  }
}

/** auth.json 里当前仍有 accessToken 的 recordKey 集合；读不到（文件缺失/损坏）返回 null */
function liveRecordKeys() {
  const authData = readJson(minimaxAuthPath());
  if (!authData?.records) return null;
  return new Set(Object.keys(authData.records).filter((k) => authData.records[k]?.accessToken));
}

/**
 * 寻找 MiniMax Code.exe 安装路径
 */
export function minimaxExePath() {
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cand = path.join(local, 'Programs', 'MiniMax Code', 'MiniMax Code.exe');
  return fs.existsSync(cand) ? cand : null;
}

const WIN_TASKLIST = () => {
  try {
    return execSync('tasklist /FI "IMAGENAME eq MiniMax Code.exe" /NH', { windowsHide: true, encoding: 'utf8' });
  } catch {
    return '';
  }
};

/**
 * MiniMax Code 客户端是否正在运行
 */
export function minimaxRunning() {
  if (process.platform !== 'win32') return false;
  return /minimax code\.exe/i.test(WIN_TASKLIST());
}

/**
 * 检测本机 MiniMax 客户端安装与登录状态
 */
export function detectMiniMax() {
  const exe = minimaxExePath();
  const authFile = minimaxAuthPath();
  const exists = Boolean(exe || fs.existsSync(authFile));
  const authData = readJson(authFile);
  const records = authData?.records || {};
  const hasRecord = Object.values(records).some((r) => r?.accessToken);

  return {
    installed: exists,
    exePath: exe,
    authPath: authFile,
    signedIn: hasRecord,
    running: minimaxRunning(),
  };
}

/**
 * 从本机 ~/.minimax 读取当前登录凭据，组装为账号记录
 */
export async function liveToAccount() {
  const authFile = minimaxAuthPath();
  const authData = readJson(authFile);
  if (!authData?.records) return null;

  const recordKey = Object.keys(authData.records).find((k) => authData.records[k]?.accessToken);
  if (!recordKey) return null;
  const record = authData.records[recordKey];
  if (!record || !record.accessToken) return null;

  let profile = null;
  try {
    profile = await fetchMiniMaxProfile(record.accessToken);
  } catch {
    // profile 失败不影响返回基础账号信息
  }

  // auth.json 的记录没有稳定 uid 字段，token 又高频轮换，profile 偶发失败时无处可查 ——
  // 用 recordKey 把 uid 记住，供 currentMiniMaxUid 离线比对（见 minimaxUidCachePath 注释）。
  const uid = profile?.userId || record.subject || record.accountId || readUidCache()[recordKey] || null;
  if (uid) writeUidCache(recordKey, uid);
  const name = profile?.name || (uid ? `MiniMax_${String(uid).slice(-6)}` : 'MiniMax Code');

  return {
    provider: 'minimax',
    token: record.accessToken,
    refreshToken: record.refreshToken || null,
    expiresAt: record.expiresAtMs ? new Date(record.expiresAtMs).toISOString() : null,
    uid: uid ? String(uid) : null,
    name,
    email: profile?.email || null,
    source: 'local-app',
    meta: {
      // 不写 authRecordKey：它是「这条账号绑定本机客户端凭据链」的开关，一旦挂上，
      // 该账号刷新前就会去 auth.json 重读 refreshToken（可能会被别的账号的链顶掉）、
      // 刷新后还会回写 auth.json。本机导入/浏览器登录混用时曾因此让两个账号共用同一条链
      // 互相作废，故这里只留来源标记，链的绑定交给 alignMiniMaxFromLocal 按 uid 判断。
      clientId: record.clientId,
      scopes: record.scopes,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * 获取当前登录的 UID。
 * 优先用 record 自带字段；没有则按 recordKey 命中 uid 缓存（token 会轮换，uid 不会）。
 *
 * records 为空（客户端从未登录 / 已登出）时一律返回 null——绝不回落到缓存。
 * 回落的代价是：客户端登出后 uid 缓存还留着，面板会继续把那个旧账号标成
 * 「客户端当前」，看起来像登出没生效。
 */
export function currentMiniMaxUid() {
  const authFile = minimaxAuthPath();
  const authData = readJson(authFile);
  if (!authData?.records) return null;
  const recordKey = Object.keys(authData.records).find((k) => authData.records[k]?.accessToken);
  if (!recordKey) return null;
  const record = authData.records[recordKey];
  const own = record?.subject || record?.accountId;
  if (own) return String(own);
  return readUidCache()[recordKey] || null;
}

/**
 * 获取当前登录记录的稳定 key（token 轮换时保持不变，可跨账号库匹配）
 */
export function currentMiniMaxRecordKey() {
  const authFile = minimaxAuthPath();
  const authData = readJson(authFile);
  if (!authData?.records) return null;
  return Object.keys(authData.records).find((k) => authData.records[k]?.accessToken) || null;
}

/**
 * 获取当前登录的 Token（用于比对当前登录账号）
 */
export function currentMiniMaxToken() {
  const authFile = minimaxAuthPath();
  const authData = readJson(authFile);
  if (!authData?.records) return null;
  const record = Object.values(authData.records).find((r) => r?.accessToken);
  return record?.accessToken || null;
}

/**
 * 读取指定 record（刷新前对齐本机客户端最新 refreshToken 用）。
 * recordKey 见 liveToAccount 写入的 meta.authRecordKey。
 */
export function readMiniMaxRecord(recordKey) {
  if (!recordKey) return null;
  const authData = readJson(minimaxAuthPath());
  return authData?.records?.[recordKey] || null;
}

/**
 * 刷新前对齐：本机导入账号（带 meta.authRecordKey）从 ~/.minimax auth.json 重读该 record 的
 * 最新凭据，原地更新 account.{token,refreshToken,expiresAt}。
 *
 * 背景：MiniMax 的 refreshToken 是轮换式一次性的，本机客户端会独立刷新（auth.json 的 generation
 * 随之累加）。账号库里的快照可能早被服务端作废，直接用会触发 invalid_grant
 * （"this refresh token can no longer be used"）。device 登录账号无 authRecordKey，跳过（自持独立链）。
 *
 * @returns {boolean} 是否发生了对齐更新
 */
export function alignMiniMaxFromLocal(account, log) {
  const key = account?.meta?.authRecordKey;
  if (!key) return false;
  try {
    // 归属校验：本机客户端同一时刻只登录一个账号，auth.json 里那条 record 属于**它**，
    // 不一定属于调用方这个账号。若两个账号（如「本机导入」与「浏览器登录」）因为历史原因
    // 挂了同一个 authRecordKey，不校验就会拿别人的链去刷新——两个账号共用一次性 refreshToken，
    // 必然互相作废（invalid_grant）。uid 对不上就认定不是本账号的链，直接跳过对齐。
    const rec = readMiniMaxRecord(key);
    if (!rec?.refreshToken || rec.refreshToken === account.refreshToken) return false;
    const recUid = rec.subject || rec.accountId || readUidCache()[key] || null;
    if (recUid && account.uid && String(recUid) !== String(account.uid)) {
      log?.('本机客户端当前登录的是另一个 MiniMax 账号，跳过凭据对齐（避免两条链互相作废）');
      return false;
    }
    account.refreshToken = rec.refreshToken;
    if (rec.accessToken) account.token = rec.accessToken;
    if (rec.expiresAtMs) account.expiresAt = new Date(rec.expiresAtMs).toISOString();
    log?.('检测到本机客户端已轮换凭据，改用最新 refreshToken 刷新…');
    return true;
  } catch {
    return false;
  }
}

/**
 * 安全回写刷新后的凭据到 ~/.minimax auth.json。返回是否实际写入。
 *
 * 仅对「本机导入」账号（带 meta.authRecordKey）且**客户端未运行**时回写：
 *   - device 登录账号（minimaxAuth.js）持有独立 loginEpoch，绝不回写，避免与客户端刷新链互斥；
 *   - 客户端运行中不回写——它内存里的 refreshToken 不受文件控制，回写新 token 会让客户端
 *     下次刷新命中已被我们消费的旧 token（invalid_grant），反而弄坏客户端。
 * 回写失败静默返回 false：账号库已由 refreshContext 更新，下次刷新前会再重读文件对齐。
 */
export function writeMiniMaxAuth(account) {
  const key = account?.meta?.authRecordKey;
  if (!key) return false;
  if (minimaxRunning()) return false;
  const authFile = minimaxAuthPath();
  const authData = readJson(authFile);
  const rec = authData?.records?.[key];
  if (!rec) return false;

  rec.accessToken = account.token;
  if (account.refreshToken) rec.refreshToken = account.refreshToken;
  if (account.expiresAt) {
    const ms = new Date(account.expiresAt).getTime();
    if (Number.isFinite(ms)) rec.expiresAtMs = ms;
  }
  rec.generation = (Number(rec.generation) || 0) + 1;

  const tmp = authFile + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(authData, null, 2), { mode: 0o600, encoding: 'utf8' });
    fs.renameSync(tmp, authFile);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}
