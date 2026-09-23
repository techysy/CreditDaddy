/**
 * 本地账号存储 — 数据全部留在本机（参考 WorkDaddy 的数据边界原则）。
 *
 * 目录：$QODERDADDY_HOME（默认 ~/.qoderdaddy）
 *   accounts.json  账号列表（含 token，0600 权限）
 *   state.json     运行状态（签到完成日历等）
 *
 * 写入采用 原子写（临时文件 + rename），避免进程中断损坏数据。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PROVIDERS } from './constants.js';

export function dataDir() {
  return process.env.QODERDADDY_HOME || path.join(os.homedir(), '.qoderdaddy');
}

const ACCOUNTS_FILE = () => path.join(dataDir(), 'accounts.json');
const STATE_FILE = () => path.join(dataDir(), 'state.json');

async function ensureDir() {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
}

/** 原子写：临时文件 + rename，失败不留半截文件 */
export async function atomicWrite(file, content) {
  const tmp = path.join(
    path.dirname(file),
    `.tmp-${path.basename(file)}-${crypto.randomBytes(4).toString('hex')}`
  );
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, file);
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
  await atomicWrite(ACCOUNTS_FILE(), JSON.stringify(accounts, null, 2));
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
  const n = typeof v === 'number' ? v : /^d+$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 校验并构造账号记录（不含重复检查，由调用方负责）。
 * 可选元数据：uid / email / refreshToken / expiresAt / source
 */
export function normalizeAccountInput({ name, provider, token, uid, email, refreshToken, expiresAt, source }) {
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

/** 对外输出的脱敏账号视图 */
export function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    tokenMasked: maskToken(a.token),
    isPat: typeof a.token === 'string' && a.token.startsWith('pt-'),
    uid: a.uid || null,
    email: a.email || null,
    expiresAt: a.expiresAt || null,
    hasRefreshToken: Boolean(a.refreshToken),
    source: a.source || 'manual',
    verified: a.verified ?? null,
    createdAt: a.createdAt,
    lastCheckin: a.lastCheckin,
    lastResult: a.lastResult || null,
  };
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

// 导入 / 导出（含 10router 互通）见 transfer.js
