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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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

  const record = Object.values(authData.records).find((r) => r?.accessToken);
  if (!record || !record.accessToken) return null;

  let profile = null;
  try {
    profile = await fetchMiniMaxProfile(record.accessToken);
  } catch {
    // profile 失败不影响返回基础账号信息
  }

  const uid = profile?.userId || record.subject || record.accountId || null;
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
      authRecordKey: Object.keys(authData.records)[0],
      clientId: record.clientId,
      scopes: record.scopes,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * 获取当前登录的 UID
 */
export function currentMiniMaxUid() {
  const authFile = minimaxAuthPath();
  const authData = readJson(authFile);
  if (!authData?.records) return null;
  const record = Object.values(authData.records).find((r) => r?.accessToken);
  return record?.subject || record?.accountId || null;
}
