/**
 * 10Router 集成：用 10Router 仪表盘的虚拟 key（sk-…）
 *   1. 读取 10Router 其他供应商的额度总览（GET /api/usage/quotas，10Router 1.2.1+）
 *   2. 把本机 ZCode / OpenCode / mirasim / 小米 MiMo 的用量同步进 10Router 的用量统计
 *      （POST /api/settings/database/import-usage，与 10router-sync 插件同一接口，10Router 1.0.7+）
 *
 * 配置存 ~/.creditdaddy/tenrouter.json（0600，含 key，不随账号导出）；
 * key 只由守护进程使用，面板拿到的永远是脱敏值。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './store.js';
import { logger } from './logger.js';
import { SOURCES, SOURCE_LABEL, collectSource, selectSince, detectSources } from './usageSync.js';

const FILE = () => path.join(dataDir(), 'tenrouter.json');
const QUOTA_TIMEOUT_MS = 90_000;   // 10Router 端并发查询全部供应商，冷缓存时可能较慢
const IMPORT_TIMEOUT_MS = 120_000;
const BATCH = 5000;
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CONFIG = { endpoint: '', key: '', sync: { enabled: false, sources: [...SOURCES] }, syncState: {}, lastSync: null };

export function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return { ...DEFAULT_CONFIG, ...c, sync: { ...DEFAULT_CONFIG.sync, ...(c.sync || {}) }, syncState: c.syncState || {} };
  } catch { return structuredClone(DEFAULT_CONFIG); }
}

function saveConfig(c) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

// 读改写串行，避免面板保存与后台同步互相覆盖
let chain = Promise.resolve();
function withConfig(fn) {
  const run = chain.then(async () => { const c = loadConfig(); const r = await fn(c); saveConfig(c); return r; });
  chain = run.catch(() => {});
  return run;
}

export function normalizeEndpoint(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);   // 非法地址直接抛错
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

const maskKey = (k) => (k ? (k.length > 12 ? k.slice(0, 5) + '…' + k.slice(-4) : '…') : '');
export const isConfigured = (c = loadConfig()) => Boolean(c.endpoint && c.key);

/** 面板用的配置视图（key 脱敏） */
export async function publicConfig() {
  const c = loadConfig();
  return {
    configured: isConfigured(c),
    endpoint: c.endpoint,
    keyMasked: maskKey(c.key),
    sync: c.sync,
    lastSync: c.lastSync,
    syncing: Boolean(syncing),
    sources: await detectSources(),
  };
}

/** 更新配置：key 留空表示保持原值；endpoint 为空 = 清除整个配置 */
export function updateConfig({ endpoint, key, syncEnabled, sources } = {}) {
  return withConfig((c) => {
    if (endpoint !== undefined) {
      c.endpoint = normalizeEndpoint(endpoint);
      if (!c.endpoint) { Object.assign(c, structuredClone(DEFAULT_CONFIG)); return; }
    }
    if (typeof key === 'string' && key.trim()) {
      const k = key.trim();
      if (/\s/.test(k)) throw new Error('key 不能包含空白字符');
      c.key = k;
    }
    if (typeof syncEnabled === 'boolean') c.sync.enabled = syncEnabled;
    if (Array.isArray(sources)) c.sync.sources = sources.filter((s) => SOURCES.includes(s));
  });
}

