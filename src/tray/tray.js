/**
 * CLI 托盘 — 移植自 10Router cli/src/cli/tray/tray.js（AGPL-3.0 同族，双向移植免许可记账）。
 *
 * Windows：PowerShell NotifyIcon（零二进制、杀软友好）；macOS/Linux：懒装 systray2
 * （装进用户数据目录 runtime/node_modules，npm 包本体不携带签名二进制——杀软误报防线，
 * 见 trayRuntime.js）。菜单：打开面板 / 立即领取 / 开机自启开关 / 退出。
 *
 * CD 适配差异（对照 10R 原版）：
 *  - 「立即领取」替代 10R 无此项：托盘直达 checkin-all（CD 的核心动作）
 *  - i18n 走 src/i18n.js 的 t()（面板四语词典同一出处），不单独建 tray.json
 *  - 面板地址 = daemon 实际绑定端口（daemon 起来后回填，端口冲突自动 +1 的口径一致）
 */
import { exec } from 'node:child_process';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

let trayInstance = null;
let isWinTray = false;

/** 托盘图标：单色模板图（macOS 菜单栏随明暗着色）→ 品牌 PNG 回落 */
function getIconBase64() {
  const platform = process.platform;
  const iconFile = platform === 'darwin' ? 'icon-template.png' : 'icon-brand.png';
  try {
    const iconPath = path.join(__dirname, iconFile);
    if (fs.existsSync(iconPath)) {
      return fs.readFileSync(iconPath).toString('base64');
    }
  } catch (e) {}
  // 回落：1×1 透明 PNG（systray 无图不注册）
  return 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAHpJREFUOE9jYBgFgwEwMjIy/Gdg+P8fyP4PxP8ZGBgEcBnGyMjIsICBgSEAhyH/gfgBUNN8XJoZsdkCVL8Ah+b/QPwbqvkBMvk/AwMDAzYX/GdgYAhAN+A/SICRWAMYGfFEJSMjzriEiwDR/xmIa2RkZCSqnZERb3QCAAo3KxzxbKe1AAAAAElFTkSuQmCC';
}

function isTraySupported() {
  const platform = process.platform;
  if (!['darwin', 'win32', 'linux'].includes(platform)) return false;
  if (platform === 'linux' && !process.env.DISPLAY) return false;
  return true;
}

/**
 * 初始化托盘。options: { port, onQuit, onOpenPanel, onClaimAll }
 * daemon 未就绪时仍可先挂图标（端口回填靠 setTooltip/updateItem）。
 */
function initTray(options) {
  if (!isTraySupported()) return null;
  if (process.platform === 'win32') return initWindowsTray(options);
  return initUnixTray(options);
}

async function buildMenuItems(port, autostartEnabled) {
  // i18n 延迟取——词典可能随面板切换语言，菜单项构建时取当前值
  const { t } = await import('../i18n.js');
  return [
    { title: t('托盘：CreditDaddy（端口 {port}）', { port: port || '…' }), tooltip: t('服务运行中'), enabled: false },
    { title: t('打开面板'), tooltip: t('在浏览器中打开'), enabled: true },
    { title: t('立即领取全部'), tooltip: t('对所有账号跑一轮签到与活动领取'), enabled: true },
    { title: autostartEnabled ? t('✓ 已开启开机自启') : t('开启开机自启'), tooltip: t('系统启动时自动运行'), enabled: true },
    { title: t('退出'), tooltip: t('停止守护进程并退出'), enabled: true },
  ];
}

const MENU_INDEX = { STATUS: 0, PANEL: 1, CLAIM: 2, AUTOSTART: 3, QUIT: 4 };

async function getAutostartEnabled() {
  try {
    const { isAutoStartEnabled } = await import('./autostart.js');
    return isAutoStartEnabled();
  } catch (e) {
    return false;
  }
}

async function handleClick(index, options, onAutostartToggle) {
  const { onQuit, onOpenPanel, onClaimAll, port } = options;
  const { t } = await import('../i18n.js');
  if (index === MENU_INDEX.PANEL) {
    if (onOpenPanel) onOpenPanel();
    else openBrowser(`http://127.0.0.1:${port || 47860}`);
  } else if (index === MENU_INDEX.CLAIM) {
    if (onClaimAll) onClaimAll();
  } else if (index === MENU_INDEX.AUTOSTART) {
    const enabled = getAutostartEnabled();
    try {
      const { enableAutoStart, disableAutoStart } = await import('./autostart.js');
      if (enabled) disableAutoStart();
      else enableAutoStart();
      onAutostartToggle(!enabled);
    } catch (e) {}
  } else if (index === MENU_INDEX.QUIT) {
    console.log(t('\n正在停止 CreditDaddy…'));
    if (onQuit) onQuit();
    killTray();
    setTimeout(() => process.exit(0), 500);
  }
}

