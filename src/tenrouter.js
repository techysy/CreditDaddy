/**
 * 10Router 集成：用 10Router 仪表盘的虚拟 key（sk-…）
 *   1. 读取 10Router 其他供应商的额度总览（GET /api/usage/quotas，10Router 1.2.1+）
 *   2. 把本机 ZCode / OpenCode / mirasim / 小米 MiMo 的用量与妙手（CatPaw）云端用量同步进 10Router 的用量统计
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
import { t } from './i18n.js';
import { SOURCES, SOURCE_LABEL, collectSource, selectSince, detectSources } from './usageSync.js';

const FILE = () => path.join(dataDir(), 'tenrouter.json');
const QUOTA_TIMEOUT_MS = 90_000;   // 10Router 端并发查询全部供应商，冷缓存时可能较慢
const IMPORT_TIMEOUT_MS = 120_000;
const BATCH = 5000;
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CONFIG = {
  endpoint: '',
  key: '',
  adminPassword: '',
  sync: { enabled: false, sources: [...SOURCES], sourcesVersion: 2 },
  syncState: {},
  lastSync: null,
  quotaPush: { enabled: true, intervalMin: 60, lastPush: null },
  // 账号连接同步（账号管理弹窗「同步账号到 10R」）：enabled 总开关 + 渠道勾选。
  // providers 空 = 全部候选渠道（向后兼容老配置）；渠道是 CD provider 视角
  // （qoder / qoder-cn / workbuddy / workbuddy-intl / tokenharbor）。
  accountSync: { enabled: true, providers: [] },
  // 额度卡推送的渠道排除：10Router 已单独配了同源渠道（如 minimax-code 连接）时，
  // 免去 CD 侧维护同名免费卡（minimax-free-*），两边卡片重复且数字各刷新各的。
  // 记「明确不推」的 CD provider，空 = 全推。
  quotaPushDisabledProviders: [],
};
// v1.0.0 及更早保存的来源全集；版本迁移只补「此后新增」的来源，不复活用户手动关掉的
const LEGACY_SOURCES = ['zcode', 'opencode', 'mirasim', 'mimo', 'catpaw'];
const SOURCES_VERSION = 3;   // 3: 新增 10Router 本机实例来源（10r）

export function loadConfig() {
  try {
    return normalizeLoaded(JSON.parse(fs.readFileSync(FILE(), 'utf8')));
  } catch (e) {
    // 只有「文件不存在」才回默认值。EPERM/EBUSY（杀软/同步盘瞬时占用）或 JSON 损坏时
    // 返回默认对象，下一个 withConfig 会把「默认值 + 本轮改动」整份写回——端点、key、
    // 同步水位全部被静默抹掉，且 catpaw 的 sentTotals 清零会让历史用量整段重发。宁可报错。
    if (e.code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    if (e instanceof SyntaxError) {
      try {
        const bak = JSON.parse(fs.readFileSync(FILE() + '.bak', 'utf8'));
        console.error('tenrouter: 配置文件损坏,已用备份恢复 ' + FILE() + '.bak');
        return normalizeLoaded(bak);
      } catch { /* 备份也没有/同坏——按原错误上抛，禁止用默认值覆盖现场 */ }
    }
    throw new Error(`读取 ${FILE()} 失败: ${e.message}`);
  }
}

// loadConfig 的归一化（旧配置 sources 快照迁移等，主文件与 .bak 同一形状）
function normalizeLoaded(c) {
  const sync = { ...DEFAULT_CONFIG.sync, ...(c.sync || {}) };
  const quotaPush = { ...DEFAULT_CONFIG.quotaPush, ...(c.quotaPush || {}) };
  const accountSync = { ...DEFAULT_CONFIG.accountSync, ...(c.accountSync || {}) };
  // 旧配置里的 sources 是保存时的快照，会盖掉新增来源（妙手因此被静默关掉）；
  // 只把此后新增的来源默认并入，用户手动关掉的保持关闭。
  const savedVersion = Number(c.sync?.sourcesVersion) || 1;
  if (savedVersion < SOURCES_VERSION) {
    sync.sources = (Array.isArray(sync.sources) ? [...sync.sources] : [...SOURCES]);
    for (const s of SOURCES) if (!LEGACY_SOURCES.includes(s) && !sync.sources.includes(s)) sync.sources.push(s);
    sync.sourcesVersion = SOURCES_VERSION;
  }
  return { ...DEFAULT_CONFIG, ...c, sync, quotaPush, accountSync, syncState: c.syncState || {} };
}

