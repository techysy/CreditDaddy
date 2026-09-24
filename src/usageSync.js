/**
 * 本机 AI 工具用量 → 10Router 用量统计（与 10router-sync 插件 scripts/export-usage.mjs 同一口径）。
 *
 * 来源：
 *   zcode     ~/.zcode/cli/db/db.sqlite 的 model_usage（只导出官方渠道 builtin: / account:，
 *             自定义 / 网关渠道的流量已由 10Router 自身记账，导出会重复计数）
 *   opencode  ~/.local/share/opencode/opencode.db 的 session
 *   mirasim   ~/.mirasim/insights/usage-YYYY-MM.ndjson（跳过经 10Router 中转的调用）
 *   mimo      ~/.local/share/mimocode/mimocode.db 的 message（assistant 轮次）
 * 行结构与插件一致（provider 前缀 zcode- / opencode- / mirasim- / mimo-，cost 记 0 或源值），
 * 10Router 按行签名去重，重复同步不会产生重复数据。
 *
 * 增量：每个来源记住已同步到的最大时间戳，下一轮只发这之后（回退 2 天重叠兜底迟到行）的行；
 * 首次同步发送全部历史。SQLite 用 Node 内置 node:sqlite（Node 22.5+ / 桌面版 Electron 37 均可用），
 * 读取前先把数据库连同 -wal/-shm 复制到临时目录，绝不触碰客户端正在写的原文件。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SOURCES = ['zcode', 'opencode', 'mirasim', 'mimo'];
export const SOURCE_LABEL = { zcode: 'ZCode', opencode: 'OpenCode', mirasim: 'mirasim', mimo: '小米 MiMo' };
const OVERLAP_MS = 2 * 86400e3;

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
  const exist = (list) => list.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  let mirasim = [];
  const insights = path.join(home, '.mirasim', 'insights');
  try {
    mirasim = fs.readdirSync(insights).filter((f) => /^usage-\d{4}-\d{2}\.ndjson$/.test(f)).sort().map((f) => path.join(insights, f));
  } catch {}
  return { zcode: exist(zcode), opencode: exist(opencode), mirasim, mimo: exist(mimo) };
}

/** 本机检测到哪些来源 */
export async function detectSources() {
  const p = sourcePaths();
  const sqlite = await sqliteAvailable();
  return SOURCES.map((id) => ({
    id, label: SOURCE_LABEL[id],
    found: p[id].length > 0,
    files: p[id].length,
    supported: id === 'mirasim' || sqlite,
  }));
}

// ── 行转换（与插件一致） ──

const OFFICIAL_PREFIXES = ['builtin:', 'account:'];
const isOfficialProvider = (id) => OFFICIAL_PREFIXES.some((p) => String(id || '').startsWith(p));
const statusTo10r = (s) => (s === 'completed' ? 'ok' : 'error');   // cancelled 也消耗了 token，记 error

export function convertZcodeRow(row) {
  const tokens = {
    prompt_tokens: row.input_tokens || 0,
    completion_tokens: row.output_tokens || 0,
    ...(row.reasoning_tokens ? { reasoning_tokens: row.reasoning_tokens } : {}),
    ...(row.cache_creation_input_tokens ? { cache_creation_input_tokens: row.cache_creation_input_tokens } : {}),
    ...(row.cache_read_input_tokens ? { cache_read_input_tokens: row.cache_read_input_tokens } : {}),
  };
  return {
    timestamp: new Date(row.started_at || row.completed_at || Date.now()).toISOString(),
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
    timestamp: new Date(s.time_created).toISOString(),
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
  return {
    timestamp: new Date(d.time?.completed || d.time?.created || row.time_created || Date.now()).toISOString(),
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
  let skippedCustom = 0;
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
        out.push(convertZcodeRow(r));
      }
    });
  }
  return { entries: out, notes: skippedCustom ? [`跳过 ${skippedCustom} 行自定义 / 网关渠道（已在别处记账）`] : [] };
}

function collectOpencode(files) {
  const out = [];
  for (const f of files) {
    withSnapshot(f, (db) => {
      for (const r of db.prepare('SELECT id, title, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session ORDER BY time_created ASC').all()) {
        out.push(convertOpencodeSession(r));
      }
    });
  }
  return { entries: out, notes: [] };
}

function collectMimo(files) {
  const out = [];
  const seen = new Set();
  for (const f of files) {
    withSnapshot(f, (db) => {
      for (const r of db.prepare('SELECT id, session_id, time_created, data FROM message ORDER BY time_created ASC').all()) {
        let d;
        try { d = JSON.parse(r.data); } catch { continue; }
        if (d.role !== 'assistant') continue;
        if (r.id) { if (seen.has(r.id)) continue; seen.add(r.id); }
        const t = d.tokens || {};
        if (!((t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0))) continue;
        out.push(convertMimoMessage(r, d));
      }
    });
  }
  return { entries: out, notes: [] };
}

function collectMirasim(files, endpoint) {
  const out = [];
  const seen = new Set();
  let selfHosted = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      if (e.id) { if (seen.has(e.id)) continue; seen.add(e.id); }
      if (isSelfHostedUpstream(e.upstreamHost, endpoint)) { selfHosted++; continue; }
      if (!((e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0))) continue;
      out.push(convertMirasimRow(e));
    }
  }
  return { entries: out, notes: selfHosted ? [`跳过 ${selfHosted} 行经 10Router 中转的调用（已在 10Router 记账）`] : [] };
}

/** 读取某来源的全部行：{ entries, notes, files }；来源不存在返回 entries=[] */
export async function collectSource(id, { endpoint, paths = sourcePaths() } = {}) {
  const files = paths[id] || [];
  if (!files.length) return { entries: [], notes: [], files: 0 };
  if (id !== 'mirasim' && !(await sqliteAvailable())) throw new Error('需要 Node 22.5+（node:sqlite）才能读取 ' + SOURCE_LABEL[id] + ' 的数据库');
  const r = id === 'zcode' ? collectZcode(files)
    : id === 'opencode' ? collectOpencode(files)
      : id === 'mimo' ? collectMimo(files)
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
