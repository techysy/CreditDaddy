/**
 * 本机千问办公客户端（QwenWork，Electron）集成 — 全部在本机完成，不依赖第三方包。
 *
 * 千问办公与 Qoder 同源（内部名 qoderwork，真机 versions.json 实锤），凭据存储同构：
 *   1. 安装探测：国内版 QwenWorkCN / 国际版 QwenWork，exe 在 %LOCALAPPDATA%\Programs\QwenWorkCN\<版本>\ 下
 *   2. 登录凭据读取：解密客户端数据目录下的 auth-v2.dat（Electron safeStorage）
 *        Windows: "v10" + nonce(12) + AES-256-GCM(密文+tag)，密钥 = DPAPI 解开 Local State 的 os_crypt.encrypted_key
 *        macOS:   "v10" + AES-128-CBC，密钥 = PBKDF2(钥匙串 "<App> Safe Storage", 'saltysalt', 1003)
 *        Linux:   "v10" + AES-128-CBC，密钥 = PBKDF2('peanuts', 'saltysalt', 1)（v11 需系统密钥环，不支持）
 *   3. 切换账号：整份 auth-v2.dat 快照原样写回（切换 = 换客户端登录）。
 *
 * 与 Qoder 的差异：
 *   - 没有 runtime-info/umid 风控子系统（客户端身份就是固定 X-QwenWork-* 头，见 constants.js）
 *   - refresh_token 单次轮换（ory_rt_，约 1 小时寿命）：官方客户端运行中每小时自己换新。
 *     所以快照过期语义不同——access token（约 7 天）没过期就允许切换，RT 过期只 warn 不拦
 *     （硬拦会把大部分快照判死，功能等于没有；实测客户端对过期 RT 是引导重登而非删文件）。
 *   - legacy auth.dat 是 SDK 占位（真机上是 placeholder token），不作为登录依据。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { dataDir } from './store.js';
import { anyProcRunning, procRunningCached } from './winProc.js';

const VARIANTS = [
  { provider: 'qwenwork-cn', label: 'QwenWork 国内版', installName: 'QwenWorkCN', appId: 'QwenWorkCN', webIdentityOrigin: 'https://qwenwork.cn' },
  { provider: 'qwenwork', label: 'QwenWork 国际版', installName: 'QwenWork', appId: 'QwenWork', webIdentityOrigin: 'https://qwenwork.ai' },
];

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const versionParts = (s) => s.split('.').map((n) => Number(n) || 0);
function compareVersionDesc(a, b) {
  // 目录名形如 2.1.0-26111906：先比 semver 段再比数字 build 后缀——丢后缀会让同版本
  // 不同 build 判等（落回 readdir 顺序），纯字典序又会让 2.9.0 压过 2.10.0
  const [av, ab] = String(a).split('-');
  const [bv, bb] = String(b).split('-');
  const x = versionParts(av), y = versionParts(bv);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  }
  return (Number(bb) || 0) - (Number(ab) || 0);
}

/**
 * 安装目录下的版本子目录：千问办公把实际运行的版本放在 <install>\<ver>\（形如 2.1.0-26111906，
 * 按版本从新到旧），顶层可能只是启动器。返回实际存在的可执行文件路径。
 */
function installExeDirs(installDir, installName) {
  let versions = [];
  try {
    versions = fs.readdirSync(installDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+(\.\d+)*(-\d+)?$/.test(e.name))
      .map((e) => e.name)
      .sort(compareVersionDesc);
  } catch {}
  const exeName = process.platform === 'win32' ? `${installName}.exe` : installName;
  // 版本子目录只在 win32/linux 找 exe（darwin 的 .app 内部没有版本子目录结构，退化成单层）
  const dirs = process.platform === 'darwin'
    ? [path.join(installDir, 'Contents', 'MacOS')]
    : [...versions.map((ver) => path.join(installDir, ver)), installDir];
  return dirs
    .map((d) => path.join(d, exeName))
    .filter(exists);
}

/**
 * 卸载注册表里登记的安装目录（自定义安装路径）。DisplayName 形如「千问办公」「QwenWorkCN 2.1.0」。
 * 走 PowerShell 以正确读出中文路径；结果缓存 5 分钟。
 */
