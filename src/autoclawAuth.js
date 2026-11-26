/**
 * AutoClaw 国内版（+86）短信直登 —— CD 独占的「小号」线。
 *
 * ## 为什么这里要自己派生 device_id（这是本模块最要紧的一条）
 *
 * 实测（2026-11-26）：本机 `%APPDATA%\autoclaw\auth.json` 的 `deviceId` 与它内部
 * access / refresh JWT 的 `device_id` claim **逐字节相同**。服务端按 JWT 里的 device_id
 * 对账设备，所以：
 *   - 复用本机那条去登录另一个号 = 用「同一台设备」登录两个账号 → 会挤掉/作废桌面客户端
 *     那条既有会话，用户会莫名被要求重新登录（最坏的一类事故）；
 *   - 因此 CD 登录必须**自派生一个新的 64-hex**，并且**落库复用**（下次登录同一个号必须
 *     还是这一条，否则服务端看到「同一账号频繁换机器」，同 quworkClient 的教训）。
 *
 * 种子取 MachineGuid（与 node-machine-id 同源，catpawLocal 已用同一读法），再与账号绑定的
 * 随机值一起哈希；但**最终以落库值 meta.autoclawDeviceId 为准**，派生只用于「第一次」。
 *
 * ## 与 src/authDevice.js 无关
 *
 * authDevice 是浏览器设备码登录（Qoder / Trae / MiniMax）：`machine_id: randomUUID()`，
 * 会话只存内存，本来就要每次新造。AutoClaw 要的恰恰是**跨进程稳定**，两者语义相反，别合。
 *
 * ## 凭据纪律（rt 单次轮换，见 autoclawClient.js 文件头）
 *
 * 这条线登录出来的账号，rt 只有 CD 一个持有者（本机客户端不知道它、也没登录这个号），
 * 所以 CD 可以自由刷新它——这正是「同步给 10R」在 (a) 口径下能成立的前提。
 * 但一旦同步给 10R，10R 也会刷：那时必须走 access-only + 定时重推（见 tenrouterAccounts.js），
 * rt 仍然只留在 CD。这条纪律在同步侧执行，本模块只管「拿到并保存这一对」。
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { addAccount } from './accounts.js';
import { loadAccounts } from './store.js';
import { logger } from './logger.js';
import { t } from './i18n.js';
import {
  AUTOCLAW_CN_HOST,
  autoclawExpiresAtMs,
  autoclawRegionOfToken,
  bareToken,
  cleanAutoclawCnPhone,
  loginAutoclawCnBySms,
  maskAutoclawPhone,
  sendAutoclawCnSmsCode,
} from './autoclawClient.js';

/** MachineGuid（Windows；读不到回 null，绝不抛） */
function machineGuid() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('REG.exe',
      ['QUERY', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, timeout: 10_000 }).toString();
    return out.split('REG_SZ')[1].replace(/\r+|\n+|\s+/g, '').toLowerCase();
  } catch { return null; }
}

let guidOverride = null;   // 测试钩子：注入固定机器码（null = 真实读取）

/** 测试钩子：注入固定 MachineGuid，传 null 恢复真实读取 */
export function _setMachineGuidForTests(v) { guidOverride = v || null; }

/**
 * 派生一个新的 device_id（64 hex）。同一台机器 + 同一 seed 恒得同一个值，
 * 但**首次生成后必须落库**（见 meta.autoclawDeviceId）——落库值才是权威。
 * @param {string} [seed] 账号唯一种子（uid / 手机号）；缺省用随机值（一次性）
 */
export function autoclawCdDeviceId(seed) {
  const guid = guidOverride || machineGuid() || 'unknown-machine';
  const value = String(seed ?? '').trim() || crypto.randomBytes(16).toString('hex');
  return crypto.createHash('sha256')
    .update(JSON.stringify({ ns: 'autoclaw.cd-device', version: 1, machine: guid, value }))
    .digest('hex');
}

/** 该账号已落库的 device_id（缺失 / 形状不对 → null） */
export function accountDeviceId(account) {
  const d = account?.meta?.autoclawDeviceId;
  return typeof d === 'string' && /^[0-9a-f]{64}$/i.test(d) ? d : null;
}

/**
 * CD 短信线的**默认**设备身份：同一台机器恒得同一个值。
 * 用固定种子（不按账号派生）是刻意的：发码与登录发生在账号行存在之前，
 * 两处必须是同一条，否则上游看到「发码设备 ≠ 登录设备」。
 * 同一个号第二次登录时改用该号落库的那条（见 loginAutoclawSms 的 existing 分支）。
 */
export function autoclawCdSmsDeviceId() {
  return autoclawCdDeviceId('autoclaw-cn-sms');
}

