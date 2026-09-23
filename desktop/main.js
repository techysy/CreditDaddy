/**
 * CreditDaddy 桌面壳（Electron）：内置 daemon + 托盘常驻。
 *
 *   - 关闭窗口 = 隐藏到托盘，后台自动签到不中断；首次隐藏时弹出气泡提示托盘位置
 *   - 单击托盘图标打开面板；右键菜单：状态 / 打开面板 / 立即签到 / 开机自启 / 打开数据目录 / 退出
 *   - 开机自启以 --hidden 启动：只驻留托盘，不弹窗口
 *   - 打包后从 resources/creditdaddy 加载服务端；开发时（electron desktop/）直接用仓库源码
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PORT = 47860;
const START_HIDDEN = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;
let boundPort = PORT;
let hideHintShown = false;
let lastSummary = '';
let daemonInfo = { version: app.getVersion(), dataDir: '' };

const serverRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'creditdaddy')
  : path.join(__dirname, '..');

// 开发模式使用独立的 userData，避免与已安装版本争抢单实例锁
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'CreditDaddy-dev'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWin());
  app.whenReady().then(boot);
}

async function boot() {
  app.setAppUserModelId('cn.techysy.creditdaddy');
  Menu.setApplicationMenu(null);
  // 托盘最先创建：即使 daemon 启动失败也能从托盘退出
  createTray();
  try {
    const load = (rel) => import(pathToFileURL(path.join(serverRoot, rel)).href);
    const daemon = await load('src/daemon.js');
    const checkin = await load('src/checkin.js');
    const store = await load('src/store.js');
    const constants = await load('src/constants.js');
    const r = await daemon.startDaemon(PORT, '127.0.0.1');
    boundPort = r.port;
    daemonInfo = { version: constants.APP_VERSION, dataDir: store.dataDir() };
    checkin.startScheduler();
  } catch (err) {
    dialog.showErrorBox('CreditDaddy 启动失败', String((err && err.stack) || err));
    quitting = true;
    app.quit();
    return;
  }
  refreshTrayMenu();
  if (!START_HIDDEN) createWindow();
}

function panelUrl() {
  return 'http://127.0.0.1:' + boundPort + '/';
}

function iconPath() {
  return path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'CreditDaddy',
    icon: iconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(panelUrl());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!hideHintShown) {
      hideHintShown = true;
      notify('CreditDaddy 仍在后台运行', '已最小化到系统托盘，自动签到不会中断。单击托盘图标可重新打开面板。');
    }
  });
  win.on('closed', () => { win = null; });
}

function showWin() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function notify(title, body) {
  if (process.platform === 'win32' && tray && typeof tray.displayBalloon === 'function') {
    tray.displayBalloon({ title, content: body, iconType: 'info' });
  } else if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

async function checkinNow() {
  tray.setToolTip('CreditDaddy - 正在签到…');
  try {
    const res = await fetch('http://127.0.0.1:' + boundPort + '/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"skipIfCheckedToday":false}',
    });
    const data = await res.json();
    lastSummary = data.summary || '签到完成';
    notify('CreditDaddy 签到完成', lastSummary);
  } catch (e) {
    lastSummary = '签到失败：' + (e && e.message);
    notify('CreditDaddy', lastSummary);
  }
  refreshTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.reload();
}

function autoLaunchEnabled() {
  try { return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; } catch { return false; }
}

function setAutoLaunch(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  refreshTrayMenu();
}

function createTray() {
  let icon = nativeImage.createFromPath(iconPath());
  if (process.platform !== 'win32') icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.on('click', () => showWin());
  tray.on('double-click', () => showWin());
  refreshTrayMenu();
  if (process.env.QD_DEBUG_TRAY) setTimeout(() => console.log('TRAY_BOUNDS', JSON.stringify(tray.getBounds())), 1000);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip('CreditDaddy v' + daemonInfo.version + ' - 后台自动签到运行中' + (lastSummary ? '\n' + lastSummary : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'CreditDaddy v' + daemonInfo.version, enabled: false },
    { label: '面板 127.0.0.1:' + boundPort, enabled: false },
    ...(lastSummary ? [{ label: lastSummary.slice(0, 60), enabled: false }] : []),
    { type: 'separator' },
    { label: '打开面板', click: () => showWin() },
    { label: '立即签到全部账号', click: () => { checkinNow(); } },
    { type: 'separator' },
    { label: '开机自启（后台运行）', type: 'checkbox', checked: autoLaunchEnabled(), click: (item) => setAutoLaunch(item.checked) },
    { label: '打开数据目录', enabled: Boolean(daemonInfo.dataDir), click: () => shell.openPath(daemonInfo.dataDir) },
    { type: 'separator' },
    { label: '退出 CreditDaddy', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on('window-all-closed', () => {
  // 保持在托盘运行，自动签到不中断
});
app.on('before-quit', () => { quitting = true; });
