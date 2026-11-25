/**
 * 豆包（Doubao 桌面客户端）本机凭据读取与状态探测。
 *
 * 凭据存储（Windows）：
 *   %LOCALAPPDATA%\Doubao\User Data\Local State
 *     os_crypt.encrypted_key（base64，前缀 "DPAPI"）
 *     → 去前缀 → DPAPI 解密 → 32 字节 AES-256 密钥
 *   %LOCALAPPDATA%\Doubao\User Data\<Profile>\Network\Cookies（SQLite 数据库）
 *     cookies 表的 encrypted_value：Chromium v10/v11 AES-256-GCM 格式
 *     明文开头为 32 字节 Binding 哈希头（Chrome 130+），从第 33 字节起为实际 Cookie 字符串。
 *
 * 独占锁处理：
 *   客户端运行时 Chromium NetworkService 进程会对 Cookies 施加独占锁（FILE_SHARE_NONE）。
 *   本机有进程运行且直接复制失败时，通过 DuplicateHandle 复制该进程句柄进行无感热提取（<50ms，免关客户端）。
 *
 * 安全纪律：密钥与明文 Cookie 仅在本机流转，不落日志、不出本机。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { procRunningCached } from './winProc.js';

const EXE_NAMES = ['Doubao.exe', 'doubao.exe'];

export function doubaoDataDir() {
  if (process.env.DOUBAO_DATA_DIR) return process.env.DOUBAO_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Doubao', 'User Data');
  }
  return path.join(os.homedir(), '.config', 'doubao', 'User Data');
}

export function localStateFile() {
  return path.join(doubaoDataDir(), 'Local State');
}

/** 从 Cookie 串或键值对解析 Cookie 映射 */
export function parseCookieHeader(cookieInput) {
  if (!cookieInput) return {};
  if (typeof cookieInput === 'object') return cookieInput;
  const map = {};
  for (const part of String(cookieInput).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) map[name] = val;
  }
  return map;
}

/**
 * 从豆包 Cookie 提取当前活跃账号 UID：
 * multi_sids 格式为 `uid1:sid1|uid2:sid2|...`，优先匹配与当前 sessionid / sid_tt
 * 一致的条目（切号或多账号场景下，[0] 往往是旧账号，只有匹配当前会话 sid 才是真 UID）；
 * 若无 sessionid 或未命中，则回退 multi_sids 首项或 uid_tt。
 */
export function extractDoubaoUid(cookieInput) {
  const cookieMap = parseCookieHeader(cookieInput);
  const activeSid = cookieMap.sessionid || cookieMap.sessionid_ss || cookieMap.sid_tt || '';
  if (cookieMap.multi_sids) {
    let entries = [];
    try {
      entries = decodeURIComponent(cookieMap.multi_sids).split('|').filter(Boolean);
    } catch {
      entries = String(cookieMap.multi_sids).split('|').filter(Boolean);
    }
    if (activeSid) {
      for (const entry of entries) {
        const sep = entry.indexOf(':');
        if (sep > 0) {
          const entryUid = entry.slice(0, sep).trim();
          const entrySid = entry.slice(sep + 1).trim();
          if (entryUid && entrySid && entrySid === activeSid) return entryUid;
        }
      }
    }
    for (const entry of entries) {
      const firstUid = entry.split(':')[0]?.trim();
      if (firstUid) return firstUid;
    }
  }
  if (cookieMap.uid_tt) {
    try { return decodeURIComponent(cookieMap.uid_tt).trim() || null; } catch {
      return String(cookieMap.uid_tt).trim() || null;
    }
  }
  return null;
}

/**
 * 读取本机豆包客户端设备标识与版本号（用于对齐客户端请求指纹，非敏感信息）。
 */
export function readDoubaoDeviceInfo() {
  let deviceId = '';
  let installId = '';
  try {
    const lsPath = localStateFile();
    if (fs.existsSync(lsPath)) {
      const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
      deviceId = String(ls?.aha?.device?.device_id || '').trim();
      installId = String(ls?.aha?.device?.install_id || '').trim();
    }
  } catch {}
  let pcVersion = '';
  try {
    const hotFixDir = path.join(doubaoDataDir(), 'hot_fix');
    if (fs.existsSync(hotFixDir)) {
      const vers = fs.readdirSync(hotFixDir).filter((d) => /^\d+\.\d+\.\d+/.test(d)).sort();
      if (vers.length) pcVersion = vers[vers.length - 1];
    }
  } catch {}
  if (!deviceId && !installId && !pcVersion) return null;
  return { deviceId, installId, pcVersion };
}

