/**
 * 本机 QuWork 客户端凭据收割（只读，不写回）。
 *
 * 凭据存储（2026-11-26 本机实测，QuWork 桌面端 Electron）：
 *   安装    %LOCALAPPDATA%\Programs\QuWork\QuWork.exe
 *   数据目录 %APPDATA%\qurwork-desktop\
 *   凭据库  %APPDATA%\qurwork-desktop\qurwork-desktop.sqlite —— 表 auth_session 单行
 *           session_json = { accessToken(JWT，账号 Bearer), expiresAt(ms),
 *                            llmToken("sk-…"，推理 Bearer，QuWork 不轮换),
 *                            user{ id, aff_code 邀请码, inviter_id, wechat_bound,
 *                                  phone, display_name, points_entitlement{…} },
 *                            createdAt, updatedAt }
 *           **明文 SQLite，无 safeStorage 加密**（与 Croli 明文 auth.json 同档）。
 *
 * 读取纪律：
 *   - node:sqlite readOnly 打开——客户端在跑也允许并发读（WAL 模式）；EBUSY/占用时
 *     先 copy 到临时目录再读兜底（同 doubaoLocal 的 Network/Cookies 热拷贝思路）。
 *   - 只读不写：CD 不切 QuWork 客户端登录（客户端是单会话表，整行覆盖风险高，
 *     且用户口径只要求收割），永不写该库。
 *   - token 只在本机进程内流转，不落日志、不出本机（croliLocal 同款纪律）。
 *
 * 测试钩子：_setQuworkPathsForTests 注入数据目录——不加的话装了客户端的机器
 * 跑回归测试会读真机凭据库（qwenwork 事故同款教训，detect 类都必须可注入）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { procRunningCached } from './winProc.js';
import { t } from './i18n.js';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function defaultDataDir() {
  if (process.env.QUWORK_DATA_DIR) return process.env.QUWORK_DATA_DIR;
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'qurwork-desktop');
  }
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'qurwork-desktop');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'qurwork-desktop');
}

function defaultInstallDir() {
  if (process.env.QUWORK_CLIENT_PATH) return path.dirname(process.env.QUWORK_CLIENT_PATH);
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs', 'QuWork');
}

// 测试注入：{ dataDir, installDir } → 覆盖真机路径解析（null 恢复真实）
let pathsOverride = null;
export function _setQuworkPathsForTests(overrides) { pathsOverride = overrides || null; }

export function quworkDataDir() { return (pathsOverride && pathsOverride.dataDir) || defaultDataDir(); }
export function quworkDbFile() { return path.join(quworkDataDir(), 'qurwork-desktop.sqlite'); }
export function quworkExeFile() {
  const install = (pathsOverride && pathsOverride.installDir) || defaultInstallDir();
  if (!install) return null;
  const exe = process.platform === 'win32' ? 'QuWork.exe' : 'QuWork';
  const direct = path.join(install, exe);
  return exists(direct) ? direct : null;
}

/** 本机安装/登录态盘点（detect* 家族口径）；running 走 winProc 轮询快照（不 spawn，/api/status 30s 一轮） */
export function detectQuwork() {
  const exe = quworkExeFile();
  const db = quworkDbFile();
  return {
    installed: Boolean(exe),
    exe,
    dataDir: quworkDataDir(),
    dataExists: exists(quworkDataDir()),
    dbExists: exists(db),
    signedIn: exists(db),
    running: process.platform === 'win32' ? procRunningCached(['QuWork.exe']) : false,
  };
}

// node:sqlite 模块缓存（屏蔽实验特性警告——usageSync 同款做法）；null = 环境不支持
let sqliteMod;
async function loadSqlite() {
  if (sqliteMod === undefined) {
    try {
      const emit = process.emitWarning;
      process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
      try { sqliteMod = await import('node:sqlite'); } finally { process.emitWarning = emit; }
    } catch { sqliteMod = null; }
  }
  return sqliteMod;
}

/** 读 auth_session.session_json：返回对象（成功）/ null（表空）/ { error }（读失败）。
 *  直读被锁（EBUSY：客户端独占写事务）或环境无 node:sqlite 时走整库拷贝兜底。 */
async function readSessionJson(dbPath) {
  const direct = await readSessionViaSqlite(dbPath);
  if (direct !== null && !(typeof direct === 'object' && direct.error)) return direct;
  if (direct === null) return null;   // 表里没有行：不需要拷贝再试
  return readSessionViaCopy(dbPath);
}

async function readSessionViaSqlite(dbPath) {
  const mod = await loadSqlite();
  if (!mod?.DatabaseSync) return { error: t('当前运行环境不支持 node:sqlite（需要 Node 22.5+ 或桌面版），无法读取 QuWork 登录库') };
  try {
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT session_json FROM auth_session LIMIT 1').get();
      if (!row?.session_json) return null;
      return JSON.parse(String(row.session_json));
    } finally { db.close(); }
  } catch (e) {
    // EBUSY/锁定（客户端独占写事务）等 → { error } 交给拷贝兜底
    return { error: e?.message || String(e) };
  }
}

