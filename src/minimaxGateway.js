/**
 * MiniMax Code Gateway - 轻量级反向代理服务
 *
 * 支持两种模式：
 *   1. 本地客户端模式：从桌面客户端自动读取账号
 *   2. Gateway 模式：多 Token 轮换 + HTTP 服务化
 *
 * 端点：
 *   POST /minimax/v1/messages   - API 调用（流式/非流式）
 *   GET  /minimax/v1/userinfo   - 查询用户信息
 *   GET  /minimax/v1/quota      - 查询配额
 *
 * 安全：回环地址直接放行；非回环访问必须携带正确的 API Key（未配置 key 时拒绝外网）
 */

import crypto from 'node:crypto';
import { loadAccounts, loadState, loadSettings, saveSettings } from './store.js';
import { logger } from './logger.js';

const UPSTREAM_BASE = 'https://api.minimax.com';
const MAX_ATTEMPTS = 3; // 失败后切换到下一个 Token

// ── 令牌轮换状态（进程内） ──
let rrIndex = 0;
const quotaCache = new Map(); // accountId → { remaining, at }
const QUOTA_TTL_MS = 10 * 60_000; // 10 分钟缓存
const dead = new Set();     // 401/403 token 失效的账号（进程内拉黑）
const cooling = new Map();  // accountId → 冷却截止(ms)
const COOLING_MS = 2 * 60_000; // 429 短冷却
function markCooling(id, ms = COOLING_MS) { cooling.set(id, Date.now() + ms); }

// ── 工具函数 ──

/** 检查配额是否耗尽 */
function isQuotaExhausted(id) {
  const q = quotaCache.get(id);
  return Boolean(q && Date.now() - q.at < QUOTA_TTL_MS && q.remaining <= 0);
}

/** 解析有效 token：统一为 `Bearer <token>` 形式（与 minimaxClient.js 一致——
 *  MiniMax 官方 API 的 Authorization 约定即 `Bearer <key>`，zcode 网关同惯例） */
export function resolveToken(account) {
  const token = String(account.token || '').trim();
  if (!token) throw new Error('空 token');
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

/** 探测额度（可选） */
async function probeQuota(account) {
  const url = `${UPSTREAM_BASE}/api/v1/user/billing/quota`;
  const token = resolveToken(account);

  try {
    const res = await fetch(url, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`quota HTTP ${res.status}`);

    const data = await res.json();
    const remaining = Number(data.remaining || data.total || data.quota || 0);

    quotaCache.set(account.id, { remaining, at: Date.now() });
    logger.debug('MINIMAX-GW', `${account.name || account.id}: 剩余额度 ${remaining}`);
    return remaining;
  } catch (e) {
    logger.debug('MINIMAX-GW', `${account.name || account.id}: 额度查询失败 ${e.message}`);
    return null;
  }
}

/** 构建可参与轮换的账号列表 */
async function rotationQueue() {
  const all = (await loadAccounts()).filter(a => a.provider === 'minimax');

  // 过滤掉无效的账号
  const now = Date.now();
  const ready = [];
  for (const a of all) {
    if (dead.has(a.id)) continue;                       // 401/403 已拉黑
    if ((cooling.get(a.id) || 0) > now) continue;       // 429 冷却中
    if (isQuotaExhausted(a.id)) continue;

    try {
      resolveToken(a);
      ready.push(a);
    } catch {
      // Token 无效，跳过
    }
  }

  if (!ready.length) return [];

  // 轮转排序
  rrIndex = ((rrIndex % ready.length) + ready.length) % ready.length;
  return [...ready.slice(rrIndex), ...ready.slice(0, rrIndex)];
}

/** 验证请求鉴权：回环地址直接放行；非回环必须携带正确的 API Key（未配置 key 时拒绝外网） */
async function validateRequest(req) {
  const remote = req.socket?.remoteAddress || '';

  // 本机回环免密（空 remote 视为 Unix socket / 本机）
  if (!remote || ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(remote)) {
    return { valid: true };
  }

  const settings = await loadSettings();
  const apiKey = String(settings.minimaxGatewayKey || '');

  if (!apiKey) {
    return { valid: false, reason: '网关未配置 API Key，拒绝外网访问' };
  }

  // Node 入站 header 名全小写
  const givenApiKey = req.headers['x-api-key'] ||
                      req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';

  if (!givenApiKey) {
    return { valid: false, reason: '缺少 API Key' };
  }

  // 恒定时间比较
  const ab = Buffer.from(String(givenApiKey), 'utf8');
  const bb = Buffer.from(apiKey, 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // 仍然执行一次以保持恒定时间轮廓
    return { valid: false, reason: 'API Key 不匹配' };
  }
  if (!crypto.timingSafeEqual(ab, bb)) {
    return { valid: false, reason: 'API Key 不匹配' };
  }

  return { valid: true };
}

// ── 核心处理函数 ──

// hop-by-hop / 需要重写的头：精确匹配（小写），避免子串匹配误杀 x-connection-id 这类业务头
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', // 请求体重新序列化后长度可能变化，交给 fetch 按实际字节计算
  'authorization', 'x-api-key', 'accept-encoding', // 鉴权与压缩策略由网关自己设置
]);

