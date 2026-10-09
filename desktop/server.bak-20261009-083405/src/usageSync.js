/**
 * 本机 AI 工具用量 → 10Router 用量统计（与 10router-sync 插件 scripts/export-usage.mjs 同一口径）。
 *
 * 来源：
 *   zcode     ~/.zcode/cli/db/db.sqlite 的 model_usage（只导出官方渠道 builtin: / account:，
 *             自定义 / 网关渠道的流量已由 10Router 自身记账，导出会重复计数）
 *   opencode  ~/.local/share/opencode/opencode.db 的 session
 *   mirasim   ~/.mirasim/insights/usage-YYYY-MM.ndjson（跳过经 10Router 中转的调用）
 *   mimo      ~/.local/share/mimocode/mimocode.db 的 message（assistant 轮次）
 *   catpaw    妙手云端用量（catx 网关 /v1/usage/token/daily，按天 token 总量；
 *             无输入/输出拆分，整包记 prompt_tokens；当天桶隔天再入账）
 * 行结构与插件一致（provider 前缀 zcode- / opencode- / mirasim- / mimo-，cost 记 0 或源值），
 * 10Router 按行内容签名去重——签名 = (时间戳, provider, model, connectionId, apiKeyHash,
 * 输入 token, 输出 token)，行内容一模一样才会被认作重复；行内容还在变（会话进行中、
 * 按天聚合桶增长）就会被当成新行。所以客户端要保证发出去的行已经定型：
 *   - 可能回填/累计的来源（opencode 会话、mimo 消息）在结算窗 SETTLE_MS 内暂不发送；
 *   - 妙手按天桶只发差量，桶增长不再整包重发；
 *   - 时间戳缺失的行直接跳过，绝不用 Date.now() 兜底（每次同步都会变成“新行”）。
 *
 * 增量：每个来源记住已同步到的最大时间戳，下一轮只发这之后（回退 2 天重叠兜底迟到行）的行；
 * 首次同步发送全部历史。SQLite 用 Node 内置 node:sqlite（Node 22.5+ / 桌面版 Electron 37 均可用），
 * 读取前先把数据库连同 -wal/-shm 复制到临时目录，绝不触碰客户端正在写的原文件。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccounts } from './store.js';
import { fetchCatpawTokenDaily } from './catpawClient.js';

export const SOURCES = ['zcode', 'opencode', 'mirasim', 'mimo', 'catpaw', '10r'];
export const SOURCE_LABEL = { zcode: 'ZCode', opencode: 'OpenCode', mirasim: 'mirasim', mimo: '小米 MiMo', catpaw: '妙手', '10r': '10Router 本机' };
const OVERLAP_MS = 2 * 86400e3;
/** 结算窗：时间戳在此窗口内的行可能还在被来源更新（token 累计、时间字段回填），暂不发送 */
const SETTLE_MS = 60 * 60 * 1000;

let sqliteMod;
/** node:sqlite 是否可用（Node 22.5+）；不可用时 SQLite 来源跳过，mirasim（ndjson）仍可同步 */
export async function sqliteAvailable() {
  if (sqliteMod === undefined) {
    try {
      // 屏蔽 “SQLite is an experimental feature” 警告，避免刷进日志
      const emit = process.emitWarning;
      process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
      try { sqliteMod = await import('node:sqlite'); } finally { process.emitWarning = emit; }
    } catch { sqliteMod = null; }
  }
  return Boolean(sqliteMod);
}

// ── 路径 ──

