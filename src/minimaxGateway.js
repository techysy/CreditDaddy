/**
 * MiniMax Code 本地 Anthropic 兼容网关。
 *
 * 数据面端点：POST /gateway/minimax/v1/messages
 * （上游为标准 Anthropic Messages 协议：https://agent.minimax.cn/mavis/api/v1/llm/v1/messages）
 *
 * 架构特性：
 * 1. 多账号粘性主力（provider=minimax）：按剩余积分选主力并保持，出错/限流/凭据失效自动切下一个
 * 2. 自动刷新与重试：401 凭据失效时自动走 OAuth refresh 换取新 token 并重试，彻底失效才拉黑
 * 3. 429 限流保护：429 限流自动冷却（退避阶梯 30s → 1min → 2min → 5min → 10min 封顶，成功一次即清零）
 * 4. 局域网访问控制：继承相同的白名单与回环检查机制
 * 5. SSE 与 JSON 流式透明转发
 */

import { fetchJsonRace } from './zcodeClient.js';
import { loadAccounts, loadSettings, saveSettings } from './store.js';
import { refreshMiniMaxToken, refreshAccountToken, fetchMiniMaxQuota, minimaxEndpointsOf, minimaxFlavorOf } from './minimaxClient.js';
import { clearRefreshDead, __resetRefreshGuardForTests } from './refreshGuard.js';
import { refreshContext } from './accounts.js';
import { gatewayHostSuggestion } from './tenrouter.js';
import { logger, summarizeAttempts } from './logger.js';
import { t } from './i18n.js';
import { formatDurationMs } from './formatDuration.js';

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
    coolingStreak.clear();
    clearRefreshDead();
  }
}

// ── 账号轮换状态（进程内） ──

const cooling = new Map();  // accountId → 冷却截止(ms)
// accountId → 连续 429 次数（成功即清零）：决定本次 429 走到退避阶梯的哪一档
const coolingStreak = new Map();
const dead = new Map();     // accountId → 拉黑时的凭据指纹（指纹变化 = 已重新授权/刷新，自动复活）
const weights = new Map();  // accountId → { w: 剩余积分权重, at: 查询时刻 }(查询失败时保留旧快照)
const WEIGHT_TTL_MS = 10 * 60_000;  // 权重超过该时长重新查询额度,让用量变化能反映到分流上
const WEIGHT_REFRESH_CAP_MS = 2_000;   // 请求路径等新权重的上限；超时先用旧快照，刷新转后台
const weightInflight = new Map();      // accountId → 刷新中 Promise（并发请求共用一次查询）

export const stats = {
  lastCallAt: null,
  calls: 0,
  lastAccount: null,
  lastAccountAt: null,   // 「接口使用中」徽章的 30 分钟窗口锚点（面板 gwRecentWindow 内才亮）
};

// 平滑加权轮询（SWRR）：剩余积分多的账号分到更多请求，而不是雨露均沾地 round-robin。
// 查不到额度或为 0 时给保底权重，保证账号仍会被轮询（0 也可能只是查询失败/尚未刷新）。
const MIN_WEIGHT = 1;

function credFingerprint(a) {
  return `${a.token || ''}|${a.refreshToken || ''}`;
}

/** 账号被删除时清掉它在各轮换 Map 里的残留（daemon DELETE /api/accounts/:id 调用） */
export function forgetAccount(id) {
  cooling.delete(id);
  coolingStreak.delete(id);
  dead.delete(id);
  weights.delete(id);
  if (stickyId === id) stickyId = null;
  // 在途权重刷新 resolve 后会把 id 写回 weights——清掉 inflight 句柄并在其落地后补删，
  // 否则删号后残留条目永不回收（无界增长泄漏）
  const inflight = weightInflight.get(id);
  weightInflight.delete(id);
  if (inflight) inflight.catch(() => {}).then(() => { weights.delete(id); });
}

function markCooling(id, ms = ACCOUNT_COOLING_MS) {
  cooling.set(id, Date.now() + ms);
}

// 429 退避阶梯：30s → 1min → 2min → 5min → 10min 封顶（与 ZCode 网关同款）。
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

