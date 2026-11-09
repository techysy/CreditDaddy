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

/** CreditDaddy provider → 10Router 连接类型。留空 / 缺失 = 该产品暂不同步。 */
export const TENROUTER_PROVIDER_MAP = {
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  workbuddy: 'codebuddy-cn',
  'workbuddy-intl': 'codebuddy-intl',
  minimax: 'minimax-code',             // #55：MiniMax 国内订阅线 → 10R minimax-code
  'minimax-global': 'minimax-code-global',   // #55：MiniMax 国际订阅线 → 10R minimax-code-global
  trae: 'trae-cn',                     // #56：CD 的 Trae 线读国内客户端（#28）→ 10R trae-cn（条目钉死国内站）
  'trae-intl': 'trae',                 // 国际线（浏览器 OAuth 登录，10R trae 条目缺省国际站）；连接同步走 transfer 管线
  tokenharbor: 'tokenharbor-free',   // #23：会话 cookie 只喂「额度监控卡」(freeTier,不走路由);tokenharbor 钱包卡留给 sk- 运输 key
  loomy: 'loomy',
  // zcode → glm：等 zcode 反代就绪后补一行（同步流程已就绪，无需改代码）
};

export const mapProviderId = (provider) => TENROUTER_PROVIDER_MAP[provider] || null;

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
      // 10Router issue #44：导入端会探测刚同步过去的网页会话是否仍可用，
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
 * 连接体（POST /api/providers 的单账号载荷）。网页会话两种走同一形状（issue #23）：
 * - qoder 专属老形状 meta.qoderWebSession（issue #44：usage 侧不区分 authType）
 * - 通用站点 meta.cookieSiteSession（tokenharbor 等,10R 卡片直接读 creditDaddyWebSession）
 */
export function buildConnPayload(a, target) {
  const body = { provider: target, apiKey: a.token, name: connName(a) };
  const qc = a.meta?.qoderWebSession?.cookie && String(a.provider).startsWith('qoder') ? a.meta.qoderWebSession : null;
  const sc = a.meta?.cookieSiteSession?.cookie ? a.meta.cookieSiteSession : null;
  // creditDaddySync：所有经 CreditDaddy 同步的连接都带标记，10R 连接行据此亮「CD Sync」徽章
  //（此前只有 qoder 网页会话带 creditDaddyWebSession，CodeBuddy 等连接在 10R 上看不出同步来源）
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
  if (!groups.size) throw new Error('没有可同步的账号（qoder / WorkBuddy / MiniMax / Loomy / Trae 系列）；zcode 待反代就绪后支持');

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
  // issue #44：Qoder 网页会话决定 10Router 端「套餐内 Credits」能不能显示。
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
  if (sessionless.length) parts.push(`未带网页会话 ${sessionless.length}（${sessionless.join('、')}，在 CreditDaddy 重新浏览器登录 Qoder 后再同步可补齐逐资源包明细）`);
  if (deadNames.length) parts.push(`网页会话已失效 ${deadNames.length}（${deadNames.join('、')}，重新登录 Qoder 网页后再次同步）`);
  const summary = (channel === 'oauth' ? '账号同步完成（OAuth 通道）：' : '账号同步完成（apikey 通道，token 过期后需重新同步）：')
    + (parts.join('，') || '无变化')
    + (failed.length ? `；${failed.map((r) => r.provider + '：' + (r.error || r.status)).join('；')}` : '');
  return { channel, results, summary };
}
