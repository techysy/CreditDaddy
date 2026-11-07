/**
 * Trae SOLO 本地 Anthropic 兼容网关。
 *
 * 数据面端点：POST /gateway/trae/v1/messages
 * （上游为 ByteDance Trae SOLO 远程 Agent 协议：https://solo.trae.cn/api/remote/v1）
 *
 * 架构特性：
 * 1. 账号多路轮换（provider=trae）：自动在有效账号间按剩余积分加权轮询（SWRR）
 * 2. 凭据热对齐：401 时若为本机导入账号，尝试重读 storage.json 最新登录态
 * 3. 429 限流保护：429 限流自动冷却（退避阶梯 30s → 1min → 2min → 5min → 10min 封顶，成功一次即清零）
 * 4. 局域网访问控制：继承相同的白名单与回环检查机制
 * 5. SSE 增量转换：将 Trae SOLO 累积流转换为标准 Anthropic 流式 SSE 或一次性 JSON 响应
 */

import { fetchJsonRace } from './zcodeClient.js';
import { loadAccounts, loadSettings, saveSettings } from './store.js';
import { fetchTraeQuota } from './traeClient.js';
import { gatewayHostSuggestion } from './tenrouter.js';
import { logger, summarizeAttempts } from './logger.js';
import { t } from './i18n.js';
import { formatDurationMs } from './formatDuration.js';

const TRAE_SOLO_BASE = 'https://solo.trae.cn/api/remote/v1';
const ACCOUNT_COOLING_MS = 5 * 60_000;
// 429 退避阶梯：30s → 1min → 2min → 5min → 10min 封顶（与 ZCode 网关同款）。
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const MAX_ATTEMPTS = 5;
const UPSTREAM_TIMEOUT_MS = 600_000;
const UPSTREAM_CONNECT_MS = 15_000;
const DEFAULT_MODEL = 'Doubao-Seed-Code';

// ── 开关（持久化在 settings.traeGateway） ──

export async function gatewayEnabled() {
  return (await loadSettings()).traeGateway === true;
}

export async function setGatewayEnabled(v) {
  const on = v === true;
  await saveSettings({ traeGateway: on });
  if (on) {
    dead.clear();
    cooling.clear();
    coolingStreak.clear();
  }
}

/** 丢弃错误响应的 body：不读不取消的 undici body 会把连接钉住到服务端关闭或 ~300s 超时
 *  （429 风暴时每个失败尝试泄漏一条 socket）。cancel 即可，错误体不需要内容。 */
function drainErr(res) {
  try { res?.body?.cancel?.()?.catch?.(() => {}); } catch { /* 已读/已取消 */ }
}

/** 账号被删除时清掉它在各轮换 Map 里的残留（daemon DELETE /api/accounts/:id 调用） */
export function forgetAccount(id) {
  cooling.delete(id);
  coolingStreak.delete(id);
  dead.delete(id);
  weights.delete(id);
  swrr.delete(id);
  // 在途的权重刷新 resolve 后会把 id 写回 weights——清掉 inflight 句柄，
  // 让它落地时发现 Map 里已无自己（weightRefresh 的 finally 只删「仍是自己」的条目），
  // 否则删号后残留条目永不回收（无界增长泄漏）
  const inflight = weightInflight.get(id);
  weightInflight.delete(id);
  if (inflight) inflight.catch(() => {}).then(() => { weights.delete(id); swrr.delete(id); });
}

// ── 账号轮换状态（进程内） ──

const cooling = new Map();  // accountId → 冷却截止(ms)
// accountId → 连续 429 次数（成功即清零）：决定本次 429 走到退避阶梯的哪一档
const coolingStreak = new Map();
const dead = new Map();     // accountId → 拉黑时的凭据指纹（指纹变化 = 已重新授权/导入，自动复活）
const weights = new Map();  // accountId → { w: 剩余积分权重, at: 查询时刻 }
const WEIGHT_TTL_MS = 10 * 60_000;  // 超过 10 分钟重查额度，让积分变化反映到分流上
const WEIGHT_REFRESH_CAP_MS = 2_000;   // 请求路径等新权重的上限；超时先用旧快照，刷新转后台
const weightInflight = new Map();      // accountId → 刷新中 Promise（并发请求共用一次查询）

