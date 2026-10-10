/**
 * CreditDaddy 桌面壳（Electron）：内置 daemon + 托盘常驻。
 *
 *   - 关闭窗口 = 隐藏到托盘，后台自动领取不中断；首次隐藏时弹出气泡提示托盘位置
 *   - 单击托盘图标打开面板；右键菜单：状态 / 打开面板 / 立即领取 / 开机自启 / 打开数据目录 / 项目主页 / 退出
 *   - 开机自启以 --hidden 启动：只驻留托盘，不弹窗口
 *   - 打包后从 resources/creditdaddy 加载服务端；开发时（electron desktop/）直接用仓库源码
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell, Notification, dialog, ipcMain, session, safeStorage, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createPasswordStore } = require('./passwordStore');

// 自动更新（electron-updater + GitHub Releases）。开发环境不装这个依赖也能跑，缺失时静默跳过
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

const PORT = 47860;
const START_HIDDEN = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;
let boundPort = PORT;
let daemonMod = null;
let hideHintShown = false;
let mainHiddenToTray = false;   // 主窗是否被用户主动收进托盘（区分于子窗关闭的级联隐藏）
let childClosingAt = 0;         // 最近一次登录子窗 close 的时间戳：主窗 close 落在其后 1.5s 内视为级联而非用户点 X
let lastSummary = '';
const DEFAULT_HOMEPAGE = 'https://github.com/techysy/CreditDaddy';
let daemonInfo = { version: app.getVersion(), dataDir: '', homepage: DEFAULT_HOMEPAGE };
let updateState = { available: null, downloaded: null, fallback: null };
// available/downloaded: electron-updater 发现/已下载的版本号；fallback: { version, asset, installerPath? }
// GitHub API 直查到的新版本（release 缺 latest.yml 导致 electron-updater 404 时的兜底通道）

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

function restartApp() {
  quitting = true;
  app.relaunch();
  app.exit(0);
}

async function boot() {
  app.setAppUserModelId('cn.techysy.creditdaddy');
  Menu.setApplicationMenu(null);
  registerAuthWindowIpc();
  // 托盘最先创建：即使 daemon 启动失败也能从托盘退出
  createTray();
  try {
    const load = (rel) => import(pathToFileURL(path.join(serverRoot, rel)).href);
    const daemon = await load('src/daemon.js');
    const checkin = await load('src/checkin.js');
    const zauto = await load('src/zcodeAutoClaim.js');
    // ZCode 自动领取的验证码实现：隐藏窗口跑阿里云验证码 SDK（静默优先，风控时弹出让人工完成）
    zauto.setZcodeCaptchaProvider(zcodeCaptchaVerify);
    // 网关补全走 R1 镜像 Node 请求面（zcodeGateway 内置）；页内整链委托已废弃
    // （Chromium 自带的 sec-fetch-*/Origin 头反而成为风控指纹），zcodePlanCompletion 保留备用
    const store = await load('src/store.js');
    const constants = await load('src/constants.js');
    // 局域网网关：设置开启后绑定 0.0.0.0（面板访问密码开启时才建议，/gateway/* 数据面有自己的密钥）
    const bootSettings = await store.loadSettings();
    const anyLan = bootSettings.zcodeGatewayLan === true
      || bootSettings.minimaxGatewayLan === true
      || bootSettings.traeGatewayLan === true;
    const bindHost = anyLan ? '0.0.0.0' : '127.0.0.1';
    const r = await daemon.startDaemon(PORT, bindHost);
    boundPort = r.port;
    // runtime 记录：前台 / 后台 / 桌面 all 都写（P0-3 单实例守护）。桌面壳重启时若旧实例
    // 仍存活，startDaemon 已经在上面把 ALREADY_RUNNING 拉上来了，走这里也不会重复写。
    try {
      const { writeRuntime } = await import('../src/bgdaemon.js');
      await writeRuntime({ pid: process.pid, port: r.port, host: bindHost, startedAt: new Date().toISOString(), version: constants.APP_VERSION });
    } catch {}
    daemonMod = daemon;   // 保留模块引用：面板里改/关访问密码后，托盘领取实时读到新值（getPanelKey）
    daemon.setRestartHandler(() => restartApp());
    daemonInfo = { version: constants.APP_VERSION, dataDir: store.dataDir(), homepage: constants.PROJECT_URL || DEFAULT_HOMEPAGE };
    checkin.startScheduler();
  } catch (err) {
    dialog.showErrorBox('CreditDaddy 启动失败', String((err && err.stack) || err));
    quitting = true;
    app.quit();
    return;
  }
  refreshTrayMenu();
  setupAutoUpdate();
  if (!START_HIDDEN) createWindow();
}

/**
 * 自动更新：启动 30 秒后和每 6 小时查一次 GitHub Releases，后台静默下载，
 * 退出时自动安装（autoInstallOnAppQuit）；托盘菜单可手动检查 / 立即重启更新。
 * 主通道是 electron-updater（依赖 release 资产里的 latest.yml，v1.0.0 起的 release 忘传就会 404），
 * 失败时转 GitHub API 直查兜底（fetchLatestReleaseFromGitHub）。
 * Portable 版和开发模式没有自更新能力，直接跳过。
 */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  if (process.platform !== 'win32') return;          // macOS 构建未签名，Squirrel 装不上，先只做 Win 自更新
  if (process.env.PORTABLE_EXECUTABLE_DIR) return;   // portable 解压自包含，覆盖式更新会丢用户数据
  if (autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      // 电子更新器自己会挡降级，但挡不住「registry 与本地相同」的边缘态；双保险再比一次
      if (!isNewerVersion(info.version, app.getVersion())) return;
      updateState.available = info.version; refreshTrayMenu(); pushUpdateUi({ phase: 'available', version: info.version, via: 'updater' });
    });
    autoUpdater.on('update-not-available', () => { updateState.available = null; refreshTrayMenu(); });
    autoUpdater.on('update-downloaded', (info) => {
      updateState.downloaded = info.version;
      refreshTrayMenu();
      pushUpdateUi({ phase: 'downloaded', version: info.version, via: 'updater' });
      try {
        const n = new Notification({
          title: 'CreditDaddy 新版本已就绪',
          body: `v${info.version} 已在后台下载完成，退出 CreditDaddy 时自动安装（也可在托盘菜单里立即重启更新）。`,
          silent: true,
        });
        n.on('click', () => showWin());
        n.show();
      } catch {}
    });
    autoUpdater.on('error', () => {});   // 更新失败不影响主流程，托盘手动检查时会给出具体报错
  }
  const check = () => {
    const p = autoUpdater
      ? autoUpdater.checkForUpdates().catch(() => checkFallbackSilently())
      : checkFallbackSilently();
    p.catch(() => {});
  };
  setTimeout(check, 30_000).unref?.();
  setInterval(check, 6 * 60 * 60 * 1000).unref?.();
}

