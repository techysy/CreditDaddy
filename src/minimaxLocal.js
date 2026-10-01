/**
 * MiniMax Code 本机凭据读取 — 从客户端数据目录解密登录 token。
 *
 * 路径规划：
 *   Windows: C:\Users\{USER}\AppData\Roaming\MiniMax Code\
 *            - storage.json / setting.json (明文或加密)
 *            - Local State (类似 Electron，可能有全局密钥)
 *
 * 支持两种模式：
 *   1. 本地客户端模式：自动读取客户端配置文件，支持账号切换
 *   2. Gateway 模式：可作为反向代理提供 HTTP 服务（多 token 轮换）
 *
 * 参考 Mirasim 模式：
 *   - setting.json 中的 auth 对象包含 token、userId 等
 *   - 可能被安全存储（safeStorage DPAPI / AES）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from './logger.js';
import { buildExportPayload, sealTransfer, parseImport } from './transfer.js';

/** 原子写 JSON：临时文件 + rename（参照 zcodeLocal.js，避免进程中断损坏配置） */
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── 基础路径 ──

export function minimaxHome() {
  const home = process.env.MINIMAX_HOME || os.homedir();
  return home;
}

export function minimaxInstallPath() {
  // 优先使用用户提供的路径
  if (process.env.MINIMAX_INSTALL_PATH) return process.env.MINIMAX_INSTALL_PATH;

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  // 标准安装路径
  const p1 = path.join(local, 'Programs', 'MiniMax Code');
  if (fs.existsSync(p1)) return p1;

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const p2 = path.join(programFiles, 'MiniMax Code');
  if (fs.existsSync(p2)) return p2;

  return null;
}

export function minimaxDataDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const p = path.join(roaming, 'MiniMax Code');
  if (fs.existsSync(p)) return p;

  // 备用：可能在 AppData/Local
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const p2 = path.join(local, 'MiniMax Code');
  if (fs.existsSync(p2)) return p2;

  return null;
}

// ── 进程管理 ──

/** 当前是否运行中 */
export function minimaxRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq MiniMax Code.exe" /NH',
      { windowsHide: true, encoding: 'utf8' });
    return /minimax code\.exe/i.test(out);
  } catch { return false; }
}

/** 终止 MiniMax 客户端（Windows），返回关闭状态 */
export function terminateMiniMax({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, running: false };
  try { execSync('taskkill /IM "MiniMax Code.exe" /T', { windowsHide: true, stdio: 'ignore' }); } catch {}
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && minimaxRunning()) nap(250);
  if (minimaxRunning()) {
    try { execSync('taskkill /IM "MiniMax Code.exe" /T /F', { windowsHide: true, stdio: 'ignore' }); } catch {}
    deadline = Date.now() + 3000;
    while (Date.now() < deadline && minimaxRunning()) nap(250);
  }
  return { closed: !minimaxRunning(), running: minimaxRunning() };
}

// ── 探测与检测 ──

/** 探测 MiniMax 客户端是否存在及登录状态 */
export function detectMiniMax() {
  const dataDir = minimaxDataDir();
  const exists = Boolean(dataDir && fs.existsSync(dataDir));

  let signedIn = false;
  if (exists) {
    try {
      const filesToCheck = [
        path.join(dataDir, 'storage.json'),
        path.join(dataDir, 'setting.json'),
        path.join(dataDir, 'auth.json'),
      ];

      for (const file of filesToCheck) {
        if (!fs.existsSync(file)) continue;
        const content = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (content?.auth?.token || content?.token) {
          signedIn = true;
          break;
        }
      }
    } catch {}
  }

  const clientPath = minimaxInstallPath();

  return {
    dataDir,
    exists,
    signedIn,
    clientInstalled: Boolean(clientPath),
    clientPath,
    running: minimaxRunning(),
  };
}

// ── 账号操作 ──

/** 读取当前登录的 MiniMax 账号 */
export async function liveToAccount() {
  const dataDir = minimaxDataDir();
  if (!dataDir) return null;

  try {
    // 尝试多个可能的配置文件位置
    const filesToCheck = [
      path.join(dataDir, 'storage.json'),
      path.join(dataDir, 'setting.json'),
      path.join(dataDir, 'auth.json'),
    ];

    let auth = null;
    let userId = null;

    for (const file of filesToCheck) {
      if (!fs.existsSync(file)) continue;

      const content = JSON.parse(fs.readFileSync(file, 'utf8'));

      // 扁平结构
      if (content?.auth?.token) {
        auth = content.auth;
        userId = auth.userId || auth.id || null;
        break;
      }

      // 直接 token 字段
      if (content?.token) {
        auth = { token: content.token };
        userId = content.userId || content.id || null;
        break;
      }
    }

    if (!auth?.token) return null;

    // Token 处理：可能是 Bearer 前缀，也可能是普通 JWT
    let token = auth.token.trim();
    if (!token.startsWith('Bearer ')) {
      token = `Bearer ${token}`;
    }

    return {
      provider: 'minimax',
      token,
      refreshToken: auth.refreshToken || null,
      uid: userId,
      name: auth.name || auth.nickname || auth.userName || null,
      expiresAt: auth.expiresAt || (auth.exp ? new Date(auth.exp * 1000).toISOString() : null),
      source: 'local-app',
      meta: {
        capturedAt: new Date().toISOString(),
        // 带上客户端当前设备 ID，会话迁移（导出/导入）时随包走，目标机可沿用同一设备指纹
        ...(auth.deviceMid ? { deviceMid: auth.deviceMid } : {}),
      },
    };
  } catch (e) {
    logger.error('MINIMAX-LOCAL', `读取账号失败：${e.message}`);
    return null;
  }
}

