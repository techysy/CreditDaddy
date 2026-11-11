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
let buildInfo = null;      // #21 构建身份数据（打包产物才有；本地 dev 无 build.json → null，更新判定只按 semver）
let cookieSitesLib = null;  // 通用 cookie 站点配置/收割（issue #23）
let buildInfoLib = null;   // src/buildInfo.js 模块引用（loadBuildInfo / isNewerRebuild）
// 桌面壳 i18n:与内置 daemon 共用同一个 src/i18n.js 模块实例(同进程)——面板在
// 「语言」里切换后经 daemon 的 setLocale 直接生效;托盘等本壳 UI 串在重建时按当前语言渲染。
// 模块未加载前 Tt 原样返回中文 key(i18n 的约定),托盘最先创建时不受影响。
let I18N = null;
const Tt = (text, vars) => (I18N ? I18N.t(text, vars) : text);
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
  const load = (rel) => import(pathToFileURL(path.join(serverRoot, rel)).href);
  // 先装 i18n 与 locale(daemon 起来前的错误框/首屏托盘也用得上):与 daemon 同模块实例
  try {
    I18N = await load('src/i18n.js');
    const store0 = await load('src/store.js');
    const bootLocale = (await store0.loadSettings().catch(() => ({}))).locale;
    if (bootLocale) I18N.setLocale(bootLocale);
  } catch { /* 词典不可用时 Tt 原样回中文,不阻塞启动 */ }
  // 托盘最先创建：即使 daemon 启动失败也能从托盘退出
  createTray();
  try {
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
    try {
      buildInfoLib = await load('src/buildInfo.js');
      buildInfo = buildInfoLib.loadBuildInfo(serverRoot);
    } catch { buildInfo = null; }
    try { cookieSitesLib = await load('src/cookieSites.js'); } catch { cookieSitesLib = null; }
    checkin.startScheduler();
    // 面板切语言 → daemon 写 settings.json → 本壳即时重建托盘(同进程 i18n 实例已随 PUT 切走)
    try {
      let localeDebounce = null;
      fs.watch(path.join(store.dataDir(), 'settings.json'), () => {
        clearTimeout(localeDebounce);
        localeDebounce = setTimeout(() => refreshTrayMenu(), 400);
      });
    } catch { /* watcher 失败不影响功能,托盘在下一次状态变化时仍会重建 */ }
  } catch (err) {
    dialog.showErrorBox(Tt('CreditDaddy 启动失败'), String((err && err.stack) || err));
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
          title: Tt('CreditDaddy 新版本已就绪'),
          body: Tt('v{v} 已在后台下载完成，退出 CreditDaddy 时自动安装（也可在托盘菜单里立即重启更新）。', { v: info.version }),
          silent: true,
        });
        // 点通知直接开独立更新窗（不依赖主窗口——主窗卡死时这条通道仍可用）
        n.on('click', () => openUpdateUi());
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

/** 版本号比较：semver 口径（预发布 < 正式版），实现在 src/buildInfo.js 可测——
 *  旧实现 parseInt('1-test')===1 丢掉预发布号，测试包 1.7.1-test.4 被当成 1.7.1，
 *  「检查更新」永远已是最新，升不上同号正式版（用户实测）。
 *  buildInfoLib 加载失败（理论不发生：启动早期就 load）时退回旧三段比较保底。 */
function isNewerVersion(next, cur) {
  if (buildInfoLib && typeof buildInfoLib.isNewerVersion === 'function') return buildInfoLib.isNewerVersion(next, cur);
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
  if (!m) throw new Error(Tt('无法从项目主页识别 GitHub 仓库'));
  const repo = m[1] + '/' + m[2].replace(/\.git$/, '');
  const res = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),   // 静默丢包的防火墙下不给超时会吊死更新弹窗
  });
  if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => /^CreditDaddy-(?:Win-)?Setup-.*\.exe$/.test(a.name));
  if (!asset) throw new Error(`最新 release ${rel.tag_name} 没有 Windows 安装包`);
  // #21：同版本平局裁决要读 release 的构建身份资产（老 release 没有 → 只按 semver）
  let relBuild = null;
  const biAsset = (rel.assets || []).find((a) => a.name === 'build-info.json');
  if (biAsset) {
    try {
      const r = await net.fetch(biAsset.browser_download_url, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) relBuild = await r.json();
    } catch { relBuild = null; }
  }
  return {
    version: String(rel.tag_name).replace(/^v/i, ''),
    asset: { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 },
    buildInfo: relBuild,
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
    // 空闲 deadline：大安装包整体可能下载很久（不能一刀切超时），但连续 60s 一个字节
    // 都没有就是连接黑洞了——墙钟放行、静默掐断，弹窗回到 error 态而不是永远「下载中」。
    // 注意 reader.cancel 会把挂起的 read 按 {done:true} 收尾，必须用 stalled 标志区分
    // 「真下完」和「掐断」，否则截断的安装包会被当完整文件（哈希缺失时更是直接安装）
    const IDLE_MS = 60_000;
    let stalled = null;
    let idle = setTimeout(() => {
      stalled = new Error(Tt('下载中断：连接 60 秒无数据'));
      try { reader.cancel(stalled); } catch { /* 已结束 */ }
    }, IDLE_MS);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        clearTimeout(idle);
        if (done) break;
        idle = setTimeout(() => {
          stalled = new Error(Tt('下载中断：连接 60 秒无数据'));
          try { reader.cancel(stalled); } catch { /* 已结束 */ }
        }, IDLE_MS);
        chunks.push(Buffer.from(value));
        got += value.length;
        if (onProgress) onProgress(got, total);
      }
    } finally {
      clearTimeout(idle);
    }
    if (stalled) throw stalled;
    buf = Buffer.concat(chunks);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
    if (onProgress) onProgress(buf.length, buf.length);
  }
  if (expectedSha && crypto.createHash('sha256').update(buf).digest('hex') !== expectedSha) {
    throw new Error(Tt('安装包 SHA256 校验失败，已放弃安装'));
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
    if (!isNewerVersion(rel.version, app.getVersion())) {
      // #21 平局裁决:版本相同但线上是更新的构建(同 tag 重推修复包)也提醒,语义化版本不受影响
      if (buildInfoLib && buildInfo && rel.buildInfo && buildInfoLib.isNewerRebuild(buildInfo, rel.buildInfo)) {
        updateState.fallback = { ...rel, rebuild: true };
        refreshTrayMenu();
        try {
          const n = new Notification({
            title: Tt('CreditDaddy 新版本已就绪'),
            body: Tt('检测到同版本新构建 v{v}（{commit}），可能包含修复，建议更新。', { v: rel.version, commit: rel.buildInfo.commit }),
            silent: true,
          });
          n.on('click', () => openUpdateUi());
          n.show();
        } catch {}
      }
      return;
    }
    updateState.fallback = rel;
    refreshTrayMenu();
    try {
      const n = new Notification({
        title: Tt('CreditDaddy 有新版本'),
        body: Tt('v{v} 已发布，点这里或从托盘菜单「检查更新…」下载安装。', { v: rel.version }),
        silent: true,
      });
      n.on('click', () => openUpdateUi());
      n.show();
    } catch {}
  } catch {}
}

function trayUpdateLabel() {
  if (updateState.downloaded) return Tt('重启并安装更新');
  if (updateState.fallback) {
    if (updateState.fallback.installerPath) return Tt('安装已下载的 v{v}', { v: updateState.fallback.version });
    if (updateState.fallback.rebuild) return Tt('下载同版本新构建…');
    return Tt('下载并安装新版本 v{v}…', { v: updateState.fallback.version });
  }
  return Tt('检查更新…');
}

