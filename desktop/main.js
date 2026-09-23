const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PORT = 47860;
let win = null;
let tray = null;
let quitting = false;
let boundPort = PORT;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWin());
  boot();
}

async function boot() {
  app.setAppUserModelId('cn.techysy.qoderdaddy');
  Menu.setApplicationMenu(null);
  try {
    const daemon = await import(pathToFileURL(path.join(process.resourcesPath, 'qoderdaddy', 'src', 'daemon.js')).href);
    const checkin = await import(pathToFileURL(path.join(process.resourcesPath, 'qoderdaddy', 'src', 'checkin.js')).href);
    const r = await daemon.startDaemon(PORT, '127.0.0.1');
    boundPort = r.port;
    checkin.startScheduler();
  } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('QoderDaddy 启动失败', String((err && err.stack) || err));
    app.quit();
    return;
  }
  createWindow();
  createTray();
}

function panelUrl() {
  return 'http://127.0.0.1:' + boundPort + '/';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
    title: 'QoderDaddy',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(panelUrl());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWin() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('QoderDaddy - 后台自动签到运行中');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开面板', click: () => showWin() },
    { label: '立即签到全部账号', click: async () => {
      try { await fetch('http://127.0.0.1:' + boundPort + '/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"skipIfCheckedToday":false}' }); } catch (e) {}
      showWin();
    } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => showWin());
}

app.on('window-all-closed', (e) => {
  // 保持在托盘运行，自动签到不中断
});
app.on('before-quit', () => { quitting = true; });