function markRateLimited(id) {
  const streak = (coolingStreak.get(id) || 0) + 1;
  coolingStreak.set(id, streak);
  const ms = RATE_LIMIT_BACKOFF_MS[Math.min(streak, RATE_LIMIT_BACKOFF_MS.length) - 1];
  cooling.set(id, Date.now() + ms);
  return ms;
}

function resetCoolingStreak(id) { coolingStreak.delete(id); }

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
  coolingStreak.delete(account.id);
  logger.info('MINIMAX-GW', '{label} 凭据已更新,解除拉黑', { label: account.name || account.uid || account.id });
  return false;
}

/** 测试专用：仅让权重快照过期（保留粘性/拉黑状态），用于模拟额度变化 */
export function __expireWeightsForTests() { weights.clear(); }

/**
 * 测试专用：把某账号的冷却截止拨到指定时间戳（0 = 立即到期，用于快进冷却窗口）。
 * 生产不走这里——冷却窗口只能自然到期。与 zcodeGateway.__setCoolingForTests 同款。
 */
export function __setCoolingForTests(accountId, untilMs) { cooling.set(accountId, untilMs); }

/** 测试专用：清空进程内状态 */
export function __resetForTests() {
  cooling.clear();
  coolingStreak.clear();
  dead.clear();
  weights.clear();
  weightInflight.clear();
  stickyId = null;
  stats.lastCallAt = null;
  stats.calls = 0;
  stats.lastAccount = null;
  stats.lastAccountAt = null;
  __resetRefreshGuardForTests();
}

/** 账号权重:剩余积分(带 TTL 的快照,避免每个请求都打额度接口)。查询失败时保留上次快照权重。 */
async function accountWeight(a) {
  const hit = weights.get(a.id);
  if (hit && Date.now() - hit.at < WEIGHT_TTL_MS) return hit.w;
  const fallback = hit?.w ?? MIN_WEIGHT;
  // 请求路径只等一个很短的上限：额度接口健康时照常拿到新权重精准选主力；
  // 上游黑洞时最多等这么久就先用旧快照——刷新仍在后台继续，下一个请求就有新值。
  // 此前是完整等待额度查询且逐号串行，一个黑洞的上游能让权重过期后的
  // 第一个补全请求卡 1-2 分钟（客户端还挂着已连接的 SSE 请求）
  const refresh = weightRefresh(a);
  let timer;
  const capped = new Promise((r) => { timer = setTimeout(() => r(fallback), WEIGHT_REFRESH_CAP_MS); });
  try {
    return await Promise.race([refresh, capped]);
  } finally {
    clearTimeout(timer);
  }
}

/** 去重后的权重刷新：并发请求共用同一次额度查询；查询失败保留旧快照权重（时间戳仍刷新，避免每请求都撞同一坏接口） */
function weightRefresh(a) {
  const existing = weightInflight.get(a.id);
  if (existing) return existing;
  const run = (async () => {
    const hit = weights.get(a.id);
    let w = hit?.w ?? MIN_WEIGHT;
    try {
      const q = await fetchMiniMaxQuota(a, refreshContext(a, (m) => logger.info("MINIMAX-GW", t('{label} {msg}', { label: a.name || a.uid || a.id, msg: m }))));
      w = Math.max(MIN_WEIGHT, Number(q?.remaining) || 0);
    } catch {
      // 额度查询失败时保留上次快照权重：一次网络抖动不该把主力账号踢成保底权重、引发主力来回切换
    }
    weights.set(a.id, { w, at: Date.now() });
    return w;
  })();
  weightInflight.set(a.id, run);
  run.finally(() => { if (weightInflight.get(a.id) === run) weightInflight.delete(a.id); }).catch(() => {});
  return run;
}

// ── 粘性主力选型 ──
// 上次的主力账号仍健康时继续用它：两个账号积分接近时若逐请求轮换，会在两账号间
// 交替刷屏（「一主一备」困扰的来源，用户期望「出错/积分拉开差距才换」）；
// 仅当另一账号剩余积分明显更多，或主力被拉黑/冷却，才主动换主力。
let stickyId = null;
const STICKY_MARGIN_RATIO = 0.1; // 积分领先超过 10% 才换
const STICKY_MARGIN_ABS = 50;    // 且绝对差超过 50 积分

