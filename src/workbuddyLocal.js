/**
 * 本机 WorkBuddy 客户端凭据 — 读取已登录账号、切换当前账号。
 *
 * WorkBuddy（与 CodeBuddy CLI / 插件共用）把会话存成明文 JSON：
 *   Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<认证ID>.info
 *   macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/
 *   Linux:   ~/.local/share/CodeBuddyExtension/Data/Public/auth/
 * 当前会话是 workbuddy-desktop.info（国际版客户端可能用其他认证 ID），带时间戳的同名文件是客户端留下的历史会话。
 * 文件结构：{ account: { uid, nickname, phoneNumber, enterpriseId… }, auth: { accessToken, refreshToken, expiresAt, domain… }, accounts: [...] }
 *
 * 切换账号：原子写入会话文件 + 删除同目录的 "<文件>.logged-out" 登出标记；
 * WorkBuddy 监听该文件，外部改动会被直接应用（客户端日志 "External change applied to session"）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectToken } from './workbuddyClient.js';

export function workbuddyAuthDir() {
  const home = os.homedir();
  const tail = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), ...tail);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', ...tail);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), ...tail);
}

const CURRENT_RE = /^[a-z0-9-]+\.info$/i;           // workbuddy-desktop.info
const HISTORY_RE = /^[a-z0-9-]+\.\d{4}-.*\.info$/i;  // workbuddy-desktop.<时间戳>.<pid>.<uuid>.info

/** 会话 JSON → 账号记录（供 addAccount），不含网络请求 */
export function sessionToAccount(session, source) {
  const token = session?.auth?.accessToken;
  if (typeof token !== 'string' || !token) return null;
  const info = inspectToken(token);
  if (!info.provider) return null;
  const acc = session.account || {};
  const auth = session.auth || {};
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  // 除 token 外的会话字段原样保留，切换账号时用来还原会话文件
  const { accessToken: _a, refreshToken: _r, ...authRest } = auth;
  return {
    provider: info.provider,
    token,
    refreshToken: auth.refreshToken || null,
    expiresAt: iso(auth.expiresAt) || info.expiresAt,
    uid: acc.uid || info.uid,
    name: acc.nickname || acc.name || null,
    email: acc.email || null,
    source,
    meta: {
      domain: auth.domain || info.host,
      enterpriseId: acc.enterpriseId || null,
      phone: acc.phoneNumber || null,
      refreshExpiresAt: iso(auth.refreshExpiresAt),
      session: {
        account: acc, auth: authRest, accounts: Array.isArray(session.accounts) ? session.accounts : [],
        ...(Array.isArray(session.allAccounts) ? { allAccounts: session.allAccounts } : {}),
      },
    },
  };
}

/**
 * 读取本机 WorkBuddy 会话：当前会话 + 历史会话（按 uid 去重，保留最新）。
 * @returns {{ dir, accounts: Array<{...账号记录, current: boolean, file, fileTime}>, errors }}
 */
export function readWorkbuddySessions() {
  const dir = workbuddyAuthDir();
  const out = { dir, accounts: [], errors: [] };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const byUid = new Map();
  for (const name of names) {
    if (!CURRENT_RE.test(name) && !HISTORY_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const current = !HISTORY_RE.test(name);
      if (current && fs.existsSync(`${file}.logged-out`)) continue;   // 已登出
      const rec = sessionToAccount(JSON.parse(fs.readFileSync(file, 'utf8')), current ? 'WorkBuddy 当前登录' : 'WorkBuddy 历史会话');
      if (!rec) continue;
      const fileTime = fs.statSync(file).mtimeMs;
      const item = { ...rec, current, file, fileTime };
      const prev = byUid.get(rec.uid);
      if (!prev || (current && !prev.current) || (current === prev.current && fileTime > prev.fileTime)) byUid.set(rec.uid, item);
    } catch (e) {
      out.errors.push({ file, error: e.message });
    }
  }
  out.accounts = [...byUid.values()].sort((a, b) => b.current - a.current || b.fileTime - a.fileTime);
  return out;
}

/** 当前 WorkBuddy 客户端登录的 uid（未登录返回 null） */
export function currentWorkbuddyUid() {
  return readWorkbuddySessions().accounts.find((a) => a.current)?.uid || null;
}

/**
 * 把账号写成 WorkBuddy 当前会话（切换账号）。需要账号带有导入时保存的会话信息。
 * @returns {{ file, previousUid }}
 */
export function writeWorkbuddySession(account) {
  const s = account.meta?.session;
  if (!s?.account) throw new Error('该账号缺少 WorkBuddy 会话信息，请从本机重新导入后再切换');
  const dir = workbuddyAuthDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'workbuddy-desktop.info');
  let previousUid = null;
  try { previousUid = JSON.parse(fs.readFileSync(file, 'utf8'))?.account?.uid || null; } catch {}

  const ms = (iso) => (iso ? new Date(iso).getTime() : undefined);
  const session = {
    account: s.account,
    auth: {
      ...s.auth,
      accessToken: account.token,
      refreshToken: account.refreshToken || s.auth?.refreshToken,
      expiresAt: ms(account.expiresAt) ?? s.auth?.expiresAt,
      lastRefreshTime: Date.now(),
    },
    accounts: s.accounts || [],
    ...(Array.isArray(s.allAccounts) ? { allAccounts: s.allAccounts } : {}),
  };
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.unlinkSync(`${file}.logged-out`); } catch {}
  return { file, previousUid };
}
