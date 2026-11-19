/**
 * Windows 托盘（PowerShell NotifyIcon）— 移植自 10Router cli/src/cli/tray/trayWin.js（AGPL-3.0 同族，10R ← CD 双向移植免记账）。
 *
 * 为什么不用 systray 的 Go 二进制：杀软误报（Kaspersky 等 flag tray_windows.exe），
 * PowerShell 方案零二进制依赖、免签名。IPC：stdin JSON 命令 / stdout JSON 事件。
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';

let psProcess = null;
let clickHandler = null;

/**
 * Windows 托盘背景主题：true = 浅色，false = 深色（默认）。
 * 任务栏颜色跟随「Windows 模式」(SystemUsesLightTheme)，不是「应用模式」
 * (AppsUseLightTheme)——自定义主题下两者可不同，优先读任务栏自己的值。
 */
function isWindowsLightTheme() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
  try {
    const out = execSync(`reg query "${key}" /v SystemUsesLightTheme`, {
      encoding: 'utf8', timeout: 2000, windowsHide: true,
    });
    return /0x1\b/.test(out);
  } catch (e) { /* fall through to app mode */ }
  try {
    const out = execSync(`reg query "${key}" /v AppsUseLightTheme`, {
      encoding: 'utf8', timeout: 2000, windowsHide: true,
    });
    return /0x1\b/.test(out);
  } catch (e) {
    return false;
  }
}

/** 单色托盘图标跟随系统主题（深任务栏白色 / 浅任务栏黑色），缺资源回落品牌彩图标 */
function winTrayIconPath() {
  const mono = path.join(__dirname, isWindowsLightTheme() ? 'icon-mono-black.ico' : 'icon-mono-white.ico');
  try {
    if (fs.existsSync(mono)) return mono;
  } catch (e) {}
  return path.join(__dirname, 'icon.ico');
}

function sendCommand(cmd) {
  if (psProcess && psProcess.stdin.writable) {
    psProcess.stdin.write(`${JSON.stringify(cmd)}\n`, 'utf8');
  }
}

/**
 * 初始化 Windows 托盘
 * @param {Object} options - { iconPath, tooltip, items, onClick }
 * @returns {Object|null} controller with updateItem/setTooltip/kill
 */
function initWinTray(options) {
  const { iconPath, tooltip, items, onClick } = options;
  clickHandler = onClick;

  const scriptPath = path.join(__dirname, 'tray.ps1');

  try {
    psProcess = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-InputFormat', 'Text',
        '-OutputFormat', 'Text',
        '-File', scriptPath,
        '-IconPath', iconPath,
        '-Tooltip', tooltip,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    return null;
  }

  const rl = readline.createInterface({ input: psProcess.stdout });
  rl.on('line', (line) => {
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'click' && clickHandler) {
        clickHandler(evt.index);
      }
    } catch (e) {}
  });

  psProcess.on('error', () => {});
  psProcess.stderr.on('data', () => {});

  items.forEach((item, index) => {
    sendCommand({ action: 'add-item', index, title: item.title, enabled: item.enabled });
  });

  return {
    updateItem(index, title, enabled) {
      sendCommand({ action: 'update-item', index, title, enabled });
    },
    setTooltip(text) {
      sendCommand({ action: 'set-tooltip', text });
    },
    kill() {
      try {
        sendCommand({ action: 'kill' });
      } catch (e) {}
      setTimeout(() => {
        if (psProcess && !psProcess.killed) {
          try { psProcess.kill(); } catch (e) {}
        }
        psProcess = null;
      }, 300);
    },
  };
}

export { initWinTray, isWindowsLightTheme, winTrayIconPath };