export function candidateClientPath() {
  if (process.env.DOUBAO_CLIENT_PATH) return process.env.DOUBAO_CLIENT_PATH;
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(local, 'Programs', 'Doubao', 'Doubao.exe'),
    path.join(local, 'Doubao', 'Application', 'Doubao.exe'),
    path.join(local, 'Doubao', 'Application', 'app', 'Doubao.exe'),
    'C:\\Program Files\\Doubao\\Doubao.exe',
    'C:\\Program Files (x86)\\Doubao\\Doubao.exe',
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

export function doubaoRunningCached() {
  return procRunningCached(EXE_NAMES);
}

// ── 测试钩子 ──
let masterKeyOverride = null;
let codecOverride = null;

export function _setMasterKeyForTests(key) { masterKeyOverride = key; }
export function _setCodecForTests(codec) { codecOverride = codec; }

/** 缓存解出的 master key，避免重复 DPAPI 调用开销 */
let cachedMasterKey = null;

export function getMasterKey() {
  if (masterKeyOverride !== null) return masterKeyOverride;
  if (cachedMasterKey) return cachedMasterKey;
  if (process.platform !== 'win32') return null;

  const lsPath = localStateFile();
  if (!fs.existsSync(lsPath)) return null;

  try {
    const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
    const b64 = ls?.os_crypt?.encrypted_key;
    if (!b64) return null;
    const raw = Buffer.from(b64, 'base64');
    if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') return null;

    const cipher = raw.subarray(5);
    const script = "$ProgressPreference='SilentlyContinue';"
      + 'Add-Type -AssemblyName System.Security;'
      + '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());'
      + "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      input: cipher.toString('base64'),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();

    const key = Buffer.from(out, 'base64');
    if (key.length === 32) {
      cachedMasterKey = key;
      return key;
    }
  } catch {}
  return null;
}

/** 解密 Chromium v10/v11 Cookie */
export function decryptCookieValue(rawVal, key) {
  if (codecOverride?.decrypt) return codecOverride.decrypt(rawVal, key);
  if (!rawVal || !key) return '';
  const val = Buffer.isBuffer(rawVal) ? rawVal : Buffer.from(rawVal);
  if (val.length < 3) return '';
  const prefix = val.subarray(0, 3).toString('latin1');
  if (prefix === 'v10' || prefix === 'v11') {
    if (val.length < 3 + 12 + 16) return '';
    const nonce = val.subarray(3, 15);
    const tag = val.subarray(val.length - 16);
    const ciphertext = val.subarray(15, val.length - 16);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      // Chrome 130+ App-Bound 绑定头为 32 字节，真实 Cookie 在其后
      if (dec.length > 32) {
        return dec.subarray(32).toString('utf8');
      }
      return dec.toString('utf8');
    } catch {
      return '';
    }
  }
  return val.toString('utf8');
}

/**
 * 运行中通过 DuplicateHandle 瞬时复制被独占锁定的 Cookies 文件
 */
function copyLockedCookiesViaHandle(targetSubPath, destPath) {
  const psScript = `
$source = @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class HD {
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, int c);
    [DllImport("kernel32.dll")] public static extern bool DuplicateHandle(IntPtr a, IntPtr b, IntPtr c, out IntPtr d, uint e, bool f, uint g);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr a);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] public static extern uint GetFinalPathNameByHandle(IntPtr a, [Out] StringBuilder b, uint c, uint d);
    [DllImport("kernel32.dll")] public static extern uint GetFileType(IntPtr a);
    public static bool Copy(string targetPart, string dest) {
        IntPtr cur = Process.GetCurrentProcess().Handle;
        StringBuilder sb = new StringBuilder(1024);
        foreach (var p in Process.GetProcessesByName("Doubao")) {
            IntPtr hp = OpenProcess(0x0040, false, p.Id);
            if (hp == IntPtr.Zero) continue;
            try {
                for (int h = 4; h < 32768; h += 4) {
                    IntPtr dup;
                    if (DuplicateHandle(hp, new IntPtr(h), cur, out dup, 0, false, 2)) {
                        try {
                            if (GetFileType(dup) == 1) {
                                sb.Clear();
                                if (GetFinalPathNameByHandle(dup, sb, (uint)sb.Capacity, 0) > 0) {
                                    if (sb.ToString().IndexOf(targetPart, StringComparison.OrdinalIgnoreCase) >= 0) {
                                        using (var fs = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(dup, false), FileAccess.Read))
                                        using (var ofs = new FileStream(dest, FileMode.Create, FileAccess.Write)) {
                                            fs.Seek(0, SeekOrigin.Begin);
                                            fs.CopyTo(ofs);
                                        }
                                        return true;
                                    }
                                }
                            }
                        } catch {} finally { CloseHandle(dup); }
                    }
                }
            } finally { CloseHandle(hp); }
        }
        return false;
    }
}
'@
Add-Type -TypeDefinition $source
[HD]::Copy('${targetSubPath.replace(/'/g, "''")}', '${destPath.replace(/'/g, "''")}')
`;
  try {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      encoding: 'utf8',
    }).trim();
    return out.toLowerCase().includes('true');
  } catch {
    return false;
  }
}

/**
 * 复制指定 Cookies 文件到临时路径（支持运行中热提取）
 */
