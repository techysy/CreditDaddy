/**
 * Trae（ByteDance TRAE SOLO / Trae CN）本机凭据读取。
 *
 * 登录态在 <userData>/User/globalStorage/storage.json 的 iCubeAuthInfo://icube.cloudide 键，
 * 值为 Trae 自研「tc」信封（out/vs/base/common/byteCrypto.js 逆向）：pepper 是随安装包分发的
 * 公开常量表（混淆而非加密），派生 = SHA512(random)||pepper 再 SHA512，取前 32B 为 key/iv，
 * AES-128-CBC/PKCS7 解密后前 64B 是明文的 SHA512 完整性校验值。
 *
 * 只读本机自有凭据，token 不进日志、不外传。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dataDir } from './store.js';

const APP_NAMES = ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae'];
const EXE_NAMES = ['TRAE SOLO CN.exe', 'Trae CN.exe', 'TRAE SOLO.exe', 'Trae.exe'];
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const DC_PREFIX = 'iCubeAuthInfo://icube-dc:';
const HEADER = Buffer.from([116, 99, 5, 16, 0, 0]);

// byteCrypto 四常量表（Trae CN resources/app/out/main.js 提取；上游换版本时重新提取）
const WOE = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37];
const VOE = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];
const JOE = [191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209];
const HOE = [246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170];

const sha512 = (b) => crypto.createHash('sha512').update(b).digest();
const pepper = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));

/** tc 信封解密（默认 AES 模式，失败回落 AES_PRIVATE 模式）；解不开返回 null 由调用方降级 */
export function tcDecrypt(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const raw = Buffer.from(b64.trim(), 'base64');
  if (raw.length < 54 || !raw.subarray(0, 6).equals(HEADER)) return null;
  const cipher = raw.subarray(38);
  for (const p of [pepper(WOE, VOE), pepper(JOE, HOE)]) {
    try {
      const k = sha512(Buffer.concat([sha512(raw.subarray(6, 38)), p]));
      const d = crypto.createDecipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
      const plain = Buffer.concat([d.update(cipher), d.final()]);
      if (plain.length <= 64) continue;
      const body = plain.subarray(64);
      if (!sha512(body).equals(plain.subarray(0, 64))) continue;
      return JSON.parse(body.toString('utf8'));
    } catch { /* 换下一个 pepper 模式 */ }
  }
  return null;
}

function appDataRoot() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** 本机 Trae 数据目录（第一个含 storage.json 的），没有则 null */
export function traeDataDir() {
  const override = process.env.TRAE_HOME;
  if (override) {
    const file = path.join(override, 'User', 'globalStorage', 'storage.json');
    return fs.existsSync(file) ? override : null;
  }
  for (const name of APP_NAMES) {
    const file = path.join(appDataRoot(), name, 'User', 'globalStorage', 'storage.json');
    if (fs.existsSync(file)) return path.dirname(path.dirname(path.dirname(file)));
  }
  return null;
}

function readStorageJson(dir) {
  const file = path.join(dir, 'User', 'globalStorage', 'storage.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 签到接口风控要求 x-device-id 是 16 位纯数字，传 GUID/UUID 会返回 code 9074。
 * storage.json 里形如 iCubeAuthInfo://icube-dc:3049374157909753 的键名后缀就是客户端自报的设备号，
 * 直接取用可保证与 IDE 自己的指纹一致（同目录另有 icube-dc:aha-<hash> 一条，按纯数字过滤掉）。
 */
function deviceIdOf(storage) {
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(DC_PREFIX)) continue;
    const id = key.slice(DC_PREFIX.length);
    if (id.length >= 8 && /^[0-9]+$/.test(id)) return id;
  }
  return null;
}

/** 解出客户端当前登录的完整凭据；未登录/解不开返回 null */
export function readLiveAuth() {
  const dir = traeDataDir();
  if (!dir) return null;
  const storage = readStorageJson(dir);
  if (!storage) return null;
  const auth = tcDecrypt(storage[AUTH_KEY]);
  if (!auth || typeof auth.token !== 'string') return null;
  return { dataDir: dir, deviceId: deviceIdOf(storage), auth };
}