/** 版本号比较：x.y.z 逐段数值比较，next > cur 才算新版本 */
function isNewerVersion(next, cur) {
  const p = (s) => String(s).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const a = p(next);
  const b = p(cur);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

/**
 * GitHub Releases 直查兜底（zcode/qoder 式：问版本接口 → 下完整安装包 → 运行安装），
 * 只依赖 GitHub API 与 release 资产本身，不依赖 electron-updater 的 latest.yml。
 * 只认最新正式 release（prerelease / draft 不参与），安装包取 CreditDaddy-Win-Setup-*.exe（兼容旧名 CreditDaddy-Setup-*.exe）。
 */
async function fetchLatestReleaseFromGitHub() {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(daemonInfo.homepage || DEFAULT_HOMEPAGE);
  if (!m) throw new Error('无法从项目主页识别 GitHub 仓库');
  const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  const res = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => /^CreditDaddy-(?:Win-)?Setup-.*\.exe$/.test(a.name));
  if (!asset) throw new Error(`最新 release ${rel.tag_name} 没有 Windows 安装包`);
  return {
    version: String(rel.tag_name).replace(/^v/i, ''),
    asset: { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 },
  };
}

/** 下载安装包到临时目录；release 里有 SHA256SUMS-desktop.txt 就校验哈希，对不上直接放弃 */
async function downloadSetupInstaller(rel, onProgress, signal) {
  let expectedSha = null;
  const sumsRes = await net.fetch(rel.asset.url.replace(/[^/]+$/, 'SHA256SUMS-desktop.txt'), { signal }).catch(() => null);
  if (sumsRes && sumsRes.ok) {
    const line = (await sumsRes.text()).split('\n').find((l) => l.trim().endsWith(rel.asset.name));
    if (line) expectedSha = line.trim().split(/\s+/)[0].toLowerCase();
  }
  const res = await net.fetch(rel.asset.url, { signal });
  if (!res.ok) throw new Error(`下载安装包失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || rel.asset.size || 0;
  let buf;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      if (onProgress) onProgress(got, total);
    }
    buf = Buffer.concat(chunks);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
    if (onProgress) onProgress(buf.length, buf.length);
  }
  if (expectedSha && crypto.createHash('sha256').update(buf).digest('hex') !== expectedSha) {
    throw new Error('安装包 SHA256 校验失败，已放弃安装');
  }
  const file = path.join(app.getPath('temp'), rel.asset.name);
  fs.writeFileSync(file, buf);
  return file;
}

/** 兜底通道的进度由面板弹窗展示（update:state 推送），不再有独立下载小窗与原生对话框 */


/** 后台静默兜底检查：electron-updater 报错（典型是 release 缺 latest.yml 的 404）时只提醒，不自动下载 */
async function checkFallbackSilently() {
  try {
    if (updateState.fallback || updateState.downloaded || updateState.available) return;
    const rel = await fetchLatestReleaseFromGitHub();
    if (!isNewerVersion(rel.version, app.getVersion())) return;
    updateState.fallback = rel;
    refreshTrayMenu();
    try {
      const n = new Notification({
        title: 'CreditDaddy 有新版本',
        body: `v${rel.version} 已发布，点这里或从托盘菜单「检查更新…」下载安装。`,
        silent: true,
      });
      n.on('click', () => openUpdateUi());
      n.show();
    } catch {}
  } catch {}
}

function trayUpdateLabel() {
  if (updateState.downloaded) return '重启并安装更新';
  if (updateState.fallback) return updateState.fallback.installerPath ? `安装已下载的 v${updateState.fallback.version}` : `下载并安装新版本 v${updateState.fallback.version}…`;
  return '检查更新…';
}

// ── 检查更新面板弹窗：主进程只管状态机，UI 全交给面板（与 CreditDaddy 同一套设计语言） ──
let updateUi = { phase: 'idle' };   // idle | checking | latest | available | downloading | downloaded | unsupported | error
function updateUiSupported() {
  return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
}
function updateUiState() {
  return {
    supported: updateUiSupported(),
    current: app.getVersion(),
    homepage: daemonInfo.homepage || DEFAULT_HOMEPAGE,
    ...updateUi,
  };
}
function pushUpdateUi(patch) {
  updateUi = { ...updateUi, ...patch };
  try { if (win && !win.isDestroyed()) win.webContents.send('update:state', updateUiState()); } catch {}
  return updateUi;
}
function publishFallbackState() {
  const rel = updateState.fallback;
  if (!rel) return;
  if (rel.installerPath) pushUpdateUi({ phase: 'downloaded', version: rel.version, via: 'github' });
  else pushUpdateUi({
    phase: 'available', version: rel.version, via: 'github',
    sizeMB: rel.asset && rel.asset.size ? Math.max(1, Math.round(rel.asset.size / 1048576)) : null,
  });
}
/** 「检查更新」交互流程（无原生对话框版）：electron-updater 主通道 → GitHub API 直查兜底 */
async function checkUpdateInteractiveUi() {
  pushUpdateUi({ phase: 'checking', error: null });
  if (!updateUiSupported()) { pushUpdateUi({ phase: 'unsupported' }); return; }
  if (updateState.downloaded) { pushUpdateUi({ phase: 'downloaded', version: updateState.downloaded, via: 'updater' }); return; }
  if (updateState.fallback) { publishFallbackState(); return; }
  try {
    if (!autoUpdater) throw new Error('electron-updater 不可用');
    const result = await autoUpdater.checkForUpdates();
    const v = result && result.updateInfo && result.updateInfo.version;
    if (updateState.downloaded) pushUpdateUi({ phase: 'downloaded', version: updateState.downloaded, via: 'updater' });
    // 必须「严格更新」才算新版本：checkForUpdates 的 updateInfo 只是 registry 上现有的版本，
    // 本地版本比它新（如未发布的本地构建 1.3.3 vs 已发布 1.3.2）时 !== 会误报「发现新版本」
    else if (v && isNewerVersion(v, app.getVersion())) pushUpdateUi({ phase: 'available', version: v, via: 'updater' });
    else pushUpdateUi({ phase: 'latest' });
  } catch {
    try {
      const rel = await fetchLatestReleaseFromGitHub();
      if (!isNewerVersion(rel.version, app.getVersion())) { pushUpdateUi({ phase: 'latest' }); return; }
      updateState.fallback = rel;
      refreshTrayMenu();
      publishFallbackState();
    } catch (e2) {
      pushUpdateUi({ phase: 'error', error: String((e2 && e2.message) || e2) });
    }
  }
}
/** 弹窗主按钮动作：available(github)→下载；downloaded→安装并退出 */
async function updateUiPrimary() {
  if (updateUi.phase === 'downloaded') {
    if (updateState.downloaded) { quitting = true; autoUpdater.quitAndInstall(false, true); return; }
    const rel = updateState.fallback;
    if (rel && rel.installerPath) {
      try {
        spawn(rel.installerPath, [], { detached: true, stdio: 'ignore' }).unref();
        quitting = true;
        app.quit();
      } catch (err) {
        pushUpdateUi({ phase: 'error', error: `启动安装程序失败：${String((err && err.message) || err)}（可手动运行 ${rel.installerPath}）` });
      }
    }
    return;
  }
  const rel = updateState.fallback;
  if (updateUi.phase === 'available' && updateUi.via === 'github' && rel && !rel.installerPath) {
    pushUpdateUi({ phase: 'downloading', percent: null, mb: '0.0' });
    try {
      const file = await downloadSetupInstaller(rel, (got, total) => {
        pushUpdateUi({ phase: 'downloading', percent: total ? Math.round((got / total) * 100) : null, mb: (got / 1048576).toFixed(1) });
      });
      updateState.fallback = { ...rel, installerPath: file };
      refreshTrayMenu();
      pushUpdateUi({ phase: 'downloaded', version: rel.version, via: 'github' });
    } catch (e) {
      pushUpdateUi({ phase: 'error', error: String((e && e.message) || e) });
    }
  }
}
/** 托盘 / 系统通知入口：唤起主窗口并让面板打开更新弹窗 */
function openUpdateUi() {
  showWin();
  pushUpdateUi({});   // 先同步一次当前状态
  try { if (win && !win.isDestroyed()) win.webContents.send('update:open'); } catch {}
}

// 旧的原生对话框交互流程已由面板内更新弹窗取代（见 updateUi 状态机与 update:* IPC）


/**
 * ZCode 领取用的验证码：隐藏窗口里跑阿里云验证码 SDK。
 * 静默验证（startTracelessVerification）直接通过则全程无感；8 秒未完成或触发风控时把窗口
 * 显示出来让人工完成（最长 2 分钟）。返回 { captchaParam, region }。
 */
function zcodeCaptchaVerify(cfg) {
  return new Promise((resolve, reject) => {
    let capWin = null;
    let settled = false;
    const cleanup = () => { settled = true; if (capWin && !capWin.isDestroyed()) capWin.destroy(); };
    const fail = (msg) => { clearTimeout(timer); if (!settled) { cleanup(); reject(new Error(msg)); } };
    const pass = (param) => { clearTimeout(timer); if (!settled) { cleanup(); resolve({ captchaParam: param, region: cfg.region || '' }); } };
    const timer = setTimeout(() => fail('等待验证码超时'), 120000);

    // JSON 内嵌 <script> 时把 < 转义成 \u003c，防止配置值（服务端下发）里出现 </script> 闭合标签注入
    const jsonSafe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
    const html = `<!doctype html><meta charset="utf-8"><title>验证码</title><body style="margin:0;background:#fff">
<script>window.AliyunCaptchaConfig=${jsonSafe({ region: cfg.region || '', prefix: cfg.prefix || '' })};</script>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"><\/script>
<div id="c"></div><button id="b" hidden>打开验证码</button>
<script>
window.initAliyunCaptcha({
  SceneId:${jsonSafe(cfg.sceneId)},mode:'popup',language:'zh-CN',showErrorTip:false,
  element:'#c',button:'#b',
  getInstance:(i)=>{
    if(i&&typeof i.startTracelessVerification==='function'){i.startTracelessVerification();setTimeout(()=>console.log('ZCAP:INTERACTIVE'),8000);}
    else console.log('ZCAP:INTERACTIVE');
  },
  success:(p)=>console.log('ZCAP:OK:'+(typeof p==='string'?p:(p&&p.captchaVerifyParam)||'')),
  fail:()=>console.log('ZCAP:INTERACTIVE'),
  onError:()=>console.log('ZCAP:ERR'),
});
<\/script></body>`;

    capWin = new BrowserWindow({
      show: false, width: 420, height: 560, title: '完成验证码（ZCode 活动领取）',
      icon: iconPath(), autoHideMenuBar: true,
      webPreferences: { session: session.fromPartition('zcap-' + crypto.randomUUID()), contextIsolation: true, sandbox: true },
    });
    capWin.webContents.on('console-message', (e, level, message) => {
      const msg = typeof message === 'string' ? message : (e && e.message) || '';
      if (msg.startsWith('ZCAP:OK:')) pass(msg.slice(8));
      else if (msg === 'ZCAP:INTERACTIVE') { if (capWin && !capWin.isDestroyed() && !capWin.isVisible()) capWin.show(); }
      else if (msg.startsWith('ZCAP:ERR')) fail('验证码组件加载失败');
    });
    capWin.on('closed', () => fail('验证码未完成'));
    capWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

/**
 * ZCode 免费额度网关的整链补全提供者：隐藏窗口先加载 zcode.z.ai 本站（真 Chromium
 * TLS/cookie/来源），页内跑阿里云验证码 SDK 拿 token，再在【同一页面上下文】里发起
 * plan 端点补全 fetch —— 同源、同会话、同网络栈，规避 Node fetch 的 TLS 指纹风控。
 * 返回 { status, contentType, body }；window 结束后 devtools 无残留。
 */
function zcodePlanCompletion({ captchaCfg, jwt, rawBody, headers = {} }) {
  return new Promise((resolve, reject) => {
    let capWin = null;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; if (capWin && !capWin.isDestroyed()) capWin.destroy(); reject(new Error('网关补全超时（120s）')); } }, 120000);
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); if (capWin && !capWin.isDestroyed()) capWin.destroy(); fn(arg); } };

    const jsonSafe = (o) => JSON.stringify(o).replace(/</g, '<');
    capWin = new BrowserWindow({
      show: false, width: 460, height: 600, title: 'ZCode 额度网关（后台验证）',
      icon: iconPath(), autoHideMenuBar: true,
      webPreferences: { session: session.fromPartition('zcap-' + crypto.randomUUID()), contextIsolation: true, sandbox: true },
    });
    capWin.webContents.on('console-message', (e, level, message) => {
      const msg = typeof message === 'string' ? message : (e && e.message) || '';
      if (msg.startsWith('ZGW:RESP:')) {
        try { done(resolve, JSON.parse(msg.slice(9))); } catch { done(reject, new Error('网关响应解析失败')); }
      } else if (msg.startsWith('ZGW:ERR:')) {
        done(reject, new Error(msg.slice(8)));
      } else if (msg === 'ZCAP:INTERACTIVE') {
        if (capWin && !capWin.isDestroyed() && !capWin.isVisible()) capWin.show();
      }
    });
    capWin.on('closed', () => done(reject, new Error('网关窗口提前关闭')));

    // 先落本站拿真实来源与 cookie，再在页内跑验证码 + 同源补全
    if (headers['User-Agent']) capWin.webContents.setUserAgent(headers['User-Agent']);
    capWin.webContents.loadURL('https://zcode.z.ai/').then(() => {
      const pageJs = `(async () => {
        try {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
            s.onload = res; s.onerror = () => rej(new Error('captcha script load failed'));
            document.head.appendChild(s);
          });
          const cfg = ${jsonSafe(captchaCfg)};
          const holder = document.createElement('div'); holder.id = 'cap'; document.body.appendChild(holder);
          const btn = document.createElement('button'); btn.id = 'btn'; btn.hidden = true; document.body.appendChild(btn);
          const param = await new Promise((res2, rej2) => {
            let inst = null;
            window.initAliyunCaptcha({
              SceneId: cfg.sceneId, prefix: cfg.prefix, mode: 'popup', language: 'zh-CN', showErrorTip: false,
              element: '#cap', button: '#btn', region: cfg.region,
              getInstance: (i) => { inst = i; if (i && typeof i.startTracelessVerification === 'function') i.startTracelessVerification(); },
              success: (p) => res2(typeof p === 'string' ? p : (p && p.captchaVerifyParam) || ''),
              captchaVerifyCallback: (p) => { res2(p); return { captchaResult: true }; },
              fail: () => rej2(new Error('captcha fail')),
              onError: () => rej2(new Error('captcha error')),
            });
            setTimeout(() => { try { if (inst && typeof inst.startTracelessVerification === 'function') inst.startTracelessVerification(); } catch {} }, 500);
          });
          const extra = ${jsonSafe(headers)};
          delete extra['User-Agent'];
          const resp = await fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', {
            method: 'POST',
            headers: {
              ...extra,
              'Content-Type': 'application/json',
              'X-Aliyun-Captcha-Verify-Param': param,
              'X-Aliyun-Captcha-Verify-Region': cfg.region || '',
              'Authorization': 'Bearer ' + ${jsonSafe(jwt)},
            },
            body: ${jsonSafe(rawBody)},
          });
          const text = await resp.text();
          console.log('ZGW:RESP:' + JSON.stringify({ status: resp.status, contentType: resp.headers.get('content-type') || 'application/json', body: text }));
        } catch (e) {
          console.log('ZGW:ERR:' + (e && e.message || String(e)));
        }
      })()`;
      capWin.webContents.executeJavaScript(pageJs).catch((err) => done(reject, new Error('页内脚本执行失败：' + err.message)));
    }).catch((err) => done(reject, new Error('zcode.z.ai 打开失败：' + err.message)));
  });
}

/**
 * 隐私（无痕）登录窗口：每次用一个全新的内存态 session 分区（不带 persist: 前缀 = 不落盘），
 * 与系统浏览器及其它登录会话完全隔离；关闭时清空该 session 的存储。用于网页 OAuth / 选账号登录。
 */
async function openIncognitoWindow(url) {
  const partition = 'incognito-' + crypto.randomUUID();
  const ses = session.fromPartition(partition);   // 无 persist: 前缀 → 内存态，进程退出即消失
  // 国际版按 IP 识别地区（qoder.com）：配置了出口代理时登录窗显式走它；
  // 未配置则保持默认（Electron 窗口本来就跟随系统代理，不覆盖）
  if (/\/\/qoder\.com(\/|$)/.test(url)) {
    const proxy = daemonMod && typeof daemonMod.getLoginProxyUrl === 'function' ? daemonMod.getLoginProxyUrl() : null;
    if (proxy) await ses.setProxy({ proxyRules: proxy, proxyBypassRules: '<local>' }).catch(() => {});
  }
  const authWin = new BrowserWindow({
    width: 480,
    height: 720,
    title: '登录（隐私窗口）',
    icon: iconPath(),
    autoHideMenuBar: true,
    // 故意不设 parent：Windows 的 owner 级联（electron#26031/#12142）会在子窗销毁时连带
    // 向主窗发 close/隐藏——带 owner 且经过站点弹窗（Google OAuth 等）的登录流程里，级联
    // 可能晚于收割（两次 POST + 探测）才到达，1.5s 时间窗兜不住，主窗凭空消失。
    // 10Router 同款做法：授权窗一律独立顶层、不设 owner，从根上消灭级联。
    webPreferences: { session: ses, preload: CONTAINER_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 开窗时主窗是否可见：子窗（含站点自弹窗）关闭若把主窗连带最小化/隐藏，closed 后恢复。
  // mainHiddenToTray：用户主动收进托盘时不恢复（那是有意为之，不是级联 bug）。
  const parentWasVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
  const guardMainAfterClose = (w) => {
    w.on('close', () => {
      childClosingAt = Date.now();
      w._mainVisibleBefore = Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
    });
    w.on('closed', () => {
      if (!parentWasVisible || mainHiddenToTray || !win || win.isDestroyed()) return;
      // 子窗关闭前主窗本来就不可见（用户自己最小化/收托盘）→ 不越权恢复
      if (w._mainVisibleBefore === false) return;
      const restoreMain = () => {
        try {
          if (win.isMinimized()) win.restore();
          if (!win.isVisible()) win.show();
        } catch { /* ignore */ }
      };
      restoreMain();
      setTimeout(restoreMain, 300);   // 连带隐藏可能稍晚于 closed 事件到达
    });
  };
  authWin.setMenuBarVisibility(false);
  attachContainerCapture(authWin.webContents);
  attachShellContextMenu(authWin);
  // 同一次登录里网站自己弹的窗口（如第三方账号选择、二次验证）复用同一隐私 session
  authWin.webContents.setWindowOpenHandler(({ url: subUrl }) => {
    if (String(subUrl).toLowerCase().startsWith('https://')) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: ses, preload: CONTAINER_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    }
    return { action: 'deny' };
  });
  authWin.webContents.on('did-create-window', (child) => {
    attachContainerCapture(child.webContents);
    attachShellContextMenu(child);
    guardMainAfterClose(child);   // 站点自弹窗（如授权完成页）同样可能触发级联
  });
  guardMainAfterClose(authWin);
  authWin.on('closed', () => {
    // 清空前抢救 Qoder 网页会话 Cookie（httpOnly，页面脚本拿不到，只有 session API 能读）：
    // 逐资源包用量明细接口只认这个会话。daemon 端会探测归属 uid 后再绑定到对应账号。
    // 必须先等收割完成再清存储——两者并发的话 clearStorageData 会抢先抹掉 Cookie，
    // 收割永远是空的（国际版「缺网页会话」长期修不好的根因）。
    harvestQoderWebSession(ses)
      .catch(() => {})
      .finally(() => { ses.clearStorageData().catch(() => {}); });
  });
  authWin.loadURL(url);
  return authWin;
}

/** 读取本次登录窗口隐私会话里的 qoder 网页 Cookie，交给 daemon 按 uid 归户。
 *  两个域都上报（含 Cookie 数量的诊断信息）——daemon 会把「收割到 0 条」也记进运行日志，
 *  否则收割失败完全静默，「缺网页会话」查不到原因。 */
async function harvestQoderWebSession(ses) {
  const targets = [
    { kind: 'qoder-cn', url: 'https://qoder.cn' },
    { kind: 'qoder', url: 'https://qoder.com' },
  ];
  const panelKey = daemonMod && typeof daemonMod.getPanelKey === 'function' ? daemonMod.getPanelKey() : '';
  for (const t of targets) {
    const cookies = await ses.cookies.get({ url: t.url }).catch(() => []);
    const cookie = (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
    await fetch('http://127.0.0.1:' + boundPort + '/api/auth/qoder-web-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(panelKey ? { 'x-qd-key': panelKey } : {}) },
      body: JSON.stringify({ kind: t.kind, cookie, diag: { cookieCount: (cookies || []).length } }),
    }).catch(() => {});
  }
}

// ──────────────────────── 密码管理（捕获/自动填充/管理窗）────────────────────────
// 与 10Router 桌面壳同款：无痕登录窗里遇到账号密码表单，弹出「是否保存」询问；
// 下次登录自动填充（该站点恰好一条时聚焦自动填，多账号右键显式选），也可在
// 托盘「已保存的密码…」里手动录入 / 改名 / 显示 / 复制 / 删除。存储约定：
//  - 库文件 userData/passwords.json，只落密文：safeStorage（Windows=DPAPI 绑当前
//    系统用户）加密；cipher 不可用即整功能停用，绝不落明文。
//  - 渲染层传来的 url 一律不采信，归属 origin 只按主进程侧读到的 senderFrame.url。
//  - 容器 = 登录窗及其站点自弹子窗（注册 preload-container.js，参与捕获/填充）；
//    主窗是面板本身——导出口令、访问密码输入框都在里面，不注册为容器，
//    只挂右键基础菜单，避免把面板口令错当站点密码捕获/回填。询问窗/管理窗同理。
const CONTAINER_PRELOAD = path.join(__dirname, 'preload-container.js');

const safeStorageCipher = {
  available: () => { try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; } },
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (blob) => safeStorage.decryptString(Buffer.from(String(blob), 'base64')).toString('utf8'),
};

let pwStore = null;
function getPwStore() {
  if (!pwStore) pwStore = createPasswordStore({ file: path.join(app.getPath('userData'), 'passwords.json'), cipher: safeStorageCipher, log: (m) => console.log(m) });
  return pwStore;
}
function listPasswords() {
  try { return getPwStore().list(); } catch { return []; }
}

const cleanText = (v) => String(v === undefined || v === null ? '' : v).trim().slice(0, 300);

// pw:* 事件的归属 origin：优先发送 frame 的真实 URL（iframe 里的登录框归 iframe），
// frame 已销毁等场景回退整页 URL。
function frameOrigin(e) {
  try {
    const fu = e.senderFrame && e.senderFrame.url;
    if (fu) return new URL(fu).origin;
  } catch { /* 回退 sender */ }
  try { return new URL(e.sender.getURL()).origin; } catch { return null; }
}

const containerContents = new Set();
const typedCaptures = new Map();   // webContents.id → {origin, url, username, password, ts}

function attachContainerCapture(contents) {
  if (!contents || containerContents.has(contents)) return;
  containerContents.add(contents);
  contents.once('destroyed', () => {
    containerContents.delete(contents);
    typedCaptures.delete(contents.id);
  });
  // SPA 登录启发式：输入过密码后同 origin 换路径 → 视作登录成功，转保存询问。
  // 原地提交（失败重试同 URL）/换站/超 10 分钟都不算。
  contents.on('did-navigate', (_e, url) => {
    const rec = typedCaptures.get(contents.id);
    if (!rec) return;
    typedCaptures.delete(contents.id);
    try {
      const next = new URL(url || '');
      if (!/^https?:$/.test(next.protocol)) return;
      if (next.origin.toLowerCase() !== String(rec.origin).toLowerCase()) return;
      if (next.toString() === rec.url) return;
      if (Date.now() - rec.ts > 10 * 60 * 1000) return;
      offerPasswordSave({ origin: rec.origin, username: rec.username, password: rec.password });
    } catch { /* ignore */ }
  });
}

let pwDisabledNotified = false;
// 保存询问的唯一入口（form 捕获 / typed 启发式共用）：去重 + 更新判定，再弹窗。
// 手动录入走管理窗。
function offerPasswordSave({ origin, username, password }) {
  if (!origin || !password) return;
  const store = getPwStore();
  if (!store.isAvailable()) {
    if (!pwDisabledNotified) {
      pwDisabledNotified = true;
      notify('密码管理已停用', '系统凭据加密不可用，无法安全保存密码（不会写明文到磁盘）。');
    }
    return;
  }
  if (store.isNeverAsk(origin)) return;
  const existing = store.findEntry(origin, username || '');
  let isUpdate = false;
  if (existing) {
    try { if (store.reveal(existing.id) === password) return; } catch { /* 解不开按更新处理 */ }
    isUpdate = true;
  }
  promptSavePassword({ origin, username: username || '', password, isUpdate });
}

// ── 保存询问窗（保存/更新、永不保存此站点、暂不）──
let savePwWin = null;
let savePwPending = null;   // {origin, username, password, isUpdate}

function promptSavePassword(payload) {
  if (savePwWin && !savePwWin.isDestroyed()) { savePwWin.focus(); return; }   // 一次只处理一条
  savePwPending = payload;
  savePwWin = new BrowserWindow({
    width: 470,
    height: 256,
    parent: (win && !win.isDestroyed()) ? win : undefined,
    alwaysOnTop: true,
    title: payload.isUpdate ? '更新密码？' : '保存密码？',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
  });
  attachShellContextMenu(savePwWin);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:14px;display:flex;flex-direction:column;gap:8px;background:transparent">
<div style="font-size:14px;font-weight:600">PW_TITLE</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">站点</span>
<input value="SITE_VAL" readonly style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;color:#555;background:transparent">
</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">用户名</span>
<input id="u" value="USER_VAL" placeholder="用户名" style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">密码</span>
<input id="p" type="password" value="PASS_VAL" style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
</div>
<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
<button id="never" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">永不保存此站点</button>
<button id="no" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">暂不</button>
<button id="ok" style="padding:5px 14px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer">SAVE_LBL</button>
</div>
<script>
const { ipcRenderer } = require('electron');
const decide = (action) => ipcRenderer.send('pw:save-decide', {
  action,
  username: document.getElementById('u').value,
  password: document.getElementById('p').value,
});
document.getElementById('ok').addEventListener('click', () => decide('save'));
document.getElementById('never').addEventListener('click', () => decide('never'));
document.getElementById('no').addEventListener('click', () => window.close());
['u', 'p'].forEach((id) => document.getElementById(id).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') decide('save');
  if (e.key === 'Escape') window.close();
}));
</script>
</body></html>`;
  const filled = html
    .replace('PW_TITLE', esc(payload.isUpdate ? '更新密码？' : '保存密码？'))
    .replace('SITE_VAL', esc(payload.origin))
    .replace('USER_VAL', esc(payload.username))
    .replace('PASS_VAL', esc(payload.password))
    .replace('SAVE_LBL', esc(payload.isUpdate ? '更新' : '保存'));
  savePwWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(filled))
    .catch((e) => { console.log('pw save prompt load failed: ' + e.message); try { savePwWin.close(); } catch { /* ignore */ } });
  savePwWin.on('closed', () => { savePwWin = null; savePwPending = null; });
}

