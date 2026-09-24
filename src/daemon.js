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
 *   POST   /api/checkin                全部签到 {provider?, skipIfCheckedToday?}
 *   POST   /api/auth/device/start      发起浏览器登录 {provider: qoder / qoder-cn / workbuddy / workbuddy-intl / zcode-bigmodel / zcode-zai}
 *   POST   /api/auth/device/poll       轮询浏览器登录结果 {sessionId}
 *   GET    /api/local/detect           检测本机 Qoder 客户端 / IDE / CLI
 *   POST   /api/local/scan             读取本机已登录账号（解密客户端凭据 + 扫描旧版 IDE）
 *   POST   /api/local/import           导入扫描候选 {candidateId, provider?, name?}
 *   GET    /api/tenrouter              10Router 集成配置（key 脱敏）；PUT 保存 {endpoint, key?, syncEnabled?, sources?}；DELETE 清除
 *   POST   /api/tenrouter/test         测试地址与 key {endpoint?, key?}
 *   GET    /api/tenrouter/quotas       10Router 其他供应商额度总览（?force=1 跳过缓存）
 *   POST   /api/tenrouter/sync         立即同步本机用量到 10Router {dryRun?}
 *   GET    /api/qoder/umid             Qoder 设备身份组件状态（Linux / fnOS）
 *   POST   /api/qoder/umid/install     下载官方 qodercli 并提取设备身份组件
 *   GET    /api/logs                   最近日志
 *   GET    /api/status                 守护进程状态
 *   POST   /api/export                 导出账号 {password?, provider?}（有口令 → 10router 兼容加密文件）
 *   POST   /api/import                 导入账号 {data, password?}（CreditDaddy / 10router 导出文件）
 *   GET    /                           Web 面板
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, getLogs } from './logger.js';
import {
  loadAccounts, loadState, withAccounts, publicAccount, dataDir,
} from './store.js';
import { addAccount, importAccounts, refreshContext } from './accounts.js';
import { productImpl } from './providers.js';
import { readWorkbuddySessions, writeWorkbuddySession, workbuddyAuthDir, currentWorkbuddyUid } from './workbuddyLocal.js';
import { liveToAccount as zcodeLiveAccount, switchTo as zcodeSwitchTo, currentZcodeUid, detectZcode, ensureVirtualDeviceMid } from './zcodeLocal.js';
import { exportAccounts, parseImport, TransferError } from './transfer.js';
import { runCheckinTick, getSchedulerInfo, dayKey } from './checkin.js';
import { detectQoderApps, readQoderAppAccounts, riskIdentityAvailable, riskIdentitySource } from './qoderApp.js';
import { umidInfo, installUmid } from './qoderUmid.js';
import * as tenrouter from './tenrouter.js';
import { startDeviceFlow, pollDeviceFlow, LOGIN_KINDS } from './authDevice.js';
import { detectInstalls, scanLocalTokens, putCandidate, takeCandidate } from './localDetect.js';
import { PROVIDER_LABEL, APP_VERSION, PROVIDERS } from './constants.js';

const PRODUCT_IDS = ['qoder', 'workbuddy', 'zcode'];

/** 可选访问密钥：设置 CREDITDADDY_PASSWORD 后，所有 /api/* 需要 x-qd-key 头（或 ?key=）。
 *  fnOS/NAS 部署监听 0.0.0.0 时由 cmd/main 自动生成并注入。 */
const PANEL_KEY = process.env.CREDITDADDY_PASSWORD || process.env.QODERDADDY_PASSWORD || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_FILE = path.join(__dirname, 'panel.html');
const DEFAULT_PORT = 47860;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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