const decodeTasklist = (buf) => {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
};

let runningOverride = null;

/** 任一变体的 Trae 客户端是否在运行 */
export function traeRunning() {
  if (runningOverride !== null) return runningOverride;
  if (process.platform !== 'win32') return false;
  for (const exe of EXE_NAMES) {
    try {
      const out = decodeTasklist(execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exe}`, '/NH'],
        { windowsHide: true, encoding: 'buffer', timeout: 8000 }));
      if (out.toLowerCase().includes(exe.toLowerCase()) && !/no tasks|没有找到|没有任务/i.test(out)) return true;
    } catch { /* 下一个变体 */ }
  }
  return false;
}

export function candidateClientPath() {
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const name of APP_NAMES) {
    for (const exe of EXE_NAMES) {
      const p = path.join(local, 'Programs', name, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function detectTrae() {
  const dir = traeDataDir();
  const clientPath = candidateClientPath();
  let live = null;
  try { live = readLiveAuth(); } catch { /* 视为未登录 */ }
  return {
    dataDir: dir || '',
    exists: Boolean(dir),
    signedIn: Boolean(live),
    clientInstalled: Boolean(clientPath),
    clientPath,
    running: traeRunning(),
    uid: live?.auth?.userId || null,
    name: live?.auth?.account?.username || null,
  };
}

/**
 * 读取 Trae 客户端当前登录 → CreditDaddy 标准账号对象。
 * uid / name 直接从 JWT 与内嵌 account 取，不需要网络往返。
 */
export async function liveToAccount() {
  const live = readLiveAuth();
  if (!live) return null;
  const { auth, deviceId } = live;
  const account = {
    provider: 'trae',
    token: auth.token,
    // 故意不导入 refreshToken：Trae 的 refresh 会轮转 refreshToken 并作废 IDE 自己那份，
    // 等于把用户正在用的 Trae 踢下线。面板据 hasRefreshToken 显示「自动续期」，
    // 不存它就会改为显示到期日并在临期时变红，提示到 Trae 里重新登录后重新导入。
    refreshToken: null,
    uid: auth.userId ? String(auth.userId) : null,
    name: auth.account?.username || null,
    email: auth.account?.email || null,
    expiresAt: auth.expiredAt || null,
    source: 'local-app',
    meta: {
      deviceId: deviceId || undefined,
      host: auth.host || undefined,
      region: auth.userRegion?.region || undefined,
      avatarUrl: auth.account?.avatar_url || undefined,
      capturedAt: new Date().toISOString(),
    },
  };
  if (!account.uid) account.uid = uidFromJwt(auth.token) || null;
  return account;
}

/** Cloud-IDE-JWT 的 payload.data.id 即 uid */
export function uidFromJwt(token) {
  const seg = String(token || '').split('.')[1];
  if (!seg) return null;
  try {
    const p = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    return p?.data?.id ? String(p.data.id) : null;
  } catch { return null; }
}

export function terminateTrae({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  if (!traeRunning()) return { closed: false, running: false };
  const kill = (force) => {
    for (const exe of EXE_NAMES) {
      try {
        execFileSync('taskkill.exe', force ? ['/IM', exe, '/T', '/F'] : ['/IM', exe, '/T'],
          { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
      } catch { /* 该变体没在跑 */ }
    }
  };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const deadline = Date.now() + timeoutMs;
  kill(false);
  while (Date.now() < deadline && traeRunning()) nap(250);
  if (traeRunning()) {
    kill(true);
    const hard = Date.now() + 3000;
    while (Date.now() < hard && traeRunning()) nap(250);
  }
  return { closed: !traeRunning(), running: traeRunning() };
}

/** 测试钩子 */
export function _setRunningForTests(running) { runningOverride = running; }

// ── 登录态快照与切换 ──

/**
 * 登录态白名单（对齐 TraeWorkAssistant switcher/icube.rs 的 ICUBE_ITEMS）。
 * 备份与恢复用同一张表：表外的文件不动，避免把用户的工程配置一起换掉。
 */
const SLOT_ITEMS = [
  'User/globalStorage/storage.json',
  'User/globalStorage/state.vscdb',
  'User/globalStorage/state.vscdb-wal',
  'User/globalStorage/state.vscdb-shm',
  'User/globalStorage/state.vscdb.backup',
  'machineid',
  'aha',
  'Preferences',
  'Local State',
  'Local Storage/leveldb',
  'Local Storage/config.db',
  'Network',
  'Partitions/trae-webview',
  'Partitions/icube-web-crawler-shared-session-v1.0',
  'Session Storage',
];

const slotDir = (uid) => path.join(dataDir(), 'trae-slots', String(uid));

export function hasSlot(uid) {
  return Boolean(uid) && fs.existsSync(path.join(slotDir(uid), 'User', 'globalStorage', 'storage.json'));
}

/**
 * Chromium 缓存目录：与登录态无关，但本机实测占快照体积的 91/106 MB
 * （Partitions/trae-webview/Cache 43MB + icube-web-crawler 的 Code Cache 48MB），
 * 每个账号都拷一份既慢又白占磁盘，跳过。
 */
const CACHE_NAMES = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'blob_storage']);
const notCache = (p) => !CACHE_NAMES.has(path.basename(p));

function copyInto(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const isDir = fs.statSync(src).isDirectory();
  fs.cpSync(src, dst, isDir ? { recursive: true, filter: notCache } : undefined);
}

/** 把当前登录的 15 项快照到 trae-slots/<uid>/，旧快照转成 .bak 保留一代 */
function saveSlot(uid) {
  const root = traeDataDir();
  if (!root || !uid) return 0;
  const dest = slotDir(uid);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest + '.bak', { recursive: true, force: true });
    fs.renameSync(dest, dest + '.bak');
  }
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const rel of SLOT_ITEMS) {
    const src = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(src)) continue;
    copyInto(src, path.join(dest, ...rel.split('/')));
    n++;
  }
  return n;
}

function restoreSlot(uid) {
  const root = traeDataDir();
  const src = slotDir(uid);
  if (!root || !fs.existsSync(src)) return 0;
  let n = 0;
  for (const rel of SLOT_ITEMS) {
    const from = path.join(src, ...rel.split('/'));
    if (!fs.existsSync(from)) continue;
    copyInto(from, path.join(root, ...rel.split('/')));
    n++;
  }
  return n;
}

/**
 * 把本机 Trae 切到目标账号的登录态：先快照当前登录（防丢号），再覆盖回目标快照。
 * Trae 在运行时会把内存里的旧登录写回文件，所以必须先退出（force 时代为退出）。
 */
export async function switchTo(account, { force = false } = {}) {
  const live = readLiveAuth();
  if (!live) throw new Error('本机 Trae 没有可读取的登录态（storage.json 缺失或解不开）');
  const cur = live.auth.userId;
  if (account.uid && cur && String(account.uid) === String(cur)) return { switched: false, alreadyActive: true };

  // 只认整份快照：实测「只把 token 写回 storage.json」的冷切换会让 Trae 显示未登录
  // （它判登录还要看 state.vscdb），比不切更糟，所以这条路已删除。
  if (!hasSlot(account.uid)) {
    throw new Error(`账号「${account.name || account.uid}」还没有登录态快照：请先在 Trae 里登录该账号，再回这里点一次「本机导入」`);
  }

  let closedClient = false;
  if (traeRunning()) {
    if (!force) {
      const e = new Error('Trae 客户端正在运行，请先退出后再切换（或强制切换，切换后自动重新拉起 Trae）');
      e.traeRunning = true;
      throw e;
    }
    closedClient = terminateTrae().closed === true;
  }

  if (cur) saveSlot(cur);
  restoreSlot(account.uid);
  return { switched: true, alreadyActive: false, closedClient };
}

/** 供 daemon 在导入成功后立即建快照（否则新导入的账号没有可恢复的登录态） */
export function snapshotLive() {
  try {
    const live = readLiveAuth();
    return live?.auth?.userId ? saveSlot(live.auth.userId) : 0;
  } catch { return 0; }
}