// 用户名/密码以弹窗输入为准（可改完再存）；关窗/暂不 = 丢弃这条，下次登录再问
ipcMain.on('pw:save-decide', (e, msg) => {
  const fromPrompt = savePwWin && !savePwWin.isDestroyed() && e.sender === savePwWin.webContents;
  if (!fromPrompt || !savePwPending) return;
  const payload = savePwPending;
  savePwPending = null;
  try { savePwWin.close(); } catch { /* ignore */ }
  if (!msg || typeof msg !== 'object') return;
  if (msg.action === 'never') {
    try { getPwStore().setNeverAsk(payload.origin); } catch { /* ignore */ }
    return;
  }
  if (msg.action === 'save') {
    const username = String(msg.username === undefined ? payload.username : msg.username).trim().slice(0, 300);
    const password = String(msg.password === undefined ? payload.password : msg.password);
    try { getPwStore().upsert({ origin: payload.origin, username, password }); } catch { /* 存不上不阻塞 */ }
  }
});

// 捕获一：<form> submit（preload 捕获阶段送来）
ipcMain.on('pw:captured', (e, payload) => {
  if (!containerContents.has(e.sender) || !payload || typeof payload !== 'object') return;
  const origin = frameOrigin(e);
  if (!origin) return;
  offerPasswordSave({ origin, username: cleanText(payload.username), password: String(payload.password || '') });
});