/** 常量时间比较，避免通过响应时间逐字符猜出密钥 */
function keyMatches(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(PANEL_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hostnameOf(hostHeader) {
  try { return new URL(`http://${hostHeader}`).hostname; } catch { return ''; }
}

/**
 * 浏览器侧防护，返回拒绝原因（null = 放行）：
 *   - 监听回环地址时，Host 必须是 127.0.0.1 / localhost / ::1（挡住 DNS 重绑定读取 token）
 *   - 带 Origin 的请求必须与 Host 同源（挡住任意网页跨站 POST 添加/导入账号、触发签到）
 * 非浏览器客户端（curl、CLI、托盘菜单）不带 Origin，不受影响。
 */
export function rejectForeignRequest(headers, bindHost) {
  const host = headers.host || '';
  if (LOOPBACK_HOSTS.has(bindHost) && !LOOPBACK_HOSTS.has(hostnameOf(host))) {
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

async function handleApi(req, res, url) {
  if (PANEL_KEY) {
    const key = req.headers['x-qd-key'] || url.searchParams.get('key') || '';
    if (!keyMatches(key)) {
      return json(res, 401, { error: '需要访问密钥（x-qd-key 头或 ?key= 参数）' });
    }
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
      logger.warn('DAEMON', `账号 ${account.name || account.id} 校验失败：${account.verifyError}`);
    }
    logger.info('DAEMON', `添加账号 ${account.name || account.id}（${PROVIDER_LABEL[account.provider]}）`);
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
    logger.info('DAEMON', `删除账号 ${removed.name || removed.id}`);
    return json(res, 200, { ok: true });
  }

  // 单账号签到
  const checkinMatch = p.match(/^\/api\/accounts\/([\w-]+)\/checkin$/);
  if (checkinMatch && method === 'POST') {
    const { results, summary } = await runCheckinTick({ onlyAccountId: checkinMatch[1], skipIfCheckedToday: false });
    return json(res, 200, { results, summary });
  }

  // 全部签到（默认跳过今日已签；传 skipIfCheckedToday:false 强制全部重签）
  if (p === '/api/checkin' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const { results, summary } = await runCheckinTick({
      provider: body?.provider || undefined,
      product: body?.product || undefined,
      skipIfCheckedToday: body?.skipIfCheckedToday !== false,
    });
    return json(res, 200, { results, summary });
  }

  // 积分查询（统一结构：total / used / remaining / parts[]）
  const quotaMatch = p.match(/^\/api\/accounts\/([\w-]+)\/quota$/);
  if (quotaMatch && method === 'GET') {
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.id === quotaMatch[1]);
    if (!account) return json(res, 404, { error: '账号不存在' });
    try {
      const ctx = refreshContext(account, (m) => logger.info('QUOTA', `${account.name || account.id}：${m}`));
      return json(res, 200, { quota: await productImpl(account.provider).quota(account, ctx) });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
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
        await addAccount(live, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步 ZCode 当前登录失败：' + e.message));
      }
      try {
        ensureVirtualDeviceMid(target);
        const r = zcodeSwitchTo(target, { force: body?.force === true });
        // 虚拟设备 ID 首次生成时需落盘
        await withAccounts((list) => {
          const cur = list.find((a) => a.id === target.id);
          if (cur) cur.meta = { ...(cur.meta || {}), deviceMid: target.meta.deviceMid };
        });
        logger.info('DAEMON', r.alreadyActive ? `ZCode 当前已是 ${target.name || target.id}` : `ZCode 已切换到 ${target.name || target.id}`);
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, e.zcodeRunning ? 409 : 400, { error: e.message, code: e.zcodeRunning ? 'ZCODE_RUNNING' : undefined });
      }
    }
    if (!target.provider.startsWith('workbuddy')) return json(res, 400, { error: '只有 WorkBuddy / ZCode 账号支持切换' });
    // 先把客户端当前会话的最新 token 收回账号库，避免被覆盖后丢失
    const cur = readWorkbuddySessions().accounts.find((a) => a.current);
    if (cur && cur.uid !== target.uid) {
      const { file: _f, fileTime: _t, current: _c, ...rec } = cur;
      await addAccount(rec, { trusted: true }).catch((e) => logger.warn('DAEMON', '同步 WorkBuddy 当前会话失败：' + e.message));
    }
    try {
      const r = writeWorkbuddySession(target);
      logger.info('DAEMON', `WorkBuddy 已切换到 ${target.name || target.id}`);
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

  // ── 本机检测 / 凭据扫描 ──
  if (p === '/api/local/detect' && method === 'GET') {
    return json(res, 200, { apps: detectQoderApps(), workbuddyDir: workbuddyAuthDir(), zcode: detectZcode(), legacy: detectInstalls() });
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
    // 4) 旧版 VS Code 系 Qoder IDE / CLI：明文 token 扫描（归属需用户选择）
    const det = detectInstalls();
    const dirs = det.ideDataDirs.filter(d => d.exists).map(d => d.path);
    if (det.cliDir.exists) dirs.push(det.cliDir.path);
    const legacy = await scanLocalTokens(dirs);
    for (const c of legacy.candidates) {
      candidates.push({ ...c, provider: null, source: '旧版 Qoder IDE / CLI 文件', imported: known(null, takeCandidate(c.id)?.token) });
    }
    return json(res, 200, { candidates, errors, scanned: legacy.scanned, scannedDirs: [...dirs, wb.dir] });
  }
  if (p === '/api/local/import' && method === 'POST') {
    const body = await readBody(req);
    const cand = takeCandidate(String(body?.candidateId || ''));
    if (!cand) return json(res, 404, { error: '候选不存在或已过期，请重新扫描' });
    const record = cand.record || {
      provider: body.provider === 'qoder-cn' ? 'qoder-cn' : 'qoder',
      token: cand.token, source: 'local-scan',
    };
    const { account, duplicate, updated } = await addAccount(
      { ...record, name: body.name || record.name || null },
      { trusted: Boolean(cand.record) },
    );
    if (duplicate && !updated) return json(res, 409, { error: '该账号已存在，信息已是最新' });
    logger.info('DAEMON', (updated ? '已用本机凭据更新：' : '从本机导入账号：') + (account.name || account.id));
    return json(res, updated ? 200 : 201, { account: publicAccount(account), updated });
  }

  // ── 10Router 集成（虚拟 key：额度总览 + 用量同步） ──
  if (p === '/api/tenrouter' && method === 'GET') {
    return json(res, 200, await tenrouter.publicConfig());
  }
  if (p === '/api/tenrouter' && method === 'PUT') {
    const body = await readBody(req).catch(() => ({}));
    try {
      await tenrouter.updateConfig({ endpoint: body?.endpoint, key: body?.key, syncEnabled: body?.syncEnabled, sources: body?.sources });
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
  if (p === '/api/tenrouter/sync' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      return json(res, 200, await tenrouter.runUsageSync({ dryRun: body?.dryRun === true }));
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

  // 日志
  if (p === '/api/logs' && method === 'GET') {
    return json(res, 200, { logs: getLogs(200) });
  }

  // 状态
  if (p === '/api/status' && method === 'GET') {
    const accounts = await loadAccounts();
    const state = await loadState();
    return json(res, 200, {
      ok: true,
      app: 'CreditDaddy',
      version: APP_VERSION,
      accountsCount: accounts.length,
      dataDir: dataDir(),
      today: dayKey(),
      todayDone: state?.qoderDailyDone || {},
      scheduler: getSchedulerInfo(),
      riskIdentity: riskIdentityAvailable(),
      riskSource: riskIdentitySource(),
      umid: umidInfo(),
      platform: process.platform,
      workbuddyCurrentUid: currentWorkbuddyUid(),
      zcodeCurrentUid: currentZcodeUid(),
      keyRequired: Boolean(PANEL_KEY),
    });
  }

  // 导出
  if (p === '/api/export' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const provider = PROVIDERS.includes(body?.provider) ? body.provider : undefined;
    const product = PRODUCT_IDS.includes(body?.product) ? body.product : undefined;
    try {
      return json(res, 200, exportAccounts(await loadAccounts(), { password: body?.password || undefined, provider, product }));
    } catch (e) {
      if (e instanceof TransferError) return json(res, 400, { error: e.message, code: e.code });
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
      if (e instanceof TransferError) return json(res, 400, { error: e.message, code: e.code });
      throw e;
    }
    const r = await importAccounts(parsed.accounts);
    const skipped = r.skipped + parsed.skipped;
    logger.info('DAEMON', `导入完成（${parsed.source}）：新增 ${r.added}，续期 ${r.updated}，跳过 ${skipped}`);
    return json(res, 200, { added: r.added, updated: r.updated, skipped, source: parsed.source });
  }

  return json(res, 404, { error: '未知接口' });
}

export function startDaemon(port = DEFAULT_PORT, host = '127.0.0.1') {
  let panelHtml = '';
  fs.readFile(PANEL_FILE, 'utf8').then((h) => { panelHtml = h; }).catch(() => {});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const denied = rejectForeignRequest(req.headers, host);
      if (denied) {
        logger.warn('DAEMON', `拒绝请求 ${req.method} ${url.pathname}：${denied}（Host=${req.headers.host || ''} Origin=${req.headers.origin || ''}）`);
        return json(res, 403, { error: denied });
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url);
      }
      // Web 面板
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!panelHtml) { try { panelHtml = await fs.readFile(PANEL_FILE, 'utf8'); } catch {} }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(panelHtml || '<h1>CreditDaddy</h1><p>panel.html 缺失</p>');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) logger.error('DAEMON', `请求处理失败：${err?.message || err}`);
      if (!res.headersSent) json(res, status, { error: err?.message || '内部错误' });
    }
  });

  return new Promise((resolve) => {
    let attempts = 0;
    const bind = (p) => {
      // 失败重试时必须摘掉上一次的 listening 监听，否则成功后会重复触发
      const onError = (err) => {
        server.off('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && attempts < 10) {
          attempts += 1;
          logger.warn('DAEMON', `端口 ${p} 被占用，改试 ${p + 1}`);
          server.close();
          setTimeout(() => bind(p + 1), 300);
        } else {
          logger.error('DAEMON', `监听失败：${err?.message || err}`);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        const bound = server.address().port;
        logger.info('DAEMON', `CreditDaddy 守护进程已启动：http://${host}:${bound}`);
        if ((host === '0.0.0.0' || host === '::') && !PANEL_KEY) {
          logger.warn('DAEMON', '监听 0.0.0.0 且未设置 CREDITDADDY_PASSWORD —— 局域网内任何人可访问账号 API，建议设置访问密钥');
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
