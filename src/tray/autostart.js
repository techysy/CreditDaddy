/**
 * 开机自启（托盘菜单项）— 移植自 10Router cli/src/cli/tray/autostart.js（AGPL-3.0 同族）。
 * Windows=启动目录 VBS（隐藏窗口直启 node）；macOS=LaunchAgent plist；Linux=XDG autostart .desktop。
 * 不依赖 npm bin -g（npm 9 已移除），cli.js 路径按 __dirname 反推。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const APP_NAME = 'creditdaddy';
const APP_LABEL = 'com.creditdaddy.autostart';

/** 解析本包 cli.js 绝对路径：显式参数 → process.argv[1] → __dirname 反推（全局装布局无关） */
function getCliJsPath(cliPath) {
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.argv[1]) {
    const resolved = path.resolve(process.argv[1]);
    if (path.basename(resolved) === 'creditdaddy.js' && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  // autostart.js 在 <pkg>/src/tray/ 下，cli.js 在 <pkg>/bin/ 下
  const computed = path.resolve(__dirname, '..', '..', 'bin', 'creditdaddy.js');
  if (fs.existsSync(computed)) return computed;
  return null;
}

function enableAutoStart(cliPath) {
  const platform = process.platform;
  if (!['darwin', 'win32', 'linux'].includes(platform)) return false;
  if (platform === 'linux' && !process.env.DISPLAY) return false;
  try {
    if (platform === 'darwin') return enableMacOS(cliPath);
    if (platform === 'win32') return enableWindows(cliPath);
    if (platform === 'linux') return enableLinux(cliPath);
  } catch (err) { /* 自启是可选能力，静默失败 */ }
  return false;
}

function disableAutoStart() {
  const platform = process.platform;
  try {
    if (platform === 'darwin') return disableMacOS();
    if (platform === 'win32') return disableWindows();
    if (platform === 'linux') return disableLinux();
  } catch (e) {}
  return false;
}

/** macOS 需 plist 文件 + launchd 注册同时在才如实报告（launchd 处于失败态时不撒谎） */
function isAutoStartEnabled() {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${APP_LABEL}.plist`);
      if (!fs.existsSync(plistPath)) return false;
      try {
        execSync(`launchctl list ${APP_LABEL}`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000 });
        return true;
      } catch (e) {
        return false;
      }
    } else if (platform === 'win32') {
      const startupPath = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${APP_NAME}.vbs`);
      return fs.existsSync(startupPath);
    } else if (platform === 'linux') {
      const desktopPath = path.join(os.homedir(), '.config', 'autostart', `${APP_NAME}.desktop`);
      return fs.existsSync(desktopPath);
    }
  } catch (e) {}
  return false;
}

/**
 * 当前 Node 进程是否就是 launchd 管理的那个 agent 实例——
 * `launchctl unload` 对 Aqua 域 agent 发 SIGTERM，若托盘点击者自己就是被管理的进程，
 * unload 会杀掉执行点击的进程（图标消失而非菜单翻转）。enable/disable 侧避开。
 */
function isAgentSelfMacOS() {
  try {
    const output = execSync(`launchctl list ${APP_LABEL}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    return !!(match && parseInt(match[1], 10) === process.pid);
  } catch (e) {
    return false;
  }
}

function enableMacOS(cliPath) {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${APP_LABEL}.plist`);
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }
  const nodePath = process.execPath;
  const script = getCliJsPath(cliPath);
  if (!script) return false;
  // node + cli.js 直启（绝对路径、无 shell wrapper）——zsh -l 依赖用户 rc 文件，脆弱
  const launchPath = `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`;
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${script}</string>
        <string>daemon</string>
        <string>--tray</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/creditdaddy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/creditdaddy.error.log</string>
</dict>
</plist>`;
  fs.writeFileSync(plistPath, plistContent);
  if (isAgentSelfMacOS()) return true;   // 不杀自己：plist 已更新，下次登录生效
  try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch (e) {}
  try { execSync(`launchctl load -w "${plistPath}"`, { stdio: 'ignore' }); } catch (e) {}
  return true;
}

function disableMacOS() {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${APP_LABEL}.plist`);
  if (!isAgentSelfMacOS()) {
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch (e) {}
  }
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  return true;
}

function enableWindows(cliPath) {
  const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbsPath = path.join(startupDir, `${APP_NAME}.vbs`);
  if (!fs.existsSync(startupDir)) return false;
  const nodePath = process.execPath;
  const script = getCliJsPath(cliPath);
  if (!script) return false;
  // node + cli.js 直启、隐藏窗口（不绕 .cmd 查找——npm prefix 路径不可靠）
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodePath}"" ""${script}"" daemon --tray", 0, False
`;
  fs.writeFileSync(vbsPath, vbsContent);
  return true;
}

function disableWindows() {
  const vbsPath = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${APP_NAME}.vbs`);
  if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
  return true;
}

function enableLinux(cliPath) {
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopPath = path.join(autostartDir, `${APP_NAME}.desktop`);
  if (!fs.existsSync(autostartDir)) {
    try { fs.mkdirSync(autostartDir, { recursive: true }); } catch (e) { return false; }
  }
  const nodePath = process.execPath;
  const script = getCliJsPath(cliPath);
  if (!script) return false;
  const desktopContent = `[Desktop Entry]
Type=Application
Name=CreditDaddy
Comment=CreditDaddy daemon
Exec=${nodePath} ${script} daemon --tray
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(desktopPath, desktopContent);
  return true;
}

function disableLinux() {
  const desktopPath = path.join(os.homedir(), '.config', 'autostart', `${APP_NAME}.desktop`);
  if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath);
  return true;
}

export { enableAutoStart, disableAutoStart, isAutoStartEnabled };