// ── 检查更新：**独立无边框小窗**（update-window.html + preload-update.js） ──
// 关键设计：更新流程完全不依赖主窗口。主窗口卡死 / 未加载 / 被销毁时，
// 托盘菜单与系统通知仍能打开这个小窗完成检查、下载、安装——这正是 1.6.6
// 白屏事故里用户唯一的自救通道（当时只能去 Releases 手动下载）。
// 页面无 nodeIntegration（contextIsolation + sandbox + preload 白名单），
// 文案全部由主进程 Tt() 渲染后 IPC 推送——单源，页面只做展示。
const UPDATE_HTML = path.join(__dirname, 'update-window.html');
const UPDATE_PRELOAD = path.join(__dirname, 'preload-update.js');
let updateWin = null;
let updateDlCtrl = null;   // 下载中的 AbortController（关窗 → abort，不留半截文件）

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
  const view = updateUiState();
  try { if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update:win-state', view); } catch {}
  // 主窗口若开着也同步一份（面板里的更新入口与更新窗状态一致）
  try { if (win && !win.isDestroyed()) win.webContents.send('update:state', view); } catch {}
  return updateUi;
}

function publishFallbackState() {
  const rel = updateState.fallback;
  if (!rel) return;
  if (rel.installerPath) pushUpdateUi({ phase: 'downloaded', version: rel.version, via: 'github' });
  else pushUpdateUi({
    phase: 'available', version: rel.version, via: 'github', rebuild: Boolean(rel.rebuild),
    commit: rel.buildInfo && rel.buildInfo.commit || null,
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
    if (!autoUpdater) throw new Error(Tt('electron-updater 不可用'));
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
      if (!isNewerVersion(rel.version, app.getVersion())) {
        if (buildInfoLib && buildInfo && rel.buildInfo && buildInfoLib.isNewerRebuild(buildInfo, rel.buildInfo)) {
          updateState.fallback = { ...rel, rebuild: true };
          refreshTrayMenu();
          publishFallbackState();
          return;
        }
        pushUpdateUi({ phase: 'latest' });
        return;
      }
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
        const child = spawn(rel.installerPath, [], { detached: true, stdio: 'ignore' });
        // spawn 的 ENOENT/EPERM 走异步 'error' 事件，try/catch 接不到——不接的话是
        // uncaughtException 直接掀翻主进程（恰好死在「安装更新」这一步）
        child.on('error', (err) => {
          pushUpdateUi({ phase: 'error', error: Tt('启动安装程序失败：{err}（可手动运行 {file}）', { err: String((err && err.message) || err), file: rel.installerPath }) });
        });
        child.unref();
        quitting = true;
        app.quit();
      } catch (err) {
        pushUpdateUi({ phase: 'error', error: Tt('启动安装程序失败：{err}（可手动运行 {file}）', { err: String((err && err.message) || err), file: rel.installerPath }) });
      }
    }
    return;
  }
  const rel = updateState.fallback;
  if (updateUi.phase === 'available' && updateUi.via === 'github' && rel && !rel.installerPath) {
    pushUpdateUi({ phase: 'downloading', percent: null, mb: '0.0' });
    // 关窗/取消 → abort：updateDlCtrl 此前从未赋值，「取消下载」是死按钮（1.7.0 审计发现）
    updateDlCtrl = new AbortController();
    const myCtrl = updateDlCtrl;
    try {
      const file = await downloadSetupInstaller(rel, (got, total) => {
        pushUpdateUi({ phase: 'downloading', percent: total ? Math.round((got / total) * 100) : null, mb: (got / 1048576).toFixed(1) });
      }, myCtrl.signal);
      updateState.fallback = { ...rel, installerPath: file };
      refreshTrayMenu();
      pushUpdateUi({ phase: 'downloaded', version: rel.version, via: 'github' });
    } catch (e) {
      // 用户主动取消不报错误态，回到 available 可再次下载
      if (myCtrl.signal.aborted) pushUpdateUi({ phase: 'available', version: rel.version, via: 'github', rebuild: Boolean(rel.rebuild) });
      else pushUpdateUi({ phase: 'error', error: String((e && e.message) || e) });
    } finally {
      if (updateDlCtrl === myCtrl) updateDlCtrl = null;
    }
  }
}
/** 更新窗文案（静态部分一次性下发；带参数的正文在页面上做占位符替换） */
function updateWindowStrings() {
  return {
    windowTitle: Tt('CreditDaddy 更新'),
    checkingTitle: Tt('正在检查更新'),
    checkingBody: Tt('正在向 GitHub Releases 查询最新版本…'),
    latestTitle: Tt('已是最新版本'),
    latestBody: Tt('当前 v{current} 已是最新版本。'),
    availableTitle: Tt('发现新版本'),
    availableBody: Tt('新版本 v{version}（当前 v{current}）可以下载安装。'),
    rebuildTitle: Tt('发现同版本新构建'),
    rebuildBody: Tt('检测到 v{version} 的新构建，可能包含修复，可直接下载安装。'),
    downloadingTitle: Tt('正在下载更新'),
    downloadingBody: Tt('下载完成后可直接安装，安装时 CreditDaddy 会先退出。'),
    downloadedTitle: Tt('更新已就绪'),
    downloadedBody: Tt('安装包已下载完成，点「立即安装」重启并完成更新。'),
    unsupportedTitle: Tt('当前版本不支持应用内更新'),
    unsupportedBody: Tt('开发模式 / 便携版 / 非 Windows 平台不支持应用内更新，请到 Releases 页面手动下载。'),
    errorTitle: Tt('检查更新失败'),
    sizeSuffix: Tt('（约 {mb} MB）'),
    commitLabel: Tt('构建 {commit}'),
    downloadInstall: Tt('下载并安装'),
    openReleases: Tt('打开 Releases'),
    installNow: Tt('立即安装'),
    later: Tt('稍后'),
    ok: Tt('好的'),
    cancel: Tt('取消'),
    close: Tt('关闭'),
  };
}

/**
 * 打开（或聚焦）独立更新窗。
 * ⚠️ 这里刻意**不调用 showWin()**：主窗口卡死时正是要避开它。
 */
function openUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    try { updateWin.show(); updateWin.focus(); } catch {}
    return;
  }
  updateWin = new BrowserWindow({
    width: 420,
    height: 360,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,                      // 页面内自定义标题栏（拖拽区 + 关闭按钮）
    title: Tt('CreditDaddy 更新'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0c' : '#f5f6f8',
    // 更新窗不设 parent：主窗卡死/最小化到托盘时它仍可独立显示并操作
    webPreferences: {
      preload: UPDATE_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updateWin.once('ready-to-show', () => { try { if (updateWin && !updateWin.isDestroyed()) updateWin.show(); } catch {} });
  // 本地 file 页面：外链/导航一律拦死（「打开 Releases」走主进程 shell.openExternal）
  updateWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  updateWin.webContents.on('will-navigate', (e, url) => {
    if (!String(url).startsWith('file://')) e.preventDefault();
  });
  updateWin.on('closed', () => {
    if (updateDlCtrl) { try { updateDlCtrl.abort(); } catch {} updateDlCtrl = null; }
    updateWin = null;
  });
  updateWin.loadFile(UPDATE_HTML).catch((e) => {
    console.error('update window load failed:', e && e.message);
    try { updateWin && updateWin.close(); } catch {}
  });
}

// 更新窗页面 bootstrap：静态文案 + 当前状态（页面可能比状态推送晚加载完成）
ipcMain.handle('update:win-bootstrap', (e) => {
  if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return null;
  return { strings: updateWindowStrings(), view: updateUiState() };
});
// 页面量好内容高度后回报，窗口按状态贴合（各态高度不同，宽度恒 420）
ipcMain.on('update:win-fit', (e, height) => {
  if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return;
  const h = Math.max(220, Math.min(640, Math.ceil(Number(height) || 0)));
  try { updateWin.setContentSize(420, h); } catch {}
});
ipcMain.on('update:win-action', (e, action) => {
  if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return;
  if (action === 'close') { try { updateWin.close(); } catch {} return; }
  if (action === 'open-releases') {
    try { shell.openExternal((daemonInfo.homepage || DEFAULT_HOMEPAGE) + '/releases'); } catch {}
    return;
  }
  if (action === 'primary') { updateUiPrimary().catch(() => {}); return; }
  // 下载中点「取消」：abort 掉在途下载（closed 处理器兜底关窗场景，这里显式处理点按钮场景）
  if (action === 'cancel') {
    if (updateDlCtrl) { try { updateDlCtrl.abort(); } catch {} updateDlCtrl = null; }
    return;
  }
});

/**
 * 托盘 / 系统通知入口：**只开独立更新窗，不唤醒主窗口**。
 * 主窗口未启动（--hidden 常驻）或已卡死时，这条路径依然可用。
 */
function openUpdateUi() {
  openUpdateWindow();
  pushUpdateUi({});   // 先同步一次当前状态（页面 bootstrap 也会补发，双保险）
}

/** 托盘 / 通知点击「检查更新」：开窗并立即跑一次检查 */
function openUpdateUiAndCheck() {
  openUpdateUi();
  checkUpdateInteractiveUi().catch(() => {});
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
    const timer = setTimeout(() => fail(Tt('等待验证码超时')), 120000);

    // JSON 内嵌 <script> 时把 < 转义成 \u003c，防止配置值（服务端下发）里出现 </script> 闭合标签注入
    const jsonSafe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
    const html = `<!doctype html><meta charset="utf-8"><title>${Tt('验证码')}</title><body style="margin:0;background:#fff">
<script>window.AliyunCaptchaConfig=${jsonSafe({ region: cfg.region || '', prefix: cfg.prefix || '' })};</script>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"><\/script>
<div id="c"></div><button id="b" hidden>${Tt('打开验证码')}</button>
<script>
window.initAliyunCaptcha({
  SceneId:${jsonSafe(cfg.sceneId)},mode:'popup',language:'zh-CN',showErrorTip:false,
  element:'#c',button:'#b',
  getInstance:(i)=>{
    if(i&&typeof i.startTracelessVerification==='function'){i.startTracelessVerification();setTimeout(()=>console.log('ZCAP:INTERACTIVE'),8000);}
    else console.log('ZCAP:INTERACTIVE');
  },
  success:(p)=>console.log('ZCAP:OK:'+(typeof p==='string'?p:(p&&p.captchaVerifyParam)||'')),
  fail:(p)=>{const tp=(p&&(typeof p.captchaVerifyParam==='string'?p.captchaVerifyParam:(typeof p.CaptchaVerifyParam==='string'?p.CaptchaVerifyParam:'')))||'';if(tp&&((p.success===true&&p.verifyResult===true)||(p.verifyCode==='T006')))console.log('ZCAP:OK:'+tp);else console.log('ZCAP:INTERACTIVE');},
  onError:()=>console.log('ZCAP:ERR'),
});
<\/script></body>`;

    capWin = new BrowserWindow({
      show: false, width: 420, height: 560, title: Tt('完成验证码（ZCode 活动领取）'),
      icon: iconPath(), autoHideMenuBar: true,
      webPreferences: { session: session.fromPartition('zcap-' + crypto.randomUUID()), contextIsolation: true, sandbox: true },
    });
    capWin.webContents.on('console-message', (e, level, message) => {
      const msg = typeof message === 'string' ? message : (e && e.message) || '';
      if (msg.startsWith('ZCAP:OK:')) pass(msg.slice(8));
      else if (msg === 'ZCAP:INTERACTIVE') { if (capWin && !capWin.isDestroyed() && !capWin.isVisible()) capWin.show(); }
      else if (msg.startsWith('ZCAP:ERR')) fail(Tt('验证码组件加载失败'));
    });
    capWin.on('closed', () => fail(Tt('验证码未完成')));
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
    const timer = setTimeout(() => { if (!settled) { settled = true; if (capWin && !capWin.isDestroyed()) capWin.destroy(); reject(new Error(Tt('网关补全超时（120s）'))); } }, 120000);
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); if (capWin && !capWin.isDestroyed()) capWin.destroy(); fn(arg); } };

    const jsonSafe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
    capWin = new BrowserWindow({
      show: false, width: 460, height: 600, title: Tt('ZCode 额度网关（后台验证）'),
      icon: iconPath(), autoHideMenuBar: true,
      webPreferences: { session: session.fromPartition('zcap-' + crypto.randomUUID()), contextIsolation: true, sandbox: true },
    });
    capWin.webContents.on('console-message', (e, level, message) => {
      const msg = typeof message === 'string' ? message : (e && e.message) || '';
      if (msg.startsWith('ZGW:RESP:')) {
        try { done(resolve, JSON.parse(msg.slice(9))); } catch { done(reject, new Error(Tt('网关响应解析失败'))); }
      } else if (msg.startsWith('ZGW:ERR:')) {
        done(reject, new Error(msg.slice(8)));
      } else if (msg === 'ZCAP:INTERACTIVE') {
        if (capWin && !capWin.isDestroyed() && !capWin.isVisible()) capWin.show();
      }
    });
    capWin.on('closed', () => done(reject, new Error(Tt('网关窗口提前关闭'))));

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
      capWin.webContents.executeJavaScript(pageJs).catch((err) => done(reject, new Error(Tt('页内脚本执行失败：') + err.message)));
    }).catch((err) => done(reject, new Error(Tt('zcode.z.ai 打开失败：') + err.message)));
  });
}

/**
 * 登录窗口。两种会话形态：
 *  - 隐私（默认）：全新内存态 session 分区（不带 persist: 前缀 = 不落盘），与系统浏览器
 *    及其它登录会话完全隔离；关闭时清空该 session 的存储 —— 每次捕获都要重新登录。
 *  - 持久（persistKey = 'cookie-site-<id>'）：`persist:` 分区按站点落盘——**用户在本窗登录
 *    一次后，下一轮重捕/重探直接复用活着的社会Cookie会话，免二次登录**（站点 SSO 场景
 *    每登录一次都要过一遭谷歌验证码，这是最高频的痛点）。落盘位置与账号库同在用户数据目录
 *    （本机自有凭据，同一份 0600 纪律），面板「清除已存会话」可随时抹掉。Qoder 专属线不用它。
 */