export function sourcePaths(home = os.homedir(), env = process.env, platform = process.platform) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const zcode = [path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')];
  try {
    const projects = path.join(home, '.zcode', 'projects');
    for (const name of fs.readdirSync(projects)) zcode.push(path.join(projects, name, 'db.sqlite'));
  } catch {}
  const opencode = [path.join(home, '.local', 'share', 'opencode', 'opencode.db')];
  if (platform === 'win32') opencode.push(path.join(local, 'opencode', 'opencode.db'));
  const mimo = [path.join(home, '.local', 'share', 'mimocode', 'mimocode.db')];
  if (platform === 'win32') {
    mimo.push(path.join(home, 'AppData', 'Roaming', 'Xiaomi MiMo', 'mimocode.db'));
    mimo.push(path.join(home, 'AppData', 'Roaming', 'Xiaomi MiMo', 'mimocode', 'mimocode.db'));
    mimo.push(path.join(local, 'mimocode', 'mimocode.db'));
  }
  // 本机 10Router/9Router 实例的记账库（同 10router-sync 插件 --source 10r 的发现逻辑）；
  // TENROUTER_DB 可显式指向另一个实例的库
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const routerDb = [];
  if (env.TENROUTER_DB) routerDb.push(env.TENROUTER_DB);
  if (platform === 'win32') {
    routerDb.push(path.join(roaming, '10router', 'db', 'data.sqlite'));
    routerDb.push(path.join(roaming, '9router', 'db', 'data.sqlite'));
  } else {
    routerDb.push(path.join(home, '.10router', 'db', 'data.sqlite'));
    routerDb.push(path.join(home, '.9router', 'db', 'data.sqlite'));
  }
  const exist = (list) => list.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  let mirasim = [];
  const insights = path.join(home, '.mirasim', 'insights');
  try {
    mirasim = fs.readdirSync(insights).filter((f) => /^usage-\d{4}-\d{2}\.ndjson$/.test(f)).sort().map((f) => path.join(insights, f));
  } catch {}
  return { zcode: exist(zcode), opencode: exist(opencode), mirasim, mimo: exist(mimo), '10r': exist(routerDb) };
}

/** 本机检测到哪些来源 */
export async function detectSources() {
  const p = sourcePaths();
  const sqlite = await sqliteAvailable();
  const catpawAccounts = (await loadAccounts()).filter((a) => a.provider === 'catpaw' && a.token).length;
  return SOURCES.map((id) => ({
    id, label: SOURCE_LABEL[id],
    found: id === 'catpaw' ? catpawAccounts > 0 : p[id].length > 0,
    files: id === 'catpaw' ? catpawAccounts : p[id].length,
    supported: id === 'mirasim' || id === 'catpaw' || sqlite,
  }));
}

// ── 行转换（与插件一致） ──

const OFFICIAL_PREFIXES = ['builtin:', 'account:'];
const isOfficialProvider = (id) => OFFICIAL_PREFIXES.some((p) => String(id || '').startsWith(p));
const statusTo10r = (s) => (s === 'completed' ? 'ok' : 'error');   // cancelled 也消耗了 token，记 error

export function convertZcodeRow(row) {
  const ms = Number(row.started_at || row.completed_at);
  if (!Number.isFinite(ms) || ms <= 0) return null;   // 缺时间戳不能用 Date.now() 兜底：每次同步都是一条“新行”
  const tokens = {
    prompt_tokens: row.input_tokens || 0,
    completion_tokens: row.output_tokens || 0,
    ...(row.reasoning_tokens ? { reasoning_tokens: row.reasoning_tokens } : {}),
    ...(row.cache_creation_input_tokens ? { cache_creation_input_tokens: row.cache_creation_input_tokens } : {}),
    ...(row.cache_read_input_tokens ? { cache_read_input_tokens: row.cache_read_input_tokens } : {}),
  };
  return {
    timestamp: new Date(ms).toISOString(),
    provider: 'zcode-' + String(row.provider_id || 'unknown').replace(/^(builtin:|account:)/, ''),
    model: row.model_id || 'unknown',
    connectionId: null, apiKey: null,
    endpoint: 'zcode://' + (row.agent || 'session'),
    cost: 0,   // 官方渠道是订阅套餐，不是按量计费
    status: statusTo10r(row.status),
    tokens,
    meta: {
      source: 'zcode', zcodeProviderId: row.provider_id || null, agent: row.agent || null,
      sessionId: row.session_id || null, durationMs: row.duration_ms ?? null, planUsage: true,
    },
  };
}

export function convertOpencodeSession(s) {
  const ms = Number(s.time_created);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  let modelId = 'unknown', providerID = 'opencode';
  if (s.model) {
    try {
      const m = typeof s.model === 'string' ? JSON.parse(s.model) : s.model;
      modelId = m.id || 'unknown';
      providerID = m.providerID || 'opencode';
    } catch { modelId = String(s.model); }
  }
  const tokens = { prompt_tokens: s.tokens_input || 0, completion_tokens: s.tokens_output || 0 };
  if (s.tokens_cache_read) tokens.cache_read_input_tokens = s.tokens_cache_read;
  return {
    timestamp: new Date(ms).toISOString(),
    provider: 'opencode-' + providerID,
    model: modelId,
    connectionId: null, apiKey: null,
    endpoint: 'opencode://desktop',
    cost: s.cost || 0,
    status: 'ok',
    tokens,
    meta: {
      source: 'opencode', opencodeSessionId: s.id || null, title: s.title || null, agent: s.agent || null,
      reasoning_tokens: s.tokens_reasoning || 0, cache_write_tokens: s.tokens_cache_write || 0,
    },
  };
}