export const stats = {
  lastCallAt: null,
  calls: 0,
  lastAccount: null,
  lastAccountAt: null,   // 「接口使用中」徽章的 30 分钟窗口锚点（面板 gwRecentWindow 内才亮）
};

const MIN_WEIGHT = 1;

function credFingerprint(a) {
  return `${a.token || ''}|${a.uid || ''}`;
}

function markCooling(id, ms = ACCOUNT_COOLING_MS) {
  cooling.set(id, Date.now() + ms);
}

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

function isDead(account) {
  const fp = dead.get(account.id);
  if (fp === undefined) return false;
  if (fp === credFingerprint(account)) return true;
  dead.delete(account.id);
  cooling.delete(account.id);
  coolingStreak.delete(account.id);
  logger.info('TRAE-GW', '{label} 凭据已更新,解除拉黑', { label: account.name || account.uid || account.id });
  return false;
}

/**
 * 测试专用：把某账号的冷却截止拨到指定时间戳（0 = 立即到期，用于快进冷却窗口）。
 * 生产不走这里——冷却窗口只能自然到期。与 zcodeGateway.__setCoolingForTests 同款。
 */
export function __setCoolingForTests(accountId, untilMs) { cooling.set(accountId, untilMs); }

export function __resetForTests() {
  cooling.clear();
  coolingStreak.clear();
  dead.clear();
  weights.clear();
  weightInflight.clear();
  swrr.clear();
  stats.lastCallAt = null;
  stats.calls = 0;
  stats.lastAccount = null;
  stats.lastAccountAt = null;
}

async function accountWeight(a) {
  const hit = weights.get(a.id);
  if (hit && Date.now() - hit.at < WEIGHT_TTL_MS) return hit.w;
  const fallback = hit?.w ?? MIN_WEIGHT;
  // 请求路径只等一个很短的上限：额度接口健康时（通常亚秒）照常拿到新权重精准分流；
  // 上游黑洞时最多等这么久就先用旧快照——刷新仍在后台继续，下一个请求就有新值。
  // 此前是完整等待额度查询（两个 POST，各 15s 上限）且逐号串行，一个黑洞的上游
  // 能让权重过期后的第一个补全请求卡 1-2 分钟
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
      const q = await fetchTraeQuota(a);
      w = Math.max(MIN_WEIGHT, Number(q?.remaining) || 0);
    } catch {
      // 额度查询失败保留上次快照权重（网络抖动不该把主力踢成保底权重）
    }
    weights.set(a.id, { w, at: Date.now() });
    return w;
  })();
  weightInflight.set(a.id, run);
  run.finally(() => { if (weightInflight.get(a.id) === run) weightInflight.delete(a.id); }).catch(() => {});
  return run;
}

const swrr = new Map();
function ensureSwrr(id) { if (!swrr.has(id)) swrr.set(id, 0); }

async function rotationQueue() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'trae');
  const now = Date.now();
  const candidates = [];
  for (const a of all) {
    if (isDead(a)) continue;
    if ((cooling.get(a.id) || 0) > now) continue;
    if (!a.token) continue;
    ensureSwrr(a.id);
    candidates.push(a);
  }
  // 权重并行取（各自 2s 封顶），不再逐号串行等——N 个账号的最坏停顿从 N×上限变成 1 个上限
  const ws = await Promise.all(candidates.map((a) => accountWeight(a)));
  const ready = candidates.map((a, i) => {
    swrr.set(a.id, (swrr.get(a.id) || 0) + ws[i]);
    return { account: a, weight: ws[i] };
  });
  if (!ready.length) return [];

  let pick = ready[0];
  for (const it of ready) if ((swrr.get(it.account.id) || 0) > (swrr.get(pick.account.id) || 0)) pick = it;
  const total = ready.reduce((s, it) => s + it.weight, 0);
  swrr.set(pick.account.id, (swrr.get(pick.account.id) || 0) - total);

  const rest = ready.filter((it) => it.account.id !== pick.account.id)
    .sort((x, y) => y.weight - x.weight)
    .map((it) => it.account);
  return [pick.account, ...rest];
}

