/**
 * 本地账号存储 — 数据全部留在本机（参考 WorkDaddy 的数据边界原则）。
 *
 * 目录：$CREDITDADDY_HOME（兼容旧的 $QODERDADDY_HOME；默认 ~/.creditdaddy）
 *   accounts.json  账号列表（含 token，0600 权限）
 *   state.json     运行状态（签到完成日历等）
 * 项目曾名 QoderDaddy：默认目录不存在而 ~/.qoderdaddy 存在时，首次访问自动复制过来（旧目录保留）。
 *
 * 写入采用 原子写（临时文件 + rename），避免进程中断损坏数据。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PROVIDERS, productOf } from './constants.js';

let migrated = false;

/** 从旧版 ~/.qoderdaddy 复制数据到新目录（只在新目录尚不存在时执行一次） */
function migrateLegacyDir(target) {
  migrated = true;
  const legacy = path.join(os.homedir(), '.qoderdaddy');
  try {
    if (fsSync.existsSync(target) || !fsSync.existsSync(legacy)) return;
    fsSync.cpSync(legacy, target, { recursive: true, errorOnExist: false });
    fsSync.writeFileSync(path.join(target, 'MIGRATED_FROM_QODERDADDY'), new Date().toISOString());
  } catch {}
}

export function dataDir() {
  const explicit = process.env.CREDITDADDY_HOME || process.env.QODERDADDY_HOME;
  if (explicit) return explicit;
  const target = path.join(os.homedir(), '.creditdaddy');
  if (!migrated) migrateLegacyDir(target);
  return target;
}

const ACCOUNTS_FILE = () => path.join(dataDir(), 'accounts.json');
const STATE_FILE = () => path.join(dataDir(), 'state.json');
const SETTINGS_FILE = () => path.join(dataDir(), 'settings.json');

async function ensureDir() {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
}

// Windows 上 rename 覆盖已有文件时，外部程序（杀软扫描、同步盘、另一守护进程）瞬时占用
// 会直接抛 EPERM/EBUSY/EACCES：先按递增间隔重试，仍失败则兜底直写目标（牺牲原子性换可用性）。
const RENAME_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let renameImpl = null;
export function _setRenameForTests(fn) { renameImpl = fn || null; }

/** 原子写：临时文件 + rename（带故障重试与直写兜底） */
export async function atomicWrite(file, content, { retries = 6 } = {}) {
  const tmp = path.join(
    path.dirname(file),
    `.tmp-${path.basename(file)}-${crypto.randomBytes(4).toString('hex')}`
  );
  await fs.writeFile(tmp, content, { mode: 0o600 });
  const doRename = renameImpl || ((a, b) => fs.rename(a, b));
  let transientRetries = 0;
  try {
    for (let i = 0; i <= retries; i++) {
      try { await doRename(tmp, file); return; } catch (e) {
        if (!RENAME_TRANSIENT.has(e?.code)) throw e;   // 非占用类错误立即走兜底（如 EXDEV）
        transientRetries++;
        if (i < retries) await sleep(120 * (i + 1));
      }
    }
  } catch { /* 落入兜底 */ }
  // 兜底：读回临时文件直接覆盖写目标，并清理临时文件（避免 .tmp-* 残留）
  try {
    const data = await fs.readFile(tmp, 'utf8');
    await fs.writeFile(file, data, { mode: 0o600 });
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`读取 ${file} 失败: ${e.message}`);
  }
}

// ─── 账号 ───

export async function loadAccounts() {
  const list = await readJson(ACCOUNTS_FILE(), []);
  return Array.isArray(list) ? list : [];
}

export async function saveAccounts(accounts) {
  await ensureDir();
  const file = ACCOUNTS_FILE();
  const bak = file + '.bak';
  try {
    // 只有当已有账号文件存在且非空时才建立/更新 .bak 备份
    const existing = await fs.readFile(file, 'utf8').catch(() => null);
    if (existing && existing.trim().length > 2) {
      await atomicWrite(bak, existing);
    }
  } catch {}
  await atomicWrite(file, JSON.stringify(accounts, null, 2));
}

// 进程内串行队列：所有「读-改-写」都经由 withAccounts，避免并发请求互相覆盖
let accountsQueue = Promise.resolve();

/**
 * 串行地读取 → 修改 → 保存账号列表。fn 可直接修改传入的数组（或返回新数组），
 * 返回 fn 的结果。fn 内不要做网络请求，以免长时间占住队列。
 */
export function withAccounts(fn) {
  const run = accountsQueue.then(async () => {
    const accounts = await loadAccounts();
    const result = await fn(accounts);
    await saveAccounts(accounts);
    return result;
  });
  accountsQueue = run.catch(() => {});
  return run;
}

export function newId() {
  return crypto.randomUUID();
}

const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 过期时间统一成 ISO 字符串（接受 ISO / 秒 / 毫秒） */
export function normalizeExpiry(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 校验并构造账号记录（不含重复检查，由调用方负责）。
 * 可选元数据：uid / email / refreshToken / expiresAt / source / meta（产品相关的非通用字段，如 WorkBuddy 会话信息）
 */
export function normalizeAccountInput({ name, provider, token, uid, email, refreshToken, expiresAt, source, meta }) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`provider 必须是 ${PROVIDERS.join(' 或 ')}`);
  }
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new Error('token 不能为空');
  return {
    id: newId(),
    name: String(name || '').trim() || null,
    provider,
    token: trimmed,
    uid: optStr(uid),
    email: optStr(email),
    refreshToken: optStr(refreshToken),
    expiresAt: normalizeExpiry(expiresAt),
    source: optStr(source) || 'manual',
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
    createdAt: new Date().toISOString(),
    lastCheckin: null,
    lastResult: null,
  };
}