async function openIncognitoWindow(url, { persistKey } = {}) {
  const partition = persistKey ? 'persist:' + persistKey : 'incognito-' + crypto.randomUUID();
  const ses = session.fromPartition(partition);   // 无 persist: 前缀 → 内存态，进程退出即消失
  const isPersist = Boolean(persistKey);
  // 按 IP 识别地区的站点（qoder.com 国际版 + cookie-site 捕获窗，如 Token Harbor 对大陆/港澳封锁）：
  // 配置了出口代理时登录窗显式走它；未配置则保持默认（Electron 窗口本来就跟随系统代理，不覆盖）。
  // 登录窗与 daemon 探测同走「网络出口（全局）」——两边出口 IP 一致，避免窗内登录成功、
  // 探测被拒的错位（同一个站两种出口，一边通一边拒最难排查）。规则型代理（Clash 等）
  // 对国内站点自动直连，不影响 MiMo / LongCat 等国内站登录。
  const cookieSite = cookieSitesLib && typeof cookieSitesLib.siteForLoginUrl === 'function' ? cookieSitesLib.siteForLoginUrl(url) : null;
  const isQoderUrl = /(:\/\/|\.)qoder\.(com|cn)(\/|$)/.test(url);
  if (isQoderUrl || cookieSite) {
    const proxy = daemonMod && typeof daemonMod.getLoginProxyUrl === 'function' ? daemonMod.getLoginProxyUrl() : null;
    if (proxy) await ses.setProxy({ proxyRules: proxy, proxyBypassRules: '<local>' }).catch(() => {});
  }
  const authWin = new BrowserWindow({
    width: 480,
    height: 720,
    // 标题区分两种窗（用户可辨，不再靠猜）：持久窗复用已存登录态（可能直接进控制台）、
    // 无痕窗全新会话（必然是登录页）。
    title: Tt(isPersist ? '登录（会话复用）' : '登录（无痕窗口）'),
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
  // river 等 WorkOS 站点：截获 authenticate 响应体里的 token（页面内存读不到）
  attachAuthTokenSniffer(authWin.webContents, ses);
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
  // 登录窗口按目标站点登记收割器(#23 通用 cookie 捕获;Qoder 维持专属通道)
  // （cookieSite 已在开窗前计算：捕获窗的出口代理也按它显式设置）
  authWin.on('closed', () => {
    // 清空前抢救会话 Cookie（httpOnly，页面脚本拿不到，只有 session API 能读）。
    // 必须先等收割完成再清存储——两者并发的话 clearStorageData 会抢先抹掉 Cookie，
    // 收割永远是空的（国际版「缺网页会话」长期修不好的根因）。
    const jobs = [];
    if (isQoderUrl) jobs.push(harvestQoderWebSession(ses));
    if (cookieSite) jobs.push(harvestCookieSiteSession(ses, cookieSite));
    Promise.allSettled(jobs)
      .catch(() => {})
      .finally(() => {
        // 持久分区【不擦存储】——复用登录态正是它的存在意义；「清除已存会话」入口
        // （clear-cookie-site-session）负责显式抹除。无痕分区照旧关窗即清。
        if (!isPersist) ses.clearStorageData().catch(() => {});
      });
  });
  authWin.loadURL(url);
  return authWin;
}

/** 读取本次登录窗口隐私会话里的 qoder 网页 Cookie，交给 daemon 按 uid 归户。
 *  两个域都上报（含 Cookie 数量的诊断信息）——daemon 会把「收割到 0 条」也记进运行日志，
 *  否则收割失败完全静默，「缺网页会话」查不到原因。
 *  上报成功且有账号完成绑定时推 `qoder-web-session:bound` 事件：面板的「缺网页会话」
 *  徽章据此即时消失（此前只靠 12s/30s 两个 setTimeout 猜收割时机，猜错就挂到
 *  30s 周期轮——收割明明完成了用户却要手动刷新）。 */
async function harvestQoderWebSession(ses) {
  const targets = [
    { kind: 'qoder-cn', url: 'https://qoder.cn' },
    { kind: 'qoder', url: 'https://qoder.com' },
  ];
  const panelKey = (daemonMod && typeof daemonMod.getSessionKey === 'function' && daemonMod.getSessionKey()) || (daemonMod && typeof daemonMod.getPanelKey === 'function' ? daemonMod.getPanelKey() : '');
  let boundTotal = 0;
  for (const t of targets) {
    const cookies = await ses.cookies.get({ url: t.url }).catch(() => []);
    const cookie = (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
    // 上报结果不再静默：连接失败 / 401 被「网页会话收割」日志缺席时无从查起——
    // 状态码与失败原因落 tray 通知（daemon 日志是 daemon 侧的，desktop 侧失败它看不见）。
    let note = '';
    try {
      const res = await fetch('http://127.0.0.1:' + boundPort + '/api/auth/qoder-web-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(panelKey ? { 'x-qd-key': panelKey } : {}) },
        body: JSON.stringify({ kind: t.kind, cookie, diag: { cookieCount: (cookies || []).length } }),
      });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        boundTotal += Number(d.bound) || 0;
      } else {
        note = 'HTTP ' + res.status + (res.status === 401 ? '（密钥被拒——壳与 daemon 版本或实例不一致？）' : '');
      }
    } catch (e) {
      note = '连接失败：' + (e?.cause?.code || e?.message || e);
    }
    if (note) notify('Qoder', Tt('{kind} 网页会话收割上报失败：{note}', { kind: t.kind, note }));
  }
  if (boundTotal > 0) {
    try { if (win && !win.isDestroyed()) win.webContents.send('qoder-web-session:bound', { bound: boundTotal }); } catch { /* ignore */ }
  }
}

/** #23：浏览器隐藏窗探针——同一会话内加载 dashboard,轮询配额标记(绕 Node 的 TLS/UA/CSR 差异) */
async function probeViaHiddenWindow(ses, site, timeoutMs = 20000) {
  let w = null;
  try {
    w = new BrowserWindow({ show: false, width: 480, height: 640, webPreferences: { session: ses, sandbox: true } });
    await w.webContents.loadURL(site.probe.url);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const html = await w.webContents.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""').catch(() => '');
      const matchOk = typeof site.probe.match === 'function' ? site.probe.match(html) : (site.probe.match && html.includes(site.probe.match));
      if (html && matchOk) return html;
      // 登录页壳出现 = 会话被拒,提前终止(与 daemon 的 invalid 分类对齐)
      if (html && /sign\s?in|log\s?in/i.test(html) && html.length > 500) return html;
      await new Promise((r) => setTimeout(r, 500));
    }
    // 超时兜底:把当前 HTML(可能是风控挑战/空壳)也一并上送,便于区分猫眼
    return await w.webContents.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""').catch(() => null);
  } catch { return null; }
  finally { try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* ignore */ } }
}

/** WorkOS 会话 token 截获（river）：SPA 把 token 只放内存 Map（Co），localStorage 不写、
 *  cookie 里也只有标记/可能带 Path 域——页面脚本与 session API 都拿不到 token 本体。
 *  唯一可靠出口是 `/user_management/authenticate` 的**响应体**（access + refresh 全在里面）：
 *  给登录窗挂 CDP Network 监听，见响应即摘。摘到的 token 以 storage 同形键交给 daemon
 *  （parseRiverSession 原样消费），通道顺序不变。 */
function attachAuthTokenSniffer(wc, ses) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch { return; }
  wc.debugger.on('message', (e, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const url = String(params?.response?.url || '');
    if (!url.includes('/user_management/authenticate')) return;
    wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then((r) => {
      try {
        const body = JSON.parse(r.body);
        if (!body?.access_token) return;
        ses._workosAuth = {
          accessToken: body.access_token,
          refreshToken: body.refresh_token || null,
          user: body.user || null,
          capturedAt: new Date().toISOString(),
        };
      } catch { /* 非 JSON 响应忽略 */ }
    }).catch(() => { /* 响应体取不到不致命 */ });
  });
  try { wc.debugger.sendCommand('Network.enable'); } catch { /* ignore */ }
}