async function unavailableReason() {
  const all = (await loadAccounts()).filter((a) => a.provider === 'trae');
  if (!all.length) return '没有 Trae 账号：请在 Trae 客户端登录后在面板进行本机导入';
  const now = Date.now();
  const n = { dead: 0, cooling: 0, noToken: 0 };
  for (const a of all) {
    if (isDead(a)) n.dead++;
    else if ((cooling.get(a.id) || 0) > now) n.cooling++;
    else if (!a.token) n.noToken++;
  }
  const parts = [];
  if (n.cooling) parts.push(`${n.cooling} 个临时冷却中（稍后自动恢复）`);
  if (n.dead) parts.push(`${n.dead} 个凭据已失效（需在 Trae 客户端重新登录后导入）`);
  if (n.noToken) parts.push(`${n.noToken} 个缺少 Token`);
  return `没有可用的 Trae 账号：${parts.join('；')}`;
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
    const limit = 20 * 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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
 * 将 Anthropic messages 格式转成 Trae query 单轮/多轮提示词
 */
function buildTraeQuery(bodyObj) {
  const parts = [];
  if (bodyObj.system) {
    const sysText = typeof bodyObj.system === 'string'
      ? bodyObj.system
      : Array.isArray(bodyObj.system)
        ? bodyObj.system.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n')
        : '';
    if (sysText.trim()) parts.push(`System: ${sysText.trim()}`);
  }

  const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
  for (const m of msgs) {
    const roleLabel = m.role === 'assistant' ? 'Assistant' : 'User';
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[Image]' : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (text.trim()) {
      parts.push(`${roleLabel}: ${text.trim()}`);
    }
  }

  if (!parts.length) {
    return '你好';
  }

  // 如果只有一条用户消息且没有系统消息，直接返回该文本
  if (parts.length === 1 && parts[0].startsWith('User: ')) {
    return parts[0].slice(6).trim();
  }

  return parts.join('\n\n');
}

/**
 * 处理 Trae 本地网关请求
 */