/**
 * 可用账号队列：队首 = 本次主力账号，其余按剩余积分降序作重试兜底。
 * 拉黑/冷却在挂载时剔除；扭转主力粘性见上方说明。
 */
async function rotationQueue() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'minimax' || a.provider === 'minimax-global');
  const now = Date.now();
  const candidates = [];
  for (const a of all) {
    if (isDead(a)) continue;
    if ((cooling.get(a.id) || 0) > now) continue;
    if (!a.token) continue;
    candidates.push(a);
  }
  // 权重并行取（各自 2s 封顶），不再逐号串行等
  const ws = await Promise.all(candidates.map((a) => accountWeight(a)));
  const ready = candidates.map((a, i) => ({ account: a, weight: ws[i] }));
  if (!ready.length) return [];

  ready.sort((x, y) => y.weight - x.weight);
  let head = ready[0];
  const sticky = stickyId ? ready.find((it) => it.account.id === stickyId) : null;
  if (sticky && sticky.account.id !== head.account.id) {
    const margin = Math.max(STICKY_MARGIN_ABS, head.weight * STICKY_MARGIN_RATIO);
    if (head.weight - sticky.weight < margin) head = sticky;
  }
  if (stickyId && stickyId !== head.account.id) {
    const from = all.find((a) => a.id === stickyId);
    logger.info('MINIMAX-GW', '主力账号 {from} → {to}（剩余积分领先）', { from: from?.name || from?.uid || stickyId, to: head.account.name || head.account.uid || head.account.id });
  }
  stickyId = head.account.id;
  return [head.account, ...ready.filter((it) => it.account.id !== head.account.id).map((it) => it.account)];
}

