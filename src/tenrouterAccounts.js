/**
 * CreditDaddy 账号 → 10Router 连接同步：把本机管理的订阅账号推给 10Router 当上游连接。
 *
 * 通道一（推荐）：POST /api/oauth/transfer/import —— 需在 10Router 设置里配置「面板密码」。
 *   完整 OAuth 形态（accessToken + refreshToken），10R 端按 JWT sub 去重并原位更新，反复同步幂等；
 *   先用面板密码登录（/api/auth/login）换 auth_token 会话再推送——transfer 路由只认会话 / CLI token。
 * 通道二（默认）：POST /api/providers —— 仅用已配的 sk- 虚拟 key。
 *   dashboardGuard 为远程 agent 留的口子（POST /api/providers 认虚拟 key）；apikey 形态、
 *   不带 refreshToken，token 过期后需重新同步；同名连接返回 409 且不覆盖。
 *
 * 扩展新产品：在 TENROUTER_PROVIDER_MAP 加一行即可（如 zcode → glm 等反代就绪后补上），
 * 同步主流程只读这张表，无需改动其他代码。
 */

import crypto from 'node:crypto';
import { buildExportPayload, sealTransfer } from './transfer.js';
import { liveToAccount as croliLiveAccount } from './croliLocal.js';
import { logger } from './logger.js';

/** CreditDaddy provider → 10Router 连接类型。留空 / 缺失 = 该产品暂不同步。 */
export const TENROUTER_PROVIDER_MAP = {
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  qwenwork: 'qwenwork',              // 10R 原生 qwenwork 渠道（设备码流同款）——access-only 同步（ROTATING_RT_SYNC_PROVIDERS）
  'qwenwork-cn': 'qwenwork-cn',
  workbuddy: 'codebuddy-cn',
  'workbuddy-intl': 'codebuddy-intl',
  minimax: 'minimax-code',             // #55：MiniMax 国内订阅线 → 10R minimax-code
  'minimax-global': 'minimax-code-global',   // #55：MiniMax 国际订阅线 → 10R minimax-code-global
  trae: 'trae-cn',                     // #56：CD 的 Trae 线读国内客户端（#28）→ 10R trae-cn（条目钉死国内站）
  'trae-intl': 'trae',                 // 国际线（浏览器 OAuth 登录，10R trae 条目缺省国际站）；连接同步走 transfer 管线
  tokenharbor: 'tokenharbor-free',   // #23：会话 cookie 只喂「额度监控卡」(freeTier,不走路由);tokenharbor 钱包卡留给 sk- 运输 key
  loomy: 'loomy',
  dumate: 'dumate',                  // 10R #113：DuMate 百度搭子 web-cookie 渠道
  lingxi: 'lingxi',                  // 10R #127：WPS 灵犀 web 会话渠道（token=完整 WPS Cookie 罐，api-key 形态直推）
  croli: 'croli',                    // 10R #156：Clerk OAuth 渠道——access-only 同步（ROTATING_RT_SYNC_PROVIDERS，见下）
  // ⚠ meoo 不再同步（test.12 实测）——rotating refresh token 双副本死锁，机制沉淀：
  //   这类 provider 的 rt 是**单次使用制**：任一侧拿 rt 换新 access，服务端立即作废
  //   旧 rt。rt 是一次性票据不是密钥，无法「复制」——同步过去后 CD 与 10R 各持一份
  //   快照，谁先刷新谁的另一侧就恒 invalid_grant，且无从恢复（只剩重新授权）。
  //   10R 的 meoo 连接改由 10R 侧自行管理（扫码 / 控制面 Key）。
  //   同类 provider（Clerk 系 croli 等）的正确接法见 croli 行：同步只推 accessToken、
  //   刷新权收敛在 CD（ROTATING_RT_SYNC_PROVIDERS + resyncCroliAccessToken 自动重推）。
  // zcode → glm：等 zcode 反代就绪后补一行（同步流程已就绪，无需改代码）
};