async function call(c, pathname, { method = 'GET', body, timeout = QUOTA_TIMEOUT_MS } = {}) {
  if (!isConfigured(c)) throw Object.assign(new Error('尚未配置 10Router 地址与 key'), { code: 'NOT_CONFIGURED' });
  let res;
  try {
    res = await fetch(c.endpoint + pathname, {
      method,
      headers: { Authorization: `Bearer ${c.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`无法连接 10Router（${c.endpoint}）：${e.cause?.code || e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('10Router 拒绝了这个 key（请确认是仪表盘里的虚拟 key sk-…，且未被停用）'), { code: 'BAD_KEY' });
  if (res.status === 404 && pathname.startsWith('/api/usage/quotas')) {
    throw Object.assign(new Error('这个 10Router 版本还没有额度总览接口，需要 10Router 1.2.1 及以上'), { code: 'TOO_OLD' });
  }
  if (!res.ok) throw new Error(`10Router 返回 HTTP ${res.status}${data?.error ? '：' + data.error : ''}`);
  if (data === null) throw new Error('10Router 返回的不是 JSON（地址是否指向了 10Router？）');
  return data;
}

/** 其他供应商的额度总览（10Router 端已按仪表盘同一口径归一） */
export async function fetchQuotas({ force = false } = {}) {
  const data = await call(loadConfig(), '/api/usage/quotas' + (force ? '?force=1' : ''));
  return {
    generatedAt: data.generatedAt || new Date().toISOString(),
    connections: Array.isArray(data.connections) ? data.connections : [],
  };
}

/** 测试连接：用额度接口同时验证地址与 key；老版本 10Router 只能同步用量时也视为可用 */
export async function testConnection(override) {
  const c = { ...loadConfig(), ...(override || {}) };
  try {
    const q = await call(c, '/api/usage/quotas');
    return { ok: true, quotas: true, connections: (q.connections || []).length };
  } catch (e) {
    if (e.code === 'TOO_OLD') return { ok: true, quotas: false, warning: e.message };
    return { ok: false, error: e.message, code: e.code };
  }
}

// ── 用量同步 ──

let syncing = null;
let timer = null;

/** 同步一轮；并发调用共用同一轮。dryRun 只统计不上传。 */
export function runUsageSync({ dryRun = false, trigger = 'manual' } = {}) {
  if (!syncing) syncing = doSync({ dryRun, trigger }).finally(() => { syncing = null; });
  return syncing;
}

async function doSync({ dryRun, trigger }) {
  const c = loadConfig();
  if (!isConfigured(c)) throw Object.assign(new Error('尚未配置 10Router 地址与 key'), { code: 'NOT_CONFIGURED' });
  const results = [];
  for (const id of c.sync.sources) {
    const label = SOURCE_LABEL[id];
    try {
      const { entries, notes, files } = await collectSource(id, { endpoint: c.endpoint });
      if (!files) { results.push({ source: id, label, status: 'absent' }); continue; }
      const { selected, maxTs } = selectSince(entries, c.syncState[id]?.lastTs);
      if (dryRun || !selected.length) {
        results.push({ source: id, label, status: dryRun ? 'dry-run' : 'up-to-date', total: entries.length, selected: selected.length, notes });
        continue;
      }
      let imported = 0, skipped = 0;
      for (let i = 0; i < selected.length; i += BATCH) {
        const r = await call(c, '/api/settings/database/import-usage', {
          method: 'POST', body: { usageHistory: selected.slice(i, i + BATCH) }, timeout: IMPORT_TIMEOUT_MS,
        });
        imported += r.imported || 0;
        skipped += r.skipped || 0;
      }
      await withConfig((cc) => { cc.syncState[id] = { lastTs: maxTs, at: new Date().toISOString() }; });
      results.push({ source: id, label, status: 'ok', total: entries.length, selected: selected.length, imported, skipped, notes });
    } catch (e) {
      results.push({ source: id, label, status: 'failed', error: e.message });
      if (e.code === 'BAD_KEY') break;   // key 不对，后面的来源也不用试了
    }
  }
  const imported = results.reduce((n, r) => n + (r.imported || 0), 0);
  const failed = results.filter((r) => r.status === 'failed');
  const summary = dryRun
    ? '预览：' + results.map((r) => `${r.label} ${r.status === 'absent' ? '未检测到' : (r.selected ?? 0) + ' 行'}`).join('，')
    : failed.length
      ? `同步完成：新增 ${imported} 行，${failed.length} 个来源失败（${failed.map((r) => r.label + '：' + r.error).join('；')}）`
      : `同步完成：新增 ${imported} 行`;
  if (!dryRun) {
    await withConfig((cc) => { cc.lastSync = { at: new Date().toISOString(), trigger, summary, results }; });
    (failed.length ? logger.warn : logger.info).call(logger, '10R', summary);
  }
  return { summary, results };
}

/** 后台每小时同步一次（仅在配置了且开启自动同步时） */
export function startUsageSyncScheduler() {
  if (timer) return;
  const tick = () => {
    const c = loadConfig();
    if (!isConfigured(c) || !c.sync.enabled) return;
    runUsageSync({ trigger: 'auto' }).catch((e) => logger.warn('10R', '自动同步失败：' + e.message));
  };
  setTimeout(tick, 60_000).unref?.();   // 启动 1 分钟后先跑一轮
  timer = setInterval(tick, SYNC_INTERVAL_MS);
  timer.unref?.();
}