async function initWindowsTray(options) {
  try {
    const { initWinTray, winTrayIconPath } = await import('./trayWin.js');
    const { t } = await import('../i18n.js');
    const iconPath = winTrayIconPath();
    const autostartEnabled = await getAutostartEnabled();
    const items = await buildMenuItems(options.port, autostartEnabled);
    trayInstance = initWinTray({
      iconPath,
      tooltip: t('CreditDaddy - 端口 {port}', { port: options.port || '…' }),
      items,
      onClick: (index) => {
        handleClick(index, options, async (newEnabled) => {
          const { t: tt } = await import('../i18n.js');
          trayInstance.updateItem(MENU_INDEX.AUTOSTART, newEnabled ? tt('✓ 已开启开机自启') : tt('开启开机自启'), true);
        });
      },
    });
    isWinTray = true;
    return trayInstance;
  } catch (err) {
    return null;
  }
}

/** macOS/Linux：懒装 systray2（trayRuntime 负责），装不上时托盘静默降级（无图标但 daemon 照常） */
async function resolveSystray() {
  let runtimeDir = null;
  try {
    const { getRuntimeNodeModules } = await import('./trayRuntime.js');
    runtimeDir = getRuntimeNodeModules();
  } catch (e) {}
  const candidates = [];
  if (runtimeDir) {
    candidates.push(path.join(runtimeDir, 'systray2'), path.join(runtimeDir, 'systray'));
  }
  candidates.push('systray2', 'systray');
  for (const spec of candidates) {
    try {
      const mod = nodeRequire(spec);
      if (mod && (mod.default || mod)) return { mod: mod.default || mod, isV2: String(spec).endsWith('systray2') };
    } catch (e) {}
  }
  return null;
}

async function chmodTrayBin(pkgName) {
  // systray2 的 Go 二进制偶发落盘没带 +x（macOS 实测），spawn 时 EACCES 静默失败难排查
  try {
    const { getRuntimeNodeModules } = await import('./trayRuntime.js');
    const binName = process.platform === 'darwin' ? 'tray_darwin_release' : 'tray_linux_release';
    const candidates = [
      path.join(getRuntimeNodeModules(), pkgName, 'traybin', binName),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
  } catch (e) {}
}

async function initUnixTray(options) {
  try {
    const resolved = await resolveSystray();
    if (!resolved) return null;
    const { mod: SysTray, isV2 } = resolved;
    const { t } = await import('../i18n.js');
    await chmodTrayBin(isV2 ? 'systray2' : 'systray');

    const autostartEnabled = await getAutostartEnabled();
    const items = await buildMenuItems(options.port, autostartEnabled);
    const menu = {
      icon: getIconBase64(),
      // macOS：模板模式——icon-template.png 的 alpha 通道即图形，菜单栏随明暗着色；
      // 彩色品牌图的 alpha 是实心方块不能做模板。Linux 面板无模板惯例 → 用彩色图。
      isTemplateIcon: process.platform === 'darwin',
      title: '',
      tooltip: t('CreditDaddy - 端口 {port}', { port: options.port || '…' }),
      items,
    };
    trayInstance = new SysTray({ menu, debug: false, copyDir: true });
    isWinTray = false;
    trayInstance.onClick((action) => {
      handleClick(action.seq_id, options, (newEnabled) => {
        trayInstance.sendAction({
          type: 'update-item',
          item: { title: newEnabled ? t('✓ 已开启开机自启') : t('开启开机自启'), tooltip: t('系统启动时自动运行'), enabled: true },
          seq_id: MENU_INDEX.AUTOSTART,
        });
      });
    });
    if (isV2 && typeof trayInstance.ready === 'function') {
      trayInstance.ready().catch(() => {});
    }
    return trayInstance;
  } catch (err) {
    return null;
  }
}

/** 停托盘，等子进程完全退出（macOS 不释放 NSStatusItem 会留幽灵图标、重挂注册不上） */
function killTray() {
  const instance = trayInstance;
  const wasWin = isWinTray;
  trayInstance = null;
  if (!instance) return Promise.resolve();

  if (wasWin) {
    try { instance.kill(); } catch (e) {}
    return Promise.resolve();
  }

  let proc = null;
  try {
    proc = instance._process || (typeof instance.process === 'function' ? instance.process() : null);
  } catch (e) {}

  const gracefulQuit = () => { try { instance.kill(true); } catch (e) {} };
  const closeIpc = () => { try { instance.kill(false); } catch (e) {} };

  if (!proc || !proc.pid) {
    gracefulQuit();
    closeIpc();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; closeIpc(); resolve(); };
    proc.once('exit', finish);
    gracefulQuit();
    setTimeout(() => { try { process.kill(proc.pid, 0); proc.kill('SIGTERM'); } catch (e) {} }, 800);
    setTimeout(() => { try { process.kill(proc.pid, 0); proc.kill('SIGKILL'); } catch (e) {} }, 1600);
    const deadline = Date.now() + 3000;
    const poll = setInterval(() => {
      try { process.kill(proc.pid, 0); } catch { clearInterval(poll); finish(); return; }
      if (Date.now() > deadline) { clearInterval(poll); finish(); }
    }, 50);
  });
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') cmd = `open "${url}"`;
  else if (platform === 'win32') cmd = `start "" "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd);
}

export { initTray, killTray, isTraySupported, MENU_INDEX };
