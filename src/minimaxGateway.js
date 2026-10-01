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
 * 安全：仅允许本地访问（可配置 API Key 鉴权）
 */

import { loadAccounts, loadState, loadSettings } from './store.js';
import { logger } from './logger.js';

const UPSTREAM_BASE = 'https://api.minimax.com';
const MAX_ATTEMPTS = 3; // 失败后切换到下一个 Token

// ── 令牌轮换状态（进程内） ──
let rrIndex = 0;
const quotaCache = new Map(); // accountId → { remaining, at }
const QUOTA_TTL_MS = 10 * 60_000; // 10 分钟缓存

// ── 工具函数 ──

/** 检查配额是否耗尽 */
function isQuotaExhausted(id) {
  const q = quotaCache.get(id);
  return Boolean(q && Date.now() - q.at < QUOTA_TTL_MS && q.remaining <= 0);
}

/** 解析有效 token */
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
  const ready = [];
  for (const a of all) {
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

/** 验证请求鉴权（本地访问或 API Key） */
async function validateRequest(req) {
  const remote = req.socket?.remoteAddress || '';

  // 方案 1：仅允许本地访问（回环地址）
  if (!['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(remote)) {
    return { valid: false, reason: '禁止外网访问' };
  }

  // 方案 2：可选 API Key 鉴权
  const settings = await loadSettings();
  const apiKey = settings.minimaxGatewayKey;

  if (apiKey && apiKey.length > 0) {
    const givenApiKey = req.headers['x-api-key'] ||
                        req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
                        req.headers['X-API-Key'];

    if (!givenApiKey) {
      return { valid: false, reason: '缺少 API Key' };
    }

    // 恒定时间比较
    const ab = Buffer.from(String(givenApiKey), 'utf8');
    const bb = Buffer.from(String(apiKey), 'utf8');
    if (ab.length !== bb.length) {
      crypto.timingSafeEqual(ab, ab); // 仍然执行一次以保持恒定时间轮廓
      return { valid: false, reason: 'API Key 不匹配' };
    }
    if (!crypto.timingSafeEqual(ab, bb)) {
      return { valid: false, reason: 'API Key 不匹配' };
    }
  }

  return { valid: true };
}

// ── 核心处理函数 ──

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

    try {
      // 构建上游请求头（清理一些不必要的 header）
      const upstreamHeaders = {};
      for (const [key, value] of Object.entries(req.headers)) {
        // 跳过 hop-by-hop headers
        if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade'].some(h => key.includes(h))) {
          continue;
        }
        upstreamHeaders[key] = value;
      }

      // 设置 Authorization header
      upstreamHeaders.Authorization = token;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000); // 60s 超时

      const resObj = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: req.body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      logger.info('MINIMAX-GW', `${label} 成功 (${resObj.status})`);

      // 5. 原样转发响应（支持 SSE 和流式）
      const ct = resObj.headers.get('content-type') || 'application/json';
      const status = resObj.status;

      // 清理一些不必要的 response headers
      const responseHeaders = {};
      for (const [key, value] of resObj.headers.entries()) {
        if (!['content-type', 'content-length', 'cache-control', 'date'].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      }
      responseHeaders['Cache-Control'] = 'no-cache';

      res.writeHead(status, responseHeaders);

      // 流式转发
      if (resObj.body) {
        const reader = resObj.body.getReader();
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
            res.end();
          }
        };
        pump();
      } else {
        res.end();
      }
      return true;

    } catch (e) {
      lastError = e;
      logger.warn('MINIMAX-GW', `${label} 失败：${e.message}`);

      // 如果是 401，标记该 token 为无效
      if (e.message.includes('401') || e.message.includes('403')) {
        quotaCache.set(account.id, { remaining: 0, at: Date.now() });
        logger.info('MINIMAX-GW', `${label}: 标记为无效 token`);
      }

      // 继续尝试下一个账号
      continue;
    }
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

/** 设置 API Key */
export async function setApiKey(key) {
  const settings = await loadSettings();
  settings.minimaxGatewayKey = key?.trim() || '';
  await loadSettings(); // save via module side effect or implement proper save
  return settings;
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
