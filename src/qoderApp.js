/**
 * 本机 Qoder 客户端（Qoder App，Electron）集成 — 全部在本机完成，不依赖第三方包。
 *
 *   1. 安装探测：国际版 Qoder / 国内版 Qoder CN 的程序目录、数据目录、版本号
 *   2. 设备风控身份：调用客户端自带的 umid/runtime-info 生成
 *      Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType。
 *      国际版服务端只对带风控身份的请求下发「每天领 100 Credits」活动（实测）。
 *   3. 登录凭据读取：解密客户端数据目录下的 auth.v1.dat（Electron safeStorage）
 *        Windows: "v10" + nonce(12) + AES-256-GCM(密文+tag)，密钥 = DPAPI 解开 Local State 的 os_crypt.encrypted_key
 *        macOS:   "v10" + AES-128-CBC，密钥 = PBKDF2(钥匙串 "<App> Safe Storage", 'saltysalt', 1003)
 *        Linux:   "v10" + AES-128-CBC，密钥 = PBKDF2('peanuts', 'saltysalt', 1)（v11 需系统密钥环，不支持）
 *
 * 协议细节来自本机 Qoder App 0.2.x 的客户端代码（campaignMainService / nativeRiskIdentityMainService）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { dataDir } from './store.js';
import { installedUmid, CLI_RISK_ENV } from './qoderUmid.js';

const RISK_TTL_MS = 50 * 60 * 1000;        // 客户端每 60±5 分钟刷新一次，这里保守取 50 分钟
const RISK_TIMEOUT_MS = 25_000;             // 与客户端一致
const DEFAULT_CLIENT_VERSION = '0.2.5';

const VARIANTS = [
  { provider: 'qoder', label: 'Qoder 国际版', installName: 'Qoder', appId: 'com.qoder.app', riskEnv: 3 },
  { provider: 'qoder-cn', label: 'Qoder 国内版', installName: 'Qoder CN', appId: 'com.qodercn.app', riskEnv: 0 },
];

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

const versionParts = (s) => s.split('.').map((n) => Number(n) || 0);
function compareVersionDesc(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  }
  return 0;
}

/**
 * 一个安装目录下的 resources 候选：0.3+ 的启动器把实际运行的版本放在
 * .qoder-versions\<ver>\resources（按版本从新到旧），顶层 resources 可能只是首装时的旧版残留。
 */
function resourceDirsIn(installDir) {
  const root = path.join(installDir, '.qoder-versions');
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+(\.\d+)*$/.test(e.name))
      .map((e) => e.name)
      .sort(compareVersionDesc);
  } catch {}
  return [...versions.map((ver) => path.join(root, ver, 'resources')), path.join(installDir, 'resources')];
}

/**
 * 卸载注册表里登记的安装目录（自定义安装路径）。DisplayName 形如「Qoder 0.4.1」/「Qoder CN 0.4.1」，
 * 不匹配「Qoder IDE」（IDE 不带 runtime-info）。走 PowerShell 以正确读出中文路径；结果缓存 5 分钟。
 */
let registryCache = { at: 0, entries: null };
function registryInstallDirs(v) {
  if (process.platform !== 'win32') return [];
  if (!registryCache.entries || Date.now() - registryCache.at > 5 * 60_000) {
    let entries = [];
    try {
      const script = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        + "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue"
        + " | Where-Object { $_.DisplayName -like 'Qoder*' }"
        + ' | Select-Object DisplayName,InstallLocation,UninstallString,DisplayIcon | ConvertTo-Json -Compress';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) entries = [].concat(JSON.parse(out));
    } catch {}
    registryCache = { at: Date.now(), entries };
  }
  const nameRe = new RegExp(`^${v.installName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s+v?\\d[\\d.]*)?$`, 'i');
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
  return dirs;
}