// 捕获二：SPA 无 form 登录的 pending 输入，等 did-navigate 消费（见 attachContainerCapture）
ipcMain.on('pw:typed', (e, payload) => {
  if (!containerContents.has(e.sender) || !payload || typeof payload !== 'object') return;
  const origin = frameOrigin(e);
  if (!origin) return;
  try {
    typedCaptures.set(e.sender.id, {
      origin,
      url: e.sender.getURL(),
      username: cleanText(payload.username),
      password: String(payload.password || ''),
      ts: Date.now(),
    });
  } catch { /* ignore */ }
});

// 自动填充：该 origin 恰好一条已存条目才自动回填（多账号走右键菜单显式选，不自动猜）
ipcMain.on('pw:focus', (e) => {
  if (!containerContents.has(e.sender)) return;
  const origin = frameOrigin(e);
  if (!origin) return;
  const store = getPwStore();
  if (!store.isAvailable() || store.isNeverAsk(origin)) return;
  let entries = [];
  try { entries = store.listForOrigin(origin); } catch { return; }
  if (entries.length !== 1) return;
  try {
    const password = store.reveal(entries[0].id);
    e.sender.send('pw:fill', { origin, username: entries[0].username, password });
  } catch { /* ignore */ }
});

// ── 面板访问密码验证（打开「已保存的密码」管理窗前校验；未设面板密码则无门槛）──
let pwVerifyWin = null;
let pwVerifyResolve = null;
let pwVerifyKey = '';