export function convertMimoMessage(row, d) {
  const t = d.tokens || {};
  const tokens = {
    prompt_tokens: t.input || 0,
    completion_tokens: t.output || 0,
    ...(t.reasoning ? { reasoning_tokens: t.reasoning } : {}),
    ...(t.cache?.read ? { cache_read_input_tokens: t.cache.read } : {}),
    ...(t.cache?.write ? { cache_creation_input_tokens: t.cache.write } : {}),
  };
  const ms = Number(d.time?.completed || d.time?.created || row.time_created);
  if (!Number.isFinite(ms) || ms <= 0) return null;   // 缺时间戳宁可不发：Date.now() 兜底每次都会变成“新行”
  return {
    timestamp: new Date(ms).toISOString(),
    provider: 'mimo-' + (d.providerID || 'mimo'),
    model: d.modelID || 'unknown',
    connectionId: null, apiKey: null,
    endpoint: 'mimo://' + (d.agent || 'desktop'),
    cost: d.cost || 0,
    status: 'ok',
    tokens,
    meta: { source: 'mimo', mimoMessageId: row.id || null, sessionId: row.session_id || null, agent: d.agent || null, mode: d.mode || null, planUsage: true },
  };
}

/** mirasim 调用若经本机 / 局域网的 10Router 中转，10Router 自己已记过账，再导入会重复 */
export function isSelfHostedUpstream(upstreamHost, endpointUrl) {
  if (!upstreamHost) return false;
  let host = upstreamHost, port = null;
  try {
    const u = new URL(upstreamHost.includes('://') ? upstreamHost : `http://${upstreamHost}`);
    host = u.hostname;
    port = u.port ? Number(u.port) : 80;
  } catch {}
  const isPrivate = host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (!isPrivate) return false;
  if (endpointUrl) {
    try { if (new URL(endpointUrl).hostname === host) return true; } catch {}
  }
  return port === 20127 || port === 20128 || port === 80 || port === 443;
}

export function convertMirasimRow(e) {
  // mirasim 的 input 只算净新增（缓存分列），真实输入 = input + cacheRead + cacheWrite
  const tokens = { prompt_tokens: (e.input || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0), completion_tokens: e.output || 0 };
  if (e.cacheRead) tokens.cache_read_input_tokens = e.cacheRead;
  if (e.cacheWrite) tokens.cache_creation_input_tokens = e.cacheWrite;
  if (e.reasoning) tokens.reasoning_tokens = e.reasoning;
  const ok = (e.status || 0) >= 200 && (e.status || 0) < 400;
  return {
    timestamp: e.ts,
    provider: 'mirasim-' + String(e.provider || 'unknown'),
    model: e.model || 'unknown',
    connectionId: null, apiKey: null,
    endpoint: 'mirasim://' + (e.agent || e.leg || 'relay'),
    cost: 0,
    status: ok ? 'ok' : 'error',
    tokens,
    meta: {
      source: 'mirasim', mirasimCallId: e.id || null, relayCallId: e.relayCallId || null, agent: e.agent || null,
      leg: e.leg || null, viaRelay: e.viaRelay ?? null, upstreamHost: e.upstreamHost || null, effort: e.effort || null,
      httpStatus: e.status ?? null, durationMs: e.durationMs ?? null, repo: e.repo || null, workspace: e.workspace || null,
      planUsage: true,
    },
  };
}

/**
 * 妙手（CatPaw）云端按天用量 → 行。
 * 云端只有一个总数（无输入/输出/缓存拆分、无模型维度），整包记入 prompt_tokens
 * （LLM 负载输入占大头，这样拆分偏差最小）；成本记 0（套餐制，与 zcode 官方渠道同口径）。
 * connectionId 参与 10Router 行签名，用它区分多账号，避免同日同量互相去重。
 */