async function unavailableReason() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'minimax' || a.provider === 'minimax-global');
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
    if (e.endsWith('*')) {
      // 通配要求带点段尾：防止 192.168.31.1* 这类把 .100-.199 整段一起放行的怪手。
      // 要扩整段子网，把写法统一为 192.168.31.*（带尾句点）。
      const prefix = e.slice(0, -1);
      if (!prefix.endsWith('.')) return false;
      return host.toLowerCase().startsWith(prefix.toLowerCase());
    }
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
  // 优雅断开（客户端 fetch abort 在上游响应前）只触发 res 'close'，不触发 req 'close'
  res.once('close', () => { if (!res.writableEnded) clientAbort.abort(); });

  for (let i = 0; i < Math.min(MAX_ATTEMPTS, queue.length); i++) {
    const account = queue[i];
    if (isDead(account) || (cooling.get(account.id) || 0) > Date.now()) continue;
    const label = account.name || account.uid || account.id;

    let upstream;

    let activeToken = account.token;
    // 按账号档位选上游域名（国内 agent.minimax.cn / 国际 agent.minimax.io，协议同形）
    const upstreamUrl = minimaxEndpointsOf(account).messagesUrl;
    const sendUpstream = async (tok) => {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`,
        'anthropic-version': '2023-06-01',
      };
      return fetchJsonRace(upstreamUrl, {
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
      // 如果 401 且账号有 refreshToken，尝试就地刷新一次并重试（走与 checkin/quota 统一的 refreshAccountToken，自带互斥防竞态与自动落盘）
      if (upstream.status === 401 && account.refreshToken) {
        logger.info('MINIMAX-GW', '{label} 收到 401,尝试刷新凭据...', { label });
        try {
          const creds = await refreshAccountToken(account, {
            log: (m) => logger.info('MINIMAX-GW', '{label} {msg}', { label, msg: m }),
          });
          activeToken = creds.token;
          // 刷新回写即凭据更新：解除该账号可能存在的拉黑/冷却（指纹已变化，防御性直清）
          dead.delete(account.id);
          cooling.delete(account.id);
          resetCoolingStreak(account.id);
          upstream = await sendUpstream(activeToken);
        } catch (refErr) {
          logger.warn('MINIMAX-GW', '{label} 凭据刷新失败: {err}', { label, err: refErr.message });
        }
      }
    } catch (e) {
      if (clientAbort.signal.aborted) return;
      attempted.push({ account: label, ok: false, error: e.message });
      continue;
    }

    if (upstream.ok) {
      stats.lastAccount = label;
      stats.lastAccountAt = Date.now();
      resetCoolingStreak(account.id);   // 成功一次即清零连续 429 计数
      logger.info('MINIMAX-GW', '{label} 补全成功 ({status})', { label, status: upstream.status });
      try {
        const meta = JSON.parse(rawBody);
        logger.debug('MINIMAX-GW', '请求详情：model={model} stream={stream} ua={ua}', { model: meta?.model || '-', stream: meta?.stream ? 'y' : 'n', ua: req.headers?.['user-agent'] || '-' });
      } catch {}

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
          if (clientAbort.signal.aborted) {
            // 客户端主动断开（点停止/换一句）属正常收尾，不是故障
            logger.debug('MINIMAX-GW', '流式转发中断:{err}', { err: e.message });
          } else {
            // 上游中途断了：补一帧 Anthropic error 事件再收尾，别让客户端只见裸 EOF
            logger.warn('MINIMAX-GW', '上游流中断:{err}', { err: e.message });
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `上游流中断：${e.message}` } })}\n\n`);
            } catch { /* 客户端已不在 */ }
          }
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
      logger.info('MINIMAX-GW', '{label} 凭据失效,拉黑', { label });
      continue;
    }
    if (upstream.status === 402 || /insufficient_balance|余额不足|额度不足/i.test(errText)) {
      markCooling(account.id, 30 * 60_000);
      attempted.push({ account: label, ok: false, error: '额度耗尽 (402)，冷却 30 分钟' });
      logger.warn('MINIMAX-GW', '{label} 额度耗尽 (402),冷却 30 分钟', { label });
      continue;
    }
    if (upstream.status === 429) {
      const ms = markRateLimited(account.id);
      const dur = formatDurationMs(ms);
      const streak = coolingStreak.get(account.id);
      attempted.push({ account: label, ok: false, error: `429 限流，冷却 ${dur}` });
      logger.info('MINIMAX-GW', '{label} 429 限流,冷却 {dur}(连续第 {streak} 次)', { label, dur, streak });
      continue;
    }

    attempted.push({ account: label, ok: false, error: `上游错误 HTTP ${upstream.status}: ${errText.slice(0, 100)}` });
  }

  // 全部重试失败
  const failedDetail = summarizeAttempts(attempted);
  logger.warn('MINIMAX-GW', '全部 {n} 次尝试失败{detail}(下一请求自动重试)', { n: attempted.length, detail: failedDetail ? ':' + failedDetail : '' });
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: '所有 MiniMax 账号均调用失败',
    attempts: attempted,
  }));
  return true;
}

export async function gatewayStatus() {
  const enabled = await gatewayEnabled();
  const all = (await loadAccounts()).filter((a) => a.provider === 'minimax' || a.provider === 'minimax-global');
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
      lastAccountAt: stats.lastAccountAt,
    },
    accounts: all.length,
    // cooling 保持字符串数组（历史形状）；冷却细节走 coolingDetail（与 zcodeGateway 同款）
    cooling: all.filter((a) => !isDead(a) && (cooling.get(a.id) || 0) > now).map((a) => a.name || a.uid || a.id),
    coolingDetail: all.filter((a) => !isDead(a) && (cooling.get(a.id) || 0) > now)
      .map((a) => {
        const remainMs = (cooling.get(a.id) || 0) - now;
        return {
          id: a.id, name: a.name || a.uid || a.id,
          remainMs, remainSeconds: Math.max(0, Math.ceil(remainMs / 1000)),
          remainText: formatDurationMs(remainMs),
          streak: coolingStreak.get(a.id) || 0,
        };
      }),
    dead: all.filter((a) => isDead(a)).map((a) => a.name || a.uid || a.id),
    endpoint: '/gateway/minimax/v1/messages',
  };
}