/** 收完整请求体（原生 http.IncomingMessage 没有 .body，必须先收流再转发） */
function readRawBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Gateway 入口处理函数
 * 处理所有 /minimax/v1/* 路径的请求
 */
export async function handleMiniMaxGateway(req, res) {
  // 1. 验证鉴权
  const authResult = await validateRequest(req);
  if (!authResult.valid) {
    return res.writeHead(403).end(JSON.stringify({ error: authResult.reason }));
  }

  // 2. 构建上游请求 URL
  const upstreamUrl = `${UPSTREAM_BASE}${req.url}`;

  // 3. 获取可用账号队列
  const queue = await rotationQueue();

  if (!queue.length) {
    logger.warn('MINIMAX-GW', '没有可用的 MiniMax 账号');
    return res.writeHead(503).end(JSON.stringify({
      error: '没有可用的 MiniMax 账号',
      note: '请先在「添加账号 → 本机导入」中导入账号，或确保 MiniMax Code 客户端已登录'
    }));
  }

  logger.info('MINIMAX-GW', `收到请求：${req.method} ${req.url} (${queue.length} 个可用账号)`);

  // 3.5 收完整请求体（原生 IncomingMessage 没有 .body；流只能消费一次，在轮换前读好）
  let rawBody;
  try { rawBody = await readRawBody(req); } catch (e) {
    res.writeHead(e.status || 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }

  // 4. 尝试所有账号（轮询）
  let lastError = null;

  for (const account of queue) {
    const label = account.name || account.uid || account.id;
    let token;

    try {
      token = resolveToken(account);
    } catch (e) {
      logger.warn('MINIMAX-GW', `${label}: Token 无效，跳过`);
      continue;
    }

    // 构建上游请求头（剔除 hop-by-hop 头，精确匹配避免误杀 x-connection-id 这类业务头）
    const upstreamHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      upstreamHeaders[key] = value;
    }
    upstreamHeaders.Authorization = token;
    // 网关不做压缩透传——undici 会自动解压 gzip，请求压缩上游会让客户端二次解压乱码
    upstreamHeaders['accept-encoding'] = 'identity';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000); // 60s 超时
    let clientGone = false;
    const abortOnClose = () => { clientGone = true; controller.abort(); };
    req.on('close', abortOnClose);

    let resObj;
    try {
      resObj = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        // GET/HEAD 不允许带 body；其余方法转发实际收到的字节（content-length 由 fetch 计算）
        ...(rawBody && req.method !== 'GET' && req.method !== 'HEAD' ? { body: rawBody } : {}),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      req.off('close', abortOnClose);
      if (clientGone) return true; // 客户端先断了，无需再换账号
      lastError = e;
      logger.warn('MINIMAX-GW', `${label} 失败：${e.message}`);
      continue;
    }
    clearTimeout(timeoutId);
    req.off('close', abortOnClose);

    // 非 2xx 按状态分类：401/403 → 拉黑该账号换下一个；429 → 短冷却换下一个；其余透传
    if (!resObj.ok) {
      const text = await resObj.text().catch(() => '');
      lastError = new Error(`HTTP ${resObj.status}: ${text.slice(0, 120)}`);

      if (resObj.status === 401 || resObj.status === 403) {
        dead.add(account.id);
        logger.info('MINIMAX-GW', `${label}: 认证失败 (${resObj.status})，标记 token 失效并换下一个账号`);
        continue;
      }
      if (resObj.status === 429) {
        markCooling(account.id);
        logger.info('MINIMAX-GW', `${label}: 429 限流，冷却 ${Math.round(COOLING_MS / 60_000)} 分钟并换下一个账号`);
        continue;
      }
      // 其他 4xx/5xx：记录并原样透传给客户端
      logger.warn('MINIMAX-GW', `${label} 上游错误 ${resObj.status}：${text.slice(0, 120)}`);
      res.writeHead(resObj.status, { 'Content-Type': resObj.headers.get('content-type') || 'application/json' });
      res.end(text);
      return true;
    }

    logger.info('MINIMAX-GW', `${label} 成功 (${resObj.status})`);

    // 5. 原样转发响应（支持 SSE 和流式）。
    // 注意：undici 已自动解压上游 gzip——body 是明文，绝不能透传 content-encoding
    // （带着会让客户端对明文做二次解压 → 乱码）；content-length 由实际转发内容决定。
    const responseHeaders = {};
    for (const [key, value] of resObj.headers.entries()) {
      const k = key.toLowerCase();
      if (k === 'content-encoding' || k === 'content-length') continue;
      responseHeaders[key] = value;
    }
    if (!responseHeaders['content-type']) responseHeaders['content-type'] = 'application/json';
    responseHeaders['Cache-Control'] = 'no-cache';

    res.writeHead(resObj.status, responseHeaders);

    // 流式转发
    if (resObj.body) {
      const reader = resObj.body.getReader();
      // 客户端断开时取消上游读取，避免悬挂（参照 zcodeGateway）
      const cancelOnClose = () => { reader.cancel().catch(() => {}); };
      req.on('close', cancelOnClose);
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && !res.write(Buffer.from(value))) {
              // 背压处理
              await new Promise(r => res.once('drain', r));
            }
          }
        } catch (e) {
          logger.warn('MINIMAX-GW', `流式传输中断：${e.message}`);
        } finally {
          req.off('close', cancelOnClose);
          res.end();
        }
      };
      pump();
    } else {
      res.end();
    }
    return true;
  }

  // 6. 全部失败返回错误
  logger.error('MINIMAX-GW', `所有账号尝试均失败：${lastError?.message || '未知错误'}`);

  res.writeHead(502).end(JSON.stringify({
    error: 'MiniMax Gateway: 所有账号请求失败',
    attempts: queue.length,
    details: lastError?.message || 'Unknown error',
    suggestion: '请检查账号是否过期或额度是否耗尽'
  }));

  return true;
}