export function convertCatpawDaily(date, deltaTokens, account, modelLabel = 'unknown', seq = 0, totalTokens = deltaTokens) {
  const [y, m, d] = String(date).split('-').map(Number);
  // 本地正午锚点：任何时区都落在当天；seq 秒偏移让同日多段差量签名不同（否则等量差量会被去重误杀）
  const ts = new Date(y, (m || 1) - 1, d || 1, 12, 0, seq % 60);
  return {
    timestamp: ts.toISOString(),
    provider: 'catpaw-catx',
    model: modelLabel,
    connectionId: 'catpaw-' + account.id,
    apiKey: null,
    endpoint: 'catpaw://daily',
    cost: 0,
    status: 'ok',
    tokens: { prompt_tokens: deltaTokens, completion_tokens: 0 },
    meta: {
      source: 'catpaw', aggregate: 'daily', unsplitTokens: true, planUsage: true,
      catpawAccountId: account.id, accountName: account.name || null,
      date, deltaTokens, totalTokens, seq,
    },
  };
}

const localDateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 妙手云端用量：逐账号拉按天 token 总量（当天桶不完整，留到隔天再入账）。
 * 云端按天桶会随补录增长，整包重发会被 10Router 当成新行（token 数不同、签名不同）→ 同一天记多行。
 * 所以按 sentTotals 记账只发差量：桶没长就不发；桶长了只发增量，时间戳按发送次数错开秒。
 */
async function collectCatpaw(accounts, modelLabel, sentTotals = {}) {
  const out = [];
  const notes = [];
  const nextSent = {};
  const now = Date.now();
  const todayKey = localDateKey();
  let failed = 0, lastErr = null;
  for (const a of accounts) {
    try {
      const daily = await fetchCatpawTokenDaily(a.token, { startTime: now - 400 * 86400e3, endTime: now });
      for (const d of daily) {
        if (!d || !d.date || !(Number(d.totalTokens) > 0)) continue;
        if (d.date >= todayKey) continue;
        const key = a.id + '|' + d.date;
        const total = Number(d.totalTokens);
        const prev = sentTotals[key] || { total: 0, parts: 0 };
        const delta = total - (Number(prev.total) || 0);
        if (delta <= 0) { nextSent[key] = prev; continue; }   // 桶没长（或云端回撤）：不重发
        out.push(convertCatpawDaily(d.date, delta, a, modelLabel, prev.parts || 0, total));
        nextSent[key] = { total, parts: (prev.parts || 0) + 1 };
      }
    } catch (e) { failed++; lastErr = e; }
  }
  if (failed && !out.length) throw lastErr;
  if (failed) notes.push(`${failed} 个妙手账号用量拉取失败：${lastErr && lastErr.message}`);
  out.sort((x, y) => (x.timestamp < y.timestamp ? -1 : 1));
  return { entries: out, notes, nextSentTotals: { ...sentTotals, ...nextSent } };
}

/** 本机 10Router/9Router 的 usageHistory 行 → 导入行（同 10router-sync 插件 --source 10r）。
 * 平面列 + tokens/meta JSON 原样保留：10R 原生行带真实计费与错误状态，不做任何归零；
 * meta.gatewaySync 只标「源实例原生产生的行」，源实例自己从别处导入的行保持 imported 标记，
 * 聚合端据此排除健康度统计、并按行签名去重。 */
export function convertRouterRow(row, dbPath, tag = 'creditdaddy') {
  const safeParse = (v) => {
    if (v && typeof v === 'object') return v;
    try { return v ? JSON.parse(v) : {}; } catch { return {}; }
  };
  const tokens = safeParse(row.tokens);
  const meta = safeParse(row.meta);
  if (!meta.source) meta.source = '10r';
  meta.syncedFrom = tag || dbPath;
  meta.sourceDbPath = dbPath;   // 机器可查的出处，同实例防护据此拒绝回灌
  if (meta.imported !== true) meta.gatewaySync = true;
  if (row.connectionId) meta.sourceConnectionId = row.connectionId;
  return {
    timestamp: row.timestamp,
    provider: row.provider || 'unknown',
    model: row.model || 'unknown',
    connectionId: null,   // 源实例的连接 uuid 对聚合端无意义，只留在 meta 里
    apiKey: row.apiKey || null,
    endpoint: row.endpoint || null,
    promptTokens: row.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completionTokens: row.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0,
    cost: row.cost || 0,
    status: row.status || 'ok',
    tokens,
    meta,
  };
}

function isLoopbackEndpoint(url) {
  try {
    const u = new URL(String(url || '').includes('://') ? url : 'http://' + url);
    return u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]' || /^127\./.test(u.hostname);
  } catch { return false; }
}