/** 相同 provider 下 token 相同、或 uid 相同（同一用户换了新 token）视为同一账号 */
export function findDuplicate(accounts, provider, token, uid = null) {
  const t = String(token || '').trim();
  return accounts.find((a) => a.provider === provider && (a.token === t || (uid && a.uid && a.uid === uid)));
}

export function maskToken(token) {
  if (typeof token !== 'string' || token.length < 12) return '***';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

const maskPhone = (p) => (typeof p === 'string' && p.length >= 7 ? p.slice(0, 3) + '****' + p.slice(-4) : null);

function zcodeFlavor(meta) {
  if (!meta) return null;
  const c = meta.credentials || {};
  const keys = Object.keys(c);
  const hasZai = Boolean(c['oauth:zai:access_token'] || meta.loginProvider === 'zai' || keys.some((k) => k.includes('zai')));
  const hasBig = Boolean(c['oauth:bigmodel:access_token'] || meta.loginProvider === 'bigmodel' || keys.some((k) => k.includes('bigmodel')));
  return hasZai && hasBig ? 'both' : hasZai ? 'zai' : hasBig ? 'bigmodel' : null;
}

/** 对外输出的脱敏账号视图 */
export function publicAccount(a) {
  const meta = a.meta || {};
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    product: productOf(a.provider),
    tokenMasked: maskToken(a.token),
    isPat: typeof a.token === 'string' && a.token.startsWith('pt-'),
    uid: a.uid || null,
    email: a.email || null,
    expiresAt: a.expiresAt || null,
    hasRefreshToken: Boolean(a.refreshToken),
    source: a.source || 'manual',
    phone: maskPhone(meta.phone),
    domain: meta.domain || null,
    flavor: a.provider === 'zcode' ? zcodeFlavor(meta) : null,
    canSwitch: Boolean(meta.session?.account || meta.credentials || meta.qoderAuth || a.provider === 'catpaw' || a.provider === 'trae'),
    verified: a.verified ?? null,
    createdAt: a.createdAt,
    lastCheckin: a.lastCheckin,
    lastResult: a.lastResult || null,
  };
}

// ─── 面板设置（访问密码等；密码只存数据目录 settings.json，永不通过接口回显） ───

export async function loadSettings() {
  const s = await readJson(SETTINGS_FILE(), {});
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

// 与 accountsQueue 同样的串行队列：saveSettings 内部是「读 → 合并 → 写」三步，
// 不串行的话两个并发写（面板改密码 + 网关切局域网）会各自基于旧快照落盘，互相覆盖。
let settingsQueue = Promise.resolve();

/** 合并写入设置并返回合并后的完整对象（原子写，串行执行） */
export function saveSettings(patch) {
  const run = settingsQueue.then(async () => {
    await ensureDir();
    const next = Object.assign(await loadSettings(), patch);
    await atomicWrite(SETTINGS_FILE(), JSON.stringify(next, null, 2));
    return next;
  });
  settingsQueue = run.catch(() => {});
  return run;
}

/**
 * 串行地读取 → 修改 settings.json。fn 直接改传入对象即可，返回 fn 的结果。
 * 只用于「读出来算一算再写回去」的调用方（单次 saveSettings 已经是原子的）。
 * 锁顺序：先 accountsQueue 再 settingsQueue，禁止反向嵌套，否则会死锁。
 */
export function withSettings(fn) {
  const run = settingsQueue.then(async () => {
    await ensureDir();
    const settings = await loadSettings();
    const result = await fn(settings);
    await atomicWrite(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
    return result;
  });
  settingsQueue = run.catch(() => {});
  return run;
}

// ─── 运行状态（签到日历） ───

export async function loadState() {
  const s = await readJson(STATE_FILE(), {});
  return s && typeof s === 'object' ? s : {};
}

export async function saveState(state) {
  await ensureDir();
  await atomicWrite(STATE_FILE(), JSON.stringify(state, null, 2));
}

// state.json 有多个互不相干的写入方（签到轮写 qoderDailyDone / deviceClaim，
// 网关写 zcodeGatewayExhausted），各自「读 → 改几个键 → 写回」会丢更新：
// 签到轮拿旧快照落盘，就把网关刚写的耗尽打标抹掉了。与 settings 共用一个队列。
let stateQueue = Promise.resolve();

/** 串行地读取 → 修改 → 保存运行状态；fn 直接改传入对象即可，返回 fn 的结果。 */
export function withState(fn) {
  const run = stateQueue.then(async () => {
    await ensureDir();
    const state = await loadState();
    const result = await fn(state);
    await atomicWrite(STATE_FILE(), JSON.stringify(state, null, 2));
    return result;
  });
  stateQueue = run.catch(() => {});
  return run;
}

// 导入 / 导出（含 10router 互通）见 transfer.js
