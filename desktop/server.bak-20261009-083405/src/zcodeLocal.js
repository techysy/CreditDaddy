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

/**
 * ZCode 支持把数据目录整体挪盘，真实位置写在 ~/.zcode/v2/setting.json 的 dataBaseDir 里
 * （口径对齐 pjpv/zcode-switch 的 resolve_data_root）。例如实测到 dataBaseDir = "D:\ZCodeData"，
 * 凭据于是在 D:\ZCodeData\.zcode\v2\credentials.json；而 ~/.zcode/v2/credentials.json
 * 是挪盘前留下的陈旧副本，读它会一直看到旧账号、切换被误判成 alreadyActive。
 *
 * 只挪数据目录、不挪 home：凭据加密密钥仍由 os.homedir() 派生（见 zcrypto.defaultSecret），
 * setting.json 也仍在 home 下（它就是引导信息本身）。
 */
function dataRoot(h) {
  const s = readJson(path.join(h, '.zcode', 'v2', 'setting.json'));
  const d = typeof s?.dataBaseDir === 'string' ? s.dataBaseDir.trim() : '';
  return d && path.isAbsolute(d) ? d : h;
}

export function zcodePaths() {
  const h = home();
  const v2 = path.join(dataRoot(h), '.zcode', 'v2');
  return {
    home: h,
    credentials: path.join(v2, 'credentials.json'),
    config: path.join(v2, 'config.json'),
    setting: path.join(h, '.zcode', 'v2', 'setting.json'),
    providerConfig: path.join(v2, 'provider_config.json'),
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
      setting: readJson(p.setting),
      providerConfig: readJson(p.providerConfig),
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
  ensureCodingPlanIdentity(account, p);

  // 深度对齐 config.json：保证目标账号对应渠道（zai / bigmodel）处于启用状态，避免出现套餐「未登录」
  const creds = account.meta.credentials || {};
  const isZai = Boolean(creds['oauth:zai:access_token'] || account.meta.loginProvider === 'zai' || Object.keys(creds).some((k) => k.includes('zai')));
  const isBig = Boolean(creds['oauth:bigmodel:access_token'] || account.meta.loginProvider === 'bigmodel' || Object.keys(creds).some((k) => k.includes('bigmodel')));

  const cfg = account.meta.config || readJson(p.config) || { provider: {} };
  cfg.provider = cfg.provider || {};
  if (isZai) {
    if (cfg.provider['builtin:zai']) cfg.provider['builtin:zai'].enabled = true;
    if (cfg.provider['builtin:zai-start-plan']) cfg.provider['builtin:zai-start-plan'].enabled = true;
    if (cfg.provider['builtin:bigmodel']) cfg.provider['builtin:bigmodel'].enabled = false;
  } else if (isBig) {
    if (cfg.provider['builtin:bigmodel']) cfg.provider['builtin:bigmodel'].enabled = true;
    if (cfg.provider['builtin:bigmodel-coding-plan']) cfg.provider['builtin:bigmodel-coding-plan'].enabled = true;
    if (cfg.provider['builtin:zai']) cfg.provider['builtin:zai'].enabled = false;
    if (cfg.provider['builtin:zai-start-plan']) cfg.provider['builtin:zai-start-plan'].enabled = false;
  }
  atomicWriteJson(p.config, cfg);

  // 深度对齐 setting.json：即使账号未保存过 setting 快照，也自动修复选择器 key
  const set = account.meta.setting || readJson(p.setting) || {};
  set.modelProviderFamilyModes = set.modelProviderFamilyModes || {};
  set.modelProviderFamilySelectedKeys = set.modelProviderFamilySelectedKeys || {};
  // providerFamilyDomain 是客户端模型页的「家族显示开关」：
  // 设为 zai 时整个 BigModel 家族被隐藏（反之亦然），切号必须与 active_provider 同步对齐，
  // 否则客户端界面上目标渠道一栏直接消失 / 显示未登录（zcode-switch 同样写这个字段）。
  if (isZai) {
    set.modelProviderFamilyModes.zai = 'oauth';
    set.modelProviderFamilySelectedKeys.zai = 'coding-plan:builtin:zai-start-plan';
    set.providerFamilyDomain = 'zai';
  } else if (isBig) {
    set.modelProviderFamilyModes.bigmodel = 'oauth';
    set.modelProviderFamilySelectedKeys.bigmodel = 'coding-plan:builtin:bigmodel-coding-plan';
    set.providerFamilyDomain = 'bigmodel';
  }
  if (set.providerFamilyDomain) set.providerFamilyDomainUpdatedAt = Date.now();
  atomicWriteJson(p.setting, set);

  // 深度对齐 provider_config.json：默认模型选择指向目标账号的 Coding Plan，否则客户端模型页会判定「未登录」
  if (account.meta.providerConfig) atomicWriteJson(p.providerConfig, account.meta.providerConfig);
  alignDefaultModelSelection(account, isZai ? 'zai' : isBig ? 'bigmodel' : null);

  writeVirtualDeviceMid(account);
  return { switched: true, alreadyActive: false };
}

/** ZCode 客户端判定套餐已登录的必要键：account-provider:<providerId>:identity（值为该账号身份 ID）。
 *  缺失时客户端 nPn/oPn 读不到 accountIdentity，直接跳过该套餐 → 界面显示「未登录」。 */
export function ensureCodingPlanIdentity(account, paths = zcodePaths()) {
  const creds = account?.meta?.credentials;
  if (!creds) return;
  const secret = zc.defaultSecret(paths.home);
  let changed = false;

  const putIdentity = (providerId, identity) => {
    if (!identity) return;
    const key = `account-provider:${providerId}:identity`;
    if (creds[key]) return; // 已有则不覆盖
    creds[key] = zc.encryptWithSecret(String(identity), secret);
    changed = true;
  };

  // BigModel：身份 ID 取自 oauth:bigmodel:user_info.id
  const bigInfo = zc.decryptJsonOpt(creds['oauth:bigmodel:user_info'], secret);
  const bigUid = bigInfo?.id ?? bigInfo?.user_id ?? null;
  if (bigUid) {
    putIdentity('account:bigmodel-individual-coding-plan', bigUid);
    putIdentity('account:bigmodel-team-coding-plan', bigUid);
  }

  // Z.ai：身份 ID 取自 oauth:zai:user_info.user_id
  const zaiInfo = zc.decryptJsonOpt(creds['oauth:zai:user_info'], secret);
  const zaiUid = zaiInfo?.user_id ?? zaiInfo?.id ?? null;
  if (zaiUid) {
    putIdentity('account:zai-individual-coding-plan', zaiUid);
    putIdentity('account:zai-team-coding-plan', zaiUid);
    putIdentity('account:zai-start-plan', zaiUid);
  }

  if (changed) atomicWriteJson(paths.credentials, creds);
}

/** 把 provider_config.json 的 defaultModelSelection 指向目标账号对应的 Coding Plan */
export function alignDefaultModelSelection(account, family) {
  if (!family) return;
  const p = zcodePaths();
  const file = p.providerConfig;
  if (!fs.existsSync(file)) return;
  const cfg = readJson(file);
  if (!cfg || typeof cfg !== 'object') return;
  cfg.config = cfg.config || {};

  const providerId = family === 'zai'
    ? 'account:zai-individual-coding-plan'
    : 'account:bigmodel-individual-coding-plan';
  const modelId = family === 'zai' ? 'glm-5.3-flash' : 'glm-5.3';
  cfg.config.defaultModelSelection = { providerId, modelId };
  atomicWriteJson(file, cfg);
  return providerId;
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
