/**
 * AutoClaw（智谱澳龙 / AutoGLM 桌面端）本机凭据读取 —— 只读，绝不写客户端文件。
 *
 * 数据目录（Windows 本机实测 1.20.0）：
 *   %APPDATA%\autoclaw\auth.json
 *     { deviceId(64 hex), updatedAt, token:"enc:djEw…", refreshToken:"enc:djEw…",
 *       userInfo: { user_id, user_name, user_phone(已脱敏 131****3656), id, account_type,
 *                   product, is_guest, config… } }
 *   token / refreshToken 是 Electron safeStorage 密文：
 *     "enc:" 前缀去掉后 base64 解码 = "v10" + nonce(12) + AES-256-GCM 密文 + tag(16)，
 *     密钥来自同目录 Local State 的 os_crypt.encrypted_key（base64，前 5 字节 "DPAPI"，
 *     去头后 DPAPI CurrentUser 解出 32 字节 key）。
 *   → 直接复用 qoderApp.js 的 safeStorageCodec（同一套 Windows/mac/linux 分支，别新写一份）。
 *
 * 安全纪律：
 *  - 密钥与明文 token 只在本机进程内流转，不落日志、不出本机；对外只暴露掩码后的手机号。
 *  - 收割只读不写（客户端运行中退出时会用内存里的登录覆盖文件，写回去只会制造不一致；
 *    换号需求走客户端自己登录后重新本机导入）。
 *  - _setDetectForTests 钩子：装了 AutoClaw 的机器跑 `npm test` 时不得读真机目录
 *    （qwenwork 事故同款教训）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { procRunningCached } from './winProc.js';
import { t } from './i18n.js';

export const AUTOCLAW_EXE = 'AutoClaw.exe';
/** 双线同源同客户端：一个客户端只登一个号，凭据里 JWT 的 source_id 决定归哪条线 */
export const AUTOCLAW_VARIANTS = [
  { provider: 'autoclaw', label: 'AutoClaw' },
  { provider: 'autoclaw-cn', label: 'AutoClaw CN' },
];

/** 数据目录：%APPDATA%\autoclaw（可用 AUTOCLAW_DATA_DIR 覆盖：供测试与自定义安装） */
export function autoclawDataDir() {
  if (process.env.AUTOCLAW_DATA_DIR) return process.env.AUTOCLAW_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'autoclaw');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'autoclaw');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autoclaw');
}

export const authFile = () => path.join(autoclawDataDir(), 'auth.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ── 测试钩子 ──

let detectOverride = null;   // 替代 detectAutoclaw（真实探测要读本机目录）
let codecOverride = null;    // 替代 safeStorageCodec（DPAPI 依赖真实用户上下文）

/** 测试钩子：注入安装探测，传 null 恢复真实探测 */
export function _setDetectForTests(fn) { detectOverride = fn || null; }
/** 测试钩子：注入 safeStorage 编解码器，传 null 恢复真实实现 */
export function _setCodecForTests(codec) { codecOverride = codec || null; }

// ── 安装 / 运行探测 ──

export function candidateClientPaths() {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(local, 'Programs', 'AutoClaw', AUTOCLAW_EXE),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'AutoClaw', AUTOCLAW_EXE),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'AutoClaw', AUTOCLAW_EXE),
  ];
}

export function candidateClientPath() {
  return candidateClientPaths().find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/** 轮询口径：读 winProc 快照，不 spawn */
export function autoclawRunningCached() {
  return procRunningCached([AUTOCLAW_EXE]);
}

/**
 * 本机探测（/api/status 与「添加账号 → 本机导入」共用；同步零子进程）。
 * 只回布尔与掩码名，绝不回 token。
 */
export function detectAutoclaw() {
  if (detectOverride) return detectOverride();
  const file = authFile();
  const j = readJson(file);
  const clientPath = candidateClientPath();
  return {
    dataDir: autoclawDataDir(),
    exists: Boolean(j),
    signedIn: Boolean(j?.token),
    // 凭据是否加密（enc: + Local State 都在）——判断能不能解，不解密
    encrypted: Boolean(j?.token && /^enc:/i.test(String(j.token))),
    clientInstalled: Boolean(clientPath),
    clientPath,
    running: autoclawRunningCached(),
    // uid 直接来自 auth.json 的 userInfo.id（明文，无需解密）：面板「客户端当前登录」徽章用
    uid: j?.userInfo?.id != null ? String(j.userInfo.id) : null,
    userName: typeof j?.userInfo?.user_name === 'string' ? j.userInfo.user_name : null,
    phoneMasked: typeof j?.userInfo?.user_phone === 'string' ? j.userInfo.user_phone : null,
    // 归属线要解 JWT 才知道（source_id），detect 是同步零解密口径 → 不在此判定
    updatedAt: Number.isFinite(j?.updatedAt) ? j.updatedAt : null,
  };
}

// ── 解密 ──

/** "enc:<base64>" → Buffer（v10 布局） */
export function decodeEncField(value) {
  const s = String(value ?? '').replace(/^enc:/i, '');
  if (!s) return null;
  try { return Buffer.from(s, 'base64'); } catch { return null; }
}

/**
 * 解密 auth.json 的一对凭据。
 * @returns {Promise<{accessToken,refreshToken,deviceId,userInfo}|null>} 未登录/解密失败 = null
 */
export async function decryptAutoclawAuth(raw = readJson(authFile()), { codec = null } = {}) {
  if (!raw || typeof raw.token !== 'string' || !raw.token) return null;
  let dec = codecOverride || codec;
  if (!dec) {
    try {
      const { safeStorageCodec } = await import('./qoderApp.js');
      dec = await safeStorageCodec(autoclawDataDir(), ['AutoClaw']);
    } catch {
      return null;
    }
  }
  try {
    const tokBuf = decodeEncField(raw.token);
    const refBuf = decodeEncField(raw.refreshToken);
    if (!tokBuf) return null;
    const accessToken = String(dec.decrypt(tokBuf)).trim();
    const refreshToken = refBuf ? String(dec.decrypt(refBuf)).trim() : null;
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken,
      deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : null,
      userInfo: raw.userInfo && typeof raw.userInfo === 'object' ? raw.userInfo : null,
    };
  } catch {
    return null;
  }
}