/** 拷贝兜底：整库复制到临时文件再读（-wal 伴生文件一并带上，防 WAL 里的最新行读不到） */
async function readSessionViaCopy(dbPath) {
  const tmp = path.join(os.tmpdir(), `cd-quwork-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  try {
    fs.copyFileSync(dbPath, tmp);
    for (const suffix of ['-wal', '-shm']) {
      try { if (exists(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, tmp + suffix); } catch {}
    }
    const r = await readSessionViaSqlite(tmp);
    if (r && typeof r === 'object' && r.error) return { error: r.error, via: 'copy' };
    return r;
  } catch (e) {
    return { error: e?.message || String(e), via: 'copy' };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(tmp + suffix, { force: true }); } catch {}
    }
  }
}

/**
 * 读取本机当前登录 → CD 账号记录（liveToAccount 家族同构）。
 * 未装/未登录/库里没凭据 → 抛可操作报错（调用方 local/scan 收集进 errors）。
 */
export async function quworkLiveAccount() {
  const det = detectQuwork();
  if (!det.dbExists) {
    if (!det.installed) throw new Error(t('未检测到 QuWork 客户端（%LOCALAPPDATA%\\Programs\\QuWork）——请先安装并登录'));
    throw new Error(t('QuWork 已安装但登录库还不存在（{db}）——请启动客户端登录一次', { db: quworkDbFile() }));
  }
  const raw = await readSessionJson(quworkDbFile());
  if (raw && typeof raw === 'object' && raw.error && !raw.accessToken) {
    throw new Error(t('QuWork 登录库读取失败：{err}', { err: raw.error }));
  }
  const accessToken = raw && typeof raw === 'object' ? String(raw.accessToken || '') : '';
  if (!accessToken) throw new Error(t('QuWork 登录库里没有凭据——请在客户端登录后重试本机导入'));
  const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
  const uid = user.id === undefined || user.id === null ? null : String(user.id);
  const expMs = Number(raw.expiresAt) > 0 ? Number(raw.expiresAt) : null;
  const points = user.points_entitlement?.total_points;
  const rawDisplay = String(user.display_name || user.nickname || user.username || '').trim();
  // 真机上 display_name 就是手机号（13194973656）——账号名走掩码，明文只留 meta.phone
  // （publicAccount 已掩码回显），避免整串手机号进面板标题与导出文件
  const display = /^\d{11}$/.test(rawDisplay) ? '' : rawDisplay;
  const phone = String(user.phone || '').trim();
  const masked = uid ? `${uid.slice(0, 3)}****${uid.slice(-2)}` : null;
  const name = display ? `QuWork (${display})`
    : phone ? `QuWork (${phone.slice(0, 3)}****${phone.slice(-4)})`
    : uid ? `QuWork (${masked})` : 'QuWork (本机)';
  return {
    provider: 'quwork',
    token: accessToken,
    refreshToken: null,          // QuWork 无独立 refresh token：expiresAt 后经 /api/user/refresh 用 access 续期
    uid,
    name,
    email: String(user.email || '').trim() || null,
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    source: 'local-app',
    meta: {
      quworkLlmToken: String(raw.llmToken || '') || null,
      quworkAffCode: String(user.aff_code || '') || null,
      quworkWechatBound: user.wechat_bound === true,
      quworkPhone: String(user.phone || '') || null,
      quworkPoints: Number.isFinite(Number(points)) ? Number(points) : null,
      // 设备标识每账号固定一份：/api/user/activate 要求 64-hex device_identifier，
      // 客户端自造设备身份合法（10R 已实测），落库复用避免服务端见「频繁换机」
      quworkDeviceId: quworkDeterministicDeviceId(uid || accessToken),
      quworkAuthFile: quworkDbFile(),
      capturedAt: new Date().toISOString(),
    },
  };
}

/** 稳定设备标识：按 uid（或 token 哈希）派生，重复导入/重装后仍得同一个值 */
function quworkDeterministicDeviceId(seed) {
  return crypto.createHash('sha256').update(JSON.stringify({
    ns: 'quwork.device-identifier', version: 1, platform: 'other', source: 'generated', value: `creditdaddy:${seed}`,
  })).digest('hex');
}

/** 客户端当前登录 uid（status 轮询轻量口径：只取 session.user.id，命名/设备派生都不做） */
export async function quworkCurrentUid() {
  if (!exists(quworkDbFile())) return null;
  try {
    const raw = await readSessionJson(quworkDbFile());
    if (!raw || typeof raw !== 'object' || raw.error) return null;
    const id = raw.user?.id;
    return id === undefined || id === null ? null : String(id);
  } catch { return null; }
}

/**
 * 签到成功后把新 access token / 积分回写本机库？——**不写**。
 * CD 对 QuWork 客户端库严格只读（单会话表整行覆盖风险高），仅在报错文案里用到这个判定。
 */
export function quworkWritable() { return false; }

/** 报错文案用的位置描述 */
export function quworkHintPaths() {
  return t('已检查：{exe}、{db}', { exe: quworkExeFile() || path.join(defaultInstallDir() || '%LOCALAPPDATA%\\Programs', 'QuWork', 'QuWork.exe'), db: quworkDbFile() });
}