let registryCache = { at: 0, entries: null };
function registryInstallDirs(v) {
  if (process.platform !== 'win32') return [];
  if (!registryCache.entries || Date.now() - registryCache.at > 5 * 60_000) {
    let entries = [];
    try {
      const script = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        + "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue"
        + " | Where-Object { $_.DisplayName -like 'QwenWork*' -or $_.DisplayName -like '千问办公*' }"
        + ' | Select-Object DisplayName,InstallLocation,UninstallString,DisplayIcon | ConvertTo-Json -Compress';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) entries = [].concat(JSON.parse(out));
    } catch {}
    registryCache = { at: Date.now(), entries };
  }
  // DisplayName 实测形如「千问办公」「QwenWorkCN 2.1.0」——按 installName 构造正则
  //（裸名「千问办公」两个版本都命中，归属交给下面的目录段过滤）
  const nameRe = new RegExp(`^(千问办公|${v.installName})(\\s+v?\\d[\\d.]*)?$`, 'i');
  const exeDir = (s) => {
    const m = String(s || '').match(/^\s*"([^"]+)"|^\s*([^,]+?\.exe)/i);
    return m ? path.dirname(m[1] || m[2]) : null;
  };
  const dirs = [];
  for (const e of registryCache.entries) {
    if (!nameRe.test(String(e?.DisplayName || '').trim())) continue;
    const dir = (e.InstallLocation && String(e.InstallLocation).trim()) || exeDir(e.UninstallString) || exeDir(e.DisplayIcon);
    if (dir) dirs.push(dir.replace(/[\\/]+$/, ''));
  }
  // 注册表命中不区分双版本，按路径段精确归属——'qwenwork' 是 'qwenworkcn' 的前缀，
  // 子串 includes 会把 CN 目录误收进国际版（'QwenWorkCN\2.1.0' 命中 includes('qwenwork')）
  return dirs.filter((d) => d.toLowerCase().split(/[\\/]+/).includes(v.installName.toLowerCase()));
}

function candidateInstallDirs(v, { registry = false } = {}) {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Programs', v.installName),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', v.installName),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', v.installName),
      ...(registry ? registryInstallDirs(v) : []),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      `/Applications/${v.installName}.app`,
      path.join(home, 'Applications', `${v.installName}.app`),
    ];
  }
  const slug = v.installName.toLowerCase();
  return [`/opt/${slug}`, `/usr/lib/${slug}`];
}

function userDataDir(v) {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), v.appId);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', v.appId);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), v.appId);
}

function pickInstallDir(v, { registry = false } = {}) {
  const dirs = candidateInstallDirs(v, { registry }).filter(isDir);
  return dirs.find((d) => installExeDirs(d, v.installName).length) || dirs[0] || null;
}

/** 探测本机已安装的千问办公客户端（国内版 / 国际版） */
export function detectQwenworkApps() {
  return VARIANTS.map((v) => {
    let installDir = pickInstallDir(v);
    // 默认位置没找到可用的 exe → 再查卸载注册表里的实际安装目录（自定义路径）
    if (process.platform === 'win32' && !(installDir && installExeDirs(installDir, v.installName).length)) {
      installDir = pickInstallDir(v, { registry: true }) || installDir;
    }
    const exe = installDir ? installExeDirs(installDir, v.installName)[0] || null : null;
    // 版本号从版本子目录名取（installName\<ver>\xxx.exe）
    let version = null;
    if (exe) {
      const m = exe.match(/[\\/](\d+(?:\.\d+)*(?:-\d+)?)[\\/][^\\/]+$/);
      if (m) version = m[1];
    }
    const data = userDataDir(v);
    return {
      provider: v.provider,
      label: v.label,
      installed: Boolean(exe),
      exe,
      installDir,
      version,
      dataDir: data,
      dataExists: exists(data),
      signedIn: exists(path.join(data, 'auth-v2.dat')),
    };
  });
}

// ─── Electron safeStorage 解密（与 qoderApp.js 同构） ───

function dpapiUnprotect(buf) {
  const script = 'Add-Type -AssemblyName System.Security;'
    + '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());'
    + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  // 使用 -EncodedCommand 传入 UTF-16LE Base64，避免命令行参数中包含敏感 API 关键字被杀毒软件误报
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
        if (err) return reject(new Error('DPAPI 解密失败：' + err.message));
        resolve(Buffer.from(String(stdout).trim(), 'base64'));
      });
    child.stdin.end(buf.toString('base64'));
  });
}