// 配置落盘走 store.atomicWrite：Windows 上杀软/同步盘瞬时占文件会直接 EPERM，
// 裸 renameSync 会整路抛到 API 500；atomicWrite 内置占用重试与直写兜底
async function saveConfig(c) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const { atomicWrite } = await import('./store.js');
  const file = FILE();
  // 同 saveAccounts：写前留一份 .bak，主文件损坏（断电半写/杀软截断）时 loadConfig 有路可回。
  // 只有主文件本身可解析时才允许它覆盖 .bak——否则「从 .bak 恢复后第一次保存」会把
  // 仍损坏的主文件内容写进 .bak，把唯一的退路也毁掉
  try {
    const existing = fs.readFileSync(file, 'utf8');
    if (existing.trim().length > 2) {
      JSON.parse(existing);   // 抛 = 主文件是坏的，.bak 保持原样
      await atomicWrite(file + '.bak', existing);
    }
  } catch { /* 主文件不存在/读不了/已损坏：没有可备份的，.bak 不动 */ }
  await atomicWrite(file, JSON.stringify(c, null, 2));
}

// 读改写串行，避免面板保存与后台同步互相覆盖
let chain = Promise.resolve();
function withConfig(fn) {
  const run = chain.then(async () => { const c = loadConfig(); const r = await fn(c); await saveConfig(c); return r; });
  chain = run.catch(() => {});
  return run;
}

export function normalizeEndpoint(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);   // 非法地址直接抛错
  // LLM 客户端风格的 base URL 带 /v1 后缀——10Router 只认站点根地址，/v1 会让 /api/* 调用落空并误报版本过旧
  return (u.origin + u.pathname).replace(/\/+$/, '').replace(/\/v1$/, '');
}

const maskKey = (k) => (k ? (k.length > 12 ? k.slice(0, 5) + '…' + k.slice(-4) : '…') : '');
export const isConfigured = (c = loadConfig()) => Boolean(c.endpoint && c.key);

/** ZCode 网关白名单预填建议：10Router 服务地址的主机部分（回环地址无加白意义，返回空）。 */
export function gatewayHostSuggestion() {
  try {
    const h = new URL(loadConfig().endpoint || '').hostname;
    return h && !/^(127\.|localhost$|::1$)/i.test(h) ? h : '';
  } catch { return ''; }
}

/** 面板用的配置视图（key 脱敏） */
export async function publicConfig() {
  const c = loadConfig();
  return {
    configured: isConfigured(c),
    endpoint: c.endpoint,
    keyMasked: maskKey(c.key),
    hasAdminPassword: Boolean(c.adminPassword),
    sync: c.sync,
    quotaPush: c.quotaPush,
    accountSync: c.accountSync,
    quotaPushDisabledProviders: c.quotaPushDisabledProviders || [],
    lastSync: c.lastSync,
    syncing: Boolean(syncing),
    sources: await detectSources(),
  };
}

/** 更新配置：key 留空表示保持原值；endpoint 为空 = 清除整个配置 */
export function updateConfig({ endpoint, key, adminPassword, syncEnabled, sources, quotaPushEnabled, quotaPushIntervalMin, accountSyncEnabled, accountSyncProviders, quotaPushDisabledProviders } = {}) {
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
    if (typeof adminPassword === 'string' && adminPassword) c.adminPassword = adminPassword;
    if (typeof syncEnabled === 'boolean') c.sync.enabled = syncEnabled;
    if (Array.isArray(sources)) {
      c.sync.sources = sources.filter((s) => SOURCES.includes(s));
      c.sync.sourcesVersion = SOURCES_VERSION;   // 显式保存过勾选结果，之后不再自动并入新来源
    }
    c.quotaPush = { ...DEFAULT_CONFIG.quotaPush, ...(c.quotaPush || {}) };
    if (typeof quotaPushEnabled === 'boolean') c.quotaPush.enabled = quotaPushEnabled;
    if (quotaPushIntervalMin !== undefined) {
      const min = Math.max(15, Math.min(1440, Number(quotaPushIntervalMin) || 60));
      c.quotaPush.intervalMin = min;
    }
    // 账号连接同步：总开关 + 渠道白名单（空数组 = 不限渠道，向后兼容）
    c.accountSync = { ...DEFAULT_CONFIG.accountSync, ...(c.accountSync || {}) };
    if (typeof accountSyncEnabled === 'boolean') c.accountSync.enabled = accountSyncEnabled;
    if (Array.isArray(accountSyncProviders)) c.accountSync.providers = accountSyncProviders.map(String);
    // 额度卡推送的渠道排除（10R 侧已有同源渠道时免去重复卡片）
    if (Array.isArray(quotaPushDisabledProviders)) c.quotaPushDisabledProviders = quotaPushDisabledProviders.map(String);
  });
}