export const mapProviderId = (provider) => TENROUTER_PROVIDER_MAP[provider] || null;

/**
 * rotating refresh token 的 provider：同步只推 accessToken（rt 剥空）。
 * rt 单次使用制下两副本必然互杀（meoo test.12 事故口径，见映射表注释）——
 * 刷新权收敛在 CD：CD 侧 token 变化后由 resyncCroliAccessToken() 自动重推，
 * 10R 端只持 access、从不触发轮换，token 过期前总有新值续上。
 * apikey 通道（buildConnPayload）本来只带 a.token，天然符合，无需处理。
 */
// 千问办公同口径：ory_rt_ 单次轮换（官方客户端每小时换新），CD/10R 两副本必互杀——
// 同步只推 accessToken（约 7 天有效），RT 留在客户端本机；客户端运行时 CD 的 status
// 轮询会把最新 token 同步回账号库，下次手动同步即续上 10R 侧
const ROTATING_RT_SYNC_PROVIDERS = new Set(['croli', 'qwenwork', 'qwenwork-cn']);

const TIMEOUT_MS = 60_000;

async function trFetch(url, { key, cookie, method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // 这里的 body 是账号明文 token（/api/oauth/transfer/import）与 apiKey（/api/providers）。
      // 307/308 重定向会把 body 原样重放到新地址，Authorization 反而会被剥掉——所以必须拒绝。
      redirect: 'error',
    });
  } catch (e) {
    // redirect:'error' 抛的是 cause.message === 'unexpected redirect'（顶层 message 只是 "fetch failed"）
    if (e?.cause?.message === 'unexpected redirect') {
      throw new Error(`10Router 返回了重定向，已拒绝跟随：账号凭据只发往你填写的地址，请把地址改成最终地址`);
    }
    throw new Error(`无法连接 10Router：${e.cause?.code || e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
}

const authCookie = (setCookie) => {
  const m = /(?:^|,\s*)auth_token=([^;,\s]+)/.exec(setCookie || '');
  return m ? `auth_token=${m[1]}` : null;
};

/** 用面板密码登录换会话 Cookie；失败抛「面板密码不正确」类错误 */
async function login(endpoint, password) {
  const r = await trFetch(`${endpoint}/api/auth/login`, { method: 'POST', body: { password } });
  const cookie = authCookie(r.setCookie);
  if (r.status !== 200 || !cookie) {
    throw Object.assign(new Error(r.status === 401 ? '10Router 面板密码不正确' : `10Router 登录失败（HTTP ${r.status}）`), { code: 'BAD_PASSWORD' });
  }
  return cookie;
}

const connName = (a) => a.name || a.email || a.uid || 'account-' + a.id;

/** 通道一：transfer/import（OAuth 形态，按目标 provider 分组推送） */
async function syncViaTransfer({ endpoint, cookie, groups }) {
  const results = [];
  for (const [target, list] of groups) {
    const passphrase = crypto.randomBytes(18).toString('base64url');   // 仅作传输口令，不落盘
    const blob = sealTransfer(buildExportPayload(list), passphrase);
    const r = await trFetch(`${endpoint}/api/oauth/transfer/import`, {
      cookie, method: 'POST', body: { provider: target, passphrase, blob },
    });
    if (r.status !== 200) {
      results.push({ provider: target, count: list.length, status: 'failed', error: r.data?.error || `HTTP ${r.status}` });
      continue;
    }
    const d = r.data || {};
    results.push({
      provider: target, count: list.length, status: (d.failed || 0) ? 'partial' : 'ok',
      imported: d.imported || 0, updated: d.updated || 0, skipped: d.skipped || 0, failed: d.failed || 0,
      // 10Router issue #44：导入端会探测刚同步过去的账号会话是否仍可用，
      // 失败清单直接回显到本端摘要（见 syncAccountsTo10r 的 sessionWarns）。
      webSessions: d.webSessions || null,
    });
  }
  return results;
}

/** 通道二：POST /api/providers（apikey 形态，逐账号建连接；同名 409 记「已存在」） */
async function syncViaProviders({ endpoint, key, groups }) {
  const results = [];
  for (const [target, list] of groups) {
    const row = { provider: target, count: list.length, status: 'ok', imported: 0, skipped: 0, failed: 0 };
    for (const a of list) {
      const body = buildConnPayload(a, target);
      const r = await trFetch(`${endpoint}/api/providers`, { key, method: 'POST', body });
      if (r.status === 201 || r.status === 200) row.imported++;
      else if (r.status === 409) row.skipped++;
      else { row.failed++; row.error = r.data?.error || `HTTP ${r.status}`; }
    }
    row.status = row.failed ? (row.imported ? 'partial' : 'failed') : 'ok';
    results.push(row);
  }
  return results;
}

/**
 * 连接体（POST /api/providers 的单账号载荷）。账号会话两种走同一形状（issue #23）：
 * - qoder 专属老形状 meta.qoderWebSession（issue #44：usage 侧不区分 authType）
 * - 通用站点 meta.cookieSiteSession（tokenharbor 等,10R 卡片直接读 creditDaddyWebSession）
 */
export function buildConnPayload(a, target) {
  const body = { provider: target, apiKey: a.token, name: connName(a) };
  const qc = a.meta?.qoderWebSession?.cookie && String(a.provider).startsWith('qoder') ? a.meta.qoderWebSession : null;
  const sc = a.meta?.cookieSiteSession?.cookie ? a.meta.cookieSiteSession : null;
  // creditDaddySync：所有经 CreditDaddy 同步的连接都带标记，10R 连接行据此亮「CD Sync」徽章
  //（此前只有 qoder 账号会话带 creditDaddyWebSession，CodeBuddy 等连接在 10R 上看不出同步来源）
  const psd = { creditDaddySync: true, userId: a.uid || null };
  if (qc) psd.creditDaddyWebSession = { cookie: qc.cookie, capturedAt: qc.capturedAt || null, userId: a.uid || null };
  else if (sc) psd.creditDaddyWebSession = { cookie: sc.cookie, capturedAt: sc.capturedAt || null, userId: null };
  // Trae 签到（10R traeCheckin）优先用「登录时注册的设备」：CD 浏览器登录给每个账号
  // 造了独立指纹（meta.traeDevice.deviceId），随 psd 带过去，避免 10R 端陌生派生号
  // 领积分吃 9074（#31 口径）。私钥只服务本机 refresh 链，不出本机。
  if (a.provider === 'trae' && a.meta?.traeDevice?.deviceId && /^\d{8,}$/.test(String(a.meta.traeDevice.deviceId))) {
    psd.creditDaddyTraeDevice = {
      deviceId: String(a.meta.traeDevice.deviceId),
      ...(a.meta.traeDevice.machineId ? { machineId: String(a.meta.traeDevice.machineId) } : {}),
    };
  }
  body.providerSpecificData = psd;
  return body;
}

/**
 * 同步账号到 10Router。
 * @returns {{ channel: 'oauth'|'apikey', results: Array, summary: string }}
 */
export async function syncAccountsTo10r({ endpoint, key, adminPassword, accounts }) {
  if (!endpoint) throw Object.assign(new Error('尚未配置 10Router 地址'), { code: 'NOT_CONFIGURED' });
  if (!key && !adminPassword) throw Object.assign(new Error('尚未配置 10Router 虚拟 key'), { code: 'NOT_CONFIGURED' });

  // 按目标 10R 连接类型分组；无映射的产品（zcode/mirasim/catpaw 等）记入跳过原因
  const groups = new Map();
  const unmapped = new Map();
  const traeIntl = [];
  for (const a of accounts || []) {
    if (!a || !a.token) continue;
    // #56：国内线（provider trae）里混进国际账号（旧 meta.isIntl 标记）不往 trae-cn 推——
    // 10R 拿国内端点打国际 token 必然 20101。provider 'trae-intl' 有独立映射（→ trae），不走这。
    if (a.provider === 'trae' && (a.meta?.isIntl || a.isIntl)) {
      traeIntl.push(a);
      continue;
    }
    const target = mapProviderId(a.provider);
    if (!target) {
      if (a.provider) unmapped.set(a.provider, (unmapped.get(a.provider) || 0) + 1);
      continue;
    }
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(a);
  }
  // rotating rt 的组剥离 refreshToken（拷贝剥离，不动原账号行——buildExportPayload
  // 还服务于手动导出，全量备份不能被同步策略污染）
  for (const [target, list] of groups) {
    if (ROTATING_RT_SYNC_PROVIDERS.has(target)) {
      groups.set(target, list.map((a) => ({ ...a, refreshToken: null })));
    }
  }
  if (!groups.size) throw new Error('没有可同步的账号（qoder / 千问办公 / WorkBuddy / MiniMax / Loomy / Trae / DuMate / 灵犀 / Croli 系列）；zcode 待反代就绪后支持');

  let channel = 'apikey';
  let cookie = null;
  const results = [];
  if (adminPassword) {
    channel = 'oauth';
    cookie = await login(endpoint, adminPassword);
    try {
      results.push(...await syncViaTransfer({ endpoint, cookie, groups }));
    } finally {
      trFetch(`${endpoint}/api/auth/logout`, { cookie, method: 'POST' }).catch(() => {});
    }
  } else {
    if (!key) throw Object.assign(new Error('尚未配置 10Router 虚拟 key'), { code: 'NOT_CONFIGURED' });
    results.push(...await syncViaProviders({ endpoint, key, groups }));
  }

  const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'partial');
  const parts = [];
  if (sum('imported')) parts.push(`导入 ${sum('imported')}`);
  if (sum('updated')) parts.push(`更新 ${sum('updated')}`);
  if (sum('skipped')) parts.push(`已存在 ${sum('skipped')}`);
  if (sum('failed')) parts.push(`失败 ${sum('failed')}`);
  if (unmapped.size) parts.push('跳过 ' + [...unmapped].map(([p, n]) => `${p} ×${n}`).join('、'));
  if (traeIntl.length) parts.push(`跳过 Trae 国际版 ×${traeIntl.length}（CreditDaddy 的 Trae 线仅支持国内站）`);
  // issue #44：Qoder 账号会话决定 10Router 端「套餐内 Credits」能不能显示。
  // OAuth 通道：10Router 导入时已逐账号探测，失效清单原样带回（deadNames）；
  // 两条通道都要点名本地就没有会话的账号（apikey 通道 webSessions 恒为
  // null，条件自动适用；OAuth 通道里已被探测过的组不重复报）。
  const deadNames = [];
  for (const r of results) {
    for (const f of r.webSessions?.failures || []) deadNames.push(f.name);
  }
  const sessionless = [];
  for (const [target, list] of groups) {
    if (!String(target).startsWith('qoder')) continue;
    for (const a of list) {
      if (results.find((r) => r.provider === target)?.webSessions == null && !a.meta?.qoderWebSession?.cookie) {
        sessionless.push(connName(a));
      }
    }
  }
  if (sessionless.length) parts.push(`未带账号会话 ${sessionless.length}（${sessionless.join('、')}，在 CreditDaddy 重新浏览器登录 Qoder 后再同步可补齐逐资源包明细）`);
  if (deadNames.length) parts.push(`账号会话已失效 ${deadNames.length}（${deadNames.join('、')}，重新登录 Qoder 网页后再次同步）`);
  const summary = (channel === 'oauth' ? '账号同步完成（OAuth 通道）：' : '账号同步完成（apikey 通道，token 过期后需重新同步）：')
    + (parts.join('，') || '无变化')
    + (failed.length ? `；${failed.map((r) => r.provider + '：' + (r.error || r.status)).join('；')}` : '');
  return { channel, results, summary };
}

/* ───────────── croli access 自动重推（rotating rt 的同步维护，见映射表 meoo 注释） ─────────────
 *
 * croli 同步只推 accessToken（ROTATING_RT_SYNC_PROVIDERS），刷新权收敛在 CD；而 CD 的
 * croli token 快照跟着官方客户端 sidecar 的 rt 轮换走（auth.json 直读）——access 随时
 * 会换新。10R 端拿着旧 access 到期即断，所以要在这里持续维护：比对上次推过的值，
 * 变了就自动重推一遍（syncAccountsTo10r 幂等，10R 按 uid 原位更新）。
 *
 * 基准值存内存：重启丢一次记录 → 首轮多推一遍，10R 端原位更新同 token，无害。
 * 推送无论成败都记录当前值——失败（10R 不可达等）时避免每个周期对同一目标反复重试；
 * 官方 sidecar 再轮换出新 token 时自然触发下一轮。
 */

const CROLI_RESYNC_INTERVAL_MS = 30 * 60_000;
let lastCroliPushedToken = null;
let croliResyncTimerHandle = null;
let croliResyncRunning = false;

/**
 * 单轮 croli 重推检查。@param {object} tenrouterConfig 10Router 配置（loadConfig() 的值）。
 * @param {object} [opts] 测试注入：{ account } 直接指定要推的账号（生产走 croliLiveAccount 实时快照）。
 * @returns {Promise<{pushed:boolean, reason:string}|null>} null = 未配置 / 渠道关闭 /
 *   白名单排除 croli（无事发生不记录）；pushed=false 且 reason='token-unchanged' = 基准未变。
 */
export async function resyncCroliAccessToken(tenrouterConfig, { account } = {}) {
  const c = tenrouterConfig;
  if (!c?.endpoint || (!c.key && !c.adminPassword)) return null;
  if (c.accountSync?.enabled === false) return null;
  const allow = Array.isArray(c.accountSync?.providers) ? c.accountSync.providers : [];
  if (allow.length && !allow.includes('croli')) return null;

  let live = account || null;
  if (!live) {
    try {
      live = await croliLiveAccount();
    } catch {
      return { pushed: false, reason: 'no-live-account' };
    }
  }
  if (!live?.token) return { pushed: false, reason: 'no-live-account' };
  if (live.token === lastCroliPushedToken) return { pushed: false, reason: 'token-unchanged' };

  const tokenAtAttempt = live.token;
  try {
    const r = await syncAccountsTo10r({ endpoint: c.endpoint, key: c.key, adminPassword: c.adminPassword, accounts: [live] });
    logger.info('TENROUTER_SYNC', 'croli access 已重推:{summary}', { summary: r.summary });
    lastCroliPushedToken = tokenAtAttempt;
    return { pushed: true, reason: 'ok', summary: r.summary };
  } catch (e) {
    logger.warn('TENROUTER_SYNC', 'croli access 重推失败（下轮 token 再变时重试）:{err}', { err: e?.message || e });
    // 失败也记录尝试值：同一 token 不反复轰 10R；官方轮换出新值会自动再来
    lastCroliPushedToken = tokenAtAttempt;
    return { pushed: false, reason: 'push-failed', error: e?.message || String(e) };
  }
}

/** croli access 重推轮询（30 分钟一轮）。@param {() => object} getConfig 10Router 配置读取器。 */
export function startCroliResyncWatch(getConfig) {
  if (croliResyncTimerHandle) return;
  const tick = async () => {
    if (croliResyncRunning) return;
    croliResyncRunning = true;
    try {
      await resyncCroliAccessToken(getConfig?.());
    } catch (e) {
      logger.warn('TENROUTER_SYNC', 'croli 重推轮异常:{err}', { err: e?.message || e });
    } finally {
      croliResyncRunning = false;
    }
  };
  croliResyncTimerHandle = setInterval(tick, CROLI_RESYNC_INTERVAL_MS);
  croliResyncTimerHandle.unref?.();
  setTimeout(tick, 60_000).unref?.();   // 启动 1 分钟后先跑一轮，把重启丢失的记录补上
  logger.info('TENROUTER_SYNC', 'croli access 自动重推已启动（每 30 分钟比对一次）');
}