function safelyCopyCookiesDb(srcPath, destPath, profileName = 'Default') {
  try {
    fs.copyFileSync(srcPath, destPath);
    return true;
  } catch (err) {
    if (err.code === 'EBUSY' && process.platform === 'win32') {
      const matchPart = path.join(profileName, 'Network', 'Cookies');
      return copyLockedCookiesViaHandle(matchPart, destPath);
    }
    return false;
  }
}

/**
 * 读取并解密豆包指定 Profile 的 Cookie 列表
 */
export async function readDoubaoProfileCookies(profileDirName = 'Default') {
  const masterKey = getMasterKey();
  if (!masterKey) return null;

  const cookieFile = path.join(doubaoDataDir(), profileDirName, 'Network', 'Cookies');
  if (!fs.existsSync(cookieFile)) return null;

  const tmp = path.join(os.tmpdir(), `cd_doubao_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
  const copied = safelyCopyCookiesDb(cookieFile, tmp, profileDirName);
  if (!copied || !fs.existsSync(tmp)) return null;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return null;
  }

  const cookieMap = {};
  const cookiePairs = [];
  try {
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%doubao.com' AND (path = '/' OR path IS NULL OR path = '')").all();
    for (const r of rows) {
      try {
        const val = decryptCookieValue(r.encrypted_value, masterKey);
        if (val && /^[\x20-\x7E]+$/.test(val)) {
          cookieMap[r.name] = val;
          cookiePairs.push(`${r.name}=${val}`);
        }
      } catch {}
    }
    db.close();
  } catch {} finally {
    try { fs.unlinkSync(tmp); } catch {}
  }

  if (cookiePairs.length === 0) return null;

  const uid = extractDoubaoUid(cookieMap);

  return {
    profileDirName,
    uid,
    cookies: cookieMap,
    cookieHeader: cookiePairs.join('; '),
    hasSession: Boolean(cookieMap.sessionid || cookieMap.sessionid_ss),
  };
}

/**
 * 遍历并读取客户端中所有 Profile 的会话
 */
export async function readDoubaoProfiles() {
  const profiles = [];
  const lsPath = localStateFile();
  let infoCache = {};
  let lastUsed = 'Default';
  if (fs.existsSync(lsPath)) {
    try {
      const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
      infoCache = ls?.profile?.info_cache || {};
      lastUsed = ls?.profile?.last_used || 'Default';
    } catch {}
  }

  const profileKeys = Object.keys(infoCache);
  if (!profileKeys.includes('Default')) profileKeys.unshift('Default');

  for (const k of profileKeys) {
    const prof = await readDoubaoProfileCookies(k);
    if (prof) {
      const meta = infoCache[k] || {};
      profiles.push({
        ...prof,
        displayName: meta.name || (k === 'Default' ? '工作' : k),
        active: k === lastUsed,
      });
    }
  }

  return profiles;
}

/** 读取当前活跃/首选的豆包会话凭据 */
export async function readDoubaoCredential() {
  const profiles = await readDoubaoProfiles();
  return profiles.find((p) => p.active && p.hasSession) || profiles.find((p) => p.hasSession) || null;
}

/** 本机豆包综合探测（供 /api/status 与 /api/detect-local 使用，纯同步零耗时） */
export function detectDoubao() {
  const dataDir = doubaoDataDir();
  const stateExists = fs.existsSync(localStateFile());
  const clientPath = candidateClientPath();
  const running = doubaoRunningCached();

  // 纯文件存在性判断，不唤起子进程与 DPAPI，保障 /api/status 亚秒级响应
  const defaultCookiesPath = path.join(dataDir, 'Default', 'Network', 'Cookies');
  let signedIn = false;
  try {
    signedIn = fs.existsSync(defaultCookiesPath);
  } catch {}

  return {
    dataDir,
    exists: stateExists,
    signedIn,
    clientInstalled: Boolean(clientPath),
    clientPath,
    running,
  };
}

/**
 * 本机当前登录 → 标准化账号对象（供「添加账号 → 本机导入」）。
 */
export async function liveToAccount() {
  const cred = await readDoubaoCredential();
  if (!cred || !cred.cookieHeader) return null;

  const name = cred.displayName
    ? `豆包 (${cred.displayName})`
    : (cred.uid ? `豆包 (${String(cred.uid).slice(0, 6)}…)` : '豆包 (本机)');
  const doubaoDevice = readDoubaoDeviceInfo();

  return {
    provider: 'doubao',
    token: cred.cookieHeader,
    refreshToken: null,
    uid: cred.uid || null,
    name,
    expiresAt: null,
    source: 'local-app',
    meta: {
      cookieSiteId: 'doubao',
      displayName: cred.displayName,
      ...(doubaoDevice ? { doubaoDevice } : {}),
      cookieSiteSession: {
        cookie: cred.cookieHeader,
        capturedAt: new Date().toISOString(),
      },
    },
  };
}
