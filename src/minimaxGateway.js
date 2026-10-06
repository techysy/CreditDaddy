/**
 * MiniMax Code 本地 Anthropic 兼容网关。
 *
 * 数据面端点：POST /gateway/minimax/v1/messages
 * （上游为标准 Anthropic Messages 协议：https://agent.minimax.cn/mavis/api/v1/llm/v1/messages）
 *
 * 架构特性：
 * 1. 账号多路轮换（provider=minimax）：自动在有效账号间轮询
 * 2. 自动刷新与重试：401 凭据失效时自动走 OAuth refresh 换取新 token 并重试，彻底失效才拉黑
 * 3. 429 限流保护：429 限流自动冷却 5 分钟
 * 4. 局域网访问控制：继承相同的白名单与回环检查机制
 * 5. SSE 与 JSON 流式透明转发
 */

import { fetchJsonRace } from './zcodeClient.js';
import { loadAccounts, loadSettings, saveSettings } from './store.js';
import { refreshMiniMaxToken, fetchMiniMaxQuota, MINIMAX_MESSAGES_URL } from './minimaxClient.js';
import { refreshContext } from './accounts.js';
import { gatewayHostSuggestion } from './tenrouter.js';
import { logger } from './logger.js';

const ACCOUNT_COOLING_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const UPSTREAM_TIMEOUT_MS = 600_000;
const UPSTREAM_CONNECT_MS = 15_000;

// ── 开关（持久化在 settings.minimaxGateway） ──

export async function gatewayEnabled() {
  return (await loadSettings()).minimaxGateway === true;
}

export async function setGatewayEnabled(v) {
  const on = v === true;
  await saveSettings({ minimaxGateway: on });
  // 开启网关视为「重新开始」：清掉进程内的拉黑/冷却状态，
  // 否则重新授权后旧黑名单仍会把账号挡在轮转队列外（曾导致开关无效）。
  if (on) {
    dead.clear();
    cooling.clear();
  }
}

// ── 账号轮换状态（进程内） ──

const cooling = new Map();  // accountId → 冷却截止(ms)
const dead = new Map();     // accountId → 拉黑时的凭据指纹（指纹变化 = 已重新授权/刷新，自动复活）
const weights = new Map();  // accountId → 上次查到的剩余积分（0 时按保底权重轮询，保持可用性）

export const stats = {
  lastCallAt: null,
  calls: 0,
  lastAccount: null,
};

// 平滑加权轮询（SWRR）：剩余积分多的账号分到更多请求，而不是雨露均沾地 round-robin。
// 查不到额度或为 0 时给保底权重，保证账号仍会被轮询（0 也可能只是查询失败/尚未刷新）。
const MIN_WEIGHT = 1;

function credFingerprint(a) {
  return `${a.token || ''}|${a.refreshToken || ''}`;
}

function markCooling(id, ms = ACCOUNT_COOLING_MS) {
  cooling.set(id, Date.now() + ms);
}

function markDead(account) {
  dead.set(account.id, credFingerprint(account));
  cooling.set(account.id, Number.MAX_SAFE_INTEGER);
}

/**
 * 账号是否仍处于拉黑状态。拉黑记的是「当时那份凭据」的指纹：
 * 重新登录/重新导入/刷新回写换了 token 后指纹不匹配 → 自动复活（清黑名单与冷却）。
 */
function isDead(account) {
  const fp = dead.get(account.id);
  if (fp === undefined) return false;
  if (fp === credFingerprint(account)) return true;
  dead.delete(account.id);
  cooling.delete(account.id);
  logger.info('MINIMAX-GW', `${account.name || account.uid || account.id} 凭据已更新，解除拉黑`);
  return false;
}

/** 测试专用：清空进程内状态 */
export function __resetForTests() {
  cooling.clear();
  dead.clear();
  weights.clear();
  swrr.clear();
  stats.lastCallAt = null;
  stats.calls = 0;
  stats.lastAccount = null;
}

/** 账号权重：剩余积分（上次快照，避免每个请求都打额度接口）。查不到用保底权重。 */
async function accountWeight(a) {
  if (!weights.has(a.id)) {
    try {
      const q = await fetchMiniMaxQuota(a, refreshContext(a, (m) => logger.info('MINIMAX-GW', `${a.name || a.uid || a.id} ${m}`)));
      const remaining = Number(q?.remaining) || 0;
      weights.set(a.id, Math.max(MIN_WEIGHT, remaining));
    } catch {
      weights.set(a.id, MIN_WEIGHT);
    }
  }
  return weights.get(a.id);
}

// SWRR 状态：accountId → 当前有效权重（每次调度累加，被选中的减去总权重）
const swrr = new Map();
function ensureSwrr(id) { if (!swrr.has(id)) swrr.set(id, 0); }

