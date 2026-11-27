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
import http from 'node:http';
import net from 'node:net';
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
let cdpOverride = null;

export function _setMasterKeyForTests(key) { masterKeyOverride = key; }
export function _setCodecForTests(codec) { codecOverride = codec; }
export function _setCdpForTests(fn) { cdpOverride = fn; }

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

function httpGetJson(urlStr, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = http.get(parsed, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectCdpWs(urlStr, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection(
      { host: parsed.hostname, port: parseInt(parsed.port || '80', 10) },
      () => {
        socket.write([
          `GET ${parsed.pathname}${parsed.search || ''} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '', '',
        ].join('\r\n'));
      }
    );

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let msgId = 1;
    const pending = new Map();

    const timer = setTimeout(() => {
      socket.destroy(new Error('CDP connect timeout'));
    }, timeoutMs);

    function sendFrame(text) {
      const payload = Buffer.from(text, 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, masked]));
    }

    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      if (!handshakeDone) {
        const he = buf.indexOf('\r\n\r\n');
        if (he >= 0) {
          if (!buf.subarray(0, he).toString('utf8').includes('101')) {
            clearTimeout(timer);
            socket.destroy(new Error('WebSocket handshake failed'));
            reject(new Error('WebSocket handshake failed'));
            return;
          }
          handshakeDone = true;
          buf = buf.subarray(he + 4);
          clearTimeout(timer);
          resolve({
            send(method, params = {}) {
              return new Promise((res, rej) => {
                const id = msgId++;
                pending.set(id, { resolve: res, reject: rej });
                sendFrame(JSON.stringify({ id, method, params }));
                setTimeout(() => {
                  if (pending.has(id)) {
                    pending.delete(id);
                    rej(new Error(`CDP method ${method} timed out`));
                  }
                }, 20000);
              });
            },
            close() { socket.destroy(); },
          });
        }
        return;
      }

      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let payloadLen = buf[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) break;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) break;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (buf.length < offset + payloadLen) break;
        const payload = buf.subarray(offset, offset + payloadLen);
        buf = buf.subarray(offset + payloadLen);

        if (opcode === 1) {
          try {
            const msg = JSON.parse(payload.toString('utf8'));
            if (msg.id && pending.has(msg.id)) {
              const p = pending.get(msg.id);
              pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } catch {}
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      for (const [, p] of pending) p.reject(new Error('CDP socket closed'));
      pending.clear();
    });
  });
}

/**
 * 通过本机豆包桌面客户端（CDP 调试协议）执行 UI 自动化签到。
 * 用于突破 710010702 风控拦截：通过客户端内置的真实反作弊与原生签名环境完成签到。
 */
export async function checkinDoubaoViaLocalClient(options = {}) {
  if (cdpOverride) return cdpOverride(options);

  if (process.platform !== 'win32') return { status: 'unsupported', reason: 'platform_not_supported' };
  const clientPath = candidateClientPath();
  if (!clientPath || !fs.existsSync(clientPath)) return { status: 'unsupported', reason: 'client_not_installed' };

  const port = options.port || 19222;
  const userData = doubaoDataDir();
  const allowRestart = Boolean(options.allowRestart);
  const timeoutMs = options.timeoutMs || 30_000;

  // 1. 检查 CDP 端口是否已就绪
  let cdpReady = false;
  try {
    const v = await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1500);
    if (v?.Browser) cdpReady = true;
  } catch {}

  let startedByUs = false;
  if (!cdpReady) {
    const running = doubaoRunningCached();
    if (running && !allowRestart) {
      return { status: 'unsupported', reason: 'running_without_cdp' };
    }
    if (running && allowRestart) {
      try { execFileSync('taskkill', ['/F', '/IM', 'Doubao.exe', '/T'], { stdio: 'ignore', timeout: 5000 }); } catch {}
      await sleep(2000);
    }
    const { spawn } = await import('node:child_process');
    const child = spawn(clientPath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    startedByUs = true;

    // 轮询等待 CDP 端口就绪（至多 15 秒）
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const v = await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1500);
        if (v?.Browser) { cdpReady = true; break; }
      } catch {}
    }
    if (!cdpReady) {
      return { status: 'failed', message: '豆包 CDP 调试模式启动超时' };
    }
  }

  // 等待页面加载（至多 12 秒）
  let chatTarget = null;
  const pageDeadline = Date.now() + 12_000;
  while (Date.now() < pageDeadline) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${port}/json`, 2000);
      if (Array.isArray(targets)) {
        chatTarget = targets.find((t) => t.type === 'page' && t.url?.includes('doubao-chat/chat'))
          || targets.find((t) => t.type === 'page' && t.title?.includes('豆包'));
        if (chatTarget?.webSocketDebuggerUrl) break;
      }
    } catch {}
    await sleep(1000);
  }

  if (!chatTarget?.webSocketDebuggerUrl) {
    return { status: 'failed', message: '未找到豆包聊天页面' };
  }

  let cdp;
  try {
    cdp = await connectCdpWs(chatTarget.webSocketDebuggerUrl, timeoutMs);
  } catch (err) {
    return { status: 'failed', message: `CDP 连接失败: ${err.message}` };
  }

  try {
    await sleep(2500);

    const clickExpr = `
      (() => {
        const all = [...document.querySelectorAll('*')];
        const signed = all.find((el) => {
          const t = el.textContent?.trim();
          return t && (t === '\\u4eca\\u65e5\\u5df2\\u7b7e\\u5230' || t === '\\u5df2\\u7b7e\\u5230' || t.includes('\\u660e\\u65e5\\u7b7e\\u5230'));
        });
        if (signed) return { already: true };

        let btn = all.find((el) => {
          const t = el.textContent?.trim();
          return t === '\\u7acb\\u5373\\u7b7e\\u5230' || (t?.includes('\\u7acb\\u5373\\u7b7e\\u5230') && t.length < 20);
        });
        if (!btn) return { found: false };

        const rect = btn.getBoundingClientRect();
        return {
          found: true,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          text: btn.textContent?.trim()?.slice(0, 30),
        };
      })()
    `;

    const findRes = await cdp.send('Runtime.evaluate', { expression: clickExpr, returnByValue: true });
    const val = findRes?.result?.value;
    if (val?.already) {
      return { status: 'already', message: '今天已签到' };
    }
    if (!val?.found || !val.rect) {
      return { status: 'failed', message: '未在豆包窗口中找到「立即签到」按钮' };
    }

    const cx = val.rect.x + val.rect.w / 2;
    const cy = val.rect.y + val.rect.h / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await sleep(100);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });

    await sleep(4000);

    const verifyExpr = `
      (() => {
        const text = document.body?.innerText || '';
        return {
          success: text.includes('\\u5df2\\u7b7e\\u5230') || text.includes('\\u660e\\u65e5\\u7b7e\\u5230') || text.includes('\\u7b7e\\u5230\\u6210\\u529f') || !text.includes('\\u7acb\\u5373\\u7b7e\\u5230'),
          error: text.includes('\\u98ce\\u63a7') || text.includes('\\u7cfb\\u7edf\\u9519\\u8bef'),
        };
      })()
    `;
    const verifyRes = await cdp.send('Runtime.evaluate', { expression: verifyExpr, returnByValue: true });
    const vVal = verifyRes?.result?.value;

    if (vVal?.success) {
      return { status: 'checked-in', claimedAmount: 200, message: '通过豆包客户端完成签到，+200 额度' };
    }
    return { status: 'failed', message: '豆包客户端未确认签到结果' };
  } finally {
    try { cdp.close(); } catch {}
    if (startedByUs) {
      try {
        execFileSync('taskkill', ['/F', '/IM', 'Doubao.exe', '/T'], { stdio: 'ignore', timeout: 5000 });
        await sleep(2000);
        const { spawn } = await import('node:child_process');
        spawn(clientPath, [], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
    }
  }
}