function candidateResourceDirs(v, { registry = false } = {}) {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const installDirs = [
      path.join(local, 'Programs', v.installName),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', v.installName),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', v.installName),
      ...(registry ? registryInstallDirs(v) : []),
    ];
    const seen = new Set();
    const unique = installDirs.filter((d) => {
      const k = path.resolve(d).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return [
      ...unique.flatMap(resourceDirsIn),
      // AppX 风格（微软商店版 / MSIX）：Qoder_*.msix 通常在 Start Menu 快捷方式指向的位置
      path.join(local, 'Microsoft', 'WindowsApps', v.installName),
      // Squirrel 更新目录：Electron 应用的临时升级包
      path.join(local, 'electron', 'updates', v.installName),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      `/Applications/${v.installName}.app/Contents/Resources`,
      path.join(home, 'Applications', `${v.installName}.app`, 'Contents', 'Resources'),
      // 可能是 qodercn.app 或 qoder.app
      `/Applications/Qoder.app/Contents/Resources`,
      `/Applications/Qoder\\ CN.app/Contents/Resources`,
    ];
  }
  const slug = v.installName.toLowerCase().replace(/\s+/g, '-');
  return [`/opt/${v.installName}/resources`, `/opt/${slug}/resources`, `/usr/lib/${slug}/resources`, '/snap/qoder/current/resources'];
}

function userDataDir(v) {
  const home = os.homedir();
  const name = `${v.appId}.stable`;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), name);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), name);
}

function readVersion(resourcesDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'build-manifest.json'), 'utf8'));
    if (typeof m.productVersion === 'string') return m.productVersion;
  } catch {}
  return null;
}

const RUNTIME_INFO_EXE = process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info';
const runtimeInfoIn = (resources) => (exists(path.join(resources, 'umid', RUNTIME_INFO_EXE)) ? path.join(resources, 'umid', RUNTIME_INFO_EXE) : null);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** 在候选里选 resources：优先带 runtime-info 的（风控身份靠它），否则第一个存在的 */
function pickResources(dirs) {
  const existing = dirs.filter(isDir);
  return existing.find((d) => runtimeInfoIn(d)) || existing[0] || null;
}

/** 探测本机已安装的 Qoder 客户端（国际版 / 国内版） */
export function detectQoderApps() {
  return VARIANTS.map((v) => {
    let resources = pickResources(candidateResourceDirs(v));
    // 默认位置没找到可用的 runtime-info → 再查卸载注册表里的实际安装目录（自定义路径）
    if (process.platform === 'win32' && !(resources && runtimeInfoIn(resources))) {
      resources = pickResources(candidateResourceDirs(v, { registry: true })) || resources;
    }
    const runtimeInfo = resources ? runtimeInfoIn(resources) : null;
    const data = userDataDir(v);
    return {
      provider: v.provider,
      label: v.label,
      installed: Boolean(resources),
      resourcesDir: resources,
      version: resources ? readVersion(resources) : null,
      runtimeInfo,
      dataDir: data,
      dataExists: exists(data),
      signedIn: exists(path.join(data, 'auth.v1.dat')),
    };
  });
}

// ─── 设备风控身份 ───

/** 与客户端一致的 Cosy-MachineOS 格式：x86_64_win32 / aarch64_darwin … */
export function machineOs() {
  const a = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  return `${a}_${process.platform}`;
}