/** 处理特定子路由（如 /userinfo、/quota） */
export async function handleSubRoute(req, res, route) {
  // 1. 验证鉴权
  const authResult = await validateRequest(req);
  if (!authResult.valid) {
    return res.writeHead(403).end(JSON.stringify({ error: authResult.reason }));
  }

  // 2. 获取第一个有效账号
  const accounts = (await loadAccounts()).filter(a => a.provider === 'minimax');
  const firstAccount = accounts.find(a => {
    try { resolveToken(a); return !isQuotaExhausted(a.id); } catch { return false; }
  });

  if (!firstAccount) {
    return res.writeHead(503).end(JSON.stringify({ error: '没有可用的 MiniMax 账号' }));
  }

  try {
    const token = resolveToken(firstAccount);

    // 根据路由类型构造不同的 API 请求
    let upstreamUrl;
    if (route === '/userinfo') {
      upstreamUrl = `${UPSTREAM_BASE}/api/v1/user/profile`;
    } else if (route === '/quota') {
      upstreamUrl = `${UPSTREAM_BASE}/api/v1/user/billing/quota`;
    } else {
      return res.writeHead(404).end(JSON.stringify({ error: 'Unknown route' }));
    }

    const resObj = await fetch(upstreamUrl, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resObj.ok) {
      const text = await resObj.text().catch(() => '');
      throw new Error(`HTTP ${resObj.status}: ${text.slice(0, 120)}`);
    }

    const ct = resObj.headers.get('content-type') || 'application/json';
    const data = await resObj.json();

    res.writeHead(resObj.status, { 'Content-Type': ct });
    res.end(JSON.stringify(data, null, 2));

  } catch (e) {
    logger.error('MINIMAX-SUBROUTE', `${route} 失败：${e.message}`);
    res.writeHead(500).end(JSON.stringify({ error: e.message }));
  }

  return true;
}