async function call(c, pathname, { method = 'GET', body, timeout = QUOTA_TIMEOUT_MS } = {}) {
  if (!isConfigured(c)) throw Object.assign(new Error('尚未配置 10Router 地址与 key'), { code: 'NOT_CONFIGURED' });
  // 兼容历史配置里已存的 /v1 后缀（新版 normalizeEndpoint 剥离，但旧配置不会自动重写）
  const base = c.endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
  let res;
  try {
    res = await fetch(base + pathname, {
      method,
      headers: { Authorization: `Bearer ${c.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
      // 请求体里是本机各账号的 token/用量，Authorization 是 10Router 的 key。
      // fetch 默认跟随重定向，而 307/308 会把请求体原样重放到新地址（Authorization 会被
      // 剥掉，但 body 不会）——一个被 307 的 10Router 就足以把凭据送到别处。直接拒绝重定向。
      redirect: 'error',
    });
  } catch (e) {
    // redirect:'error' 抛的是 cause.message === 'unexpected redirect'（顶层 message 只是 "fetch failed"）
    if (e?.cause?.message === 'unexpected redirect') {
      throw new Error(`10Router（${c.endpoint}）返回了重定向，已拒绝跟随：凭据只发往你填写的地址，请把地址改成最终地址`);
    }
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

/** 10Router 自身健康（/api/health，无需 key；未配置或不可达时返回 ok:false） */
export async function fetchHealth(override) {
  const ov = { ...(override || {}) };
  if (typeof ov.endpoint === 'string') ov.endpoint = normalizeEndpoint(ov.endpoint);
  const c = { ...loadConfig(), ...ov };
  if (!c.endpoint) return { ok: false, error: '未配置 10Router 地址' };
  try {
    const res = await fetch(c.endpoint.replace(/\/v1$/, '') + '/api/health', {
      headers: { Accept: 'application/json', ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { ok: false, error: `HTTP ${res.status}` };
    return {
      ok: data.ok === true,
      driver: data.driver || null,
      lastDriverError: typeof data.lastDriverError === 'string' ? data.lastDriverError : null,
    };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.message };
  }
}

/** 测试连接：用额度接口同时验证地址与 key；老版本 10Router 只能同步用量时也视为可用 */
export async function testConnection(override) {
  const ov = { ...(override || {}) };
  if (typeof ov.endpoint === 'string') ov.endpoint = normalizeEndpoint(ov.endpoint);
  const c = { ...loadConfig(), ...ov };
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
      const { entries, notes, files, nextSentTotals } = await collectSource(id, {
        endpoint: c.endpoint, catpawModel: c.sync.catpawModel, sentTotals: c.syncState[id]?.sentTotals,
      });
      if (!files) { results.push({ source: id, label, status: 'absent' }); continue; }
      // catpaw 的行是「某天的差量」，时间戳落在历史日期，不能按水位线筛（会漏掉老日期的新差量）；
      // 它的增量由 sentTotals 记账，entries 本身就是该发的差量。
      const { selected, maxTs } = id === 'catpaw'
        ? { selected: entries, maxTs: entries.length ? entries[entries.length - 1].timestamp : (c.syncState[id]?.lastTs ?? null) }
        : selectSince(entries, c.syncState[id]?.lastTs);
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
      await withConfig((cc) => {
        cc.syncState[id] = { lastTs: maxTs, at: new Date().toISOString() };
        if (id === 'catpaw' && nextSentTotals) cc.syncState[id].sentTotals = nextSentTotals;
      });
      results.push({ source: id, label, status: 'ok', total: entries.length, selected: selected.length, imported, skipped, notes });
    } catch (e) {
      results.push({ source: id, label, status: 'failed', error: e.message });
      if (e.code === 'BAD_KEY') break;   // key 不对，后面的来源也不用试了
    }
  }
  const imported = results.reduce((n, r) => n + (r.imported || 0), 0);
  const skippedDup = results.reduce((n, r) => n + (r.skipped || 0), 0);
  const failed = results.filter((r) => r.status === 'failed');
  const summary = dryRun
    ? '预览：' + results.map((r) => `${r.label} ${r.status === 'absent' ? '未检测到' : (r.selected ?? 0) + ' 行'}`).join('，')
    : failed.length
      ? `同步完成：新增 ${imported} 行，跳过 ${skippedDup} 行重复，${failed.length} 个来源失败（${failed.map((r) => r.label + '：' + r.error).join('；')}）`
      : `同步完成：新增 ${imported} 行，跳过 ${skippedDup} 行重复`;
  if (!dryRun) {
    await withConfig((cc) => { cc.lastSync = { at: new Date().toISOString(), trigger, summary, results }; });
    // 日志走 key+args（按界面语言实时重渲染）；summary 原文继续供面板展示
    const logTpl = failed.length
      ? '同步完成：新增 {imported} 行，跳过 {skipped} 行重复，{failed} 个来源失败（{detail}）'
      : '同步完成：新增 {imported} 行，跳过 {skipped} 行重复';
    (failed.length ? logger.warn : logger.info).call(logger, '10R', logTpl,
      { imported, skipped: skippedDup, failed: failed.length, detail: failed.map((r) => r.label + '：' + r.error).join('；') });
  }
  return { summary, results };
}

/**
 * 额度卡推送（issue #24）：把 CD 解析好的额度数字 POST 到 10Router 通用接口。
 * 独立于用量同步开关——受 c.quotaPush.enabled 控制（默认开启），只要配了地址与 key 且开关开启即可推送。
 * @param {{onlySources?: string[]}} opts  onlySources=只推这些 source（就地重探只刷涉及的那几路）
 * fail-soft：任何一路失败只记日志。
 */
export async function pushQuotaCards({ onlySources } = {}) {
  const c = loadConfig();
  if (!c.endpoint || !c.key) return { results: [], skipped: 'not-configured' };
  if (c.quotaPush?.enabled === false) return { results: [], skipped: 'disabled' };
  const { runQuotaPush } = await import('./externalQuota.js');
  const { loadAccounts } = await import('./store.js');
  let accounts = await loadAccounts();
  // 渠道排除：10Router 已单独配了同源渠道（如 minimax-code 连接）时，跳过对应 CD 渠道的
  // 免费卡推送——两边卡片重复且数字各刷各的。账号从源头滤掉比在 runQuotaPush 里逐家族判
  // 更简单：没有账号的家族自然一个卡都不出。
  const disabled = Array.isArray(c.quotaPushDisabledProviders) ? c.quotaPushDisabledProviders : [];
  if (disabled.length && !Array.isArray(onlySources)) {
    accounts = accounts.filter((a) => !disabled.includes(a.provider));
  }
  const res = await runQuotaPush({
    endpoint: c.endpoint, key: c.key, accounts,
    ...(Array.isArray(onlySources) && onlySources.length ? { onlySource: onlySources } : {}),
  });
  await withConfig((cc) => {
    cc.quotaPush = { ...(cc.quotaPush || {}), lastPush: new Date().toISOString() };
  });
  return res;
}

const SCHEDULER_CHECK_MS = 60 * 1000;   // 每分钟轮询一次定时条件

/** 后台调度器：按配置频率自动同步用量与推送额度卡 */
export function startUsageSyncScheduler() {
  if (timer) return;
  let lastSyncAt = 0;
  let lastPushAt = 0;
  const tick = () => {
    // loadConfig 在读失败（杀软/同步盘瞬时占用、JSON 损坏且无备份）时会抛——
    // setInterval 回调里的未捕获异常会直接干掉整个 daemon（无 uncaughtException 兜底），
    // 跳过这一轮即可，下一轮再试
    let c;
    try { c = loadConfig(); } catch (e) {
      logger.warn('10R', '调度轮读取配置失败,跳过本轮:{err}', { err: e.message });
      return;
    }
    if (!isConfigured(c)) return;
    const now = Date.now();
    // 1) 用量同步：每 1 小时一轮（需开启自动开关）
    if (c.sync.enabled && now - lastSyncAt >= SYNC_INTERVAL_MS) {
      lastSyncAt = now;
      runUsageSync({ trigger: 'auto' }).catch((e) => logger.warn('10R', '自动同步失败:{err}', { err: e.message }));
    }
    // 2) 额度卡推送：按配置频率（默认 60 分钟，需开启开关）
    const pushIntervalMs = Math.max(15, Number(c.quotaPush?.intervalMin) || 60) * 60 * 1000;
    if (c.quotaPush?.enabled !== false && now - lastPushAt >= pushIntervalMs) {
      lastPushAt = now;
      pushQuotaCards().catch((e) => logger.warn('10R', '额度卡推送失败:{err}', { err: e.message }));
    }
  };
  setTimeout(tick, 30_000).unref?.();   // 启动 30 秒后先跑一轮首检
  timer = setInterval(tick, SCHEDULER_CHECK_MS);
  timer.unref?.();
}
