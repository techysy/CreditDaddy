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
import { spawn, execFile } from 'node:child_process';
import { dataDir } from './store.js';

const RISK_TTL_MS = 50 * 60 * 1000;        // 客户端每 60±5 分钟刷新一次，这里保守取 50 分钟
const RISK_TIMEOUT_MS = 25_000;             // 与客户端一致
const DEFAULT_CLIENT_VERSION = '0.2.5';

const VARIANTS = [
  { provider: 'qoder', label: 'Qoder 国际版', installName: 'Qoder', appId: 'com.qoder.app', riskEnv: 3 },
  { provider: 'qoder-cn', label: 'Qoder 国内版', installName: 'Qoder CN', appId: 'com.qodercn.app', riskEnv: 0 },
];

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function candidateResourceDirs(v) {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(local, 'Programs', v.installName, 'resources'),
      path.join(pf, v.installName, 'resources'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      `/Applications/${v.installName}.app/Contents/Resources`,
      path.join(home, 'Applications', `${v.installName}.app`, 'Contents', 'Resources'),
    ];
  }
  const slug = v.installName.toLowerCase().replace(/\s+/g, '-');
  return [`/opt/${v.installName}/resources`, `/opt/${slug}/resources`, `/usr/lib/${slug}/resources`];
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

/** 探测本机已安装的 Qoder 客户端（国际版 / 国内版） */
export function detectQoderApps() {
  return VARIANTS.map((v) => {
    const resources = candidateResourceDirs(v).find((d) => exists(d)) || null;
    const exe = process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info';
    const runtimeInfo = resources && exists(path.join(resources, 'umid', exe)) ? path.join(resources, 'umid', exe) : null;
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

/** 机器 ID：优先复用客户端的 auth.machine-id，否则在 QoderDaddy 数据目录持久化一个 */
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
  const app = detectQoderApps().find((a) => a.provider === provider && a.version)
    || detectQoderApps().find((a) => a.version);
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
 * 获取某账号的设备风控身份；本机未安装 Qoder 客户端时返回 null。
 * 优先用同版本客户端（国际版 env=3 / 国内版 env=0），缺失时退而用另一版本的 runtime-info。
 */
export async function getRiskIdentity(provider, uid) {
  if (!uid) return null;
  const key = `${provider}:${uid}`;
  const hit = riskCache.get(key);
  if (hit?.value && Date.now() - hit.at < RISK_TTL_MS) return hit.value;
  if (hit?.promise) return hit.promise;

  const apps = detectQoderApps().filter((a) => a.runtimeInfo);
  const exe = (apps.find((a) => a.provider === provider) || apps[0])?.runtimeInfo;
  if (!exe) return null;
  const env = (VARIANTS.find((v) => v.provider === provider) || VARIANTS[0]).riskEnv;

  const promise = runRuntimeInfo(exe, env, uid)
    .then((value) => { riskCache.set(key, { value, at: Date.now() }); return value; })
    .catch((e) => { riskCache.delete(key); throw e; });
  riskCache.set(key, { promise });
  return promise;
}

export function riskIdentityAvailable() {
  return detectQoderApps().some((a) => a.runtimeInfo);
}

// ─── Electron safeStorage 解密 ───

function dpapiUnprotect(buf) {
  const ps = 'Add-Type -AssemblyName System.Security;'
    + '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());'
    + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
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

/** 取得某个 Electron userData 目录对应的 safeStorage 解密器 */
async function safeStorageDecryptor(userData, appNames) {
  if (keyCache.has(userData)) return keyCache.get(userData);
  let decrypt;
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
    decrypt = (data) => {
      const ver = data.subarray(0, 3).toString();
      if (ver !== 'v10') throw new Error(ver === 'v11' ? '需要系统密钥环（v11），暂不支持' : '未知的加密格式');
      const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
      return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString('utf8');
    };
  }
  keyCache.set(userData, decrypt);
  return decrypt;
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
      const decrypt = await safeStorageDecryptor(app.dataDir, ['Qoder App', app.label.includes('国内') ? 'Qoder CN' : 'Qoder']);
      const obj = JSON.parse(decrypt(fs.readFileSync(file)));
      if (typeof obj?.token !== 'string' || !obj.token) throw new Error('auth.v1.dat 中没有 token');
      accounts.push({
        provider: app.provider,
        source: `${app.label} 客户端`,
        file,
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
