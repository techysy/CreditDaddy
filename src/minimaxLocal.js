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

  // auth.json 记录没有稳定 uid 字段，token 又高频轮换：
  // 把 profile 解析出的 uid 按 authRecordKey 缓存，供 currentMiniMaxUid 离线比对。
  const cached = readJson(minimaxUidCachePath()) || {};
  const uid = profile?.userId || record.subject || record.accountId || cached[recordKey] || null;
  if (profile?.userId && cached[recordKey] !== profile.userId) {
    cached[recordKey] = profile.userId;
    try {
      writeJson(minimaxUidCachePath(), cached);
    } catch {
      // 缓存写失败不影响本次返回
    }
  }
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
      authRecordKey: recordKey,
      clientId: record.clientId,
      scopes: record.scopes,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * 获取当前登录的 UID。
 * 优先用 record 自带字段；没有则按 authRecordKey 命中 uid 缓存（token 会轮换，uid 不会）。
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
  const cached = readJson(minimaxUidCachePath());
  return cached?.[recordKey] || null;
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
