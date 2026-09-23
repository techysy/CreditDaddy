/**
 * QoderDaddy 守护进程 — 本地 HTTP API + Web 面板。
 *
 * 架构参考 WorkDaddy：
 *   - 只监听 127.0.0.1，数据不出本机
 *   - 无依赖，Node 18+ 原生 http 模块
 *
 * API:
 *   GET  /api/accounts           账号列表（脱敏）
 *   POST /api/accounts           添加账号 {name, provider, token}
 *   DELETE /api/accounts/:id     删除账号
 *   POST /api/accounts/:id/checkin   手动为单个账号签到
 *   POST /api/checkin            手动为全部账号签到
 *   GET  /api/accounts/:id/quota 查询配额
 *   GET  /api/logs               最近日志
 *   GET  /api/status             守护进程状态
 *   POST /api/export             导出账号（明文 JSON，注意保管）
 *   POST /api/import             导入账号 [{name,provider,token}]
 *   GET  /                       Web 面板
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, getLogs } from './logger.js';
import {
  loadAccounts, saveAccounts, loadState,
  normalizeAccountInput, findDuplicate, publicAccount,
  exportPayload, dataDir,
} from './store.js';
import { runCheckinTick } from './checkin.js';
import { fetchUserinfo, fetchQuotaUsage } from './qoderClient.js';
import { startDeviceFlow, pollDeviceFlow } from './authDevice.js';
import { detectInstalls, scanLocalTokens, takeCandidate } from './localDetect.js';
import { PROVIDER_LABEL, APP_VERSION } from './constants.js';

/** 可选访问密钥：设置 QODERDADDY_PASSWORD 后，所有 /api/* 需要 x-qd-key 头（或 ?key=）。
 *  fnOS/NAS 部署监听 0.0.0.0 时由 cmd/main 自动生成并注入。 */
const PANEL_KEY = process.env.QODERDADDY_PASSWORD || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_FILE = path.join(__dirname, 'panel.html');
const DEFAULT_PORT = 47860;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('请求体不是合法 JSON'); }
}

async function handleApi(req, res, url) {
  if (PANEL_KEY) {
    const key = req.headers['x-qd-key'] || url.searchParams.get('key') || '';
    if (key !== PANEL_KEY) {
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

  // 添加账号
  if (p === '/api/accounts' && method === 'POST') {
    const body = await readBody(req);
    const account = normalizeAccountInput(body);
    const accounts = await loadAccounts();
    const dup = findDuplicate(accounts, account.provider, account.token);
    if (dup) return json(res, 409, { error: `该账号已存在（${dup.name || dup.id}）` });

    // 尝试拉取 userinfo 自动补全名字
    try {
      const ui = await fetchUserinfo(account);
      const nick = ui?.nickname || ui?.name || ui?.username || ui?.email || null;
      if (nick && !account.name) account.name = nick;
      account.verified = true;
    } catch (e) {
      account.verified = false;
      account.verifyError = e.message;
      logger.warn('DAEMON', `账号 ${account.name || account.id} 校验失败：${e.message}`);
    }

    accounts.push(account);
    await saveAccounts(accounts);
    logger.info('DAEMON', `添加账号 ${account.name || account.id}（${PROVIDER_LABEL[account.provider]}）`);
    return json(res, 201, { account: publicAccount(account) });
  }

  // 删除账号
  const delMatch = p.match(/^\/api\/accounts\/([\w-]+)$/);
  if (delMatch && method === 'DELETE') {
    const accounts = await loadAccounts();
    const i = accounts.findIndex((a) => a.id === delMatch[1]);
    if (i < 0) return json(res, 404, { error: '账号不存在' });
    const [removed] = accounts.splice(i, 1);
    await saveAccounts(accounts);
    logger.info('DAEMON', `删除账号 ${removed.name || removed.id}`);
    return json(res, 200, { ok: true });
  }

  // 单账号签到
  const checkinMatch = p.match(/^\/api\/accounts\/([\w-]+)\/checkin$/);
  if (checkinMatch && method === 'POST') {
    const { results, summary } = await runCheckinTick({ onlyAccountId: checkinMatch[1], skipIfCheckedToday: false });
    return json(res, 200, { results, summary });
  }

  // 全部签到（手动，不跳过已签）
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
    const account = normalizeAccountInput({ provider, token, name: body.name || null });
    const accounts = await loadAccounts();
    if (findDuplicate(accounts, provider, token)) return json(res, 409, { error: '该账号已存在' });
    // best-effort 校验 + 拉昵称
    try {
      const ui = await fetchUserinfo(account);
      if (!account.name) account.name = ui?.nickname || ui?.name || ui?.username || ui?.email || null;
      account.verified = true;
    } catch (e) { account.verified = false; }
    accounts.push(account);
    await saveAccounts(accounts);
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
    const accounts = await loadAccounts();
    let added = 0, skipped = 0;
    for (const item of list) {
      try {
        const account = normalizeAccountInput(item);
        if (findDuplicate(accounts, account.provider, account.token)) { skipped++; continue; }
        accounts.push(account); added++;
      } catch { skipped++; }
    }
    await saveAccounts(accounts);
    logger.info('DAEMON', `导入完成：新增 ${added}，跳过 ${skipped}`);
    return json(res, 200, { added, skipped });
  }

  return json(res, 404, { error: '未知接口' });
}

export function startDaemon(port = DEFAULT_PORT, host = '127.0.0.1') {
  let panelHtml = '';
  fs.readFile(PANEL_FILE, 'utf8').then((h) => { panelHtml = h; }).catch(() => {});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
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
      logger.error('DAEMON', `请求处理失败：${err?.message || err}`);
      if (!res.headersSent) json(res, 500, { error: err?.message || '内部错误' });
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