// ── 状态接口 ──

/** 查询 Gateway 状态（供面板展示） */
export async function gatewayStatus() {
  const accounts = (await loadAccounts()).filter(a => a.provider === 'minimax');

  const withJwt = [];
  const exhausted = [];
  const invalid = [];

  for (const a of accounts) {
    if (dead.has(a.id)) { invalid.push(a); continue; }
    try {
      resolveToken(a);
      if (isQuotaExhausted(a.id)) {
        exhausted.push(a);
      } else {
        withJwt.push(a);
      }
    } catch {
      invalid.push(a);
    }
  }

  return {
    enabled: withJwt.length > 0,
    endpoints: ['/minimax/v1/messages', '/minimax/v1/userinfo', '/minimax/v1/quota'],
    stats: {
      totalAccounts: accounts.length,
      activeTokens: withJwt.length,
      exhaustedTokens: exhausted.length,
      invalidTokens: invalid.length,
    },
    quotas: withJwt.map(a => ({
      id: a.id,
      name: a.name || a.uid || a.id,
      remaining: quotaCache.get(a.id)?.remaining ?? null,
    })),
  };
}

/** 强制刷新配额缓存 */
export async function refreshQuotaCache() {
  const accounts = (await loadAccounts()).filter(a => a.provider === 'minimax');

  for (const a of accounts) {
    try {
      const remaining = await probeQuota(a);
      if (remaining !== null) {
        logger.info('MINIMAX-GW', `${a.name || a.id}: 刷新配额 ${remaining}`);
      }
    } catch (e) {}
  }
}

// ── 导出 API Key 管理 ──

/** 设置 API Key（合并写入 settings.json 并落盘，重启不丢） */
export async function setApiKey(key) {
  return saveSettings({ minimaxGatewayKey: key?.trim() || '' });
}

/** 清除 API Key */
export async function clearApiKey() {
  return setApiKey(null);
}

// ── 辅助测试函数 ──

/** 测试单个账号的连通性（供诊断使用） */
export async function testAccountConnectivity(accountId) {
  const accounts = (await loadAccounts()).filter(a => a.provider === 'minimax');
  const account = accounts.find(a => a.id === accountId);

  if (!account) {
    return { success: false, error: '账号不存在' };
  }

  try {
    const token = resolveToken(account);
    const res = await fetch(`${UPSTREAM_BASE}/api/v1/user/profile`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, status: res.status, message: text.slice(0, 120) };
    }

    const data = await res.json();
    return {
      success: true,
      uid: data.id || data.user_id,
      name: data.name || data.nickname,
      quota: await probeQuota(account),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