/**
 * 可参与轮转的 MiniMax 账号队列，按剩余积分加权排序（SWRR）。
 * 返回 [账号, ...]：首个为本次该分到的账号；MAX_ATTEMPTS 只取队列头部用于重试，
 * 所以这里直接把权重最高的放最前，其余按有效权重降序兜底。
 */
async function rotationQueue() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'minimax');
  const now = Date.now();
  const ready = [];
  for (const a of all) {
    if (isDead(a)) continue;
    if ((cooling.get(a.id) || 0) > now) continue;
    if (!a.token) continue;
    ensureSwrr(a.id);
    const w = await accountWeight(a);
    swrr.set(a.id, (swrr.get(a.id) || 0) + w);
    ready.push({ account: a, weight: w });
  }
  if (!ready.length) return [];

  // 有效权重最大者中签（SWRR 的「选出 current 最大」步）
  let pick = ready[0];
  for (const it of ready) if ((swrr.get(it.account.id) || 0) > (swrr.get(pick.account.id) || 0)) pick = it;
  const total = ready.reduce((s, it) => s + it.weight, 0);
  swrr.set(pick.account.id, (swrr.get(pick.account.id) || 0) - total);

  // 队首 = 本次中签账号；其余按剩余积分降序（重试兜底顺序）
  const rest = ready.filter((it) => it.account.id !== pick.account.id)
    .sort((x, y) => y.weight - x.weight)
    .map((it) => it.account);
  return [pick.account, ...rest];
}

async function unavailableReason() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'minimax');
  if (!all.length) return '没有 MiniMax 账号：请在 MiniMax Code 登录后在面板进行本机导入，或粘贴 Token 添加';
  const now = Date.now();
  const n = { dead: 0, cooling: 0, noToken: 0 };
  for (const a of all) {
    if (isDead(a)) n.dead++;
    else if ((cooling.get(a.id) || 0) > now) n.cooling++;
    else if (!a.token) n.noToken++;
  }
  const parts = [];
  if (n.cooling) parts.push(`${n.cooling} 个临时冷却中（稍后自动恢复）`);
  if (n.dead) parts.push(`${n.dead} 个凭据已失效（需在 MiniMax Code 重新登录后导入）`);
  if (n.noToken) parts.push(`${n.noToken} 个缺少 Token`);
  return `没有可用的 MiniMax 账号：${parts.join('；')}`;
}

const LOOPBACK_RE = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/;
function isLoopbackRemote(remote) {
  return !remote || LOOPBACK_RE.test(String(remote));
}

function remoteHost(remote) {
  return String(remote || '').replace(/^::ffff:/i, '').trim();
}