function collectRouter(files, endpoint) {
  // 同实例防护（同插件的 exit 2 守卫）：地址是本机回环时，探测到的本机实例库就是它自己的账，
  // 导回去会让存量行被打上 meta.imported 且全部去重命中。聚合端应把地址指向 NAS / 远端实例。
  if (isLoopbackEndpoint(endpoint)) {
    return { entries: [], notes: ['配置的 10Router 地址是本机回环：本机实例库就是它自己的账，不同步（聚合请把地址指向 NAS / 远端实例）'], files: files.length };
  }
  const out = [];
  let noTs = 0;
  for (const f of files) {
    withSnapshot(f, (db) => {
      let rows;
      try {
        rows = db.prepare('SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory ORDER BY id ASC').all();
      } catch {
        rows = db.prepare('SELECT timestamp, provider, model, promptTokens, completionTokens, tokens FROM usageHistory ORDER BY id ASC').all();
      }
      for (const r of rows) {
        // NULL 时间戳的行会让服务端按「当下」回填，每次签名都不同，去重失效——绝不发
        if (!r.timestamp) { noTs++; continue; }
        out.push(convertRouterRow(r, f));
      }
    });
  }
  const notes = [];
  if (noTs) notes.push(`跳过 ${noTs} 行无时间戳（会导致去重失效）`);
  out.sort((x, y) => (x.timestamp < y.timestamp ? -1 : 1));
  return { entries: out, notes, files: files.length };
}

// ── 读取 ──

