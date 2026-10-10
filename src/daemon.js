/**
 * CreditDaddy 守护进程 — 本地 HTTP API + Web 面板。
 *
 * 架构参考 WorkDaddy：
 *   - 默认只监听 127.0.0.1，数据不出本机
 *   - 无依赖，Node 18+ 原生 http 模块
 *   - 监听回环地址时校验 Host 头（防 DNS 重绑定），跨站 Origin 一律拒绝（防 CSRF）
 *
 * API:
 *   GET    /api/accounts               账号列表（脱敏）
 *   POST   /api/accounts               添加账号 {name, provider, token}
 *   PATCH  /api/accounts/:id           修改备注名 {name}
 *   DELETE /api/accounts/:id           删除账号
 *   POST   /api/accounts/:id/checkin   手动为单个账号签到
 *   GET    /api/accounts/:id/quota     查询积分（统一结构）
 *   POST   /api/accounts/:id/switch    切换 WorkBuddy / ZCode 客户端当前登录账号 {force?}
 *   GET    /api/accounts/:id/zcode/plans   ZCode 可领取的活动列表
 *   POST   /api/accounts/:id/zcode/claim   ZCode 领取活动 {planId, captchaParam?, region?}
 *   GET    /api/zcode/captcha-config       ZCode 领取验证码配置（sceneId / prefix / region）
 *   POST   /api/checkin                全部签到 {provider?, skipIfCheckedToday?}
 *   POST   /api/auth/device/start      发起浏览器登录 {provider: qoder / qoder-cn / workbuddy / workbuddy-intl / zcode-bigmodel / zcode-zai / minimax}
 *   POST   /api/auth/device/poll       轮询浏览器登录结果 {sessionId}
 *   GET    /api/local/detect           检测本机 Qoder 客户端 / IDE / CLI
 *   POST   /api/local/scan             读取本机已登录账号（解密客户端凭据 + 扫描旧版 IDE）
 *   POST   /api/local/import           导入扫描候选 {candidateId, provider?, name?}
 *   GET    /api/tenrouter              10Router 集成配置（key 脱敏）；PUT 保存 {endpoint, key?, syncEnabled?, sources?}；DELETE 清除
 *   POST   /api/tenrouter/test         测试地址与 key {endpoint?, key?}
 *   GET    /api/tenrouter/quotas       10Router 其他供应商额度总览（?force=1 跳过缓存）
 *   GET    /api/tenrouter/health       10Router 自身健康（/api/health 转发：ok / driver / lastDriverError）
 *   POST   /api/tenrouter/sync         立即同步本机用量到 10Router {dryRun?}
 *   POST   /api/tenrouter/sync-accounts 把本机账号推送到 10Router 连接（OAuth 通道需已配面板密码）
 *   GET    /api/qoder/umid             Qoder 设备身份组件状态（Linux / fnOS）
 *   POST   /api/qoder/umid/install     下载官方 qodercli 并提取设备身份组件
 *   GET    /api/logs                   最近日志
 *   GET    /api/status                 守护进程状态
 *   GET    /api/settings               面板设置（访问密码开关状态，不回显密码）
 *   PUT    /api/settings               设置/修改/关闭面板访问密码 {panelKey? | disable?}
 *   POST   /api/export                 导出账号 {password, provider?}（口令必填，10router 兼容加密文件）
 *   POST   /api/import                 导入账号 {data, password?}（CreditDaddy / 10router 导出文件）
 *   GET    /                           Web 面板
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, getLogs, readArchiveJsonl } from './logger.js';
import {
  loadAccounts, loadState, withAccounts, publicAccount, dataDir, loadSettings, saveSettings, withSettings,
} from './store.js';
import { addAccount, importAccounts, refreshContext } from './accounts.js';
import { productImpl } from './providers.js';
import { readWorkbuddySessions, writeWorkbuddySession, workbuddyAuthDir, currentWorkbuddyUid } from './workbuddyLocal.js';
import { refreshWorkbuddyToken } from './workbuddyClient.js';
import { loadBuildInfo } from './buildInfo.js';
import { liveToAccount as zcodeLiveAccount, switchTo as zcodeSwitchTo, currentZcodeUid, currentZcodeIdentity, detectZcode, ensureVirtualDeviceMid, terminateZcode, zcodeRunning } from './zcodeLocal.js';
import { liveToAccount as mirasimLiveAccount, switchTo as mirasimSwitchTo, currentMirasimUid, detectMirasim, terminateMirasim, mirasimRunning } from './mirasimLocal.js';
import { liveToAccount as catpawLiveAccount, switchTo as catpawSwitchTo, currentCatpawToken, detectCatpaw, terminateCatpaw } from './catpawLocal.js';
import { liveToAccount as traeLiveAccount, detectTrae, switchTo as traeSwitchTo, snapshotLive as traeSnapshotLive } from './traeLocal.js';
import { liveToAccount as minimaxLiveAccount, detectMiniMax, currentMiniMaxUid, currentMiniMaxToken, currentMiniMaxRecordKey } from './minimaxLocal.js';
import * as minimaxGateway from './minimaxGateway.js';
import * as traeGateway from './traeGateway.js';
import { fetchClaimPlans, claimPlan, fetchCaptchaConfig, proxyFirst, setProxyFirst, proxyUrl, setProxyUrl, autoClaimEnabled, autoClaimUntil, setAutoClaimEnabled, claimIntervalMin, setClaimIntervalMin, claimWindowMin, setClaimWindowMin } from './zcodeClient.js';
import { exportAccounts, buildExportPayload, parseImport, TransferError } from './transfer.js';
import { syncAccountsTo10r } from './tenrouterAccounts.js';
import { runCheckinTick, getSchedulerInfo, dayKey, enableZcodeAutoClaimWindow, refreshZcodeScheduler, pollZcodeNow, resyncAutoCheckinScheduler } from './checkin.js';
import { detectQoderApps, readQoderAppAccounts, riskIdentityAvailable, riskIdentitySource, switchTo as qoderSwitchTo, qoderRunning, terminateQoder } from './qoderApp.js';
import { umidInfo, installUmid } from './qoderUmid.js';
import * as tenrouter from './tenrouter.js';
import * as zcodeGateway from './zcodeGateway.js';
import { startDeviceFlow, pollDeviceFlow, LOGIN_KINDS } from './authDevice.js';
import { detectInstalls, scanLocalTokens, putCandidate, peekCandidate } from './localDetect.js';
import { PROVIDER_LABEL, APP_VERSION, PROVIDERS, PROJECT_URL } from './constants.js';
import { getLocale, setLocale, normalizeLocale, loadDict, t as tr } from './i18n.js';

const PRODUCT_IDS = ['qoder', 'workbuddy', 'zcode', 'mirasim', 'catpaw', 'trae', 'minimax'];

/** 面板访问密码：面板「设置」写入的 settings.json.panelKey 优先（可设 / 可关）；
 *  未设置（或被面板关闭）时回退环境变量 CREDITDADDY_PASSWORD（fnOS / 命令行部署注入），
 *  保证安装向导密码在 NAS 部署里始终有效。设置后所有 /api/* 需要 x-qd-key 头；密码不回显。 */
let PANEL_KEY = '';
let PANEL_KEY_HASH = null;      // 'scrypt:<salt_hex>:<hash_hex>' — 面板密码只存这个,不存明文
let PANEL_SESSION = null;    // 进程级会话钥（重启随机）：桌面壳寄主的 loopback 凭证,外部没人知道
let PANEL_KEY_MODE = 'none';    // 'plain' | 'hash' | 'none'

function scryptPanelKey(peer) {
  const salt = crypto.randomBytes(8);
  const h = crypto.scryptSync(String(peer), salt, 32);
  return `scrypt:${salt.toString('hex')}:${h.toString('hex')}`;
}
function scryptMatches(peer, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split(':');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const h = crypto.scryptSync(String(peer), Buffer.from(saltHex, 'hex'), 32);
    return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}

/** 面板密码是否生效（哈希 / 明文 / 环境变量任一路径都算）—— PANEL_KEY 字符串本身在哈希模式下为空。 */
export function panelKeyRequired() { return PANEL_KEY_MODE !== 'none'; }