function macKeychainPassword(service) {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-w', '-s', service], { timeout: 20_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

const keyCache = new Map();
let codecOverride = null;   // 测试注入：替代 safeStorageCodec（DPAPI 依赖真实用户上下文，测试绕开）
/** 测试钩子：注入编解码器（切换写入路径用），传 null 恢复真实实现。 */
export function _setCodecForTests(codec) { codecOverride = codec; }

let detectOverride = null;  // 测试注入：替代 detectQwenworkApps（真实探测依赖本机安装与注册表）
/** 测试钩子：注入安装探测（切换解析写入路径用），传 null 恢复真实探测。 */
export function _setDetectForTests(fn) { detectOverride = fn; }

/**
 * 某个 Electron userData 目录对应的 safeStorage 编解码器。
 * encrypt 用于把账号库里的登录快照写回客户端（切换账号），与 decrypt 同密钥同格式：
 * Windows = 'v10' + nonce(12) + AES-256-GCM 密文 + tag(16)；mac/linux = 'v10' + AES-128-CBC。
 */
export async function safeStorageCodec(userData, appNames) {
  if (keyCache.has(userData)) return keyCache.get(userData);
  let decrypt, encrypt;
  if (process.platform === 'win32') {
    const ls = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'));
    const enc = Buffer.from(ls?.os_crypt?.encrypted_key || '', 'base64');
    if (enc.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Local State 中没有 DPAPI 密钥');
    const key = await dpapiUnprotect(enc.subarray(5));
    decrypt = (data) => {
      if (data.subarray(0, 3).toString() !== 'v10') throw new Error('未知的加密格式');
      const nonce = data.subarray(3, 15);
      const tag = data.subarray(data.length - 16);
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data.subarray(15, data.length - 16)), d.final()]).toString('utf8');
    };
    encrypt = (text) => {
      const nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()]);
    };
  } else {
    let password = 'peanuts', iterations = 1;
    if (process.platform === 'darwin') {
      for (const n of appNames) {
        password = await macKeychainPassword(`${n} Safe Storage`);
        if (password) break;
      }
      if (!password) throw new Error('无法从钥匙串读取 QwenWork 的 Safe Storage 密钥');
      iterations = 1003;
    }
    const key = crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
    const iv = Buffer.alloc(16, ' ');
    decrypt = (data) => {
      const ver = data.subarray(0, 3).toString();
      if (ver !== 'v10') throw new Error(ver === 'v11' ? '需要系统密钥环（v11），暂不支持' : '未知的加密格式');
      const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
      return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString('utf8');
    };
    encrypt = (text) => {
      const c = crypto.createCipheriv('aes-128-cbc', key, iv);
      return Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]);
    };
  }
  const codec = { decrypt, encrypt };
  keyCache.set(userData, codec);
  return codec;
}

/** 客户端会读的 auth-v2.dat 快照校验（对齐 isValidWebIdentityData：缺字段写进去会被客户端判无效） */
export function isValidAuthSnapshot(auth) {
  return Boolean(auth
    && auth.schemaVersion === 3
    && auth.refreshStrategy === 'oauth_web_identity'
    && auth.loginMethod === 'browser'
    && auth.authRealm === 'standard'
    && typeof auth.token === 'string' && auth.token
    && typeof auth.refreshToken === 'string' && auth.refreshToken
    && Number.isFinite(Date.parse(auth.expiresAt))
    && Number.isInteger(auth.identityVersion)
    && (auth.identityVersion ?? -1) >= 0
    && typeof auth.loginDeviceId === 'string' && auth.loginDeviceId
    && Number.isFinite(auth.loginTimestamp));
}

/**
 * 把一份登录凭据补全成客户端可读的 auth-v2 快照（浏览器登录 / 设备码登录共用）。
 * 官方客户端对 loginMethod/refreshStrategy 有硬校验，字段缺一个整个文件作废。
 */
export function buildAuthSnapshot(provider, { token, refreshToken, expiresAt, refreshTokenExpiresAt, user, loginDeviceId }) {
  const v = VARIANTS.find((x) => x.provider === provider) || VARIANTS[0];
  const gateway = provider === 'qwenwork-cn' ? 'https://gateway.qwenwork.cn' : 'https://gateway.qwenwork.ai';
  return {
    schemaVersion: 3,
    authRealm: 'standard',
    endpoints: { authOrigin: gateway, apiOrigin: gateway, webIdentityApiOrigin: v.webIdentityOrigin },
    token,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt: refreshTokenExpiresAt || null,
    user: user || null,
    identityVersion: 0,
    loginMethod: 'browser',
    refreshStrategy: 'oauth_web_identity',
    loginDeviceId: loginDeviceId || crypto.randomUUID(),
    loginTimestamp: Date.now(),
    webIdentitySession: { version: 1, sessionId: crypto.randomUUID(), credentialRevision: 0, phase: 'active' },
  };
}