function withSnapshot(dbPath, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-usage-'));
  try {
    const dst = path.join(tmp, 'db.sqlite');
    fs.copyFileSync(dbPath, dst);
    for (const sfx of ['-wal', '-shm']) if (fs.existsSync(dbPath + sfx)) fs.copyFileSync(dbPath + sfx, dst + sfx);
    const db = new sqliteMod.DatabaseSync(dst, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function collectZcode(files) {
  const out = [];
  const seen = new Set();
  let skippedCustom = 0, skippedNoTs = 0;
  for (const f of files) {
    withSnapshot(f, (db) => {
      let rows;
      try {
        rows = db.prepare('SELECT logical_request_id, provider_id, model_id, agent, status, started_at, completed_at, duration_ms, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM model_usage ORDER BY started_at ASC').all();
      } catch {
        rows = db.prepare('SELECT logical_request_id, provider_id, model_id, agent, status, started_at, completed_at, duration_ms, input_tokens, output_tokens FROM model_usage ORDER BY started_at ASC').all();
      }
      for (const r of rows) {
        if (!isOfficialProvider(r.provider_id)) { skippedCustom++; continue; }
        if (r.provider_id && r.logical_request_id) {
          const k = `${r.provider_id}|${r.logical_request_id}`;
          if (seen.has(k)) continue;
          seen.add(k);
        }
        const e = convertZcodeRow(r);
        if (!e) { skippedNoTs++; continue; }
        out.push(e);
      }
    });
  }
  return { entries: out, notes: (skippedCustom ? [`跳过 ${skippedCustom} 行自定义 / 网关渠道（已在别处记账）`] : []).concat(skippedNoTs ? [`跳过 ${skippedNoTs} 行缺时间戳的记录（无稳定签名，避免每次同步都当成新行）`] : []) };
}

// OpenCode 一个会话一行（会话级累计），会话还在继续时 token 会变 → 签名变 → 10Router 去重拦不住，
// 同一会话会被记成两行。所以最近 SETTLE_MS 内仍在更新的会话（或更新时间不可信的）先不同步，等它停下来再同步。
function collectOpencode(files, now = Date.now()) {
  const out = [];
  let active = 0, skippedNoTs = 0;
  for (const f of files) {
    withSnapshot(f, (db) => {
      for (const r of db.prepare('SELECT id, title, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session ORDER BY time_created ASC').all()) {
        if (!Number.isFinite(r.time_updated) || now - r.time_updated < SETTLE_MS) { active++; continue; }
        const e = convertOpencodeSession(r);
        if (!e) { skippedNoTs++; continue; }
        out.push(e);
      }
    });
  }
  return { entries: out, notes: (active ? [`暂不同步 ${active} 个进行中的会话（1 小时内仍有更新，结束后再同步，避免同一会话记两行）`] : []).concat(skippedNoTs ? [`跳过 ${skippedNoTs} 行缺时间戳的会话`] : []) };
}

function collectMimo(files, now = Date.now()) {
  const out = [];
  const seen = new Set();
  let unsettled = 0, skippedNoTs = 0;
  for (const f of files) {
    withSnapshot(f, (db) => {
      for (const r of db.prepare('SELECT id, session_id, time_created, data FROM message ORDER BY time_created ASC').all()) {
        let d;
        try { d = JSON.parse(r.data); } catch { continue; }
        if (d.role !== 'assistant') continue;
        if (r.id) { if (seen.has(r.id)) continue; seen.add(r.id); }
        const t = d.tokens || {};
        if (!((t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0))) continue;
        // 消息落库后 token / 完成时间还可能回填：没有 time.completed 或刚完成的先不同步，等它定型
        const doneMs = Number(d.time?.completed);
        if (!Number.isFinite(doneMs) || doneMs <= 0 || now - doneMs < SETTLE_MS) {
          const anyMs = Number(d.time?.created || r.time_created);
          if (Number.isFinite(anyMs) && anyMs > 0) unsettled++; else skippedNoTs++;
          continue;
        }
        const e = convertMimoMessage(r, d);
        if (!e) { skippedNoTs++; continue; }
        out.push(e);
      }
    });
  }
  return { entries: out, notes: (unsettled ? [`暂不同步 ${unsettled} 行未定型的消息（1 小时内完成或完成时间缺失，结束后再同步，避免同一消息记两行）`] : []).concat(skippedNoTs ? [`跳过 ${skippedNoTs} 行缺时间戳的消息`] : []) };
}

function collectMirasim(files, endpoint, now = Date.now()) {
  const out = [];
  const seen = new Set();
  let selfHosted = 0, unsettled = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      if (e.id) { if (seen.has(e.id)) continue; seen.add(e.id); }
      if (isSelfHostedUpstream(e.upstreamHost, endpoint)) { selfHosted++; continue; }
      if (!((e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0))) continue;
      // 刚发生的调用可能还在补字段（durationMs / token 等），定型前先不发
      const tsMs = Date.parse(e.ts);
      if (!Number.isFinite(tsMs) || now - tsMs < SETTLE_MS) { unsettled++; continue; }
      out.push(convertMirasimRow(e));
    }
  }
  return { entries: out, notes: (selfHosted ? [`跳过 ${selfHosted} 行经 10Router 中转的调用（已在 10Router 记账）`] : []).concat(unsettled ? [`暂不同步 ${unsettled} 行 1 小时内的新调用（等记录定型）`] : []) };
}

/** 读取某来源的全部行：{ entries, notes, files, sentTotals? }；来源不存在返回 entries=[] */
export async function collectSource(id, { endpoint, paths = sourcePaths(), catpawModel, sentTotals } = {}) {
  if (id === 'catpaw') {
    const accounts = (await loadAccounts()).filter((a) => a.provider === 'catpaw' && a.token);
    if (!accounts.length) return { entries: [], notes: [], files: 0 };
    // catx 网关当前只出 GLM-5.3-FlashX——未配置时用真实模型名，避免 10r 里显示「未知」
    const r = await collectCatpaw(accounts, catpawModel || 'GLM-5.3-FlashX', sentTotals || {});
    return { ...r, files: accounts.length };
  }
  const files = paths[id] || [];
  if (!files.length) return { entries: [], notes: [], files: 0 };
  if (id !== 'mirasim' && !(await sqliteAvailable())) throw new Error('需要 Node 22.5+（node:sqlite）才能读取 ' + SOURCE_LABEL[id] + ' 的数据库');
  const r = id === 'zcode' ? collectZcode(files)
    : id === 'opencode' ? collectOpencode(files)
      : id === 'mimo' ? collectMimo(files)
        : id === '10r' ? collectRouter(files, endpoint)
          : collectMirasim(files, endpoint);
  return { ...r, files: files.length };
}

/** 增量筛选：只保留 watermark - 重叠 之后的行；返回 { selected, maxTs } */
export function selectSince(entries, watermarkIso) {
  const since = watermarkIso ? new Date(watermarkIso).getTime() - OVERLAP_MS : -Infinity;
  let maxTs = watermarkIso || null;
  const selected = [];
  for (const e of entries) {
    const t = new Date(e.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    if (t >= since) selected.push(e);
    if (!maxTs || t > new Date(maxTs).getTime()) maxTs = new Date(t).toISOString();
  }
  return { selected, maxTs };
}