async function initPanelKey() {
  let s = {};
  try { s = await loadSettings(); } catch {}
  const env = process.env.CREDITDADDY_PASSWORD || process.env.QODERDADDY_PASSWORD || '';
  // 存储面板密码只存 scrypt 哈希——此前的明文 panelKey 见了顺手升级（写为哈希并清除明文）。
  if (typeof s.panelKeyHash === 'string' && s.panelKeyHash.startsWith('scrypt:')) {
    PANEL_KEY_HASH = s.panelKeyHash;
    PANEL_KEY_MODE = 'hash';
    PANEL_KEY = '';
    if (s.panelKey) await saveSettings({ panelKey: '' });
  } else {
    const plain = typeof s.panelKey === 'string' && s.panelKey ? s.panelKey : '';
    if (plain) {
      PANEL_KEY_HASH = scryptPanelKey(plain);
      PANEL_KEY_MODE = 'hash';
      PANEL_KEY = '';
      await saveSettings({ panelKeyHash: PANEL_KEY_HASH, panelKey: '' });
    } else if (env) {
      PANEL_KEY = env;
      PANEL_KEY_HASH = null;
      PANEL_KEY_MODE = 'plain';   // 环境变量来源的密码按现状走（部署侧管理）
    } else {
      PANEL_KEY = '';
      PANEL_KEY_HASH = null;
      PANEL_KEY_MODE = 'none';
    }
  }
  PANEL_SESSION = crypto.randomBytes(16).toString('hex');   // 每次拉起重新随机（桌面上次用过期票不会误通行）
  setLocale(s.locale);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_FILE = path.join(__dirname, 'panel.html');
const DEFAULT_PORT = 47860;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Qoder 当前登录缓存：面板 30s 一轮 status，DPAPI 解密结果没必要每轮重算
let qoderCurCache = { at: 0, data: null };
async function qoderCurrentInfo() {
  if (qoderCurCache.data && Date.now() - qoderCurCache.at < 60_000) return qoderCurCache.data;
  const data = { apps: detectQoderApps(), uids: {}, backfill: [] };
  try {
    const r = await readQoderAppAccounts();
    for (const c of r.accounts) {
      data.uids[c.provider] = c.user.id || null;
      if (c.user.id) data.backfill.push({ provider: c.provider, uid: c.user.id, authJson: c.authJson, file: c.file });
    }
  } catch { /* 解密失败只留检测信息 */ }
  qoderCurCache = { at: Date.now(), data };
  return data;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, '请求体不是合法 JSON'); }
}

/** 常量时间比较，避免通过响应时间逐字符猜出密钥；
 *  mode 'hash' → scrypt 推导比;
 *  mode 'plain' → 仅环境变量来源，按原常量时间比;
 *  mode 'none' → 永远 false（本函数不该进来） */
function keyMatches(given) {
  const head = String(given);
  if (PANEL_SESSION && head === PANEL_SESSION) return true;   // 桌面寄主会话钥（重启随机,外部不可伪造）
  if (PANEL_KEY_MODE === 'hash') return scryptMatches(head, PANEL_KEY_HASH);
  const a = Buffer.from(head);
  const b = Buffer.from(PANEL_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hostnameOf(hostHeader) {
  try { return new URL(`http://${hostHeader}`).hostname; } catch { return ''; }
}

/** 本机自身的地址 / 主机名（60s 缓存）：非回环监听时用于放行合法 Host，挡 DNS 重绑定 */
let localHostCache = { at: 0, set: null };
function localHosts() {
  const now = Date.now();
  if (!localHostCache.set || now - localHostCache.at > 60_000) {
    const s = new Set(LOOPBACK_HOSTS);
    try { s.add(os.hostname().toLowerCase()); } catch {}
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const it of list || []) {
          if (!it?.address) continue;
          const a = it.address.toLowerCase();
          s.add(a);
          if (a.includes(':')) s.add(`[${a}]`);
        }
      }
    } catch {}
    localHostCache = { at: now, set: s };
  }
  return localHostCache.set;
}

/**
 * 浏览器侧防护，返回拒绝原因（null = 放行）：
 *   - Host 头必须是本机地址（挡住 DNS 重绑定读取 token）：
 *     · 回环监听：只允许 127.0.0.1 / localhost / ::1
 *     · 非回环监听（0.0.0.0 / 局域网 IP）：未设访问密钥时，允许本机全部网卡地址与主机名；
 *       设了密钥时密钥本身就是门槛（重绑定攻击者拿不到密钥），不再校验 Host
 *   - 带 Origin 的请求必须与 Host 同源（挡住任意网页跨站 POST 添加/导入账号、触发签到）
 * 非浏览器客户端（curl、CLI、托盘菜单）不带 Origin，不受影响。
 */
export function rejectForeignRequest(headers, bindHost) {
  const host = headers.host || '';
  const hostName = hostnameOf(host).toLowerCase();
  const loopbackBind = LOOPBACK_HOSTS.has(bindHost);
  if (loopbackBind && !LOOPBACK_HOSTS.has(hostName)) {
    return 'Host 不被允许';
  }
  if (!loopbackBind && !panelKeyRequired() && !localHosts().has(hostName)) {
    return 'Host 不被允许';
  }
  const origin = headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch {}
    if (originHost !== host) return '跨站请求被拒绝';
  }
  return null;
}

/**
 * PUT /api/settings 的实际处理（鉴权已在入口完成）：
 *   { panelKey: '新密码' }  设置 / 修改面板访问密码（≥4 位、不含空白）
 *   { disable: true }       关闭面板访问密码（导出账号的加密口令不受影响，始终必填）
 * 口令校验规则与导出加密一致（sealTransfer：至少 4 个字符）。
 */
async function handleSettingsPut(res, body) {
  if (body?.disable === true) {
    // 明文与 scrypt 哈希一起清——漏清 panelKeyHash 的话 initPanelKey 重读又把模式拉回 hash,
    // 「关闭」永不生效,还会误报成「部署环境强制注入」。
    await saveSettings({ panelKey: '', panelKeyHash: '' });
    await initPanelKey();   // 环境变量部署（fnOS）下关闭后仍保留安装向导密码
    logger.warn('DAEMON', panelKeyRequired() ? '面板访问密码已在设置里关闭,但部署环境仍注入密码(保持开启)' : '面板访问密码已关闭(导出账号仍需加密口令)', {});
    return json(res, 200, { ok: true, panelKeyEnabled: panelKeyRequired() });
  }
  const next = typeof body?.panelKey === 'string' ? body.panelKey.trim() : '';
  if (!next) return json(res, 400, { error: '请提供新密码，或提交 disable 关闭' });
  if (next.length < 4) return json(res, 400, { error: '面板访问密码至少 4 位' });
  if (/\s/.test(next)) return json(res, 400, { error: '面板访问密码不能包含空格' });
  // 只存 scrypt 哈希，明文设置完立刻请出数据目录
  await saveSettings({ panelKeyHash: scryptPanelKey(next), panelKey: '' });
  await initPanelKey();
  logger.info('DAEMON', '面板访问密码已更新（scrypt 哈希落盘)', {});
  return json(res, 200, { ok: true, panelKeyEnabled: panelKeyRequired() });
}

// socket 地址级回环判定（不是 hostname）：PANEL_KEY 未设时 fail-closed 的关键输入
function isLoopbackSocketAddr(remote) {
  const r = String(remote || '');
  return !r || /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(r);
}

// PANEL_KEY 按源 IP 失败计数限速：401 暴力猜密是免费的网络噪音――连错 10 次锁 5 分钟。
// timingSafeEqual 防了侧信道，防不了离线字典速度撞库；失败计数只留进程内，重启归零。
const keyFails = new Map();  // socketRemote → { n, lockedUntil }
const KEY_FAIL_LIMIT = 10;
const KEY_FAIL_LOCK_MS = 5 * 60_000;

function remoteKeyAddr(req) { return String((req.socket && req.socket.remoteAddress) || ''); }
function keyThrottled(remote) {
  const rec = keyFails.get(remote);
  if (!rec) return false;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  if (rec.lockedUntil) keyFails.delete(remote);
  return false;
}
function noteKeyMiss(remote) {
  const rec = keyFails.get(remote) || { n: 0 };
  rec.n += 1;
  if (rec.n >= KEY_FAIL_LIMIT) { rec.lockedUntil = Date.now() + KEY_FAIL_LOCK_MS; rec.n = 0;
    logger.warn('DAEMON', '面板密码连续 {n} 次错误,来源 {remote} 已限流 5 分钟', { n: KEY_FAIL_LIMIT, remote }); }
  keyFails.set(remote, rec);
}