/**
 * 读取本机千问办公客户端当前登录的账号（解密 auth-v2.dat）。
 * @returns {Promise<{accounts: Array, errors: Array}>} 每个账号含 provider/token/refreshToken/expiresAt/user
 */
export async function readQwenworkAppAccounts() {
  const accounts = [];
  const errors = [];
  for (const app of detectQwenworkApps()) {
    const file = path.join(app.dataDir, 'auth-v2.dat');
    if (!exists(file)) continue;
    try {
      const { decrypt } = await safeStorageCodec(app.dataDir, ['QwenWorkCN', 'QwenWork']);
      const obj = JSON.parse(decrypt(fs.readFileSync(file)));
      if (typeof obj?.token !== 'string' || !obj.token) throw new Error('auth-v2.dat 中没有 token');
      accounts.push({
        provider: app.provider,
        source: `${app.label} 客户端`,
        file,
        authJson: obj,
        token: obj.token,
        refreshToken: typeof obj.refreshToken === 'string' ? obj.refreshToken : null,
        expiresAt: typeof obj.expiresAt === 'string' ? obj.expiresAt : null,
        user: {
          id: obj.user?.id || null,
          name: obj.user?.name || null,
          email: obj.user?.email || null,
        },
      });
    } catch (e) {
      errors.push({ provider: app.provider, file, error: e.message });
    }
  }
  return { accounts, errors };
}

// ─── 切换本机千问办公登录账号 ───

const QWENWORK_EXES = ['QwenWorkCN.exe', 'QwenWork.exe'];

// 双线是两个独立客户端（可各登各号）：检测/终止按 provider 取自家 exe，不波及另一线
const exesFor = (provider) => (provider ? [provider === 'qwenwork-cn' ? 'QwenWorkCN.exe' : 'QwenWork.exe'] : QWENWORK_EXES);

/** 千问办公是否在运行（不传 provider 看任一客户端，传了只看对应双线） */
export function qwenworkRunning(provider) {
  // 走 winProc：GBK 安全的 tasklist 解码
  return anyProcRunning(exesFor(provider));
}