function remoteAllowed(remote, allowList) {
  const host = remoteHost(remote);
  if (!host) return false;
  return (Array.isArray(allowList) ? allowList : []).some((entry) => {
    const e = String(entry || '').trim();
    if (!e) return false;
    if (e.endsWith('*')) return host.toLowerCase().startsWith(e.slice(0, -1).toLowerCase());
    return host.toLowerCase() === e.toLowerCase();
  });
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = 20 * 1024 * 1024; // 20MB
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 只 pause 不 destroy：destroy 会把 socket 打死，随后写的 413 客户端收不到（只看到 ECONNRESET）
        req.pause();
        const err = new Error('请求体过大（上限 20MB）');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 处理 MiniMax 本地网关请求
 */
export async function handleGateway(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'POST /gateway/minimax/v1/messages（Anthropic /v1/messages 形态）' }));
  }
  const settings = await loadSettings();
  if (settings.minimaxGateway !== true) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'MiniMax 本地网关未开启（面板 → MiniMax → 接口设置）' }));
  }

  // 局域网访问控制
  const remote = (req.socket && req.socket.remoteAddress) || '';
  if (!isLoopbackRemote(remote)) {
    if (settings.minimaxGatewayLan !== true) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'MiniMax 网关未允许局域网访问（面板 → MiniMax → 接口设置）' }));
    }
    if (!remoteAllowed(remote, settings.minimaxGatewayAllow)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `来源 ${remoteHost(remote) || '未知'} 不在 MiniMax 网关 IP 白名单内` }));
    }
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    res.writeHead(e.status || 400, { 'Content-Type': 'application/json' });
    // 超限时请求体还没读完：先把 413 发出去，发完再断开
    res.on('finish', () => req.destroy());
    return res.end(JSON.stringify({ error: e.message }));
  }

  const queue = await rotationQueue();
  if (!queue.length) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: await unavailableReason() }));
  }

  stats.lastCallAt = new Date().toISOString();
  stats.calls += 1;

  const attempted = [];
  const clientAbort = new AbortController();
  req.once('close', () => { if (!res.writableEnded) clientAbort.abort(); });

  for (let i = 0; i < Math.min(MAX_ATTEMPTS, queue.length); i++) {
    const account = queue[i];
    if (isDead(account) || (cooling.get(account.id) || 0) > Date.now()) continue;
    const label = account.name || account.uid || account.id;

    let upstream;

    let activeToken = account.token;
    const sendUpstream = async (tok) => {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`,
        'anthropic-version': '2023-06-01',
      };
      return fetchJsonRace(MINIMAX_MESSAGES_URL, {
        method: 'POST',
        headers,
        body: rawBody,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        connectMs: UPSTREAM_CONNECT_MS,
        signal: clientAbort.signal,
      });
    };

    try {
      upstream = await sendUpstream(activeToken);
      // 如果 401 且账号有 refreshToken，尝试就地刷新一次并重试
      if (upstream.status === 401 && account.refreshToken) {
        logger.info('MINIMAX-GW', `${label} 收到 401，尝试刷新凭据…`);
        try {
          // 本机导入账号：刷新前对齐 ~/.minimax auth.json 里客户端最新的 refreshToken，避免 invalid_grant
          try {
            const { alignMiniMaxFromLocal } = await import('./minimaxLocal.js');
            if (alignMiniMaxFromLocal(account, (m) => logger.info('MINIMAX-GW', `${label} ${m}`))) {
              activeToken = account.token;
            }
          } catch {}
          const refreshed = await refreshMiniMaxToken(account.refreshToken);
          const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
          account.token = refreshed.accessToken;
          account.refreshToken = refreshed.refreshToken;
          account.expiresAt = expiresAt;
          const { withAccounts } = await import('./store.js');
          await withAccounts((list) => {
            const cur = list.find((a) => a.id === account.id);
            if (cur) {
              cur.token = refreshed.accessToken;
              cur.refreshToken = refreshed.refreshToken;
              cur.expiresAt = expiresAt;
            }
          });
          activeToken = refreshed.accessToken;
          // 刷新回写即凭据更新：解除该账号可能存在的拉黑/冷却（指纹已变化，防御性直清）
          dead.delete(account.id);
          cooling.delete(account.id);
          upstream = await sendUpstream(activeToken);
        } catch (refErr) {
          logger.warn('MINIMAX-GW', `${label} 凭据刷新失败: ${refErr.message}`);
        }
      }
    } catch (e) {
      if (clientAbort.signal.aborted) return;
      attempted.push({ account: label, ok: false, error: e.message });
      continue;
    }

    if (upstream.ok) {
      stats.lastAccount = label;
      logger.info('MINIMAX-GW', `${label} 补全成功 (${upstream.status})`);

      // 透传头（SSE / JSON）
      const forwardHeaders = {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-cache',
      };
      res.writeHead(upstream.status, forwardHeaders);

      if (upstream.body && typeof upstream.body.pipe === 'function') {
        upstream.body.pipe(res);
      } else if (upstream.body && typeof upstream.body.getReader === 'function') {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
              await new Promise((r) => res.once('drain', r));
            }
          }
        } catch (e) {
          logger.warn('MINIMAX-GW', `流式转发中断：${e.message}`);
        }
        res.end();
      } else {
        const buf = await upstream.arrayBuffer().catch(() => null);
        res.end(buf ? Buffer.from(buf) : '');
      }
      return true;
    }

    // 失败处理
    const errText = await upstream.text().catch(() => '');
    if (upstream.status === 401) {
      markDead(account);
      attempted.push({ account: label, ok: false, error: 'Token 彻底失效 (401)，拉黑' });
      logger.info('MINIMAX-GW', `${label} 凭据失效，拉黑`);
      continue;
    }
    if (upstream.status === 429) {
      markCooling(account.id, ACCOUNT_COOLING_MS);
      attempted.push({ account: label, ok: false, error: '429 限流，冷却 5 分钟' });
      logger.info('MINIMAX-GW', `${label} 429 限流，冷却 5 分钟`);
      continue;
    }

    attempted.push({ account: label, ok: false, error: `上游错误 HTTP ${upstream.status}: ${errText.slice(0, 100)}` });
  }

  // 全部重试失败
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: '所有 MiniMax 账号均调用失败',
    attempts: attempted,
  }));
  return true;
}

export async function gatewayStatus() {
  const enabled = await gatewayEnabled();
  const all = (await loadAccounts()).filter((a) => a.provider === 'minimax');
  const now = Date.now();
  const settings = await loadSettings();

  return {
    enabled,
    lan: settings.minimaxGatewayLan === true,
    allow: Array.isArray(settings.minimaxGatewayAllow) ? settings.minimaxGatewayAllow : [],
    suggestAllow: gatewayHostSuggestion(),
    stats: {
      lastCallAt: stats.lastCallAt,
      calls: stats.calls,
      lastAccount: stats.lastAccount,
    },
    accounts: all.length,
    cooling: all.filter((a) => !isDead(a) && (cooling.get(a.id) || 0) > now).map((a) => a.name || a.uid || a.id),
    dead: all.filter((a) => isDead(a)).map((a) => a.name || a.uid || a.id),
    endpoint: '/gateway/minimax/v1/messages',
  };
}
