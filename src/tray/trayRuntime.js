/**
 * systray2 运行时懒装 — 移植自 10Router cli/hooks/trayRuntime.js（AGPL-3.0 同族）。
 *
 * npm 发布包不携带签名 Go 二进制（杀软误报防线）：macOS/Linux 的托盘二进制
 * 首次使用时按需 npm install 进用户数据目录 runtime/node_modules。Windows 不需要
 * （PowerShell 方案零二进制）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SYSTRAY_PKG = 'systray2';
const SYSTRAY_VERSION = '2.1.4';
const LEGACY_SYSTRAY_PKG = 'systray';

function getRuntimeDir() {
  // <数据目录>/runtime —— 与账号库同盘同权限纪律；store.js 的 dataDir 惰性求值
  try {
    const { dataDir } = require('../store.js');
    return path.join(dataDir(), 'runtime');
  } catch (e) {
    // store 不可用（极端）退回 os.homedir()
    return path.join(require('node:os').homedir(), '.creditdaddy', 'runtime');
  }
}

function getRuntimeNodeModules() {
  return path.join(getRuntimeDir(), 'node_modules');
}

function hasSystray() {
  return fs.existsSync(path.join(getRuntimeNodeModules(), SYSTRAY_PKG, 'package.json'));
}

/** 清理旧版 systray@1.0.5（其 Go 二进制 Mach-O 头被 macOS 14+ dyld 拒绝，托盘静默失败） */
function cleanupLegacySystray({ silent = false } = {}) {
  const targets = [
    path.join(getRuntimeNodeModules(), LEGACY_SYSTRAY_PKG),
  ];
  for (const dir of targets) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        if (!silent) console.log(`[tray] removed legacy systray: ${dir}`);
      } catch (e) {
        if (!silent) console.warn(`[tray] failed to remove ${dir}: ${e.message}`);
      }
    }
  }
}

/** spawnSync npm install；npm 不可用 / 网络不通时返回 null（托盘降级无图标，daemon 照常） */
function runNpmInstall({ silent = false } = {}) {
  const runtimeDir = getRuntimeDir();
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (e) {
    return null;
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund', '--omit-dev', `${SYSTRAY_PKG}@${SYSTRAY_VERSION}`], {
    cwd: runtimeDir,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (res.status !== 0) {
    if (!silent) console.warn(`[tray] systray2 install failed: ${res.stderr || res.error || 'exit ' + res.status}`);
    return null;
  }
  return path.join(getRuntimeNodeModules(), SYSTRAY_PKG);
}

/**
 * 确保托盘运行时就绪（CLI 启动时调用）。失败不抛——托盘是增强能力，不是 daemon 的依赖。
 * @returns {{installed: boolean, cleaned: boolean}}
 */
function ensureTrayRuntime({ silent = false } = {}) {
  if (process.platform === 'win32') return { installed: false, cleaned: false };   // Windows 用 PowerShell 方案
  let cleaned = false;
  try {
    cleanupLegacySystray({ silent });
    cleaned = true;
  } catch (e) {}
  if (hasSystray()) return { installed: true, cleaned };
  const installed = Boolean(runNpmInstall({ silent }));
  return { installed, cleaned };
}

export { ensureTrayRuntime, getRuntimeDir, getRuntimeNodeModules, hasSystray, cleanupLegacySystray };