/** 获取当前登录的 MiniMax UID */
export function currentMiniMaxUid() {
  const dataDir = minimaxDataDir();
  if (!dataDir) return null;

  try {
    const file = path.join(dataDir, 'storage.json');
    if (!fs.existsSync(file)) return null;

    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    return content?.auth?.userId || content?.auth?.id || null;
  } catch {
    return null;
  }
}

/** 验证客户端当前账号是否匹配 */
export function verifyAccountMatch(account) {
  const currentUid = currentMiniMaxUid();
  if (!currentUid) return { match: false, reason: '未检测到客户端登录' };
  if (account.uid !== currentUid) return { match: false, reason: '账号不匹配' };
  return { match: true };
}

/** 写入刷新后的凭据回客户端配置 */
export async function writeMiniMaxAuth(account) {
  const dataDir = minimaxDataDir();
  if (!dataDir) return false;

  const file = path.join(dataDir, 'storage.json');
  if (!fs.existsSync(file)) return false;

  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (!s.auth) s.auth = {};
    if (account.uid && s.auth.userId !== account.uid) return false;

    // 清除 Bearer 前缀再写回（客户端可能自己会加）
    const tokenWithoutPrefix = String(account.token).replace(/^Bearer\s+/i, '');

    s.auth = {
      ...s.auth,
      token: tokenWithoutPrefix,
      refreshToken: account.refreshToken || s.auth.refreshToken,
      userId: account.uid,
      name: account.name || s.auth.name,
      exp: account.expiresAt ? Math.floor(new Date(account.expiresAt).getTime() / 1000) : s.auth.exp,
    };

    atomicWriteJson(file, s);
    return true;
  } catch (e) {
    logger.error('MINIMAX-LOCAL', `写回凭据失败：${e.message}`);
    return false;
  }
}

/** 切换 MiniMax 当前登录账号 */
export async function switchToMiniMax(account, opts = {}) {
  const force = opts.force || false;
  const dataDir = minimaxDataDir();

  if (!dataDir) {
    const err = new Error('未找到 MiniMax 客户端数据目录');
    err.code = 'NO_DATA_DIR';
    throw err;
  }

  const currentUid = currentMiniMaxUid();
  if (account.uid && currentUid && account.uid === currentUid) {
    return { switched: false, alreadyActive: true };
  }

  if (!force && minimaxRunning()) {
    const err = new Error('MiniMax Code 客户端正在运行，请先退出后再切换（或强制切换）');
    err.minimaxRunning = true;
    throw err;
  }

  const file = path.join(dataDir, 'storage.json');
  if (!fs.existsSync(file)) {
    const err = new Error(`配置文件不存在：${file}`);
    err.code = 'NO_CONFIG_FILE';
    throw err;
  }

  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s.auth) s.auth = {};

    // 清除 Bearer 前缀
    const tokenWithoutPrefix = String(account.token).replace(/^Bearer\s+/i, '');

    s.auth = {
      ...s.auth,
      token: tokenWithoutPrefix,
      refreshToken: account.refreshToken || null,
      userId: account.uid,
      name: account.name || null,
      exp: account.expiresAt ? Math.floor(new Date(account.expiresAt).getTime() / 1000) : null,
    };

    atomicWriteJson(file, s);

    return { switched: true, alreadyActive: false };
  } catch (e) {
    logger.error('MINIMAX-LOCAL', `切换账号失败：${e.message}`);
    throw e;
  }
}

// ── 会话导出/导入（跨设备迁移） ──
// 与全局账号导出同一格式：transfer.js 加密信封（scrypt + AES-256-GCM，口令必填），不产明文 token。
// 导出的 .secure.json 也可以在「导入账号」里作为普通 MiniMax 账号导入，两种用途一份文件。

/** 生成虚拟设备 ID（用于风控场景） */
export function generateDeviceMid() {
  return `mini_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** 导出当前会话（口令必填，<4 位时 sealTransfer 抛 TransferError）；无登录态返回 null */
export async function exportCurrentSession(password) {
  const account = await liveToAccount();
  if (!account) return null;
  return sealTransfer(buildExportPayload([account], { provider: 'minimax' }), password);
}

/** 导入远程会话。只接受 transfer.js 加密信封（口令错误/明文 JSON 一律拒绝） */
export async function importRemoteSession(data, password) {
  let parsed;
  try {
    parsed = parseImport(data, { password });
  } catch (e) {
    return { success: false, error: e.message };
  }
  const acc = parsed.accounts.find((a) => a.provider === 'minimax');
  if (!acc?.token || !acc.uid) {
    return { success: false, error: '文件中没有可导入的 MiniMax 会话' };
  }

  const dataDir = minimaxDataDir();
  if (!dataDir) return { success: false, error: '未找到数据目录' };

  const file = path.join(dataDir, 'storage.json');
  if (!fs.existsSync(file)) return { success: false, error: '配置文件不存在' };

  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s.auth) s.auth = {};

    // 目标机已有设备 ID 就沿用本地的（避免顶号），没有才用导出包里的
    if (!s.auth.deviceMid) {
      s.auth.deviceMid = acc.meta?.deviceMid || generateDeviceMid();
    }

    s.auth = {
      ...s.auth,
      token: String(acc.token).replace(/^Bearer\s+/i, ''),   // 与 writeMiniMaxAuth 一致：去前缀写回
      refreshToken: acc.refreshToken || null,
      userId: acc.uid,
      name: acc.name || s.auth.name,
      exp: acc.expiresAt ? Math.floor(new Date(acc.expiresAt).getTime() / 1000) : null,
      deviceMid: s.auth.deviceMid,
    };

    atomicWriteJson(file, s);
    return { success: true, importedUid: acc.uid };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