async function handleApi(req, res, url) {
  if (!panelKeyRequired()) {
    const remote = (req.socket && req.socket.remoteAddress) || '';
    if (!isLoopbackSocketAddr(remote)) {
      logger.warn('DAEMON', '拒绝非本机请求(未设面板访问密码):{method} {path} 来自 {remote}', { method: req.method, path: url.pathname, remote });
      return json(res, 403, { error: '未设置面板访问密码时，面板账号接口仅允许本机访问——请在「设置 → 通用 → 面板访问密码」设置密码后再从局域网访问' });
    }
  }
  if (panelKeyRequired()) {
    const remote = remoteKeyAddr(req);
    if (keyThrottled(remote)) {
      return json(res, 429, { error: '面板密码连续错误过多，已限流 5 分钟' });
    }
    // 只认 x-qd-key 头：query 传密会落入 fnOS / 反代的访问日志
    const key = req.headers['x-qd-key'] || '';
    if (!keyMatches(key)) {
      noteKeyMiss(remote);
      return json(res, 401, { error: '需要访问密钥（x-qd-key 头）', code: 'PANEL_KEY' });
    }
    keyFails.delete(remote);   // 猜对了立即清零
  }
  const p = url.pathname;
  const method = req.method;

  // 账号列表
  if (p === '/api/accounts' && method === 'GET') {
    const accounts = await loadAccounts();
    return json(res, 200, {
      accounts: accounts.map(publicAccount),
      providers: PROVIDER_LABEL,
      dataDir: dataDir(),
    });
  }

  // 添加账号（自动拉取 userinfo 补全名字）
  if (p === '/api/accounts' && method === 'POST') {
    const body = await readBody(req);
    let result;
    try {
      result = await addAccount({ name: body.name, provider: body.provider, token: body.token });
    } catch (e) { return json(res, 400, { error: e.message }); }
    const { account, duplicate } = result;
    if (duplicate) return json(res, 409, { error: `该账号已存在（${account.name || account.id}）` });
    if (account.verified === false) {
      logger.warn('DAEMON', '账号 {name} 校验失败:{err}', { name: account.name || account.id, err: account.verifyError });
    }
    logger.info('DAEMON', '添加账号 {name}({provider})', { name: account.name || account.id, provider: PROVIDER_LABEL[account.provider] });
    return json(res, 201, { account: publicAccount(account) });
  }

  // 修改备注名
  const idMatch = p.match(/^\/api\/accounts\/([\w-]+)$/);
  if (idMatch && method === 'PATCH') {
    const body = await readBody(req);
    const name = String(body?.name || '').trim().slice(0, 64) || null;
    const found = await withAccounts((accounts) => {
      const a = accounts.find((x) => x.id === idMatch[1]);
      if (a) a.name = name;
      return a || null;
    });
    if (!found) return json(res, 404, { error: '账号不存在' });
    return json(res, 200, { account: publicAccount(found) });
  }

  // 删除账号
  const delMatch = idMatch;
  if (delMatch && method === 'DELETE') {
    const removed = await withAccounts((accounts) => {
      const i = accounts.findIndex((a) => a.id === delMatch[1]);
      return i < 0 ? null : accounts.splice(i, 1)[0];
    });
    if (!removed) return json(res, 404, { error: '账号不存在' });
    logger.info('DAEMON', '删除账号 {name}', { name: removed.name || removed.id });
    return json(res, 200, { ok: true });
  }

  // 单账号签到
  const checkinMatch = p.match(/^\/api\/accounts\/([\w-]+)\/checkin$/);
  if (checkinMatch && method === 'POST') {
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.id === checkinMatch[1]);
    const { results, summary } = account?.provider === 'zcode'
      ? await pollZcodeNow([account.id])
      : await runCheckinTick({ onlyAccountId: checkinMatch[1], skipIfCheckedToday: false });
    return json(res, 200, { results, summary });
  }

  // 全部签到（默认跳过今日已签；传 skipIfCheckedToday:false 强制全部重签）
  if (p === '/api/checkin' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const opts = {
      provider: body?.provider || undefined,
      product: body?.product || undefined,
      skipIfCheckedToday: body?.skipIfCheckedToday !== false,
    };
    const { results, summary } = opts.provider === 'zcode' || opts.product === 'zcode'
      ? await pollZcodeNow()
      : await runCheckinTick(opts);
    return json(res, 200, { results, summary });
  }

  // 积分查询（统一结构：total / used / remaining / parts[]）
  const quotaMatch = p.match(/^\/api\/accounts\/([\w-]+)\/quota$/);
  if (quotaMatch && method === 'GET') {
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.id === quotaMatch[1]);
    if (!account) return json(res, 404, { error: '账号不存在' });
    try {
      const log = (m) => logger.info('QUOTA', '{name}:{msg}', { name: account.name || account.id, msg: m });
      const ctx = { log, ...refreshContext(account, log) };
      return json(res, 200, { quota: await productImpl(account.provider).quota(account, ctx) });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // ZCode 活动领取
  const zcodePlansMatch = p.match(/^\/api\/accounts\/([\w-]+)\/zcode\/plans$/);
  if (zcodePlansMatch && method === 'GET') {
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.id === zcodePlansMatch[1]);
    if (!account) return json(res, 404, { error: '账号不存在' });
    if (account.provider !== 'zcode') return json(res, 400, { error: '只有 ZCode 账号支持活动领取' });
    try {
      return json(res, 200, await fetchClaimPlans(account));
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }
  const zcodeClaimMatch = p.match(/^\/api\/accounts\/([\w-]+)\/zcode\/claim$/);
  if (zcodeClaimMatch && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body?.planId || typeof body.planId !== 'string') return json(res, 400, { error: '缺少 planId' });
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.id === zcodeClaimMatch[1]);
    if (!account) return json(res, 404, { error: '账号不存在' });
    if (account.provider !== 'zcode') return json(res, 400, { error: '只有 ZCode 账号支持活动领取' });
    try {
      const outcome = await claimPlan(account, body.planId.slice(0, 128), {
        captchaParam: typeof body.captchaParam === 'string' ? body.captchaParam : '',
        region: typeof body.region === 'string' ? body.region : '',
      });
      logger.info('DAEMON', 'ZCode {name} 领取成功:{plan}', { name: account.name || account.id, plan: outcome.planName });
      await zcodeGateway.clearQuotaMark(account.id);
      await withAccounts((list) => {
        const cur = list.find((a) => a.id === account.id);
        if (cur) cur.lastResult = { status: 'checked-in', message: `已领取：${outcome.planName}`, amount: 0, at: new Date().toISOString() };
      });
      return json(res, 200, outcome);
    } catch (e) {
      logger.warn('DAEMON', 'ZCode {name} 领取失败:{err}', { name: account.name || account.id, err: e.message });
      return json(res, 502, { error: e.message, code: e.code, nextAt: e.nextAt });
    }
  }
  if (p === '/api/zcode/captcha-config' && method === 'GET') {
    try {
      return json(res, 200, await fetchCaptchaConfig());
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }
  // ZCode 出口偏好：默认「直连优先、代理兜底」，可切「代理优先、直连兜底」；代理地址可面板配置（存 zcode-net.json，0600）
  // 自动领取开启时附带 1 小时时限（autoClaimUntil），到期调度器自动关闭并停止轮询
  if (p === '/api/zcode-gateway' && method === 'GET') {
    return json(res, 200, await zcodeGateway.gatewayStatus());
  }
  if (p === '/api/zcode-gateway' && method === 'PUT') {
    const body = await readBody(req).catch(() => ({}));
    if (body?.enabled !== undefined) await zcodeGateway.setGatewayEnabled(body.enabled === true);
    if (body?.lan !== undefined || body?.allow !== undefined) {
      const patch = {};
      if (body?.lan !== undefined) patch.zcodeGatewayLan = body.lan === true;
      if (body?.allow !== undefined) {
        if (!Array.isArray(body.allow)) return json(res, 400, { error: 'allow 需为字符串数组' });
        const cleaned = [...new Set(body.allow.map((x) => String(x || '').trim()).filter(Boolean))];
        if (cleaned.some((x) => /[^\w.*:-]/.test(x))) return json(res, 400, { error: '白名单条目只能是 IP / 主机名（支持 192.168.31.* 通配）' });
        patch.zcodeGatewayAllow = cleaned;
      }
      await (await import('./store.js')).saveSettings(patch);
      const lanNow = patch.zcodeGatewayLan ?? (await (await import('./store.js')).loadSettings()).zcodeGatewayLan === true;
      const allowText = patch.zcodeGatewayAllow ? patch.zcodeGatewayAllow.join(', ') : '';
      logger.info('DAEMON', 'ZCode 网关局域网:{state}{allow}(绑定改动重启后生效)', { state: lanNow ? '开' : '关(仅本机)', allow: allowText ? ',白名单:{list}' : '', list: allowText || '' });
    }
    return json(res, 200, await zcodeGateway.gatewayStatus());
  }
  if (p === '/api/i18n' && method === 'GET') {
    const locale = getLocale();
    return json(res, 200, { locale, dict: await loadDict(locale) });
  }
  // MiniMax 本地网关控制
  if (p === '/api/minimax-gateway' && method === 'GET') {
    return json(res, 200, await minimaxGateway.gatewayStatus());
  }
  if (p === '/api/minimax-gateway' && method === 'PUT') {
    const body = await readBody(req).catch(() => ({}));
    if (body?.enabled !== undefined) await minimaxGateway.setGatewayEnabled(body.enabled === true);
    if (body?.lan !== undefined || body?.allow !== undefined) {
      const patch = {};
      if (body?.lan !== undefined) patch.minimaxGatewayLan = body.lan === true;
      if (body?.allow !== undefined) {
        if (!Array.isArray(body.allow)) return json(res, 400, { error: 'allow 需为字符串数组' });
        const cleaned = [...new Set(body.allow.map((x) => String(x || '').trim()).filter(Boolean))];
        if (cleaned.some((x) => /[^\w.*:-]/.test(x))) return json(res, 400, { error: '白名单条目只能是 IP / 主机名（支持 192.168.31.* 通配）' });
        patch.minimaxGatewayAllow = cleaned;
      }
      await (await import('./store.js')).saveSettings(patch);
      const lanNow = patch.minimaxGatewayLan ?? (await (await import('./store.js')).loadSettings()).minimaxGatewayLan === true;
      const allowText = patch.minimaxGatewayAllow ? patch.minimaxGatewayAllow.join(', ') : '';
      logger.info('DAEMON', 'MiniMax 网关局域网:{state}{allow}(绑定改动重启后生效)', { state: lanNow ? '开' : '关(仅本机)', allow: allowText ? ',白名单:{list}' : '', list: allowText || '' });
    }
    return json(res, 200, await minimaxGateway.gatewayStatus());
  }
  // Trae 本地网关控制
  if (p === '/api/trae-gateway' && method === 'GET') {
    return json(res, 200, await traeGateway.gatewayStatus());
  }
  if (p === '/api/trae-gateway' && method === 'PUT') {
    const body = await readBody(req).catch(() => ({}));
    if (body?.enabled !== undefined) await traeGateway.setGatewayEnabled(body.enabled === true);
    if (body?.lan !== undefined || body?.allow !== undefined) {
      const patch = {};
      if (body?.lan !== undefined) patch.traeGatewayLan = body.lan === true;
      if (body?.allow !== undefined) {
        if (!Array.isArray(body.allow)) return json(res, 400, { error: 'allow 需为字符串数组' });
        const cleaned = [...new Set(body.allow.map((x) => String(x || '').trim()).filter(Boolean))];
        if (cleaned.some((x) => /[^\w.*:-]/.test(x))) return json(res, 400, { error: '白名单条目只能是 IP / 主机名（支持 192.168.31.* 通配）' });
        patch.traeGatewayAllow = cleaned;
      }
      await (await import('./store.js')).saveSettings(patch);
      const lanNow = patch.traeGatewayLan ?? (await (await import('./store.js')).loadSettings()).traeGatewayLan === true;
      const allowText = patch.traeGatewayAllow ? patch.traeGatewayAllow.join(', ') : '';
      logger.info('DAEMON', 'Trae 网关局域网:{state}{allow}(绑定改动重启后生效)', { state: lanNow ? '开' : '关(仅本机)', allow: allowText ? ',白名单:{list}' : '', list: allowText || '' });
    }
    return json(res, 200, await traeGateway.gatewayStatus());
  }
  if (p === '/api/zcode/net' && method === 'GET') {
    const u = proxyUrl();
    const masked = u ? (() => { try { const x = new URL(u); x.password = x.password ? '*'.repeat(4) : ''; return x.toString(); } catch { return '***'; } })() : null;
    const ac = autoClaimEnabled();
    return json(res, 200, {
      proxyFirst: proxyFirst(), proxyUrlMasked: masked,
      autoClaim: ac, autoClaimUntil: ac ? autoClaimUntil() : null,
      claimIntervalMin: claimIntervalMin(), claimWindowMin: claimWindowMin(),
      hasEnvProxy: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy),
    });
  }
  if (p === '/api/zcode/net' && method === 'PUT') {
    const body = await readBody(req).catch(() => ({}));
    try {
      if (body?.proxyFirst !== undefined) setProxyFirst(body.proxyFirst === true);
      if (body?.proxyUrl !== undefined) setProxyUrl(body.proxyUrl);
      // 自动领取计划（轮询周期 / 运行时长）先落盘，再按新配置启动
      if (body?.claimIntervalMin !== undefined) setClaimIntervalMin(body.claimIntervalMin);
      if (body?.claimWindowMin !== undefined) setClaimWindowMin(body.claimWindowMin);
      if (body?.claimIntervalMin !== undefined || body?.claimWindowMin !== undefined) refreshZcodeScheduler();
      if (body?.autoClaim !== undefined) {
        if (body.autoClaim === true) enableZcodeAutoClaimWindow();       // 开 = 按「自动领取计划」启动（2 分钟后首轮）
        else { setAutoClaimEnabled(false); refreshZcodeScheduler(); }    // 关 = 立即停表
      }
    } catch (e) { return json(res, 400, { error: e.message }); }
    const ac = autoClaimEnabled();
    logger.info('DAEMON', 'ZCode 出口:{route},自动领取:{claim},代理 {proxy}', { route: proxyFirst() ? '代理优先' : '直连优先', claim: ac ? '开(每 {min} 分钟,{window})' : '关', min: claimIntervalMin(), window: claimWindowMin() > 0 ? '运行 {windowMin} 分钟' : '一直运行', windowMin: claimWindowMin(), proxy: proxyUrl() || '(环境变量/未设置)' });
    return json(res, 200, {
      proxyFirst: proxyFirst(), autoClaim: ac, autoClaimUntil: ac ? autoClaimUntil() : null,
      claimIntervalMin: claimIntervalMin(), claimWindowMin: claimWindowMin(),
    });
  }

  // 切换 WorkBuddy / ZCode 客户端当前登录账号
  const switchMatch = p.match(/^\/api\/accounts\/([\w-]+)\/switch$/);
  if (switchMatch && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const accounts = await loadAccounts();
    const target = accounts.find((a) => a.id === switchMatch[1]);
    if (!target) return json(res, 404, { error: '账号不存在' });
    if (target.provider === 'zcode') {
      // 防丢号：先把 ZCode 当前登录（凭据 + config.json + 设备 ID）同步 / 保存进账号库，再覆盖
      const live = zcodeLiveAccount();
      if (live && live.uid !== target.uid) {
        await addAccount(live, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步 ZCode 当前登录失败:{err}', { err: e.message }));
      }
      try {
        // 强制切换：先关掉运行中的 ZCode，否则它会把内存里的旧登录覆盖回文件，切换等于没切
        let closedClient = false;
        if (body?.force === true) {
          const t = terminateZcode();
          closedClient = t.closed === true;
          if (closedClient) logger.info('DAEMON', '已关闭 ZCode 客户端(强制切换)', {});
          else if (t.running) logger.warn('DAEMON', '未能完全结束 ZCode 进程,继续强制切换', {});
        }
        ensureVirtualDeviceMid(target);
        const r = zcodeSwitchTo(target, { force: body?.force === true });
        // 虚拟设备 ID 首次生成时需落盘
        await withAccounts((list) => {
          const cur = list.find((a) => a.id === target.id);
          if (cur) cur.meta = { ...(cur.meta || {}), deviceMid: target.meta.deviceMid };
        });
        logger.info('DAEMON', r.alreadyActive ? 'ZCode 当前已是 {name}' : 'ZCode 已切换到 {name}', { name: target.name || target.id });
        return json(res, 200, { ok: true, closedClient, ...r });
      } catch (e) {
        return json(res, e.zcodeRunning ? 409 : 400, { error: e.message, code: e.zcodeRunning ? 'ZCODE_RUNNING' : undefined });
      }
    }
    if (target.provider === 'mirasim') {
      // 防丢号：先把当前登录同步进账号库
      try {
        const live = await mirasimLiveAccount();
        if (live && live.uid !== target.uid) {
          await addAccount(live, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步 mirasim 当前登录失败:{err}', { err: e.message }));
        }
      } catch (e) {}
      try {
        let closedClient = false;
        if (body?.force === true) {
          const t = terminateMirasim();
          closedClient = t.closed === true;
          if (closedClient) logger.info('DAEMON', '已关闭 Mirasim 客户端(强制切换)', {});
        }
        const r = await mirasimSwitchTo(target, { force: body?.force === true });
        logger.info('DAEMON', r.alreadyActive ? 'mirasim 当前已是 {name}' : 'mirasim 已切换到 {name}', { name: target.name || target.id });
        return json(res, 200, { ok: true, closedClient, ...r });
      } catch (e) {
        return json(res, e.mirasimRunning ? 409 : 400, { error: e.message, code: e.mirasimRunning ? 'MIRASIM_RUNNING' : undefined });
      }
    }
    if (target.provider === 'catpaw') {
      // 防丢号：先把妙手当前登录同步进账号库
      try {
        const live = await catpawLiveAccount();
        if (live && live.token !== target.token) {
          await addAccount(live, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步妙手当前登录失败:{err}', { err: e.message }));
        }
      } catch (e) {}
      try {
        let closedClient = false;
        if (body?.force === true) {
          const t = terminateCatpaw();
          closedClient = t.closed === true;
          if (closedClient) logger.info('DAEMON', '已关闭妙手客户端(强制切换)', {});
          else if (t.running) logger.warn('DAEMON', '未能完全结束妙手进程,继续强制切换', {});
        }
        const r = await catpawSwitchTo(target, { force: body?.force === true });
        logger.info('DAEMON', r.alreadyActive ? '妙手当前已是 {name}' : '妙手已切换到 {name}(重新打开客户端生效)', { name: target.name || target.id });
        return json(res, 200, { ok: true, closedClient, ...r });
      } catch (e) {
        return json(res, e.catpawRunning ? 409 : 400, { error: e.message, code: e.catpawRunning ? 'CATPAW_RUNNING' : undefined });
      }
    }
    if (target.provider === 'qoder' || target.provider === 'qoder-cn') {
      // 防丢号：先把本机当前登录的最新 auth 快照回写账号库（客户端会静默刷新 token，旧快照可能已失效），再覆盖
      try {
        const lr = await readQoderAppAccounts();
        const live = lr.accounts.find((c) => c.provider === target.provider);
        if (live && live.user.id && String(live.user.id) !== String(target.uid)) {
          await addAccount({
            provider: live.provider, token: live.token, name: live.user.name || live.user.email,
            uid: live.user.id, email: live.user.email, refreshToken: live.refreshToken, expiresAt: live.expiresAt,
            source: 'local-app', meta: { qoderAuth: live.authJson, qoderAuthFile: live.file },
          }, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步 Qoder 当前登录失败:{err}', { err: e.message }));
        }
      } catch (e) { logger.warn('DAEMON', '读取 Qoder 当前登录失败:{err}', { err: e.message }); }
      try {
        // 强制切换：先关掉运行中的 Qoder，否则它退出时会把内存里的旧登录覆盖回文件
        let closedClient = false;
        if (body?.force === true) {
          const t = terminateQoder();
          closedClient = t.closed === true;
          if (closedClient) logger.info('DAEMON', '已关闭 Qoder 客户端(强制切换)', {});
          else if (t.running) logger.warn('DAEMON', '未能完全结束 Qoder 进程,继续强制切换', {});
        }
        const r = await qoderSwitchTo(target, { force: body?.force === true });
        logger.info('DAEMON', r.alreadyActive ? 'Qoder 当前已是 {name}' : 'Qoder 已切换到 {name}(重新打开 Qoder 生效)', { name: target.name || target.id });
        return json(res, 200, { ok: true, closedClient, ...r });
      } catch (e) {
        return json(res, e.qoderRunning ? 409 : 400, { error: e.message, code: e.qoderRunning ? 'QODER_RUNNING' : undefined });
      }
    }
    if (target.provider === 'trae') {
      // 防丢号：先把 Trae 当前登录同步进账号库并建快照，再覆盖成目标账号的登录态
      try {
        const live = await traeLiveAccount();
        if (live && live.token !== target.token) {
          await addAccount(live, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步 Trae 当前登录失败:{err}', { err: e.message }));
          traeSnapshotLive();
        }
      } catch (e) {}
      try {
        // 退进程交给 switchTo：它要先确认目标有快照才会动手，避免「白关一次 Trae」
        const r = await traeSwitchTo(target, { force: body?.force === true });
        if (r.closedClient) logger.info('DAEMON', '已关闭 Trae 客户端(强制切换)', {});
        logger.info('DAEMON', r.alreadyActive ? 'Trae 当前已是 {name}' : 'Trae 已切换到 {name}(重新打开客户端生效)', { name: target.name || target.id });
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, e.traeRunning ? 409 : 400, { error: e.message, code: e.traeRunning ? 'TRAE_RUNNING' : undefined });
      }
    }
    // MiniMax 不做切换：客户端凭据只有一条路径派生的活动记录，且 refreshToken 轮换式一次性，
    // CreditDaddy 与客户端共用必然互抢（invalid_grant），切号能力已按用户决定移除。
    if (!target.provider.startsWith('workbuddy')) return json(res, 400, { error: '只有 WorkBuddy / ZCode / mirasim / 妙手 / Trae 账号支持切换' });
    // 先把客户端当前会话的最新 token 收回账号库，避免被覆盖后丢失
    const cur = readWorkbuddySessions().accounts.find((a) => a.current);
    if (cur && cur.uid !== target.uid) {
      const { file: _f, fileTime: _t, current: _c, ...rec } = cur;
      await addAccount(rec, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步 WorkBuddy 当前会话失败:{err}', { err: e.message }));
    }
    try {
      const r = writeWorkbuddySession(target);
      logger.info('DAEMON', 'WorkBuddy 已切换到 {name}', { name: target.name || target.id });
      return json(res, 200, { ok: true, file: r.file, previousUid: r.previousUid });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ── 设备码登录（Qoder） ──
  if (p === '/api/auth/device/start' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      const kind = LOGIN_KINDS.includes(body?.provider) ? body.provider : 'qoder';
      const flow = await startDeviceFlow(kind);
      return json(res, 200, flow);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (p === '/api/auth/device/poll' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body?.sessionId) return json(res, 400, { error: '缺少 sessionId' });
    try {
      return json(res, 200, await pollDeviceFlow(body.sessionId));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ── Qoder 网页会话（桌面版登录窗口关闭前抓取，用于逐资源包用量明细） ──
  // Cookie 先探测归属（响应里的 user_id），只写到同 uid 的 qoder 账号上；探测失败视为会话无效。
  if (p === '/api/auth/qoder-web-session' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const cookie = String(body?.cookie || '').trim();
    const kind = body?.kind === 'qoder-cn' ? 'qoder-cn' : 'qoder';
    // 诊断：登录窗关闭时两个域都会上报；收到 0 条 Cookie 说明窗口内根本没建立该域的网站会话
    const count = body?.diag?.cookieCount;
    logger.info('DAEMON', 'Qoder 网页会话收割({kind}):{result}', { kind, result: typeof count === 'number' ? '{count} 条 Cookie' : '已上报', count });
    if (!cookie || cookie.length > 16384) return json(res, 200, { ok: true, bound: 0, empty: true });
    const { probeWebSession } = await import('./qoderClient.js');
    const probe = await probeWebSession(kind, cookie);
    if (!probe?.user_id) {
      logger.warn('DAEMON', 'Qoder {edition}网页会话探测未通过(接口不认这份 Cookie),已丢弃', { edition: kind === 'qoder-cn' ? '国内版' : '国际版' });
      return json(res, 400, { error: '网页会话无效（探测接口未通过）' });
    }
    const now = new Date().toISOString();
    const bound = await withAccounts((list) => {
      const hits = list.filter((a) => a.provider === kind && a.uid === probe.user_id);
      for (const a of hits) {
        a.meta = { ...(a.meta || {}), qoderWebSession: { cookie, capturedAt: now } };
        a.updatedAt = now;
      }
      return hits.length;
    });
    if (!bound) {
      // 登录窗口可能先于设备码入库关闭：暂存待绑定会话，addAccount 补全 uid 后自动挂上
      await withSettings((settings) => {
        settings.pendingQoderWebSessions = {
          ...(settings.pendingQoderWebSessions || {}),
          [probe.user_id]: { kind, cookie, capturedAt: now },
        };
      });
      logger.info('DAEMON', '收到 Qoder 网页会话(uid {uid}...),暂无匹配账号,已暂存待绑定', { uid: probe.user_id.slice(0, 8) });
    } else {
      logger.info('DAEMON', '已绑定 Qoder 网页会话到 {n} 个账号(逐资源包明细可用)', { n: bound });
    }
    return json(res, 200, { ok: true, bound });
  }

  // ── 本机检测 / 凭据扫描 ──
  if (p === '/api/local/detect' && method === 'GET') {
    return json(res, 200, { apps: detectQoderApps(), workbuddyDir: workbuddyAuthDir(), zcode: detectZcode(), mirasim: detectMirasim(), catpaw: detectCatpaw(), trae: detectTrae(), minimax: detectMiniMax(), legacy: detectInstalls() });
  }
  if (p === '/api/local/scan' && method === 'POST') {
    const existing = await loadAccounts();
    const known = (provider, token, uid) => existing.some((a) => (!provider || a.provider === provider)
      && (a.token === token || (uid && a.uid === uid)));
    const candidates = [];
    const errors = [];
    const addRecord = (record, extra) => {
      candidates.push({
        id: putCandidate({ token: record.token, record }),
        kind: 'app', provider: record.provider,
        name: record.name, email: record.email, uid: record.uid, phone: record.meta?.phone ? record.meta.phone.slice(0, 3) + '****' + record.meta.phone.slice(-4) : null,
        tokenMasked: record.token.slice(0, 5) + '...' + record.token.slice(-4),
        expiresAt: record.expiresAt, hasRefreshToken: Boolean(record.refreshToken),
        imported: known(record.provider, record.token, record.uid),
        ...extra,
      });
    };
    // 1) Qoder 客户端：解密 auth.v1.dat
    const app = await readQoderAppAccounts();
    errors.push(...app.errors);
    for (const c of app.accounts) {
      addRecord({
        provider: c.provider, token: c.token, name: c.user.name || c.user.email, uid: c.user.id, email: c.user.email,
        refreshToken: c.refreshToken, expiresAt: c.expiresAt, source: 'local-app',
        // 存整份解密后的 auth.v1.dat：切换时要原样写回（里面除 token 还有客户端读的其它字段）
        meta: { qoderAuth: c.authJson, qoderAuthFile: c.file },
      }, { source: c.source });
    }
    // 2) WorkBuddy 客户端：当前会话 + 历史会话
    const wb = readWorkbuddySessions();
    errors.push(...wb.errors);
    for (const c of wb.accounts) {
      const { file: _f, fileTime: _t, current, ...record } = c;
      addRecord({ ...record, source: current ? 'workbuddy-current' : 'workbuddy-history' }, { source: c.source, current });
    }
    // 3) ZCode 客户端：解密 ~/.zcode/v2/credentials.json 的当前登录
    try {
      const z = zcodeLiveAccount();
      if (z) addRecord(z, { source: 'ZCode 当前登录', current: true });
    } catch (e) { errors.push({ file: '~/.zcode/v2/credentials.json', error: e.message }); }
    // 4) mirasim 客户端：解密 ~/.mirasim/setting.json 的当前登录
    try {
      const m = await mirasimLiveAccount();
      if (m) addRecord(m, { source: 'mirasim 当前登录', current: true });
    } catch (e) {
      // MISSING_SECRET_KEY / DECRYPT_FAILED 的文案已在 mirasimLocal 里写清检查过的位置
      errors.push({ file: '~/.mirasim/setting.json', error: e.message });
    }
    // 5) 妙手客户端：解密 %APPDATA%\catpaw-moon\catx-credential.json 的当前登录
    try {
      const cp = await catpawLiveAccount();
      if (cp) addRecord(cp, { source: '妙手当前登录', current: true });
    } catch (e) { errors.push({ file: 'catpaw-moon/catx-credential.json', error: e.message }); }
    // 6) Trae 客户端：解密 <userData>\User\globalStorage\storage.json 的 tc 信封当前登录
    try {
      const tr = await traeLiveAccount();
      if (tr) addRecord(tr, { source: 'Trae 当前登录', current: true });
    } catch (e) { errors.push({ file: 'TRAE SOLO CN/User/globalStorage/storage.json', error: e.message }); }
    // 7) MiniMax 客户端：读取 ~/.minimax 凭据当前登录
    try {
      const mm = await minimaxLiveAccount();
      if (mm) addRecord(mm, { source: 'MiniMax 当前登录', current: true });
    } catch (e) { errors.push({ file: '~/.minimax/auth/.../auth.json', error: e.message }); }
    // 8) 旧版 VS Code 系 Qoder IDE / CLI：明文 token 扫描（归属需用户选择）
    const det = detectInstalls();
    const dirs = det.ideDataDirs.filter(d => d.exists).map(d => d.path);
    if (det.cliDir.exists) dirs.push(det.cliDir.path);
    const legacy = await scanLocalTokens(dirs);
    for (const c of legacy.candidates) {
      candidates.push({ ...c, provider: null, source: '旧版 Qoder IDE / CLI 文件', imported: known(null, peekCandidate(c.id)?.token) });
    }
    return json(res, 200, { candidates, errors, scanned: legacy.scanned, scannedDirs: [...dirs, wb.dir] });
  }
  if (p === '/api/local/import' && method === 'POST') {
    const body = await readBody(req);
    const cand = peekCandidate(String(body?.candidateId || ''));
    if (!cand) return json(res, 404, { error: '候选不存在或已过期，请重新扫描' });
    const record = cand.record || {
      provider: body.provider === 'qoder-cn' ? 'qoder-cn' : 'qoder',
      token: cand.token, source: 'local-scan',
    };
    if (record.provider?.startsWith('workbuddy') && record.refreshToken) {
      try {
        const fresh = await refreshWorkbuddyToken(record);
        Object.assign(record, { token: fresh.token, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt });
      } catch (e) {
        if (e.authInvalid) return json(res, 409, { error: e.message });
        return json(res, 502, { error: `WorkBuddy 本机凭据校验失败:${e.message}` });
      }
    }
    const { account, duplicate, updated } = await addAccount(
      { ...record, name: body.name || record.name || null },
      { trusted: Boolean(cand.record) },
    );
    if (duplicate && !updated) return json(res, 409, { error: '该账号已存在，信息已是最新' });
    // Trae 的登录态是 15 项文件快照而非单个凭据文件，导入时就建一次快照，否则该账号不可切换
    if (account.provider === 'trae') traeSnapshotLive();
    logger.info('DAEMON', updated ? '已用本机凭据更新:{name}' : '从本机导入账号:{name}', { name: account.name || account.id });
    return json(res, updated ? 200 : 201, { account: publicAccount(account), updated });
  }

  // ── 10Router 集成（虚拟 key：额度总览 + 用量同步） ──
  if (p === '/api/tenrouter' && method === 'GET') {
    return json(res, 200, await tenrouter.publicConfig());
  }
  if (p === '/api/tenrouter' && method === 'PUT') {
    const body = await readBody(req).catch(() => ({}));
    try {
      await tenrouter.updateConfig({ endpoint: body?.endpoint, key: body?.key, adminPassword: body?.adminPassword, syncEnabled: body?.syncEnabled, sources: body?.sources });
      return json(res, 200, await tenrouter.publicConfig());
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/tenrouter' && method === 'DELETE') {
    await tenrouter.updateConfig({ endpoint: '' });
    return json(res, 200, await tenrouter.publicConfig());
  }
  if (p === '/api/tenrouter/test' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    let override;
    try {
      // 可以在保存前测试面板里填的新地址 / key；key 留空则用已保存的
      if (body?.endpoint) override = { endpoint: tenrouter.normalizeEndpoint(body.endpoint) };
      if (body?.key && String(body.key).trim()) override = { ...(override || {}), key: String(body.key).trim() };
    } catch (e) { return json(res, 400, { ok: false, error: '地址格式不正确：' + e.message }); }
    return json(res, 200, await tenrouter.testConnection(override));
  }
  if (p === '/api/tenrouter/quotas' && method === 'GET') {
    try {
      return json(res, 200, await tenrouter.fetchQuotas({ force: url.searchParams.get('force') === '1' }));
    } catch (e) { return json(res, e.code === 'NOT_CONFIGURED' ? 409 : 502, { error: e.message, code: e.code }); }
  }
  if (p === '/api/tenrouter/health' && method === 'GET') {
    return json(res, 200, await tenrouter.fetchHealth());
  }
  if (p === '/api/tenrouter/sync' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      return json(res, 200, await tenrouter.runUsageSync({ dryRun: body?.dryRun === true }));
    } catch (e) { return json(res, e.code === 'NOT_CONFIGURED' ? 409 : 500, { error: e.message, code: e.code }); }
  }
  if (p === '/api/tenrouter/sync-accounts' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      // 请求里带了面板密码就先落盘（下次同步不必重填），否则用已保存的
      if (typeof body?.adminPassword === 'string' && body.adminPassword) {
        await tenrouter.updateConfig({ adminPassword: body.adminPassword });
      }
      const c = tenrouter.loadConfig();
      return json(res, 200, await syncAccountsTo10r({ endpoint: c.endpoint, key: c.key, adminPassword: c.adminPassword, accounts: await loadAccounts() }));
    } catch (e) { return json(res, e.code === 'NOT_CONFIGURED' ? 409 : 500, { error: e.message, code: e.code }); }
  }

  // Qoder 设备身份组件（Linux / fnOS：从官方 qodercli 提取 UMID，国际版签到用）
  if (p === '/api/qoder/umid' && method === 'GET') {
    return json(res, 200, { ...umidInfo(), riskIdentity: riskIdentityAvailable(), riskSource: riskIdentitySource() });
  }
  if (p === '/api/qoder/umid/install' && method === 'POST') {
    try {
      await installUmid();
      return json(res, 200, { ok: true, ...umidInfo(), riskIdentity: riskIdentityAvailable(), riskSource: riskIdentitySource() });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // 日志（tag 过滤：?tag=MINIMAX-GW / ZCODE-GW 取网关调用日志，与运行日志分开展示）
  if (p === '/api/logs' && method === 'GET') {
    const tag = url.searchParams.get('tag') || null;
    // ?history=1：读当日结构化归档（.jsonl），突破环形缓冲 300 条上限，按当前语言重渲染
    if (url.searchParams.get('history') === '1') {
      let lines = readArchiveJsonl({ limit: 2000 });
      lines = tag ? lines.filter((l) => l.tag === tag) : lines.filter((l) => !(l.tag || '').endsWith('-GW'));
      return json(res, 200, { logs: lines });
    }
    return json(res, 200, { logs: getLogs(200, tag) });
  }

  // 状态
  if (p === '/api/status' && method === 'GET') {
    const accounts = await loadAccounts();
    const state = await loadState();
    // Qoder 当前登录（面板轮询每 30s 打一次，DPAPI 解密结果缓存 1 分钟）
    const qoder = await qoderCurrentInfo();
    // 旧账号没赶上「整份 auth 快照」的导入：本机 Qoder 有登录且账号库里有缺快照的同 uid 账号时，顺手回填（可逆、只在缺失时发生）
    const needBackfill = qoder.backfill.length
      && accounts.some((a) => (a.provider === 'qoder' || a.provider === 'qoder-cn')
        && a.uid && !a.meta?.qoderAuth
        && qoder.backfill.some((b) => b.provider === a.provider && String(b.uid) === String(a.uid)));
    if (needBackfill) {
      await withAccounts((list) => {
        for (const b of qoder.backfill) {
          const cur = list.find((a) => a.provider === b.provider && a.uid && b.uid && String(a.uid) === String(b.uid) && !a.meta?.qoderAuth);
          if (cur) cur.meta = { ...(cur.meta || {}), qoderAuth: b.authJson, qoderAuthFile: b.file };
        }
      }).catch((e) => logger.warn('DAEMON', '回填 Qoder 登录快照失败:{err}', { err: e.message }));
    }
    // 妙手凭据文件只存 token：当前登录按 token 对齐账号库，避免每轮状态都打网关查 uid
    const cpToken = currentCatpawToken();
    const mmToken = currentMiniMaxToken();
    const mmRecKey = currentMiniMaxRecordKey();
    // 1) token match；2) record-key match (token 轮换时仍稳定);3) uid-cache fallback
    let mmLiveUid = null;
    if (mmToken) {
      mmLiveUid = accounts.find((a) => a.provider === 'minimax' && a.token === mmToken)?.uid;
    }
    if (!mmLiveUid && mmRecKey) {
      // record-key 匹配可能命中多个（历史脏数据里本机导入与浏览器登录挂过同一个 key），
      // 此时用 uid 缓存的当前值收敛，避免随机取到「不是客户端当前登录」的那个账号。
      const byRec = accounts.filter((a) => a.provider === 'minimax' && a.meta?.authRecordKey === mmRecKey);
      if (byRec.length === 1) mmLiveUid = byRec[0].uid;
      else if (byRec.length > 1) {
        const mmCachedUid = currentMiniMaxUid();
        mmLiveUid = byRec.find((a) => a.uid === mmCachedUid)?.uid || null;
      }
    }
    if (!mmLiveUid) mmLiveUid = currentMiniMaxUid();
    const traeDet = detectTrae();
    return json(res, 200, {
      ok: true,
      app: 'CreditDaddy',
      version: APP_VERSION,
      build: loadBuildInfo() || undefined,   // #21 构建身份(打包产物才有;无文件不返回该键)
      homepage: PROJECT_URL,
      accountsCount: accounts.length,
      dataDir: dataDir(),
      today: dayKey(),
      todayDone: state?.qoderDailyDone || {},
      todayByProduct: {
        qoder: dayKey(Date.now(), 'qoder'),
        workbuddy: dayKey(Date.now(), 'workbuddy'),
        trae: dayKey(Date.now(), 'trae'),
        minimax: dayKey(Date.now(), 'minimax'),
      },
      scheduler: await getSchedulerInfo(),
      riskIdentity: riskIdentityAvailable(),
      riskSource: riskIdentitySource(),
      umid: umidInfo(),
      platform: process.platform,
      workbuddyCurrentUid: currentWorkbuddyUid(),
      qoderCurrent: qoder.uids,
      qoderClient: { installed: qoder.apps.some((x) => x.installed), signedIn: qoder.apps.some((x) => x.signedIn), running: qoderRunning() },
      zcodeCurrentUid: currentZcodeUid(),
      zcodeCurrentIdentity: currentZcodeIdentity(),
      zcodeClient: (() => { const d = detectZcode(); return { installed: d.exists, signedIn: d.signedIn, running: zcodeRunning() }; })(),
      mirasimCurrentUid: currentMirasimUid(),
      mirasimClient: (() => { const d = detectMirasim(); return { installed: d.clientInstalled, signedIn: d.signedIn, running: d.running }; })(),
      catpawCurrentUid: (cpToken && accounts.find((a) => a.provider === 'catpaw' && a.token === cpToken)?.uid) || null,
      catpawClient: (() => { const d = detectCatpaw(); return { installed: d.clientInstalled, signedIn: d.signedIn, running: d.running }; })(),
      traeCurrentUid: traeDet.uid,
      traeClient: { installed: traeDet.clientInstalled, signedIn: traeDet.signedIn, running: traeDet.running },
      minimaxCurrentUid: mmLiveUid,
      minimaxClient: (() => { const d = detectMiniMax(); return { installed: d.installed, signedIn: d.signedIn, running: d.running }; })(),
      keyRequired: panelKeyRequired(),
    });
  }

  // Panel 设置：GET 读取（只回状态不回显密码），PUT 设置 / 修改 / 关闭访问密码
  if (p === '/api/settings' && method === 'GET') {
    return json(res, 200, { panelKeyEnabled: panelKeyRequired(), locale: getLocale(), workbuddyActivity: (await loadSettings()).workbuddyActivity !== false });
  }
  if (p === '/api/settings' && method === 'PUT') {
    const body = await readBody(req).catch(() => ({}));
    if (body?.locale !== undefined) {
      const locale = normalizeLocale(body.locale);
      setLocale(locale);
      await saveSettings({ locale });
    }
    // 全局自动签到 开关 / 频率（面板「设置 → 通用」）
    if (typeof body?.autoCheckin === 'boolean') await saveSettings({ autoCheckin: body.autoCheckin });
    if (body?.checkinIntervalMin !== undefined) {
      const min = Math.max(15, Math.min(1440, Number(body.checkinIntervalMin) || 120));
      await saveSettings({ checkinIntervalMin: min });
    }
    if (body?.autoCheckin !== undefined || body?.checkinIntervalMin !== undefined) {
      await resyncAutoCheckinScheduler();
      return json(res, 200, { ok: true });
    }
    // WB 国际版活跃请求总开关（面板「设置 → 通用」）
    if (typeof body?.workbuddyActivity === 'boolean') {
      await saveSettings({ workbuddyActivity: body.workbuddyActivity });
      return json(res, 200, { ok: true });
    }
    // 只有携带密码字段才走密码分支：纯语言/其它设置的请求此前会掉进
    // 「请提供新密码」400，面板 api() 抛错导致语言切换点了不刷新（i18n 切换失效根因）
    if (body?.panelKey !== undefined || body?.disable === true) return await handleSettingsPut(res, body);
    if (body?.locale !== undefined) return json(res, 200, { ok: true, panelKeyEnabled: panelKeyRequired(), locale: getLocale() });
    return json(res, 400, { error: '请求未携带任何设置字段' });
  }

  // 导出（加密口令必填——账号含 token，不允许再导出明文文件）
  if (p === '/api/export' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const provider = PROVIDERS.includes(body?.provider) ? body.provider : undefined;
    const product = PRODUCT_IDS.includes(body?.product) ? body.product : undefined;
    const password = typeof body?.password === 'string' ? body.password : '';
    // 日志只记范围与条数——口令、token 一概不落
    const scope = provider ? (PROVIDER_LABEL[provider] || provider) : (product ? `${product}（全部版本）` : '全部账号');
    if (password.length < 4) {
      logger.warn('DAEMON', '导出被拒({scope}):未设置加密口令', { scope });
      return json(res, 400, { error: '导出必须设置加密口令（至少 4 位）', code: 'PASSWORD_REQUIRED' });
    }
    try {
      const accounts = await loadAccounts();
      const blob = exportAccounts(accounts, { password, provider, product });
      // 信封是密文、不带条数，用同参数重算一遍过滤结果记进日志
      logger.info('DAEMON', '导出账号({scope}):{n} 个(密文口令导出)', { scope, n: buildExportPayload(accounts, { provider, product }).accounts.length });
      return json(res, 200, blob);
    } catch (e) {
      if (e instanceof TransferError) {
        logger.warn('DAEMON', '导出失败({scope}):{code}', { scope, code: e.code });
        return json(res, 400, { error: e.message, code: e.code });
      }
      throw e;
    }
  }

  // 导入
  if (p === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    // 新格式 {data, password}；兼容直接 POST 文件内容
    const data = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body ? body.data : body;
    let parsed;
    try {
      parsed = parseImport(data, { password: body?.password });
    } catch (e) {
      if (e instanceof TransferError) {
        logger.warn('DAEMON', '导入失败:{code}({message})', { code: e.code, message: e.message });
        return json(res, 400, { error: e.message, code: e.code });
      }
      throw e;
    }
    const r = await importAccounts(parsed.accounts);
    const skipped = r.skipped + parsed.skipped;
    logger.info('DAEMON', '导入完成({source}):新增 {added},续期 {updated},跳过 {skipped}', { source: parsed.source, added: r.added, updated: r.updated, skipped });
    return json(res, 200, { added: r.added, updated: r.updated, skipped, source: parsed.source });
  }

  // 重启服务（桌面客户端或 CLI）
  if (p === '/api/system/restart' && method === 'POST') {
    json(res, 200, { ok: true, message: '正在重启服务…' });
    setTimeout(async () => {
      try {
        if (restartHandler) {
          await restartHandler();
          return;
        }
        // Node CLI 环境兜底重启：派生自身并退出当前进程
        const { spawn } = await import('node:child_process');
        spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'inherit',
          env: process.env,
        }).unref();
        process.exit(0);
      } catch (err) {
        logger.error('DAEMON', '自动重启失败: {err}', { err: err?.message || err });
      }
    }, 400);
    return;
  }

  return json(res, 404, { error: '未知接口' });
}

let restartHandler = null;
/** 设置外部重启处理器（桌面版 Electron 注入 app.relaunch / app.exit） */
export function setRestartHandler(fn) { restartHandler = typeof fn === 'function' ? fn : null; }

/** 当前生效的面板访问密码（同进程宿主——桌面壳——调用本机 API 时带上 x-qd-key 头） */
export function getPanelKey() { return PANEL_KEY; }
export function getSessionKey() { return PANEL_SESSION; }
export function verifyPanelPassword(input) {
  if (PANEL_KEY_MODE === 'hash') return scryptMatches(String(input), PANEL_KEY_HASH);
  if (PANEL_KEY_MODE === 'plain') return keyMatches(String(input));
  return false;
}

/** 出口代理地址（面板「ZCode 网络出口」里存的，环境变量不算——登录窗显式设置用） */
export function getLoginProxyUrl() { return proxyUrl() || null; }

export async function startDaemon(port = DEFAULT_PORT, host = '127.0.0.1') {
  await initPanelKey();
  // 跨进程单实例守护（P0-3 层）：daemon.json 记录 pid+port，端口探活信带——两个实例
  // 共用同一 dataDir 时 accounts/settings/state.json 的后写会覆盖前写（进程内串行队列
  // 不跨进程）。发现活实例直接拒启，不要悄悄抬到下一个端口共存。
  {
    const { statusRuntime } = await import('./bgdaemon.js');
    const cur = await statusRuntime().catch(() => null);
    if (cur && cur.running) {
      logger.warn('DAEMON', 'CreditDaddy 守护进程已在运行(pid {pid},{host}:{port})—— 拒绝再起实例共用同一数据目录', { pid: cur.pid, host: cur.host, port: cur.port });
      const err = new Error('CreditDaddy 守护进程已在运行（pid ' + cur.pid + '，' + (cur.host || '127.0.0.1') + ':' + cur.port + '），如需重启请先停止旧实例（CLI 可用 creditdaddy stop）');
      err.code = 'ALREADY_RUNNING';
      throw err;
    }
  }
  // 一次性清理：1.3.3 曾短暂支持 minimax-intl（MiniMax 国际版），实测其 API 侧对国内出口
  // 全链路 401（区域识别无法绕过），双版本策略已撤回——存量国际版账号移除，避免签到 /
  // 额度轮询对未知 provider 反复报错。仅在真的命中存量时落盘。
  {
    const list = await loadAccounts();
    const dead = list.filter((a) => a.provider === 'minimax-intl');
    if (dead.length) {
      await withAccounts((l) => { l.splice(0, l.length, ...l.filter((a) => a.provider !== 'minimax-intl')); });
      logger.info('DAEMON', '已移除 {count} 个 MiniMax 国际版账号(该渠道已下线,额度接口对国内网络不可用)', { count: dead.length });
    }
  }
  let panelHtml = '';
  fs.readFile(PANEL_FILE, 'utf8').then((h) => { panelHtml = h; }).catch(() => {});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const denied = rejectForeignRequest(req.headers, host);
      if (denied) {
        logger.warn('DAEMON', '拒绝请求 {method} {path}:{denied}(Host={host} Origin={origin})', { method: req.method, path: url.pathname, denied, host: req.headers.host || '', origin: req.headers.origin || '' });
        return json(res, 403, { error: denied });
      }
      // ZCode 免费额度网关（数据面，先于面板路由；仅本机回路，见 zcodeGateway.js）。
      // 规范路径带品牌段 /gateway/zcode/v1/messages，与 minimax/trae 网关命名一致，也是
      // gatewayStatus() 展示的 endpoint。/gateway/v1/messages 与 /v1/messages 为旧别名，
      // 保留向后兼容：/v1/messages 与 zcode-api 端点同形，10router 的 zcode-free 供应商
      // 只需换 host:port 即可在 CreditDaddy 网关与 zcode-api 之间切换。
      if (
        url.pathname === '/gateway/zcode/v1/messages'
        || url.pathname === '/gateway/v1/messages'
        || url.pathname === '/v1/messages'
      ) {
        return await zcodeGateway.handleGateway(req, res);
      }
      // MiniMax Code 本地 Anthropic 兼容网关
      if (url.pathname === '/gateway/minimax/v1/messages') {
        return await minimaxGateway.handleGateway(req, res);
      }
      // Trae SOLO 本地 Anthropic 兼容网关
      if (url.pathname === '/gateway/trae/v1/messages') {
        return await traeGateway.handleGateway(req, res);
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url);
      }
      // Web 面板（未设密码时同 API 口径 fail-closed）
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!panelKeyRequired()) {
          const remote = (req.socket && req.socket.remoteAddress) || '';
          if (!isLoopbackSocketAddr(remote)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('CreditDaddy：未设置面板访问密码时,面板仅允许本机访问——请在本机面板「设置 → 通用 → 面板访问密码」设置密码后再从局域网访问');
          }
        }
        if (!panelHtml) { try { panelHtml = await fs.readFile(PANEL_FILE, 'utf8'); } catch {} }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(panelHtml || '<h1>CreditDaddy</h1><p>panel.html 缺失</p>');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) logger.error('DAEMON', '请求处理失败:{err}', { err: err?.message || err });
      if (!res.headersSent) json(res, status, { error: err?.message || '内部错误' });
    }
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const bind = (p) => {
      // 失败重试时必须摘掉上一次的 listening 监听，否则成功后会重复触发
      const onError = (err) => {
        server.off('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && attempts < 10) {
          attempts += 1;
          logger.warn('DAEMON', '端口 {port} 被占用,改试 {next}', { port: p, next: p + 1 });
          server.close();
          setTimeout(() => bind(p + 1), 300);
        } else {
          // 兜底失败必须 reject：否则这个 promise 永远挂着，调用方的 startScheduler() 不会跑，
          // 进程既不监听也不退出，只在日志里留一行，看起来像「启动了但没反应」
          const msg = err?.message || String(err);
          logger.error('DAEMON', '监听失败:{msg}', { msg });
          reject(new Error(`无法监听 ${host}:${p}：${msg}`));
        }
      };
      const onListening = () => {
        server.off('error', onError);
        const bound = server.address().port;
        logger.info('DAEMON', 'CreditDaddy 守护进程已启动:http://{host}:{port}', { host, port: bound });
        if ((host === '0.0.0.0' || host === '::') && !panelKeyRequired()) {
          logger.warn('DAEMON', '监听 0.0.0.0 且未设置 CREDITDADDY_PASSWORD —— 局域网内任何人可访问账号 API,建议设置访问密钥', {});
        }
        resolve({ server, port: bound });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    bind(Number(port) || DEFAULT_PORT);
  });
}
