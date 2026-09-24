/**
 * 本机 ZCode 客户端凭据 — 读取已登录账号、切换当前账号。移植自 zcode-switch（MIT）src-tauri/src/store.rs。
 *
 * ZCode（智谱 GLM / Z.ai 桌面客户端）把当前登录态存在：
 *   ~/.zcode/v2/credentials.json      当前登录凭据（值多为 enc:v1: 加密，见 zcrypto.js）
 *   ~/.zcode/v2/config.json           当前 provider/模型配置（部分账号在此处存明文 API Key）
 *   ~/.zcode/v2/telemetry-state.json  { deviceMid, lastDailyActiveDate }
 * 只有一份"当前登录"，没有像 WorkBuddy 那样的历史会话文件，所以 CreditDaddy 侧的多账号来自
 * 每次 capture（拉取当前登录存一份）积累，而不是一次性读到全部账号。
 *
 * 切换账号（cold switch）：
 *   - ZCode 正在运行时默认拒绝（避免运行中的客户端把内存里的旧登录覆盖回文件，即"assets 时间差"问题）
 *   - 写回前由调用方（daemon switch 路由）先把当前 live 登录同步 / 保存进账号库，绝不丢号
 *   - 每个 CreditDaddy 账号维护一个 virtual device_mid（随机 UUID，落盘进账号记录），切换时写回
 *     telemetry-state.json，让不同账号在 ZCode 风控眼里是不同设备，避免账号间互相牵连
 * 不做 zcode-switch 的“热切换”（客户端运行中不重启直接换登录）：那需要跟客户端内存状态打配合，
 * 风险较高，这里只做“先确认客户端已退出”的冷切换，更符合“数据只读改，绝不直接动运行中的进程”的边界。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import * as zc from './zcrypto.js';

function home() {
  return process.env.ZCODE_HOME || os.homedir();
}

export function zcodePaths() {
  const h = home();
  const v2 = path.join(h, '.zcode', 'v2');
  return {
    home: h,
    credentials: path.join(v2, 'credentials.json'),
    config: path.join(v2, 'config.json'),
    telemetry: path.join(v2, 'telemetry-state.json'),
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function detectZcode() {
  const p = zcodePaths();
  const creds = readJson(p.credentials);
  return {
    dataDir: path.dirname(p.credentials),
    exists: fs.existsSync(p.credentials),
    signedIn: Boolean(creds && zc.isLoggedIn(creds)),
  };
}

/** 当前登录凭据 → 账号记录（供 addAccount），不做网络请求。返回 null 表示未登录或读取失败。 */
export function liveToAccount(secretOpts) {
  const p = zcodePaths();
  const creds = readJson(p.credentials);
  if (!creds || !zc.isLoggedIn(creds)) return null;
  const secret = zc.defaultSecret(p.home, secretOpts);
  const id = zc.identityWithSecret(creds, secret);
  return {
    provider: 'zcode',
    // ZCode 没有单一 access_token 字段可直接当 Bearer 用（quota 会在多个候选 token 里试），
    // 这里存整份 creds 快照（仍是各字段各自的 enc:v1 密文），token 字段留一个可读标记供列表展示。
    token: `zcode-creds:${id.userId || crypto.randomUUID()}`,
    uid: id.userId,
    name: zc.identityLabel(id),
    email: id.email,
    source: 'local-app',
    meta: {
      credentials: creds,
      config: readJson(p.config),
      canonicalHash: zc.canonicalHash(creds),
      // 沿用本机当前的设备 ID：切回这个账号时还原成它原本的设备身份
      deviceMid: readJson(p.telemetry)?.deviceMid || null,
      capturedAt: new Date().toISOString(),
    },
  };
}

/** ZCode 客户端当前登录账号的完整身份（未登录返回 null） */
export function currentZcodeIdentity() {
  const p = zcodePaths();
  const creds = readJson(p.credentials);
  if (!creds || !zc.isLoggedIn(creds)) return null;
  const id = zc.identityWithSecret(creds, zc.defaultSecret(p.home));
  return { uid: id.userId ?? null, email: id.email || null, username: id.username || null };
}

/** ZCode 客户端当前登录账号的 uid（未登录返回 null） */
export function currentZcodeUid() {
  const id = currentZcodeIdentity();
  return id?.uid != null ? String(id.uid) : null;
}

/** 账号库里是否已有同一登录（先比规范化哈希，哈希对不上再比身份） */
export function findSameLogin(liveCreds, secret, existingAccounts) {
  const hash = zc.canonicalHash(liveCreds);
  const byHash = existingAccounts.find((a) => a.meta?.canonicalHash === hash);
  if (byHash) return byHash;
  const liveId = zc.identityWithSecret(liveCreds, secret);
  if (!liveId.userId && !liveId.username && !liveId.email) return null;
  return existingAccounts.find((a) => {
    const cid = a.meta?.credentials && zc.identityWithSecret(a.meta.credentials, secret);
    if (!cid) return false;
    return Boolean(
      (liveId.userId && cid.userId && liveId.userId === cid.userId)
      || (liveId.email && cid.email && liveId.email === cid.email)
      || (liveId.username && cid.username && liveId.username === cid.username),
    );
  });
}

