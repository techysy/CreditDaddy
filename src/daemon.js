/**
 * QoderDaddy 守护进程 — 本地 HTTP API + Web 面板。
 *
 * 架构参考 WorkDaddy：
 *   - 默认只监听 127.0.0.1，数据不出本机
 *   - 无依赖，Node 18+ 原生 http 模块
 *   - 监听回环地址时校验 Host 头（防 DNS 重绑定），跨站 Origin 一律拒绝（防 CSRF）
 *
 * API:
 *   GET    /api/accounts               账号列表（脱敏）
 *   POST   /api/accounts               添加账号 {name, provider, token}
 *   DELETE /api/accounts/:id           删除账号
 *   POST   /api/accounts/:id/checkin   手动为单个账号签到
 *   GET    /api/accounts/:id/quota     查询配额
 *   POST   /api/checkin                全部签到 {provider?, skipIfCheckedToday?}
 *   POST   /api/auth/device/start      发起设备码登录 {provider}
 *   POST   /api/auth/device/poll       轮询设备码登录 {sessionId}
 *   GET    /api/local/detect           检测本机 Qoder 安装
 *   POST   /api/local/scan             扫描本机 token 候选
 *   POST   /api/local/import           导入扫描候选 {candidateId, provider, name?}
 *   GET    /api/logs                   最近日志
 *   GET    /api/status                 守护进程状态
 *   POST   /api/export                 导出账号（明文 JSON，注意保管）
 *   POST   /api/import                 导入账号 {accounts:[{name,provider,token}]}
 *   GET    /                           Web 面板
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, getLogs } from './logger.js';
import {
  loadAccounts, loadState, withAccounts, publicAccount,
  exportPayload, dataDir,
} from './store.js';
import { addAccount, importAccounts } from './accounts.js';
import { runCheckinTick } from './checkin.js';
import { fetchQuotaUsage } from './qoderClient.js';
import { startDeviceFlow, pollDeviceFlow } from './authDevice.js';
import { detectInstalls, scanLocalTokens, takeCandidate } from './localDetect.js';
import { PROVIDER_LABEL, APP_VERSION } from './constants.js';

/** 可选访问密钥：设置 QODERDADDY_PASSWORD 后，所有 /api/* 需要 x-qd-key 头（或 ?key=）。
 *  fnOS/NAS 部署监听 0.0.0.0 时由 cmd/main 自动生成并注入。 */
const PANEL_KEY = process.env.QODERDADDY_PASSWORD || '';

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

  // 删除账号
  const delMatch = p.match(/^\/api\/accounts\/([\w-]+)$/);
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
      skipIfCheckedToday: body?.skipIfCheckedToday !== false,
    });
    return json(res, 200, { results, summary });
  }

  // 配额查询
  const quotaMatch = p.match(/^\/api\/accounts\/([\w-]+)\/quota$/);
  if (quotaMatch && method === 'GET') {
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.id === quotaMatch[1]);
    if (!account) return json(res, 404, { error: '账号不存在' });
    try {
      return json(res, 200, { quota: await fetchQuotaUsage(account) });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // ── 设备码登录 ──
  if (p === '/api/auth/device/start' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try {
      const flow = startDeviceFlow(body.provider === 'qoder-cn' ? 'qoder-cn' : 'qoder');
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

  // ── 本机检测 / token 扫描 ──
  if (p === '/api/local/detect' && method === 'GET') {
    return json(res, 200, detectInstalls());
  }
  if (p === '/api/local/scan' && method === 'POST') {
    const det = detectInstalls();
    const dirs = det.ideDataDirs.filter(d => d.exists).map(d => d.path);
    if (det.cliDir.exists) dirs.push(det.cliDir.path);
    const result = await scanLocalTokens(dirs);
    return json(res, 200, { ...result, scannedDirs: dirs });
  }
  if (p === '/api/local/import' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body?.candidateId || '');
    const token = takeCandidate(id);
    if (!token) return json(res, 404, { error: '候选不存在或已过期，请重新扫描' });
    const provider = body.provider === 'qoder-cn' ? 'qoder-cn' : 'qoder';
    // best-effort 校验 + 拉昵称
    const { account, duplicate } = await addAccount({ provider, token, name: body.name || null });
    if (duplicate) return json(res, 409, { error: '该账号已存在' });
    logger.info('DAEMON', '从本机扫描导入账号：' + (account.name || account.id));
    return json(res, 201, { account: publicAccount(account) });
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
      app: 'QoderDaddy',
      version: APP_VERSION,
      accountsCount: accounts.length,
      dataDir: dataDir(),
      todayDone: state?.qoderDailyDone || {},
    });
  }

  // 导出
  if (p === '/api/export' && method === 'POST') {
    const accounts = await loadAccounts();
    return json(res, 200, exportPayload(accounts));
  }

  // 导入
  if (p === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const list = Array.isArray(body) ? body : body?.accounts;
    if (!Array.isArray(list)) return json(res, 400, { error: '导入格式：{accounts:[{name,provider,token}]}' });
    const { added, skipped } = await importAccounts(list);
    logger.info('DAEMON', `导入完成：新增 ${added}，跳过 ${skipped}`);
    return json(res, 200, { added, skipped });
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
        return res.end(panelHtml || '<h1>QoderDaddy</h1><p>panel.html 缺失</p>');
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
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && attempts < 10) {
          attempts += 1;
          logger.warn('DAEMON', `端口 ${p} 被占用，改试 ${p + 1}`);
          server.close();
          setTimeout(() => bind(p + 1), 300);
        } else {
          logger.error('DAEMON', `监听失败：${err?.message || err}`);
        }
      });
      server.listen(p, host, () => {
        const bound = server.address().port;
        logger.info('DAEMON', `QoderDaddy 守护进程已启动：http://${host}:${bound}`);
        if ((host === '0.0.0.0' || host === '::') && !PANEL_KEY) {
          logger.warn('DAEMON', '监听 0.0.0.0 且未设置 QODERDADDY_PASSWORD —— 局域网内任何人可访问账号 API，建议设置访问密钥');
        }
        resolve({ server, port: bound });
      });
    };
    bind(Number(port) || DEFAULT_PORT);
  });
}