export async function handleGateway(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'POST /gateway/trae/v1/messages（Anthropic /v1/messages 形态）' }));
  }
  const settings = await loadSettings();
  if (settings.traeGateway !== true) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Trae 本地网关未开启（面板 → Trae → 接口设置）' }));
  }

  // 局域网访问控制
  const remote = (req.socket && req.socket.remoteAddress) || '';
  if (!isLoopbackRemote(remote)) {
    if (settings.traeGatewayLan !== true) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Trae 网关未允许局域网访问（面板 → Trae → 接口设置）' }));
    }
    if (!remoteAllowed(remote, settings.traeGatewayAllow)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `来源 ${remoteHost(remote) || '未知'} 不在 Trae 网关 IP 白名单内` }));
    }
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    res.writeHead(e.status || 400, { 'Content-Type': 'application/json' });
    res.on('finish', () => req.destroy());
    return res.end(JSON.stringify({ error: e.message }));
  }

  let bodyObj = null;
  try {
    bodyObj = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: '无效的 JSON 请求体' }));
  }

  const requestedModel = (bodyObj.model || '').trim() || DEFAULT_MODEL;
  const isStream = bodyObj.stream !== false;
  const promptText = buildTraeQuery(bodyObj);

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
  // ——少这一个钩子，取消后还会真的创建 SOLO 会话烧掉额度
  res.once('close', () => { if (!res.writableEnded) clientAbort.abort(); });

  for (let i = 0; i < Math.min(MAX_ATTEMPTS, queue.length); i++) {
    const account = queue[i];
    if (isDead(account) || (cooling.get(account.id) || 0) > Date.now()) continue;
    const label = account.name || account.uid || account.id;

    let token = account.token;
    const sessionPayload = {
      mode: 'code',
      environment_id: 'default',
      initial_message: {
        chat_session_id: '',
        content: [],
        query: JSON.stringify([{ type: 'text', data: { content: promptText } }]),
        model_name: requestedModel,
        agent_type: 'solo_agent_remote',
        model_selection_strategy: 'manual',
        common_params: JSON.stringify({
          language: 'zh-cn',
          app_language: 'zh-cn',
          quality: 'stable',
          app_version: '1.0.0.1229',
          web_id: '',
          user_identity: 'Free',
          is_freshman: '0',
          biz_user_id: '',
          user_unique_id: '',
          scope: 'marscode-cn',
          tenant: 'marscode',
          region: 'CN',
          aiRegion: 'CN',
          is_privacy_mode: 0,
          privacy_mode: 'off',
          solo_chat_mode: 'code',
        }),
      },
      env: 'remote',
      auto_create_project: false,
      origin: 'web',
    };

    const makeHeaders = (tok) => ({
      Authorization: tok.startsWith('Cloud-IDE-JWT ') ? tok : `Cloud-IDE-JWT ${tok.trim()}`,
      'Content-Type': 'application/json',
      'X-Trae-Client-Type': 'web',
      Referer: 'https://solo.trae.cn/',
    });

    let sessionRes;
    try {
      sessionRes = await fetchJsonRace(`${TRAE_SOLO_BASE}/chat_sessions`, {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify(sessionPayload),
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        connectMs: UPSTREAM_CONNECT_MS,
        signal: clientAbort.signal,
      });

      // 401 时若为本机导入账号，尝试对齐本地最新凭据
      if (sessionRes.status === 401) {
        try {
          const { readLiveAuth } = await import('./traeLocal.js');
          const live = readLiveAuth();
          if (live?.auth?.token && live.auth.token !== token) {
            token = live.auth.token;
            account.token = token;
            const { withAccounts } = await import('./store.js');
            await withAccounts((list) => {
              const cur = list.find((a) => a.id === account.id);
              if (cur) cur.token = token;
            });
        logger.info('TRAE-GW', '{label} 凭据已对齐本地客户端,重试会话创建...', { label });
            sessionRes = await fetchJsonRace(`${TRAE_SOLO_BASE}/chat_sessions`, {
              method: 'POST',
              headers: makeHeaders(token),
              body: JSON.stringify(sessionPayload),
              timeoutMs: UPSTREAM_TIMEOUT_MS,
              connectMs: UPSTREAM_CONNECT_MS,
              signal: clientAbort.signal,
            });
          }
        } catch {}
      }
    } catch (e) {
      if (clientAbort.signal.aborted) return;
      attempted.push({ account: label, ok: false, error: e.message });
      continue;
    }

    if (sessionRes.status === 401) {
      drainErr(sessionRes);
      markDead(account);
      attempted.push({ account: label, ok: false, error: 'Token 彻底失效 (401)，拉黑' });
      logger.info('TRAE-GW', '{label} 凭据失效,拉黑', { label });
      continue;
    }

    if (sessionRes.status === 429) {
      drainErr(sessionRes);
      const ms = markRateLimited(account.id);
      const dur = formatDurationMs(ms);
      const streak = coolingStreak.get(account.id);
      attempted.push({ account: label, ok: false, error: `429 限流，冷却 ${dur}` });
      logger.info('TRAE-GW', '{label} 429 限流,冷却 {dur}(连续第 {streak} 次)', { label, dur, streak });
      continue;
    }

    const sessionData = await sessionRes.json().catch(() => null);
    if (!sessionRes.ok || sessionData?.code !== 0 || !sessionData?.data?.chat_session_id) {
      drainErr(sessionRes);
      const errMsg = sessionData?.message || `HTTP ${sessionRes.status}`;
      attempted.push({ account: label, ok: false, error: `会话创建失败: ${errMsg}` });
      continue;
    }

    const chatSessionId = sessionData.data.chat_session_id;
    const messageId = sessionData.data.message_id;

    // 清理 session 的辅助函数。不挂 clientAbort 信号——客户端取消时恰恰要执行这里的
    // 清理；DELETE 也走 fetchJsonRace 限时，裸 fetch 黑洞时会吊住 socket 约 5 分钟
    const cleanupSession = () => {
      fetchJsonRace(`${TRAE_SOLO_BASE}/chat_sessions/${chatSessionId}`, {
        method: 'DELETE',
        headers: makeHeaders(token),
        timeoutMs: 10_000,
      }).catch(() => {});
    };

    // 获取 events 流
    let eventsRes;
    try {
      // 走 fetchJsonRace：连接段 15s 限时 + 统一代理 / 直连兜底与会话请求自洽（此前裸 fetch——
      // 上游黑洞时一直挂到客户端断开,也整体不走面板配置的出口代理,不是统一的接口设计）
      eventsRes = await fetchJsonRace(`${TRAE_SOLO_BASE}/chat_sessions/${chatSessionId}/events?reply_to_message_id=${encodeURIComponent(messageId)}`, {
        headers: {
          Authorization: token.startsWith('Cloud-IDE-JWT ') ? token : `Cloud-IDE-JWT ${token.trim()}`,
          Accept: 'text/event-stream',
          'X-Trae-Client-Type': 'web',
          Referer: 'https://solo.trae.cn/',
        },
        signal: clientAbort.signal,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        connectMs: 15_000,
      });
    } catch (e) {
      cleanupSession();
      if (clientAbort.signal.aborted) return;
      attempted.push({ account: label, ok: false, error: `建立事件流失败: ${e.message}` });
      continue;
    }

    if (!eventsRes.ok || !eventsRes.body) {
      drainErr(eventsRes);
      cleanupSession();
      // 事件流被 429（会话建好了、拉流被限流）同样按阶梯冷却——不判的话这个号
      // 下一轮会话创建仍从 30 秒档起算，继续撞限流
      if (eventsRes.status === 429) {
        const ms = markRateLimited(account.id);
        const dur = formatDurationMs(ms);
        const streak = coolingStreak.get(account.id);
        attempted.push({ account: label, ok: false, error: `429 限流（事件流），冷却 ${dur}` });
        logger.info('TRAE-GW', '{label} 429 限流(事件流),冷却 {dur}(连续第 {streak} 次)', { label, dur, streak });
        continue;
      }
      attempted.push({ account: label, ok: false, error: `事件流 HTTP ${eventsRes.status}` });
      continue;
    }

    stats.lastAccount = label;
    stats.lastAccountAt = Date.now();
      resetCoolingStreak(account.id);   // 成功一次即清零连续 429 计数
      logger.debug('TRAE-GW', '{label} 连接成功,开始流式输出 ({model})', { label, model: requestedModel });

    // 成功建立流，按 isStream 分发
    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const msgId = `msg_${Date.now()}_${chatSessionId.slice(0, 8)}`;
      let emittedThinking = '';
      let emittedText = '';
      let thinkingOpen = false;
      let textOpen = false;
      let nextBlockIndex = 0;
      let thinkingIndex = 0;
      let textIndex = 0;
      let usageInfo = null;

      // 发送 message_start
      const sendSse = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendSse('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      const reader = eventsRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      let streamCompleted = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { streamCompleted = true; break; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            let data;
            try { data = JSON.parse(raw); } catch { continue; }

            // 1. Thinking delta
            if (data.reasoning_content && data.reasoning_content.length > emittedThinking.length) {
              const delta = data.reasoning_content.slice(emittedThinking.length);
              emittedThinking = data.reasoning_content;
              if (!thinkingOpen) {
                thinkingIndex = nextBlockIndex++;
                sendSse('content_block_start', {
                  type: 'content_block_start',
                  index: thinkingIndex,
                  content_block: { type: 'thinking', thinking: '' },
                });
                thinkingOpen = true;
              }
              sendSse('content_block_delta', {
                type: 'content_block_delta',
                index: thinkingIndex,
                delta: { type: 'thinking_delta', thinking: delta },
              });
            }

            // 2. Text delta (thought or summary)
            const candidateText = data.thought || data.tool_call_info?.params?.summary || '';
            if (candidateText && candidateText.length > emittedText.length) {
              const delta = candidateText.slice(emittedText.length);
              emittedText = candidateText;
              if (thinkingOpen) {
                sendSse('content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
                thinkingOpen = false;
              }
              if (!textOpen) {
                textIndex = nextBlockIndex++;
                sendSse('content_block_start', {
                  type: 'content_block_start',
                  index: textIndex,
                  content_block: { type: 'text', text: '' },
                });
                textOpen = true;
              }
              sendSse('content_block_delta', {
                type: 'content_block_delta',
                index: textIndex,
                delta: { type: 'text_delta', text: delta },
              });
            }

            // 3. Usage info
            if (data.prompt_tokens !== undefined || data.last_turn_total_tokens !== undefined) {
              usageInfo = data;
            }
          }
        }
      } catch (err) {
        // 客户端主动断开（点停止/换一句）属正常收尾，不是故障
      logger.debug('TRAE-GW', '流式读取中断:{err}', { err: err.message });
      } finally {
        if (thinkingOpen) {
          sendSse('content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
          thinkingOpen = false;
        }
        if (textOpen) {
          sendSse('content_block_stop', { type: 'content_block_stop', index: textIndex });
          textOpen = false;
        }

        const inputTokens = Number(usageInfo?.prompt_tokens) || 0;
        const outputTokens = Number(usageInfo?.completion_tokens) || Math.ceil((emittedThinking.length + emittedText.length) / 3);
        const cacheReadTokens = Number(usageInfo?.cache_read_input_tokens) || 0;

        const deltaUsage = { output_tokens: outputTokens };
        if (inputTokens > 0) deltaUsage.input_tokens = inputTokens;
        if (cacheReadTokens > 0) deltaUsage.cache_read_input_tokens = cacheReadTokens;

        // 上游没正常收尾（断流 / EOF / reader 抛错）时,stop_reason 别伪装成 end_turn——
        // 客户端把截断的字当完整答案就再也看不见了（两个分支都报 interrupted）。
        const stopReason = streamCompleted ? 'end_turn' : 'interrupted';

        sendSse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: deltaUsage,
        });
        sendSse('message_stop', { type: 'message_stop' });
        res.end();
        cleanupSession();
      }
      return true;
    } else {
      // 非流式响应
      const reader = eventsRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullThinking = '';
      let fullText = '';
      let usageInfo = null;
      let streamCompleted = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { streamCompleted = true; break; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const data = JSON.parse(raw);
              if (data.reasoning_content) fullThinking = data.reasoning_content;
              const t = data.thought || data.tool_call_info?.params?.summary;
              if (t) fullText = t;
              if (data.prompt_tokens !== undefined || data.last_turn_total_tokens !== undefined) {
                usageInfo = data;
              }
            } catch {}
          }
        }
      } catch (err) {
        // 客户端主动断开（点停止/换一句）属正常收尾，不是故障
      logger.debug('TRAE-GW', '非流式读取中断:{err}', { err: err.message });
      } finally {
        cleanupSession();
      }

      const content = [];
      if (fullThinking) content.push({ type: 'thinking', thinking: fullThinking });
      if (fullText) content.push({ type: 'text', text: fullText });

      const inputTokens = Number(usageInfo?.prompt_tokens) || 0;
      const outputTokens = Number(usageInfo?.completion_tokens) || Math.ceil((fullThinking.length + fullText.length) / 3);
      const cacheReadTokens = Number(usageInfo?.cache_read_input_tokens) || 0;

      const usageObj = { input_tokens: inputTokens, output_tokens: outputTokens };
      if (cacheReadTokens > 0) usageObj.cache_read_input_tokens = cacheReadTokens;

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: `msg_${Date.now()}_${chatSessionId.slice(0, 8)}`,
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content,
        stop_reason: streamCompleted ? 'end_turn' : 'interrupted',
        stop_sequence: null,
        usage: usageObj,
      }));
      return true;
    }
  }

  // 全部重试失败
  const failedDetail = summarizeAttempts(attempted);
  logger.warn('TRAE-GW', '全部 {n} 次尝试失败{detail}(下一请求自动重试)', { n: attempted.length, detail: failedDetail ? ':' + failedDetail : '' });
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: '所有 Trae 账号均调用失败',
    attempts: attempted,
  }));
  return true;
}

export async function gatewayStatus() {
  const enabled = await gatewayEnabled();
  const all = (await loadAccounts()).filter((a) => a.provider === 'trae');
  const now = Date.now();
  const settings = await loadSettings();

  return {
    enabled,
    lan: settings.traeGatewayLan === true,
    allow: Array.isArray(settings.traeGatewayAllow) ? settings.traeGatewayAllow : [],
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
    endpoint: '/gateway/trae/v1/messages',
  };
}