const WIN_TASKLIST = () => {
  try {
    return execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', { windowsHide: true, encoding: 'utf8' });
  } catch { return ''; }
};

/** ZCode 客户端是否在运行（仅 Windows 有实现；其他平台保守返回 false，即“允许切换”） */
export function zcodeRunning() {
  if (process.platform !== 'win32') return false;
  return /zcode\.exe/i.test(WIN_TASKLIST());
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 结束 ZCode 客户端进程（先优雅关闭，超时后强制 kill）。
 * 只在用户明确选择「强制切换」时调用：运行中的客户端会把内存里的旧登录覆盖回
 * credentials.json，只写文件不关进程等于没切换。
 * 注意：不要在测试里调用——它会真的结束本机 ZCode。
 */
export function terminateZcode({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { closed: false, supported: false };
  if (!zcodeRunning()) return { closed: false, running: false };
  try { execSync('taskkill /IM ZCode.exe /T', { windowsHide: true, stdio: 'ignore' }); } catch {}
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && zcodeRunning()) nap(250);
  if (zcodeRunning()) {
    try { execSync('taskkill /IM ZCode.exe /T /F', { windowsHide: true, stdio: 'ignore' }); } catch {}
    deadline = Date.now() + 3000;
    while (Date.now() < deadline && zcodeRunning()) nap(250);
  }
  return { closed: !zcodeRunning(), running: zcodeRunning() };
}

/**
 * 切换到某个 CreditDaddy 账号对应的 ZCode 登录（冷切换）。
 * @param {object} account 目标账号（需带 meta.credentials，来自本机导入）
 * 调用方须在此之前把当前 live 登录保存进账号库（防丢号，见 daemon 的 switch 路由）。
 * @param {{force?: boolean}} opts  force：ZCode 正在运行时也强制写（不建议：客户端退出前可能把内存里的旧登录覆盖回文件）
 * @returns {{switched: boolean, alreadyActive: boolean}}
 */
export function switchTo(account, { force = false } = {}) {
  if (!account?.meta?.credentials) {
    throw new Error('该账号没有保存 ZCode 凭据快照，无法切换（请重新从本机导入）');
  }
  const p = zcodePaths();
  const secret = zc.defaultSecret(p.home);
  const live = readJson(p.credentials);
  const liveHash = live ? zc.canonicalHash(live) : null;
  const targetHash = account.meta.canonicalHash || zc.canonicalHash(account.meta.credentials);

  let alreadyActive = liveHash === targetHash;
  if (!alreadyActive && live && zc.isLoggedIn(live)) {
    const liveId = zc.identityWithSecret(live, secret);
    const targetId = zc.identityWithSecret(account.meta.credentials, secret);
    const hasSignal = (id) => Boolean(id.userId || id.username || id.email);
    if (hasSignal(liveId) && hasSignal(targetId)) {
      alreadyActive = Boolean(
        (liveId.userId && targetId.userId && liveId.userId === targetId.userId)
        || (liveId.email && targetId.email && liveId.email === targetId.email),
      );
    }
  }
  if (alreadyActive) {
    writeVirtualDeviceMid(account);
    return { switched: false, alreadyActive: true };
  }

  if (!force && zcodeRunning()) {
    const err = new Error('ZCode 客户端正在运行，请先退出后再切换（或强制切换，但客户端可能把内存里的旧登录覆盖回文件）');
    err.zcodeRunning = true;
    throw err;
  }

  atomicWriteJson(p.credentials, account.meta.credentials);
  if (account.meta.config) atomicWriteJson(p.config, account.meta.config);
  writeVirtualDeviceMid(account);
  return { switched: true, alreadyActive: false };
}

/** 每个账号的虚拟设备 ID（随机生成一次，落在 account.meta.deviceMid），切换时写回 telemetry-state.json */
export function ensureVirtualDeviceMid(account) {
  if (account.meta?.deviceMid) return account.meta.deviceMid;
  const mid = crypto.randomUUID();
  account.meta = { ...(account.meta || {}), deviceMid: mid };
  return mid;
}

function writeVirtualDeviceMid(account) {
  const mid = ensureVirtualDeviceMid(account);
  const p = zcodePaths();
  const tele = readJson(p.telemetry) || {};
  if (tele.deviceMid === mid) return;
  atomicWriteJson(p.telemetry, { ...tele, deviceMid: mid });
}