/** 轮询口径（/api/status 用）：读 winProc 全量快照，不 spawn。 */
export function qwenworkRunningCached(provider) {
  return procRunningCached(exesFor(provider));
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 结束千问办公进程：先普通终止（给客户端落盘的机会），超时后 /F。provider 缺省只杀对应双线 */
export function terminateQwenwork({ provider, timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  const exes = exesFor(provider);
  const running = () => anyProcRunning(exes);
  if (!running()) return { closed: false, running: false };
  for (const exe of exes) {
    try { execFileSync('taskkill.exe', ['/IM', exe, '/T'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && running()) nap(250);
  if (running()) {
    for (const exe of exes) {
      try { execFileSync('taskkill.exe', ['/IM', exe, '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    deadline = Date.now() + 3000;
    while (Date.now() < deadline && running()) nap(250);
  }
  return { closed: !running(), running: running() };
}

/**
 * 把本机千问办公客户端的登录换成目标账号（写回 auth-v2.dat）。
 * force：由调用方先 terminateQwenwork 再进来（运行中的客户端退出时会把内存里的旧登录覆盖回文件）。
 * 快照路径缺失/失效（浏览器登录账号天生无路径）：回退到本机该线已安装客户端的真实数据目录
 * （必须已安装 + 数据目录已初始化），否则报错给指引——绝不盲写。
 *
 * ## ★ 快照过期语义（与 Qoder 不同）
 *
 * 千问办公 access token 约 7 天，refresh_token 单次轮换且仅 1 小时寿命（官方客户端运行中
 * 每小时自己换新，CD 不抢刷——轮换制两副本必互杀）。所以：
 *   - access token 已过期 → 硬拦（写进去客户端刷新必失败，等于送登录页）
 *   - 只有 RT 过期（快照超过 1 小时没同步）→ 放行 + warn：token 本体还有效，客户端引导
 *     重登而非删文件；CD 的 status 轮询会在客户端运行时自动同步最新快照，常态不会走到这里。
 */
export async function switchTo(account, { force = false } = {}) {
  const auth = account.meta?.qwenworkAuth;
  let file = account.meta?.qwenworkAuthFile;
  const label = account.provider === 'qwenwork' ? 'QwenWork 国际版' : 'QwenWork 国内版';
  if (!auth) {
    throw new Error(`账号「${account.name || account.id}」没有登录快照，无法切换：请在 QwenWork 里登录该账号后到「添加账号 → 本机导入」导入一次，或用「浏览器登录」重新登录（登录即带快照）`);
  }
  if (!file || !fs.existsSync(file)) {
    // 快照路径缺失（浏览器/设备码登录只存快照、不落本机路径，authDevice.pollQwenworkLogin
    // 只写 meta.qwenworkAuth）或已失效（客户端登出/换号/换数据目录后旧路径被覆盖删除）。
    // 解析本机该线客户端的真实数据目录作为写入目标——但绝不盲写（2026-11 真机覆盖事故底线）：
    // 只在该线客户端确认已安装且数据目录已初始化时才继续，否则维持报错给指引。
    // daemon 切换成功后会把实际写入路径回填账号的 qwenworkAuthFile（下次走正常路径）。
    const app = (detectOverride || detectQwenworkApps)().find((x) => x.provider === account.provider);
    if (app?.installed && app.dataExists) {
      file = path.join(app.dataDir, 'auth-v2.dat');
    } else if (!file) {
      throw new Error(`账号「${account.name || account.id}」是浏览器登录的账号，本机没有检测到可写入的「${label}」客户端（未安装或从未运行过）。请先安装并启动一次客户端，或到客户端登录该账号后用「添加账号 → 本机导入」导入一次`);
    } else {
      throw new Error(`账号「${account.name || account.id}」的切换凭据已失效：${label}的登录文件不在了（${file}）。请打开「${label}」客户端确认已登录该账号，然后到「添加账号 → 本机导入」重新导入一次`);
    }
  }
  if (!isValidAuthSnapshot(auth)) {
    throw new Error(`账号「${account.name || account.id}」的登录快照字段不完整（缺 schemaVersion/refreshStrategy 等客户端必读字段），请重新导入或重新登录一次`);
  }
  const expiresAtMs = Date.parse(auth.expiresAt || '');
  let rtExpiredWarn = null;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    const e = new Error(`账号「${account.name || account.id}」的登录快照已于 ${new Date(expiresAtMs).toLocaleString()} 过期，写进去客户端刷新必失败。请在 QwenWork 客户端登录该账号后重新导入，或用「浏览器登录」重登一次`);
    e.staleAuth = true;
    throw e;
  }
  const rtExpiresMs = Date.parse(auth.refreshTokenExpiresAt || '');
  if (Number.isFinite(rtExpiresMs) && rtExpiresMs <= Date.now()) {
    rtExpiredWarn = '该账号快照的刷新凭据已过期（QwenWork 的刷新凭据约 1 小时轮换一次），客户端下次刷新凭据时可能要求重新登录';
  }
  if (!force && qwenworkRunning(account.provider)) {
    const e = new Error('QwenWork 正在运行。切换会改写它的登录文件，运行中的客户端退出时会把旧登录写回去——退出后重试，或选择「关闭并强制切换」。');
    e.qwenworkRunning = true;
    throw e;
  }
  let codec;
  try {
    codec = codecOverride || await safeStorageCodec(path.dirname(file), ['QwenWorkCN', 'QwenWork']);
  } catch (e) {
    // 客户端装了但从未启动过（数据目录还没有 Local State）等场景 safeStorageCodec 会裸抛
    // ENOENT/DPAPI 错误——转成可操作的报错，daemon 按普通 400 透传面板
    throw new Error(`无法读取「${label}」客户端的加密密钥（${e.message}）。请先启动一次「${label}」客户端再切换`);
  }
  const { encrypt, decrypt } = codec;
  try {
    if (JSON.parse(decrypt(fs.readFileSync(file))).token === auth.token) {
      return { switched: false, alreadyActive: true, file };
    }
  } catch { /* 当前文件解不开就当作不同账号，继续写入 */ }
  const buf = encrypt(JSON.stringify(auth));
  const bak = file + '.creditdaddy.bak';
  try { fs.copyFileSync(file, bak); } catch { /* 备份失败不阻断，下面原子写仍会成功 */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { switched: true, alreadyActive: false, warn: rtExpiredWarn, file };
}