/** 与客户端一致的主机名清洗：可打印 ASCII，超长截断并附短哈希 */
export function machineHostname(raw = os.hostname()) {
  const e = String(raw || '').trim();
  if (!e) return undefined;
  const clip = (t) => {
    if (t.length <= 96) return t;
    const h = crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 8);
    const head = t.slice(0, 96 - 8 - 1).replace(/[-\s]+$/u, '');
    return head ? `${head}-${h}` : `unknown-${h}`;
  };
  if (/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u.test(e)) return clip(e);
  const h = crypto.createHash('sha256').update(e, 'utf8').digest('hex').slice(0, 8);
  const n = e.replace(/[^\x21-\x7e]+/gu, '-').replace(/-{2,}/gu, '-').replace(/^-+|-+$/gu, '');
  return clip(n ? `${n}-${h}` : `unknown-${h}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 机器 ID：优先复用客户端的 auth.machine-id，否则在 CreditDaddy 数据目录持久化一个 */
export function machineId(provider) {
  const v = VARIANTS.find((x) => x.provider === provider) || VARIANTS[0];
  for (const file of [path.join(userDataDir(v), 'auth.machine-id'), path.join(dataDir(), 'machine-id')]) {
    try {
      const id = fs.readFileSync(file, 'utf8').trim();
      if (UUID_RE.test(id)) return id;
    } catch {}
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dataDir(), 'machine-id'), id, { mode: 0o600 });
  } catch {}
  return id;
}

/** 客户端版本号（用于 Cosy-Version） */
export function clientVersion(provider) {
  const apps = detectQoderApps();
  const app = apps.find((a) => a.provider === provider && a.version) || apps.find((a) => a.version);
  return app?.version || DEFAULT_CLIENT_VERSION;
}

function runRuntimeInfo(exe, env, account) {
  return new Promise((resolve, reject) => {
    const withStdin = process.platform === 'darwin' || process.platform === 'win32';
    const child = spawn(exe, withStdin ? [String(env), '--account-stdin'] : [String(env)], {
      stdio: [withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error('runtime-info 超时')), RISK_TIMEOUT_MS);
    const tryParse = () => {
      const nl = out.indexOf('\n');
      if (nl < 0) return false;
      try {
        const j = JSON.parse(out.slice(0, nl));
        const pick = (k) => {
          const s = typeof j[k] === 'string' ? j[k].trim() : '';
          if (!s || s.length > 4096) throw new Error(`runtime-info 输出缺少 ${k}`);
          return s;
        };
        done(null, { machineToken: pick('machineToken'), machineCode: pick('machineCode'), machineType: pick('machineType') });
      } catch (e) { done(e); }
      return true;
    };
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (out.length > 1024 * 1024) return done(new Error('runtime-info 输出过大'));
      tryParse();
    });
    child.stderr.on('data', () => {});
    child.once('error', (e) => done(new Error(`runtime-info 启动失败：${e.message}`)));
    child.once('close', (code) => {
      if (!tryParse()) done(new Error(`runtime-info 退出码 ${code}`));
    });
    if (withStdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ account }) + '\n');
    }
  });
}

const riskCache = new Map();   // `${provider}:${uid}` → { value, at } | { promise }

/**
 * 风控身份来源：优先本机 Qoder 客户端自带的 runtime-info（国际版 env=3 / 国内版 env=0，缺失时用另一版本的），
 * 其次是从官方 qodercli 提取的设备身份组件（Linux / fnOS，见 qoderUmid.js，env 与 qodercli 一致）。
 */
function riskRunner(provider) {
  const apps = detectQoderApps().filter((a) => a.runtimeInfo);
  const app = apps.find((a) => a.provider === provider) || apps[0];
  if (app) return { exe: app.runtimeInfo, env: (VARIANTS.find((v) => v.provider === provider) || VARIANTS[0]).riskEnv, source: 'app' };
  const cli = installedUmid() || bundledCliUmid(provider);
  if (cli) return { exe: cli.path, env: CLI_RISK_ENV[provider] ?? CLI_RISK_ENV.qoder, source: 'cli' };
  return null;
}

/** Windows：客户端自带的 qodercli 会把设备身份组件解压到 ~\.qoder\.bin\umid-win32-<arch>-*\（国内版 ~\.qoder-cn） */
function bundledCliUmid(provider) {
  if (process.platform !== 'win32') return null;
  const homes = provider === 'qoder-cn' ? ['.qoder-cn', '.qoder'] : ['.qoder', '.qoder-cn'];
  for (const h of homes) {
    const bin = path.join(os.homedir(), h, '.bin');
    let dirs = [];
    try { dirs = fs.readdirSync(bin).filter((n) => n.startsWith('umid-win32-')); } catch {}
    for (const d of dirs) {
      const exe = path.join(bin, d, RUNTIME_INFO_EXE);
      if (exists(exe)) return { path: exe };
    }
  }
  return null;
}

/** 获取某账号的设备风控身份；本机既没有 Qoder 客户端也没装设备身份组件时返回 null。 */
export async function getRiskIdentity(provider, uid) {
  if (!uid) return null;
  const key = `${provider}:${uid}`;
  const hit = riskCache.get(key);
  if (hit?.value && Date.now() - hit.at < RISK_TTL_MS) return hit.value;
  if (hit?.promise) return hit.promise;

  const runner = riskRunner(provider);
  if (!runner) return null;

  const promise = runRuntimeInfo(runner.exe, runner.env, uid)
    .then((value) => { riskCache.set(key, { value, at: Date.now() }); return value; })
    .catch((e) => { riskCache.delete(key); throw e; });
  riskCache.set(key, { promise });
  return promise;
}

export function riskIdentityAvailable() {
  return Boolean(riskRunner('qoder'));
}

/** 风控身份来源：'app'（Qoder 客户端）/ 'cli'（qodercli 设备身份组件）/ null */
export function riskIdentitySource() {
  return riskRunner('qoder')?.source || null;
}

// ─── Electron safeStorage 解密 ───

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
      if (!password) throw new Error('无法从钥匙串读取 Qoder 的 Safe Storage 密钥');
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

/**
 * 读取本机 Qoder 客户端当前登录的账号（解密 auth.v1.dat）。
 * @returns {Promise<{accounts: Array, errors: Array}>} 每个账号含 provider/token/refreshToken/expiresAt/user
 */
export async function readQoderAppAccounts() {
  const accounts = [];
  const errors = [];
  for (const app of detectQoderApps()) {
    const file = path.join(app.dataDir, 'auth.v1.dat');
    if (!exists(file)) continue;
    try {
      const { decrypt } = await safeStorageCodec(app.dataDir, ['Qoder App', app.label.includes('国内') ? 'Qoder CN' : 'Qoder']);
      const obj = JSON.parse(decrypt(fs.readFileSync(file)));
      if (typeof obj?.token !== 'string' || !obj.token) throw new Error('auth.v1.dat 中没有 token');
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

// ─── 切换本机 Qoder 登录账号 ───

const QODER_EXES = ['Qoder.exe', 'Qoder CN.exe'];

/** Qoder IDE（国际版 / 国内版）是否在运行 */
export function qoderRunning() {
  if (process.platform !== 'win32') return false;
  for (const exe of QODER_EXES) {
    try {
      const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exe}`, '/NH'],
        { windowsHide: true, encoding: 'buffer', timeout: 8000 }).toString('latin1');
      if (!/No Tasks|没有/i.test(out)) return true;
    } catch { /* 查不到就换下一名 */ }
  }
  return false;
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 结束 Qoder 进程：先普通终止（给客户端落盘的机会），超时后 /F */
export function terminateQoder({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  if (!qoderRunning()) return { closed: false, running: false };
  for (const exe of QODER_EXES) {
    try { execFileSync('taskkill.exe', ['/IM', exe, '/T'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && qoderRunning()) nap(250);
  if (qoderRunning()) {
    for (const exe of QODER_EXES) {
      try { execFileSync('taskkill.exe', ['/IM', exe, '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    deadline = Date.now() + 3000;
    while (Date.now() < deadline && qoderRunning()) nap(250);
  }
  return { closed: !qoderRunning(), running: qoderRunning() };
}

/**
 * 把本机 Qoder 客户端的登录换成目标账号（写回 auth.v1.dat）。
 * force：由调用方先 terminateQoder 再进来（运行中的 Qoder 退出时会把内存里的旧登录覆盖回文件）。
 */
export async function switchTo(account, { force = false } = {}) {
  const auth = account.meta?.qoderAuth;
  const file = account.meta?.qoderAuthFile;
  if (!auth || !file) {
    throw new Error(`账号「${account.name || account.id}」没有本机登录快照，无法切换：请在 Qoder 里登录该账号后到「添加账号 → 本机导入」导入一次`);
  }
  if (!fs.existsSync(file)) throw new Error(`Qoder 凭据文件不存在：${file}（客户端可能被卸载或换了数据目录）`);
  if (!force && qoderRunning()) {
    const e = new Error('Qoder 正在运行。切换会改写 Qoder 的登录文件，运行中的 Qoder 退出时会把旧登录写回去——退出后重试，或选择「关闭并强制切换」。');
    e.qoderRunning = true;
    throw e;
  }
  const { encrypt, decrypt } = await safeStorageCodec(path.dirname(file), ['Qoder App', account.provider === 'qoder-cn' ? 'Qoder CN' : 'Qoder']);
  try {
    if (JSON.parse(decrypt(fs.readFileSync(file))).token === auth.token) {
      return { switched: false, alreadyActive: true };
    }
  } catch { /* 当前文件解不开就当作不同账号，继续写入 */ }
  const buf = encrypt(JSON.stringify(auth));
  const bak = file + '.creditdaddy.bak';
  try { fs.copyFileSync(file, bak); } catch { /* 备份失败不阻断，下面原子写仍会成功 */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { switched: true, alreadyActive: false };
}