/**
 * 读本机当前登录（每次现读现解）。
 * 便宜且必须新鲜：客户端每小时轮换，缓存会让「用本机最新对」这条零副作用路径失效。
 * 贵的只有 DPAPI 那一次，而 qoderApp.safeStorageCodec 按 userData 缓存了密钥 —— 这里
 * 同样把 codec 缓存在模块内，重复调用只剩读一个小 JSON + 一次 AES-GCM。
 * 未装 / 未登录 / 解密失败一律 null（不抛，调用方按「本机没有可用凭据」处理）。
 */
let codecCache = null;
export async function loadAutoclawLocalCredential() {
  const raw = readJson(authFile());
  if (!raw) return null;
  if (!codecCache) {
    try {
      const { safeStorageCodec } = await import('./qoderApp.js');
      codecCache = await safeStorageCodec(autoclawDataDir(), ['AutoClaw']);
    } catch { codecCache = null; }
  }
  return decryptAutoclawAuth(raw, { codec: codecCache });
}

/** 测试钩子：重置 codec 缓存（换临时目录后必须复位，否则会拿旧密钥解新目录） */
export function _resetAutoclawLocalCache() { codecCache = null; }

/** 凭据的归属线（JWT source_id）：agent* = CN；读不到 = null */
export async function autoclawLocalRegion() {
  const { autoclawRegionOfToken } = await import('./autoclawClient.js');
  const cred = await loadAutoclawLocalCredential();
  return cred ? autoclawRegionOfToken(cred.refreshToken) || autoclawRegionOfToken(cred.accessToken) : null;
}

/**
 * 本机当前登录 → 标准化账号对象（供「添加账号 → 本机导入」）。
 * @param {{provider?: string}} opts 指定期望的线；实际归属以 JWT 为准（对不上就按实际线返回）
 */
export async function liveToAccount({ provider = null } = {}) {
  const { autoclawRegionOfToken, maskAutoclawPhone, autoclawExpiresAtMs } = await import('./autoclawClient.js');
  const cred = await loadAutoclawLocalCredential();
  if (!cred) return null;
  const region = autoclawRegionOfToken(cred.refreshToken) || autoclawRegionOfToken(cred.accessToken) || (provider === 'autoclaw-cn' ? 'cn' : 'intl');
  const line = region === 'cn' ? 'autoclaw-cn' : 'autoclaw';
  const ui = cred.userInfo || {};
  const name = typeof ui.user_name === 'string' && ui.user_name.trim() ? ui.user_name.trim() : null;
  const phoneMasked = maskAutoclawPhone(ui.user_phone);
  const expMs = autoclawExpiresAtMs(cred.accessToken);
  return {
    provider: line,
    token: cred.accessToken,
    refreshToken: cred.refreshToken,
    uid: ui.id != null ? String(ui.id) : null,
    name: name || (phoneMasked ? `AutoClaw (${phoneMasked})` : 'AutoClaw (本机)'),
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    source: 'local-app',
    meta: {
      autoclawRegion: region,
      autoclawDeviceId: cred.deviceId || null,
      autoclawUserId: typeof ui.user_id === 'string' ? ui.user_id : null,
      phone: phoneMasked,
      accountType: typeof ui.account_type === 'string' ? ui.account_type : null,
      capturedAt: new Date().toISOString(),
    },
  };
}

/** 客户端会读的 uid（同步口径，/api/status 热路径用）：auth.json 的 userInfo.id，无需解密 */
export function currentAutoclawUid() {
  const j = readJson(authFile());
  return j?.userInfo?.id != null ? String(j.userInfo.id) : null;
}

// ── 客户端拉起（面板「打开客户端」按钮用）──

export function clientOpenHint() {
  const p = candidateClientPath();
  return p ? { path: p } : null;
}

/** 切换：AutoClaw 不做换号（只读收割）——如实说明，不假装成功 */
export async function switchTo() {
  const e = new Error(t('AutoClaw 线不支持从 CreditDaddy 换号：请在 AutoClaw 客户端登录目标账号，再用「本机导入」把该账号加进来'));
  e.autoclawNoSwitch = true;
  throw e;
}