/** 第一步：发短信（不落任何状态） */
export async function sendAutoclawSms(phone, { fetchImpl = null, deviceId = null } = {}) {
  const dev = deviceId || autoclawCdSmsDeviceId();
  const r = await sendAutoclawCnSmsCode(phone, { deviceId: dev, fetchImpl });
  return { ...r, deviceId: dev };
}

/**
 * 第二步：验证码换 token 对 → 建/更新账号行。
 *
 * 关键点：**先按 uid 找到已有账号行，再决定登录请求用哪条 device_id**——
 * 顺序反了（先登录再改 meta）会让 JWT 里是新设备、meta 里记的是旧设备，
 * 之后 refresh 拿 meta 那条打过去必 400001/400002 一类签名参数错，根因极难查。
 *
 * @returns {{account, duplicate:boolean, deviceId:string, region:string, phoneMasked:string|null}}
 */
export async function loginAutoclawSms({ phone, code }, { fetchImpl = null, deviceId = null } = {}) {
  const cleanPhone = cleanAutoclawCnPhone(phone);   // 非法号在打上游之前就拒掉（同 send 的口径）
  // 同号再登录 → 沿用落库那条设备身份（连登录请求本身都用它，保证 JWT 与 meta 一致）
  const existing = (await loadAccounts()).find(
    (a) => a.provider === 'autoclaw-cn' && a.uid && /^\d+$/.test(String(a.uid)) && a.meta?.autoclawLoginPhone === cleanPhone,
  );
  const dev = accountDeviceId(existing) || deviceId || autoclawCdSmsDeviceId();

  const fields = await loginAutoclawCnBySms({ phone, code }, { deviceId: dev, fetchImpl });

  // 归属线以 JWT 为准（短信登录必是国内版，但仍按 claim 判，避免将来上游改口径时静默归错线）
  const region = autoclawRegionOfToken(fields.refreshToken) || autoclawRegionOfToken(fields.accessToken) || 'cn';
  if (region !== 'cn') {
    throw new Error(t('这条线只用于 AutoClaw 国内版（+86）账号，但上游返回了 {region} 的凭据', { region }));
  }
  const provider = 'autoclaw-cn';
  const phoneMasked = maskAutoclawPhone(fields.phone);
  const expMs = autoclawExpiresAtMs(bareToken(fields.accessToken));

  // ⚠ 同 uid 已被「本机收割」占用 → 拒绝，不合并。
  // accounts.addAccount 的查重按 uid 命中会**原位改写**那一行：本机号被换成 CD 登录的
  // 凭据后，source 变成 sms-login → 它就成了「可同步」的号，而桌面客户端其实正登录着
  // 同一个号 —— 三副本互杀被我们自己的判据放行。宁可让用户换个小号，也不悄悄改语义。
  const harvested = (await loadAccounts()).find((a) => a.provider === provider && a.uid && String(a.uid) === String(fields.userId) && !isAutoclawCdOwned(a));
  if (harvested) {
    throw new Error(t('这个号已经由本机 AutoClaw 客户端管理（账号「{name}」）。短信直登只用于 CD 独占的小号——请换一个未在桌面客户端登录过的手机号', { name: harvested.name || harvested.uid }));
  }

  const { account, duplicate } = await addAccount({
    provider,
    token: bareToken(fields.accessToken),
    refreshToken: bareToken(fields.refreshToken),
    uid: fields.userId,
    name: fields.userName || (phoneMasked ? `AutoClaw CN (${phoneMasked})` : `AutoClaw CN (${String(fields.userId).slice(-6)})`),
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    // source 是同步侧的唯一判据（只同步 sms-login 来源的号，见 tenrouterAccounts.js）
    source: 'sms-login',
    meta: {
      autoclawRegion: 'cn',
      autoclawDeviceId: dev,
      autoclawLoginPhone: fields.phone || cleanPhone || null,   // 明文只落本机加密库，面板一律脱敏
      autoclawUserId: fields.userId ? String(fields.userId) : null,
      autoclawCdOwned: true,          // CD 独占刷新权：本机客户端没登录这个号
      phone: phoneMasked,
      accountHost: AUTOCLAW_CN_HOST,
      loggedInAt: new Date().toISOString(),
    },
  }, { trusted: true });

  logger.info('AUTOCLAW', 'CD 短信直登成功:{name}{dup}', { name: account.name || account.uid, dup: duplicate ? '(已有账号，凭据已更新)' : '' });
  return { account, duplicate: Boolean(duplicate), deviceId: dev, region, phoneMasked };
}

/** 账号是否「CD 独占刷新权」（同步/重推的准入判据；对外口径见 autoclawClient.canSyncAutoclawAccount） */
export function isAutoclawCdOwned(account) {
  return account?.source === 'sms-login' || account?.meta?.autoclawCdOwned === true;
}

/** 测试钩子：重置机器码覆盖（与 _setMachineGuidForTests(null) 同效，语义更清楚） */
export function _resetAutoclawAuthForTests() { guidOverride = null; }