/** #23 增补：localStorage 凭据收割（river = WorkOS SPA 会话 token，cookie/HTML 探针拿不到）。
 *  登录窗关闭后 webContents 已销毁，但同 session 的 localStorage 仍在——开同源隐藏窗读键值。
 *  实测：console SPA 的 WorkOS token 只在内存 Map，localStorage 通常为空——storage 为空时
 *  daemon 侧走 cookie 通道，这里的前缀扫描只是 dev 模式/旧 SDK 的兜底。 */
async function harvestSiteStorage(ses, site) {
  const hasKeys = Array.isArray(site.storageKeys) && site.storageKeys.length > 0;
  const hasPrefixes = Array.isArray(site.storagePrefixes) && site.storagePrefixes.length > 0;
  if (!hasKeys && !hasPrefixes) return {};
  let w = null;
  try {
    w = new BrowserWindow({ show: false, width: 480, height: 640, webPreferences: { session: ses, sandbox: true } });
    await w.webContents.loadURL(site.homeUrl);
    await new Promise((r) => setTimeout(r, 800));   // SPA 启动缓冲（localStorage 可读性与渲染无关，等一拍更稳）
    const js = `JSON.stringify((() => { try {
      const out = {};
      for (const k of ${JSON.stringify(site.storageKeys || [])}) out[k] = window.localStorage.getItem(k);
      for (const p of ${JSON.stringify(site.storagePrefixes || [])}) {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(p)) out[k] = window.localStorage.getItem(k);
        }
      }
      return out;
    } catch { return {}; } })())`;
    const raw = await w.webContents.executeJavaScript(js).catch(() => null);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
  finally { try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* ignore */ } }
}