function verifyPanelKey(key) {
  if (pwVerifyWin && !pwVerifyWin.isDestroyed()) { pwVerifyWin.focus(); return pwVerifyResolve || Promise.resolve(false); }
  return new Promise((resolve) => {
    pwVerifyKey = String(key || '');
    pwVerifyResolve = resolve;
    pwVerifyWin = new BrowserWindow({
      width: 420,
      height: 220,
      parent: (win && !win.isDestroyed()) ? win : undefined,
      modal: true,
      alwaysOnTop: true,
      title: '验证面板访问密码',
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      show: true,
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    });
    attachShellContextMenu(pwVerifyWin);
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:14px;display:flex;flex-direction:column;gap:10px;background:transparent">
<div style="font-size:14px;font-weight:600">输入面板访问密码</div>
<div style="font-size:12px;color:#888">已保存的密码需要面板访问密码才能查看。</div>
<input id="k" type="password" autofocus placeholder="面板访问密码" style="flex:1;min-width:0;padding:6px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
<div id="err" style="font-size:12px;color:#c0392b;display:none">密码不正确</div>
<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:2px">
<button id="cancel" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">取消</button>
<button id="ok" style="padding:5px 14px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer">确定</button>
</div>
<script>
const { ipcRenderer } = require('electron');
const inp = document.getElementById('k');
const err = document.getElementById('err');
const submit = () => ipcRenderer.send('pw:verify', String(inp.value || ''));
document.getElementById('ok').addEventListener('click', submit);
document.getElementById('cancel').addEventListener('click', () => window.close());
inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') window.close(); });
ipcRenderer.on('pw:verify-result', (_e, ok) => { if (!ok) { err.style.display = 'block'; inp.value = ''; inp.focus(); } });
</script>
</body></html>`;
    pwVerifyWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      .catch(() => { try { pwVerifyWin.close(); } catch { /* ignore */ } });
    pwVerifyWin.on('closed', () => {
      pwVerifyWin = null;
      if (pwVerifyResolve) { const r = pwVerifyResolve; pwVerifyResolve = null; r(false); }
    });
  });
}

ipcMain.on('pw:verify', (e, entered) => {
  const fromVerify = pwVerifyWin && !pwVerifyWin.isDestroyed() && e.sender === pwVerifyWin.webContents;
  if (!fromVerify) return;
  const a = Buffer.from(String(entered || ''));
  const b = Buffer.from(String(pwVerifyKey || ''));
  const ok = pwVerifyKey && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (ok) {
    const r = pwVerifyResolve; pwVerifyResolve = null;
    try { pwVerifyWin.close(); } catch { /* ignore */ }
    r?.(true);
  } else {
    e.sender.send('pw:verify-result', false);
  }
});

// ── 管理已保存的密码（列表/手动添加/改/显示/复制/两步删除）──
let pwMgrWin = null;
async function promptManagePasswords() {
  if (pwMgrWin && !pwMgrWin.isDestroyed()) { pwMgrWin.focus(); return; }
  // 设了面板访问密码时，必须先验证才能查看明文——托盘菜单不能绕过面板密码
  const panelKey = daemonMod && typeof daemonMod.getPanelKey === 'function' ? daemonMod.getPanelKey() : '';
  if (panelKey && !(await verifyPanelKey(panelKey))) {
    notify('密码管理已锁定', '需要输入面板访问密码才能查看已保存的密码。');
    return;
  }
  pwMgrWin = new BrowserWindow({
    width: 800,
    height: 520,
    parent: (win && !win.isDestroyed()) ? win : undefined,
    alwaysOnTop: true,
    title: '已保存的密码',
    autoHideMenuBar: true,
    show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
  });
  attachShellContextMenu(pwMgrWin);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:12px;display:flex;flex-direction:column;gap:8px;background:transparent">
<div id="err" style="display:none;font-size:12px;color:#c0392b"></div>
<div id="add" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px dashed #8885;border-radius:8px;padding:8px"></div>
<div id="list" style="display:flex;flex-direction:column;gap:6px"></div>
<script>
const { ipcRenderer, clipboard } = require('electron');
const BTN = 'padding:3px 10px;font-size:12px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent';
const INP = 'flex:1;min-width:0;padding:4px 8px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none';
const ORIGIN = 'flex-basis:100%;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
const ERRS = { invalidOrigin: '站点地址无效', needPw: '密码不能为空', failed: '操作失败' };
const errBox = document.getElementById('err');
function showErr(key) { errBox.textContent = ERRS[key] || ERRS.failed; errBox.style.display = 'block'; }
function clearErr() { errBox.style.display = 'none'; }
function rpc(msg) { return ipcRenderer.sendSync('pw:mgr', msg) || {}; }
// 行内容全部用 DOM API 构建（textContent/value），不拼 HTML 字符串，天然免注入
function row(it) {
    const rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px solid #8883;border-radius:8px;padding:8px';
    const o = document.createElement('div');
    o.style.cssText = ORIGIN;
    o.textContent = it.origin;
    o.title = it.origin;
    const un = document.createElement('input');
    un.style.cssText = INP + ';flex:2';
    un.value = it.username || '';
    un.placeholder = '用户名';
    const pin = document.createElement('input');
    pin.style.cssText = INP + ';flex:2';
    pin.type = 'password';
    pin.placeholder = '留空保持原密码';
    let revealed = false;
    const show = document.createElement('button');
    show.style.cssText = BTN;
    show.textContent = '显示';
    show.onclick = () => {
        if (!revealed) {
            const r = rpc({ action: 'reveal', id: it.id });
            if (!r.ok) return showErr(r.error || 'failed');
            pin.value = String(r.plain || '');
            pin.type = 'text';
            show.textContent = '隐藏';
            revealed = true;
        } else {
            pin.value = '';
            pin.type = 'password';
            show.textContent = '显示';
            revealed = false;
        }
    };
    const save = document.createElement('button');
    save.style.cssText = BTN;
    save.textContent = '保存';
    save.onclick = () => {
        const r = rpc({ action: 'update', id: it.id, username: un.value, password: pin.value });
        if (!r.ok) return showErr(r.error || 'failed');
        clearErr();
        render();
    };
    const copy = document.createElement('button');
    copy.style.cssText = BTN;
    copy.textContent = '复制';
    copy.onclick = () => {
        const r = rpc({ action: 'reveal', id: it.id });
        if (!r.ok) return showErr(r.error || 'failed');
        clipboard.writeText(String(r.plain || ''));
        copy.textContent = '已复制';
        setTimeout(() => { copy.textContent = '复制'; }, 1200);
    };
    const del = document.createElement('button');
    del.style.cssText = BTN;
    del.textContent = '删除';
    del.onclick = () => {
        // 两步删除：第一次点变「确认删除？」，render 重建节点自动复位
        if (del.dataset.arm !== '1') { del.dataset.arm = '1'; del.textContent = '确认删除？'; return; }
        rpc({ action: 'remove', id: it.id });
        render();
    };
    rowEl.append(o, un, pin, show, save, copy, del);
    return rowEl;
}
function render() {
    const box = document.getElementById('list');
    box.textContent = '';
    const res = rpc({ action: 'list' });
    const list = Array.isArray(res.list) ? res.list : [];
    if (!list.length) { box.textContent = '还没有已保存的密码——可在登录时保存，或在上方手动添加。'; return; }
    for (const it of list) box.appendChild(row(it));
}
// 手动添加行（origin/用户名/密码）
const addBox = document.getElementById('add');
const aO = document.createElement('input');
aO.style.cssText = INP + ';flex-basis:100%';
aO.placeholder = '站点（如 https://qoder.com）';
const aU = document.createElement('input');
aU.style.cssText = INP;
aU.placeholder = '用户名';
const aP = document.createElement('input');
aP.style.cssText = INP;
aP.type = 'password';
aP.placeholder = '密码';
const addBtn = document.createElement('button');
addBtn.style.cssText = BTN;
addBtn.textContent = '添加';
addBtn.onclick = () => {
    if (!aP.value) return showErr('needPw');
    const r = rpc({ action: 'add', origin: aO.value.trim(), username: aU.value, password: aP.value });
    if (!r.ok) return showErr(r.error || 'failed');
    clearErr();
    aO.value = ''; aU.value = ''; aP.value = '';
    render();
};
addBox.append(aO, aU, aP, addBtn);
render();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
</script>
</body></html>`;
  pwMgrWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    .catch((e) => { console.log('pw mgr load failed: ' + e.message); try { pwMgrWin.close(); } catch { /* ignore */ } });
  pwMgrWin.on('closed', () => { pwMgrWin = null; });
}

// 管理窗与主进程的单通道 RPC（sendSync）：list/add/update/remove/reveal，一律回当前全表
ipcMain.on('pw:mgr', (e, msg) => {
  const fromMgr = pwMgrWin && !pwMgrWin.isDestroyed() && e.sender === pwMgrWin.webContents;
  const out = { ok: !!fromMgr };
  if (fromMgr && msg && typeof msg === 'object') {
    const store = getPwStore();
    try {
      if (msg.action === 'add') {
        if (!String(msg.password || '')) { out.ok = false; out.error = 'needPw'; }
        else store.upsert({ origin: msg.origin, username: cleanText(msg.username), password: String(msg.password) });
      } else if (msg.action === 'update') {
        store.update(String(msg.id || ''), {
          username: msg.username !== undefined ? cleanText(msg.username) : undefined,
          password: String(msg.password || ''),
        });
      } else if (msg.action === 'remove') {
        store.remove(String(msg.id || ''));
      } else if (msg.action === 'reveal') {
        out.plain = store.reveal(String(msg.id || ''));
      }
    } catch (err) {
      out.ok = false;
      out.error = /invalid origin/i.test(String(err && err.message)) ? 'invalidOrigin' : 'failed';
    }
  }
  out.list = listPasswords();
  e.returnValue = out;
});

// ── 右键菜单（复制/粘贴/全选 + 已存密码按账号填充）──
// Electron 窗口没有浏览器右键菜单；容器页当前 frame 有已存密码时列出账号供显式填充
// （多账号的唯一填充入口；单账号走聚焦自动填充）。询问窗/管理窗不在
// containerContents 登记里，天然只有基础三项；明文只在点击那一刻 reveal。
function attachShellContextMenu(target) {
  target.webContents.on('context-menu', (e, params) => {
    const items = [
      { label: '复制', enabled: params.editFlags.canCopy, click: () => target.webContents.copy() },
      { label: '粘贴', enabled: params.editFlags.canPaste, click: () => target.webContents.paste() },
      { label: '全选', enabled: params.editFlags.canSelectAll, click: () => target.webContents.selectAll() },
    ];
    try {
      const origin = params.frameURL ? new URL(params.frameURL).origin : null;
      if (origin && containerContents.has(target.webContents)) {
        const store = getPwStore();
        if (store.isAvailable()) {
          const fillItems = store.listForOrigin(origin).map((en) => ({
            label: '填充密码：' + (en.username || '（无用户名）'),
            click: () => {
              try {
                target.webContents.send('pw:fill', { origin, username: en.username, password: store.reveal(en.id) });
              } catch { /* ignore */ }
            },
          }));
          if (fillItems.length) items.unshift({ type: 'separator' }, ...fillItems.reverse(), { type: 'separator' });
        }
      }
    } catch { /* 右键菜单主体不受影响 */ }
    const menu = Menu.buildFromTemplate(items);
    menu.popup({ window: target, x: params.x, y: params.y });
  });
}

function registerAuthWindowIpc() {
  ipcMain.handle('app-restart', () => { restartApp(); return { ok: true }; });
  // 简要更新日志：优先在线拉 GitHub Releases（列表 API 的 body 即发布时从 CHANGELOG 提取的
  // 本版段落，主题行 + 板块标题俱在）——线上改文案免重装立刻可见；抓取失败（离线 / API
  // 限流）回落解析随包 CHANGELOG.md，小窗永不空白。面板展示口径不变（每个版本 = 主题行 + 板块标题）。
  ipcMain.handle('changelog-brief', async () => {
    const parseBody = (tag, body, publishedAt) => {
      // release body 的提取段不含 CHANGELOG 标题行里的日期（awk 从标题下一行起收），日期取 API published_at
      const sec = { version: String(tag).replace(/^v/i, ''), date: String(publishedAt || '').slice(0, 10), theme: '', topics: [] };
      for (const raw of String(body).split('\n')) {
        const line = raw.trim();
        if (!sec.theme && line.startsWith('>')) sec.theme = line.replace(/^>+\s?/, '');
        else if (line.startsWith('### ')) sec.topics.push(line.slice(4).trim());
      }
      return sec;
    };
    try {
      const m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(daemonInfo.homepage || DEFAULT_HOMEPAGE);
      if (!m) throw new Error('无法从项目主页识别 GitHub 仓库');
      const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
      const res = await net.fetch(`https://api.github.com/repos/${repo}/releases?per_page=6`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),   // 在线失败快速回落本地文件，面板点「更新日志」不长时间空转
      });
      if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);
      const rels = await res.json();
      if (!Array.isArray(rels) || !rels.length) throw new Error('Releases 列表为空');
      return { ok: true, online: true, sections: rels.slice(0, 6).map((r) => parseBody(r.tag_name, r.body || '', r.published_at)) };
    } catch {
      // 回落：解析随包 CHANGELOG.md（打包时快照）
      try {
        const md = fs.readFileSync(path.join(serverRoot, 'CHANGELOG.md'), 'utf8');
        const sections = [];
        for (const raw of String(md).split('\n')) {
          const h = /^##\s*\[([^\]]+)\](?:\s*\(([^)]+)\))?/.exec(raw.trim());
          if (h) { sections.push({ version: h[1].replace(/^v/i, ''), date: h[2] || '', theme: '', topics: [] }); continue; }
          const s = sections[sections.length - 1];
          if (!s) continue;
          const line = raw.trim();
          if (!s.theme && line.startsWith('本版主题:')) s.theme = line.slice(5).trim();
          else if (line.startsWith('### ')) s.topics.push(line.slice(4).trim());
        }
        return { ok: true, sections: sections.slice(0, 6) };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  });
  // 检查更新：面板弹窗（状态查询 / 触发检查 / 主按钮动作 / 打开 Releases）
  ipcMain.handle('update-state', () => updateUiState());
  ipcMain.handle('update-check', async () => { await checkUpdateInteractiveUi(); return updateUiState(); });
  ipcMain.handle('update-install', async () => { await updateUiPrimary(); return updateUiState(); });
  ipcMain.handle('update-open-releases', () => { try { shell.openExternal((daemonInfo.homepage || DEFAULT_HOMEPAGE) + '/releases'); } catch {} });
  // 打开外部 URL（捐赠按钮用）
  ipcMain.handle('shell-open-external', (_, url) => { try { shell.openExternal(url); } catch {} });
  // 唤起小窗显示更新日志摘要（任何入口统一走 openChangelogBrief；IPC 只注册一次）
  ipcMain.handle('open-changelog-brief', () => openChangelogBrief());  ipcMain.handle('open-auth-window', async (_e, url) => {
    if (typeof url !== 'string' || !url.toLowerCase().startsWith('https://')) {
      return { ok: false, error: '只允许打开 https 链接' };
    }
    try { await openIncognitoWindow(url); return { ok: true }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // ZCode 页「打开客户端」：优先本机安装路径，退到 zcode:// 协议
  ipcMain.handle('open-zcode-client', async () => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode', 'ZCode.exe');
      if (process.platform === 'win32' && fs.existsSync(exe)) {
        const err = await shell.openPath(exe);
        if (!err) return { ok: true };
      }
      await shell.openExternal('zcode://');
      return { ok: true };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // mirasim 页「打开客户端」
  ipcMain.handle('open-mirasim-client', async () => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const cand = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', '@mirasimdesktop', 'Mirasim.exe');
      if (process.platform === 'win32' && fs.existsSync(cand)) {
        const err = await shell.openPath(cand);
        if (!err) return { ok: true };
      }
      return { ok: false, error: '未找到 Mirasim 客户端可执行文件' };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // 妙手页「打开客户端」（本机安装于 %LOCALAPPDATA%\妙手\妙手.exe）
  ipcMain.handle('open-catpaw-client', async () => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const cand = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), '妙手', '妙手.exe');
      if (process.platform === 'win32' && fs.existsSync(cand)) {
        const err = await shell.openPath(cand);
        if (!err) return { ok: true };
      }
      return { ok: false, error: '未找到妙手客户端可执行文件' };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // Trae 页「打开客户端」+ 切换后自动重开（安装位置随版本不同：TRAE SOLO CN / Trae CN / TRAE SOLO / Trae）
  ipcMain.handle('open-trae-client', async () => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const names = ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae'];
      for (const n of names) {
        const cand = path.join(local, 'Programs', n, n + '.exe');
        if (process.platform === 'win32' && fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
        }
      }
      return { ok: false, error: '未找到 Trae 客户端可执行文件' };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // MiniMax Code 页「打开客户端」
  ipcMain.handle('open-minimax-client', async () => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const cand = path.join(local, 'Programs', 'MiniMax Code', 'MiniMax Code.exe');
      if (process.platform === 'win32' && fs.existsSync(cand)) {
        const err = await shell.openPath(cand);
        if (!err) return { ok: true };
      }
      return { ok: false, error: '未找到 MiniMax Code 客户端可执行文件' };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0c' : '#f5f6f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadURL(panelUrl());
  attachShellContextMenu(win);   // 仅复制/粘贴/全选；主窗不注册为容器（见密码管理段注释）
  // 只把 https 外链交给系统浏览器打开，其他 scheme 一律不放行
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (quitting) return;
    // Windows 已知坑（electron#26031/#12142）：关闭带 owner 的登录子窗（尤其最大化过的）
    // 可能连带向主窗发出 close——此刻主窗的「关到托盘」会被误触发，面板凭空消失。
    // 子窗刚关（1.5s 内）收到的主窗 close 一律按级联处理：放行销毁流程之外的一切，
    // 不隐藏主窗，并在事件循环里恢复可见性。
    if (Date.now() - childClosingAt < 1500) {
      e.preventDefault();
      setTimeout(() => {
        try {
          if (!win || win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          if (!win.isVisible()) win.show();
        } catch { /* ignore */ }
      }, 0);
      return;
    }
    e.preventDefault();
    mainHiddenToTray = true;   // 用户主动收进托盘：登录子窗关闭后不要把面板又弹回来
    win.hide();
    if (!hideHintShown) {
      hideHintShown = true;
      notify('CreditDaddy 仍在后台运行', '已最小化到系统托盘，自动领取不会中断。单击托盘图标可重新打开面板。');
    }
  });
  win.on('closed', () => { win = null; });
}

function showWin() {
  mainHiddenToTray = false;
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// 唤起面板并弹出更新日志摘要小窗（托盘菜单与 IPC 共用；勿在回调里再 ipcMain.handle）
function openChangelogBrief() {
  showWin();
  try { if (win && !win.isDestroyed()) win.webContents.send('changelog:open'); } catch { /* ignore */ }
}

function notify(title, body) {
  if (process.platform === 'win32' && tray && typeof tray.displayBalloon === 'function') {
    tray.displayBalloon({ title, content: body, iconType: 'info' });
  } else if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

async function checkinNow() {
  tray.setToolTip('CreditDaddy - 正在领取…');
  try {
    const panelKey = daemonMod && typeof daemonMod.getPanelKey === 'function' ? daemonMod.getPanelKey() : '';
    const res = await fetch('http://127.0.0.1:' + boundPort + '/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(panelKey ? { 'x-qd-key': panelKey } : {}) },
      body: '{"skipIfCheckedToday":false}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
    lastSummary = data.summary || '领取完成';
    notify('CreditDaddy 领取完成', lastSummary);
  } catch (e) {
    lastSummary = '领取失败：' + (e && e.message);
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
  tray.setToolTip('CreditDaddy v' + daemonInfo.version + ' - 后台自动领取运行中' + (lastSummary ? '\n' + lastSummary : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'CreditDaddy v' + daemonInfo.version, enabled: false },
    { label: '面板 127.0.0.1:' + boundPort, enabled: false },
    ...(lastSummary ? [{ label: lastSummary.slice(0, 60), enabled: false }] : []),
    ...(updateState.downloaded ? [{ label: '新版本 v' + updateState.downloaded + ' 已就绪，重启即更新', enabled: false }] : []),
    { type: 'separator' },
    { label: '打开面板', click: () => showWin() },
    { label: '立即领取全部账号', click: () => { checkinNow(); } },
    { type: 'separator' },
    { label: '开机自启（后台运行）', type: 'checkbox', checked: autoLaunchEnabled(), click: (item) => setAutoLaunch(item.checked) },
    { label: '已保存的密码…', click: () => promptManagePasswords() },
    { label: '打开数据目录', enabled: Boolean(daemonInfo.dataDir), click: () => shell.openPath(daemonInfo.dataDir) },
    { label: '项目主页（GitHub）', click: () => shell.openExternal(daemonInfo.homepage) },
    { type: 'separator' },
    ...(autoUpdater
      ? [{ label: trayUpdateLabel(), click: () => { openUpdateUi(); } }]
      : []),
    { label: '更新日志…', click: () => openChangelogBrief() },
    { label: '重启 CreditDaddy', click: () => restartApp() },
    { label: '退出 CreditDaddy', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on('window-all-closed', () => {
  // 保持在托盘运行，自动领取不中断
});
app.on('before-quit', () => { quitting = true; });