/** #23：通用 cookie 站点收割——隐私会话里的全量 cookie 串成 plain string,交给 daemon 探测入库 */
async function harvestCookieSiteSession(ses, site) {
  // 全量 cookie（不过滤 URL）：带 Path 域的会话 cookie（如 /user_management 下的刷新 cookie）
  // 按 URL 过滤会被丢掉——2026-10-14 实测 river 刷新兑换「Missing refresh token」的根因之一
  const all = await ses.cookies.get({}).catch(() => []);
  // 站点要求特定鉴权 cookie（site.authCookieName：SSO 回调后由 API 异步 set-cookie，
  // 关窗早一拍它还没落地——收割就是空的，daemon 打过去必 401「会话失效」）：
  // 轮询等它最多 8s（每 400ms 一查），等不到就按现状收割（daemon 侧会归为 401 + 日志点名）。
  const authCookieName = String(site.authCookieName || '');
  if (authCookieName && !all.some((c) => c.name === authCookieName)) {
    const deadline = Date.now() + 8000;
    let polled = all;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      polled = await ses.cookies.get({}).catch(() => []);
      if (polled.some((c) => c.name === authCookieName)) break;
    }
    if (polled.some((c) => c.name === authCookieName)) {
      all.length = 0;
      all.push(...polled);
    } else {
      notify(site.name, Tt('登录凭据（{name}）尚未由站点写回——捕获可能不完整，如卡片显示会话失效请稍后在站点内重新触发一次登录', { name: authCookieName }));
    }
  }
  const cookie = cookieSitesLib.serializeCookies(all);
  const key = (daemonMod && typeof daemonMod.getSessionKey === 'function' && daemonMod.getSessionKey()) || (daemonMod && typeof daemonMod.getPanelKey === 'function' ? daemonMod.getPanelKey() : '');
  // localStorage 凭据站点（river）：token 只活在页面上下文；HTML 探针跳过（余额 API 调用即探测）
  const storageSite = Array.isArray(site.storageKeys) && site.storageKeys.length > 0;
  const storage = storageSite ? await harvestSiteStorage(ses, site).catch(() => ({})) : {};
  // CDP 截获的 WorkOS token（authenticate 响应体）以 storage 同形键并入，daemon 侧同一套解析
  const ws = ses._workosAuth;
  if (ws && ws.accessToken) {
    storage['workos:access-token'] = ws.accessToken;
    if (ws.refreshToken) storage['workos:refresh-token'] = ws.refreshToken;
    if (ws.user) storage['workos:user'] = typeof ws.user === 'string' ? ws.user : JSON.stringify(ws.user);
  }
  const storageCount = Object.values(storage || {}).filter((v) => typeof v === 'string' && v.trim()).length;
  // 先拿浏览器视角 HTML(Node 探测会拿风控/空壳,造成「登录明明成功却报会话无效」)
  const probeHtml = storageSite ? null : await probeViaHiddenWindow(ses, site).catch(() => null);
  let r = null;
  let harvestErr = '';
  try {
    r = await fetch('http://127.0.0.1:' + boundPort + '/api/cookie-sites/' + site.id + '/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-qd-key': key } : {}) },
    body: JSON.stringify({
      cookie,
      storage,
      // 名字 only（值不进日志）——刷新兑换失败时一眼看出会话 cookie 在不在
      diag: { cookieCount: (all || []).length, storageCount, cookieNames: (all || []).map((c) => c.name) },
      probeHtml,
    }),
    });
    if (!r.ok) harvestErr = 'HTTP ' + r.status + (r.status === 401 ? '（密钥被拒——壳与 daemon 实例不一致？）' : '');
  } catch (e) {
    harvestErr = '连接失败：' + (e?.cause?.code || e?.message || e);
  }
  if (harvestErr) notify(site.name, Tt('cookie 收割上报失败：{err}', { err: harvestErr }));
  if (r && r.ok) {
    try { if (win && !win.isDestroyed()) win.webContents.send('cookie-site:captured', { site: site.id, name: site.name, ok: true }); } catch { /* ignore */ }
    notify(site.name, Tt(site.no10rSync ? 'cookie 捕获成功，额度卡片已就绪' : 'cookie 捕获成功，同步到 10Router 后卡片点亮'));
  } else {
    const detail = r ? await r.json().catch(() => ({})) : {};
    const errText = (detail && detail.error) || Tt('cookie 捕获被拒：会话探测未通过，请重新登录后再试');
    notify(site.name, errText);
    try { if (win && !win.isDestroyed()) win.webContents.send('cookie-site:captured', { site: site.id, name: site.name, ok: false, error: errText }); } catch { /* ignore */ }
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
      notify(Tt('密码管理已停用'), Tt('系统凭据加密不可用，无法安全保存密码（不会写明文到磁盘）。'));
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
    title: payload.isUpdate ? Tt('更新密码？') : Tt('保存密码？'),
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
<span style="width:56px;font-size:12px;color:#888">${Tt('站点')}</span>
<input value="SITE_VAL" readonly style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;color:#555;background:transparent">
</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">${Tt('用户名')}</span>
<input id="u" value="USER_VAL" placeholder="${Tt('用户名')}" style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">${Tt('密码')}</span>
<input id="p" type="password" value="PASS_VAL" style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
</div>
<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
<button id="never" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">${Tt('永不保存此站点')}</button>
<button id="no" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">${Tt('暂不')}</button>
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
  // 单趟替换：链式 .replace 会把前一个替换值再交给后续 token 扫描——
  // 密码里恰好含「SAVE_LBL」这类字面量时会被改写成按钮文案，保存的就是错的密码
  const filled = html.replace(/PW_TITLE|SITE_VAL|USER_VAL|PASS_VAL|SAVE_LBL/g, (tok) => ({
    PW_TITLE: esc(payload.isUpdate ? Tt('更新密码？') : Tt('保存密码？')),
    SITE_VAL: esc(payload.origin),
    USER_VAL: esc(payload.username),
    PASS_VAL: esc(payload.password),
    SAVE_LBL: esc(payload.isUpdate ? Tt('更新') : Tt('保存')),
  })[tok]);
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
      title: Tt('验证面板访问密码'),
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
<div style="font-size:14px;font-weight:600">${Tt('输入面板访问密码')}</div>
<div style="font-size:12px;color:#888">${Tt('已保存的密码需要面板访问密码才能查看。')}</div>
<input id="k" type="password" autofocus placeholder="${Tt('面板访问密码')}" style="flex:1;min-width:0;padding:6px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
<div id="err" style="font-size:12px;color:#c0392b;display:none">${Tt('密码不正确')}</div>
<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:2px">
<button id="cancel" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">${Tt('取消')}</button>
<button id="ok" style="padding:5px 14px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer">${Tt('确定')}</button>
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
  const ok = daemonMod && typeof daemonMod.verifyPanelPassword === 'function' && daemonMod.verifyPanelPassword(String(entered || ''));
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
  const needKey = daemonMod && typeof daemonMod.panelKeyRequired === 'function' && daemonMod.panelKeyRequired();
  if (needKey && !(await verifyPanelKey())) {
    notify(Tt('密码管理已锁定'), Tt('需要输入面板访问密码才能查看已保存的密码。'));
    return;
  }
  pwMgrWin = new BrowserWindow({
    width: 800,
    height: 520,
    parent: (win && !win.isDestroyed()) ? win : undefined,
    alwaysOnTop: true,
    title: Tt('已保存的密码'),
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
const ERRS = { invalidOrigin: '${Tt('站点地址无效')}', needPw: '${Tt('密码不能为空')}', failed: '${Tt('操作失败')}' };
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
    un.placeholder = '${Tt('用户名')}';
    const pin = document.createElement('input');
    pin.style.cssText = INP + ';flex:2';
    pin.type = 'password';
    pin.placeholder = '${Tt('留空保持原密码')}';
    let revealed = false;
    const show = document.createElement('button');
    show.style.cssText = BTN;
    show.textContent = '${Tt('显示')}';
    show.onclick = () => {
        if (!revealed) {
            const r = rpc({ action: 'reveal', id: it.id });
            if (!r.ok) return showErr(r.error || 'failed');
            pin.value = String(r.plain || '');
            pin.type = 'text';
            show.textContent = '${Tt('隐藏')}';
            revealed = true;
        } else {
            pin.value = '';
            pin.type = 'password';
            show.textContent = '${Tt('显示')}';
            revealed = false;
        }
    };
    const save = document.createElement('button');
    save.style.cssText = BTN;
    save.textContent = '${Tt('保存')}';
    save.onclick = () => {
        const r = rpc({ action: 'update', id: it.id, username: un.value, password: pin.value });
        if (!r.ok) return showErr(r.error || 'failed');
        clearErr();
        render();
    };
    const copy = document.createElement('button');
    copy.style.cssText = BTN;
    copy.textContent = '${Tt('复制')}';
    copy.onclick = () => {
        const r = rpc({ action: 'reveal', id: it.id });
        if (!r.ok) return showErr(r.error || 'failed');
        clipboard.writeText(String(r.plain || ''));
        copy.textContent = '${Tt('已复制')}';
        setTimeout(() => { copy.textContent = '${Tt('复制')}'; }, 1200);
    };
    const del = document.createElement('button');
    del.style.cssText = BTN;
    del.textContent = '${Tt('删除')}';
    del.onclick = () => {
        // 两步删除：第一次点变「确认删除？」，render 重建节点自动复位
        if (del.dataset.arm !== '1') { del.dataset.arm = '1'; del.textContent = '${Tt('确认删除？')}'; return; }
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
    if (!list.length) { box.textContent = '${Tt('还没有已保存的密码——可在登录时保存，或在上方手动添加。')}'; return; }
    for (const it of list) box.appendChild(row(it));
}
// 手动添加行（origin/用户名/密码）
const addBox = document.getElementById('add');
const aO = document.createElement('input');
aO.style.cssText = INP + ';flex-basis:100%';
aO.placeholder = '${Tt('站点（如 https://qoder.com）')}';
const aU = document.createElement('input');
aU.style.cssText = INP;
aU.placeholder = '${Tt('用户名')}';
const aP = document.createElement('input');
aP.style.cssText = INP;
aP.type = 'password';
aP.placeholder = '${Tt('密码')}';
const addBtn = document.createElement('button');
addBtn.style.cssText = BTN;
addBtn.textContent = '${Tt('添加')}';
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
      { label: Tt('复制'), enabled: params.editFlags.canCopy, click: () => target.webContents.copy() },
      { label: Tt('粘贴'), enabled: params.editFlags.canPaste, click: () => target.webContents.paste() },
      { label: Tt('全选'), enabled: params.editFlags.canSelectAll, click: () => target.webContents.selectAll() },
    ];
    try {
      const origin = params.frameURL ? new URL(params.frameURL).origin : null;
      if (origin && containerContents.has(target.webContents)) {
        const store = getPwStore();
        if (store.isAvailable()) {
          const fillItems = store.listForOrigin(origin).map((en) => ({
            label: Tt('填充密码：{user}', { user: en.username || Tt('（无用户名）') }),
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
      const sec = { version: String(tag).replace(/^v/i, ''), date: String(publishedAt || '').slice(0, 10), theme: '', topics: [], entries: [] };
      for (const raw of String(body).split('\n')) {
        const line = raw.trim();
        if (!sec.theme && line.startsWith('>')) sec.theme = line.replace(/^>+\s?/, '');
        // 「本版主题:**…**」格式（1.5.1 起）不是引用行，在线路径也要认——此前只有本地回落解析它，
        // 在线拉到的 1.5.1 条目只剩标题没有主题（面板截图反馈）。全角/半角冒号都兼容。
        // 双语主题（2026-10-21 起）：「本版主题: … / Theme: …」同行双语，整行进主题位，
        // 英文用户读 '/ Theme: …' 后半段；解析不拆分，展示由 strip 去粗体标记。
        else if (!sec.theme && /^本版主题[:：]/.test(line)) sec.theme = line.replace(/^本版主题[:：]\s?/, '');
        else if (line.startsWith('### ')) sec.topics.push(line.slice(4).trim());
        // 纯条目行（1.7.x 起 CHANGELOG 段落是「- **标题**：长描述」形态，无主题行无 ### 板块）——
        // 整行收进 entries，面板摘要才有内容可显（截断在渲染端）
        else if (line.startsWith('- ')) sec.entries.push(line.slice(2));
      }
      return sec;
    };
    // 多语目录（2026-10-21）：按面板语言拉对应语言文件——
    //   在线：优先 raw.githubusercontent 按 tag 拉 CHANGELOG.<lang>.md（v1.6.0 起提供 en；逐版翻译，
    //   老版本在 en 文件里给一行指引回落主文件），404/超时回落 Releases API body（简中主文）。
    //   回落：随包 CHANGELOG[.<lang>].md（CI 暂存时一并拷入）。
    // 非 zh 系 locale 走对应语言文件（en/ja/ko，v1.6.0 起提供）；zh / zh-TW / 缺省走主文件
    // （简中/繁中由主文承载，繁中词典覆盖 UI 不覆盖日志正文）。
    const briefLocale = (() => { try { return I18N ? I18N.getLocale() : ''; } catch { return ''; } })();
    const briefLang = /^en/i.test(briefLocale) ? 'en' : /^ja/i.test(briefLocale) ? 'ja' : /^ko/i.test(briefLocale) ? 'ko' : '';
    const langFile = (base) => (briefLang ? path.join(serverRoot, 'CHANGELOG.' + briefLang + '.md') : path.join(serverRoot, base));
    try {
      const m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(daemonInfo.homepage || DEFAULT_HOMEPAGE);
      if (!m) throw new Error(Tt('无法从项目主页识别 GitHub 仓库'));
      const repo = m[1] + '/' + m[2].replace(/\.git$/, '');
      const parseMdSections = (md) => {
        const sections = [];
        for (const raw of String(md).split('\n')) {
          const h = /^##\s*\[([^\]]+)\](?:\s*\(([^)]+)\))?/.exec(raw.trim());
          if (h) { sections.push({ version: h[1].replace(/^v/i, ''), date: h[2] || '', theme: '', topics: [], entries: [] }); continue; }
          const s = sections[sections.length - 1];
          if (!s) continue;
          const line = raw.trim();
          if (!s.theme && line.startsWith('本版主题:')) s.theme = line.slice(5).trim();
          else if (!s.theme && /^Theme[:：]/.test(line)) s.theme = line.replace(/^Theme[:：]\s?/, '');
          else if (!s.theme && /^主题[:：]/.test(line)) s.theme = line.replace(/^主题[:：]\s?/, '');
          else if (line.startsWith('### ')) s.topics.push(line.slice(4).trim());
          else if (line.startsWith('- ')) s.entries.push(line.slice(2));
        }
        return sections;
      };
      if (briefLang) {
        // 按 tag 逐个拉对应语言文件（前 6 个版本）；某个 tag 没有该语言文件就回落该版 releases body
        try {
          const relsRes = await net.fetch(`https://api.github.com/repos/${repo}/releases?per_page=6`, {
            headers: { Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!relsRes.ok) throw new Error(`HTTP ${relsRes.status}`);
          const rels = await relsRes.json();
          if (!Array.isArray(rels) || !rels.length) throw new Error(Tt('Releases 列表为空'));
          const sections = [];
          for (const r of rels.slice(0, 6)) {
            try {
              const rawRes = await net.fetch(`https://raw.githubusercontent.com/${repo}/${r.tag_name}/CHANGELOG.${briefLang}.md`, {
                signal: AbortSignal.timeout(10_000),
              });
              if (!rawRes.ok) throw new Error(`HTTP ${rawRes.status}`);
              const md = await rawRes.text();
              const hit = parseMdSections(md).find((s) => s.version === r.tag_name.replace(/^v/i, ''));
              if (hit) { hit.date = String(r.published_at || '').slice(0, 10); sections.push(hit); continue; }
              throw new Error('section not found');
            } catch { sections.push(parseBody(r.tag_name, r.body || '', r.published_at)); }
          }
          return { ok: true, online: true, sections };
        } catch { /* 逐文件拉取失败 → 落到随包语言文件回落 */ }
      }
      const res = await net.fetch(`https://api.github.com/repos/${repo}/releases?per_page=6`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),   // 在线失败快速回落本地文件，面板点「更新日志」不长时间空转
      });
      if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);
      const rels = await res.json();
      if (!Array.isArray(rels) || !rels.length) throw new Error(Tt('Releases 列表为空'));
      return { ok: true, online: true, sections: rels.slice(0, 6).map((r) => parseBody(r.tag_name, r.body || '', r.published_at)) };
    } catch {
      // 回落：解析随包 CHANGELOG[.<lang>].md（打包时快照；语言文件缺失回落主文件）
      try {
        let md;
        try { md = fs.readFileSync(langFile('CHANGELOG.md'), 'utf8'); }
        catch { md = fs.readFileSync(path.join(serverRoot, 'CHANGELOG.md'), 'utf8'); }
        const sections = [];
        for (const raw of String(md).split('\n')) {
          const h = /^##\s*\[([^\]]+)\](?:\s*\(([^)]+)\))?/.exec(raw.trim());
          if (h) { sections.push({ version: h[1].replace(/^v/i, ''), date: h[2] || '', theme: '', topics: [], entries: [] }); continue; }
          const s = sections[sections.length - 1];
          if (!s) continue;
          const line = raw.trim();
          if (!s.theme && line.startsWith('本版主题:')) s.theme = line.slice(5).trim();
          // 双语主题（2026-10-21 起）：'本版主题: … / Theme: …' 整行入主题位
          else if (!s.theme && /^本版主题[:：]/.test(line)) s.theme = line.replace(/^本版主题[:：]\s?/, '');
          else if (line.startsWith('### ')) s.topics.push(line.slice(4).trim());
          else if (line.startsWith('- ')) s.entries.push(line.slice(2));
        }
        return { ok: true, sections: sections.slice(0, 6) };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  });
  // 检查更新：独立更新窗（状态查询 / 触发检查 / 主按钮动作 / 打开 Releases）
  ipcMain.handle('update-state', () => updateUiState());
  ipcMain.handle('update-check', async () => { await checkUpdateInteractiveUi(); return updateUiState(); });
  ipcMain.handle('update-install', async () => { await updateUiPrimary(); return updateUiState(); });
  // 面板「检查更新」入口 → 打开独立更新窗（不再用面板内弹窗：主窗口卡死时面板根本不可见）
  ipcMain.handle('update-open-window', async () => { openUpdateUi(); await checkUpdateInteractiveUi(); return updateUiState(); });
  ipcMain.handle('update-open-releases', () => { try { shell.openExternal((daemonInfo.homepage || DEFAULT_HOMEPAGE) + '/releases'); } catch {} });
  // 打开外部 URL（捐赠按钮用）
  ipcMain.handle('shell-open-external', (_, url) => {
    // 与同文件其他 handler 的校验纪律对齐：只放行 https 外链，file:///smb:// 等一概不交给系统
    if (!/^https:\/\//i.test(String(url || ''))) return;
    try { shell.openExternal(String(url)); } catch {}
  });
  // 唤起小窗显示更新日志摘要（任何入口统一走 openChangelogBrief；IPC 只注册一次）
  ipcMain.handle('open-changelog-brief', () => openChangelogBrief());  ipcMain.handle('open-auth-window', async (_e, url, opts) => {
    if (typeof url !== 'string' || !url.toLowerCase().startsWith('https://')) {
      return { ok: false, error: Tt('只允许打开 https 链接') };
    }
    // persistKey 只接受内部约定的命名（cookie-site-<站点id>），不透传任意值
    const persistKey = opts && typeof opts.persistKey === 'string' && /^cookie-site-[a-z0-9-]+$/.test(opts.persistKey)
      ? opts.persistKey : null;
    try { await openIncognitoWindow(url, { persistKey }); return { ok: true }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // 「清除已存会话」：抹掉某站点的持久登录分区存储（面板站点行入口；nodeIntegration 关闭，
  // 主进程代为执行）。返回是否确实存在过该分区。
  ipcMain.handle('clear-cookie-site-session', async (_e, persistKey) => {
    if (typeof persistKey !== 'string' || !/^cookie-site-[a-z0-9-]+$/.test(persistKey)) {
      return { ok: false, error: Tt('无效的会话标识') };
    }
    // 同名窗还开着时先关掉（否则清完它一份内存缓存又写回去）
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed() && w.webContents.session === session.fromPartition('persist:' + persistKey)) w.close();
      } catch { /* ignore */ }
    }
    try {
      await session.fromPartition('persist:' + persistKey).clearStorageData();
      return { ok: true };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
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
      return { ok: false, error: Tt('未找到 Mirasim 客户端可执行文件') };
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
      return { ok: false, error: Tt('未找到妙手客户端可执行文件') };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // Trae 页「打开客户端」+ 切换后自动重开（安装位置随版本不同：TRAE SOLO CN / Trae CN / TRAE SOLO / Trae）
  ipcMain.handle('open-doubao-client', async () => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const cand = path.join(local, 'Programs', 'Doubao', 'Doubao.exe');
      const cand2 = path.join(local, 'Doubao', 'Application', 'app', 'Doubao.exe');
      for (const c of [cand, cand2]) {
        if (process.platform === 'win32' && fs.existsSync(c)) {
          const err = await shell.openPath(c);
          if (!err) return { ok: true };
        }
      }
      return { ok: false, error: Tt('未找到豆包桌面版（请先安装）') };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) };
    }
  });
  // variant：'cn' | 'intl' —— 双版本同装时由面板弹窗选择后指定；缺省维持国内版优先的旧行为
  ipcMain.handle('open-trae-client', async (_e, variant) => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const cn = ['TRAE SOLO CN', 'Trae CN'], intl = ['TRAE SOLO', 'Trae'];
      const names = variant === 'cn' ? cn : variant === 'intl' ? intl : [...cn, ...intl];
      for (const n of names) {
        const cand = path.join(local, 'Programs', n, n + '.exe');
        if (process.platform === 'win32' && fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
        }
      }
      return { ok: false, error: variant === 'cn' ? Tt('未找到 Trae 国内版客户端') : variant === 'intl' ? Tt('未找到 Trae 国际版客户端') : Tt('未找到 Trae 客户端可执行文件') };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // Qoder 页切换后「打开客户端」：切号会先关掉运行中的 Qoder，写完登录再拉起来，
  // 省得用户自己去找快捷方式（与 ZCode / mirasim 的切完自动拉起一致）
  ipcMain.handle('open-qoder-client', async (_e, provider) => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      // 只拉目标渠道那个客户端：切的是国内版就别把国际版一起打开。
      // Launcher 优先（官方开始菜单入口指向它：负责应用 .qoder-versions 里的待生效更新并
      // 启动真实当前版本）；Programs 下的顶层 exe 是初装老版本（如 0.2.5），只作兜底。
      const base = provider === 'qoder-cn' ? 'Qoder CN' : 'Qoder';
      const cands = [
        path.join(local, base, base + ' Launcher', base + ' Launcher.exe'),
        path.join(local, 'Programs', base, base + '.exe'),
      ];
      for (const cand of cands) {
        if (process.platform === 'win32' && fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
          return { ok: false, error: err };
        }
      }
      return { ok: false, error: provider === 'qoder-cn' ? Tt('未找到 Qoder 国内版客户端') : Tt('未找到 Qoder 国际版客户端') };
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
      return { ok: false, error: Tt('未找到 MiniMax Code 客户端可执行文件') };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // Loomy 页「打开客户端」：Program Files 优先，其次 LOCALAPPDATA（与 loomyLocal.candidateClientPath 同口径）
  ipcMain.handle('open-loomy-client', async () => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const cands = [
        'C:\\Program Files\\Loomy\\Loomy.exe',
        'C:\\Program Files (x86)\\Loomy\\Loomy.exe',
        path.join(local, 'Programs', 'Loomy', 'Loomy.exe'),
      ];
      for (const cand of cands) {
        if (process.platform === 'win32' && fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
          return { ok: false, error: err };
        }
      }
      return { ok: false, error: Tt('未找到 Loomy 客户端可执行文件') };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // WorkBuddy 切号后自动拉起：国内（WorkBuddy）/ 国际（WorkBuddyAI）是两个独立客户端，只拉目标档位
  ipcMain.handle('open-workbuddy-client', async (_e, flavor) => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const names = String(flavor || 'cn') === 'intl' ? ['WorkBuddyAI'] : ['WorkBuddy'];
      for (const n of names) {
        const cand = path.join(local, 'Programs', n, n + '.exe');
        if (process.platform === 'win32' && fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
          return { ok: false, error: err };
        }
      }
      return { ok: false, error: Tt('未找到 WorkBuddy 客户端可执行文件') };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  // CodeBuddy IDE 切号后自动拉起：国内（CodeBuddy CN）/ 国际（CodeBuddy）两套独立安装
  ipcMain.handle('open-codebuddy-ide-client', async (_e, flavor) => {
    try {
      const os = require('node:os');
      const fs = require('node:fs');
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const names = String(flavor || 'cn') === 'intl' ? ['CodeBuddy'] : ['CodeBuddy CN'];
      for (const n of names) {
        const cand = path.join(local, 'Programs', n, n + '.exe');
        if (process.platform === 'win32' && fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
          return { ok: false, error: err };
        }
      }
      return { ok: false, error: Tt('未找到 CodeBuddy IDE 客户端可执行文件') };
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
      notify(Tt('CreditDaddy 仍在后台运行'), Tt('已最小化到系统托盘，自动领取不会中断。单击托盘图标可重新打开面板。'));
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
  tray.setToolTip(Tt('CreditDaddy - 正在领取…'));
  try {
    const panelKey = daemonMod && typeof daemonMod.getPanelKey === 'function' ? daemonMod.getPanelKey() : '';
    const res = await fetch('http://127.0.0.1:' + boundPort + '/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(panelKey ? { 'x-qd-key': panelKey } : {}) },
      body: '{"skipIfCheckedToday":false}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
    lastSummary = data.summary || Tt('领取完成');
    notify(Tt('CreditDaddy 领取完成'), lastSummary);
  } catch (e) {
    lastSummary = Tt('领取失败：{err}', { err: (e && e.message) });
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
  tray.setToolTip(Tt('CreditDaddy v{v} - 后台自动领取运行中', { v: daemonInfo.version }) + (lastSummary ? '\n' + lastSummary : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'CreditDaddy v' + daemonInfo.version, enabled: false },
    { label: Tt('面板 {addr}', { addr: '127.0.0.1:' + boundPort }), enabled: false },
    ...(lastSummary ? [{ label: lastSummary.slice(0, 60), enabled: false }] : []),
    ...(updateState.downloaded ? [{ label: Tt('新版本 v{v} 已就绪，重启即更新', { v: updateState.downloaded }), enabled: false }] : []),
    { type: 'separator' },
    { label: Tt('打开面板'), click: () => showWin() },
    { label: Tt('立即领取全部账号'), click: () => { checkinNow(); } },
    { type: 'separator' },
    { label: Tt('开机自启（后台运行）'), type: 'checkbox', checked: autoLaunchEnabled(), click: (item) => setAutoLaunch(item.checked) },
    { label: Tt('已保存的密码…'), click: () => promptManagePasswords() },
    { label: Tt('打开数据目录'), enabled: Boolean(daemonInfo.dataDir), click: () => shell.openPath(daemonInfo.dataDir) },
    { label: Tt('项目主页（GitHub）'), click: () => shell.openExternal(daemonInfo.homepage) },
    { type: 'separator' },
    ...(autoUpdater
      ? [{ label: trayUpdateLabel(), click: () => { openUpdateUiAndCheck(); } }]
      : []),
    { label: Tt('更新日志…'), click: () => openChangelogBrief() },
    { label: Tt('重启 CreditDaddy'), click: () => restartApp() },
    { label: Tt('退出 CreditDaddy'), click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on('window-all-closed', () => {
  // 保持在托盘运行，自动领取不中断
});
app.on('before-quit', () => { quitting = true; });
