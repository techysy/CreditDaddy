/**
 * 通用「浏览器站点 cookie 捕获」（issue #23）——配置驱动的首个接入方：Token Harbor。
 *
 * 适用面：额度/信息只存在于登录后的 dashboard HTML、凭据只能是浏览器会话 cookie 的供应商。
 * 配置表加一行即可接入新站点（登录页 URL / 收割域 / 探测规则），10Router 侧零改动——
 * 同步走既有 `providerSpecificData.creditDaddyWebSession.cookie` 传输（与 qoder 同形状）。
 *
 * ⚠ 探测头必须与 10Router `services/usage/tokenharbor.js` 同款的浏览器形:裸 fetch 的 UA
 * 会拿到「HTML 空壳 / bot 拦截」（配额标记根本不在 HTML 里，探测必然误报「登录未完成」）。
 *
 * 测试用后门（仅测试改动探测地址）：环境变量 `CD_PROBE_<站点 id 大写,非字母数字→_>`，
 * 如 CD_PROBE_TOKENHARBOR 指向本地假站。生产配置永远取 probe.url。
 */

import { fetchJsonRace } from './zcodeClient.js';

/** 浏览器形探测头（对齐 10Router tokenharbor 探针：裸 UA 会被边缘节点喂空壳页） */
export function dashboardHeaders(site) {
  return {
    Cookie: '',
    Accept: site?.probe?.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    Referer: (site.homeUrl || site.probe.url.split('/').slice(0, 3).join('/')) + '/',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

/** 登录页壳判定（会话已失效被挡回登录页）：没有配额标记且页面主题就是「登录」表单 */
function looksLikeLoginPage(html) {
  return /sign\s?in|log\s?in/i.test(html);
}

/**
 * Token Harbor dashboard HTML → 免费额度读数（与 10Router `services/usage/tokenharbor-free.js`
 * 同款口径——两处解析同一页面，规则改动需同步）。捕获时从浏览器探针 HTML 里解析一次，
 * 数字进 `meta.quotaSnapshot`，供 issue #24 的额度推送直接消费（推送不再打网络）。
 * @returns {{ used: number, resetAt: string|null } | null} 解析不出配额返回 null
 */
export function parseTokenHarborQuota(html) {
  const text = String(html || '');
  let used = null;
  const allowanceMatch = text.match(/Free allowance[\s\S]*?(\d+)%\s*(?:used|of total)/i);
  if (allowanceMatch) used = parseInt(allowanceMatch[1], 10);
  else {
    const generalPercentMatch = text.match(/Free allowance[\s\S]*?(\d+)%/i);
    if (generalPercentMatch) used = parseInt(generalPercentMatch[1], 10);
  }
  if (used === null) return null;
  let resetAt = null;
  const resetMatch = text.match(/Resets?\s+(?:in\s+)?(?:(\d+)\s*[dD])?\s*(?:(\d+)\s*[hH])?\s*(?:(\d+)\s*[mM])?/i);
  if (resetMatch && (resetMatch[1] || resetMatch[2] || resetMatch[3])) {
    const days = parseInt(resetMatch[1] || '0', 10);
    const hours = parseInt(resetMatch[2] || '0', 10);
    const minutes = parseInt(resetMatch[3] || '0', 10);
    const msOffset = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
    if (msOffset > 0) resetAt = new Date(Date.now() + msOffset).toISOString();
  }
  return { used, resetAt };
}

export const COOKIE_SITES = [
  {
    id: 'tokenharbor',
    name: 'Token Harbor',
    provider: 'tokenharbor',
    label: 'Token Harbor',
    loginUrl: 'https://tokenharbor.ai/login',
    homeUrl: 'https://tokenharbor.ai',
    // 探测标记：由于 Token Harbor 的 dashboard 页面将 Free allowance 移至客户端动态组件中渲染，
    // SSR 阶段只直出用户上下文（userEmail）。为兼顾 Node 探测与隐藏浏览器探针，满足其一即代表会话正常有效。
    probe: {
      url: 'https://tokenharbor.ai/dashboard',
      match: (html) => html.includes('Free allowance') || /userEmail[\\"]*:[\\"]*[^\\",]+@[^\\",]+/.test(html),
    },
    // 免费账号要多账号轮换(#23 增补):身份优先从 Next.js SSR state 的 userEmail 抽，兜底邮箱正则。
    identity: {
      fromHtml: {
        exec: (str) => {
          const m = /userEmail[\\"]*:[\\"]*([^\\",]+)/.exec(str);
          if (m && m[1] && m[1].includes('@')) return [m[1].trim()];
          return /[\w.+-]+@[\w-]+\.[\w.]+/.exec(str);
        },
      },
    },
    // issue #24：捕获时顺手解析网页读数，存 meta.quotaSnapshot 供额度推送消费
    quota: { fromHtml: parseTokenHarborQuota },
    accountName: 'Token Harbor',
    hint: '登录后 dashboard 才有 Free allowance 配额；凭据只存本机（账号库加密），同步到 10Router 时按 creditDaddyWebSession 形状传输。',
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    provider: 'xiaomi-mimo',
    label: '小米 MiMo',
    loginUrl: 'https://platform.xiaomimimo.com/console/balance',
    homeUrl: 'https://platform.xiaomimimo.com',
    probe: {
      url: 'https://platform.xiaomimimo.com/api/v1/userProfile',
      match: 'userId',
      accept: 'application/json, text/plain, */*',
    },
    accountName: '小米 MiMo',
    hint: '登录后自动抓取 UID 与控制台充值余额；通过外部配额（issue #24/26）推送到 10Router 配额追踪器显示余额卡片。',
  },
  {
    id: 'modelscope',
    name: 'ModelScope 魔搭',
    provider: 'modelscope',
    label: 'ModelScope',
    loginUrl: 'https://modelscope.cn',
    homeUrl: 'https://modelscope.cn',
    // 魔方余额 API 本身就是探测（GET /openapi/v1/magicubes/balance 带会话 cookie）；
    // 每日魔方额度为登录自动发放（前端无 claim 端点），故无签到自动化，只读余额出卡。
    cookieUrls: ['https://modelscope.cn', 'https://www.modelscope.cn'],
    verify: 'api',
    accountName: 'ModelScope',
    identity: { fromHtml: /[\w.+-]+@[\w-]+\.[\w.]+/ },
    hint: '登录魔搭后自动抓取魔方（Magicube）余额；每日额度自动发放无需签到，token 只存本机，余额数字推 10Router 出卡（同名认领可挂连接卡）。',
  },
  {
    id: 'river',
    name: 'River AI',
    provider: 'river',
    label: 'River AI',
    loginUrl: 'https://console.river.ai',
    homeUrl: 'https://console.river.ai',
    // 凭据主体是 WorkOS 会话——实测（2026-10-14）SPA 的 token 只在内存 Map，localStorage
    // 通常为空；持久会话走 cookie（WORKOS_REFRESH_SESSION @ auth.console.river.ai 等）。
    // 收割面必须覆盖**三个源**（console / auth / login 子域），storage 键做前缀扫描兜底。
    // 探测/身份/额度由 daemon 的 river 线一步完成（cookie 直连 → Bearer → 刷新兑换），不走 HTML 探针。
    storageKeys: ['workos:access-token', 'workos:refresh-token', 'workos:expires-at', 'workos:user'],
    storagePrefixes: ['workos:'],
    cookieUrls: ['https://console.river.ai', 'https://auth.console.river.ai', 'https://login.console.river.ai'],
    verify: 'api',
    accountName: 'River AI',
    hint: '登录 console.river.ai 后自动抓取 WorkOS 会话与 Billing 余额（$25 免费额度）；token 只存本机，推送 10Router 只带余额数字，会话过期自动刷新（单次轮换即时落盘）。',
  },
  {
    id: 'longcat',
    name: 'LongCat',
    provider: 'longcat',
    label: 'LongCat',
    loginUrl: 'https://longcat.chat/pc/login',
    homeUrl: 'https://longcat.chat',
    // 资源包汇总 API 即探测：带对 cookie 返 200 {code:0}，未登录 401「用户未登录」（2026-10-15 实测）
    probe: {
      url: 'https://longcat.chat/api/pay/quota/metering/token-packs/summary',
      match: '"code"',
      accept: 'application/json, text/plain, */*',
    },
    verify: 'api',
    accountName: 'LongCat',
    hint: '登录 longcat.chat 后自动抓取 Token 资源包余量与逐包明细（当前包 + 其他包，按官方消耗顺序排列）；推送 10Router 只带 token 数字，会话 cookie 只存本机。',
  },
  {
    id: 'doubao',
    name: '豆包',
    provider: 'doubao',
    label: '豆包',
    loginUrl: 'https://www.doubao.com',
    homeUrl: 'https://www.doubao.com',
    // 探测 = 任务面板数据接口本身（issue #32，2026-10-19/20 实测）：POST detail 带会话 cookie
    // 返 200 {code:0}，未登录返 200 {code:710012001,"login invalid"}——用 match 判业务码而非 HTTP 状态。
    // 活动页 UI 有「仅支持电脑版」前端墙，但接口不吃这套（纯 cookie 鉴权，无 a_bogus 签名）。
    // 最终定位（用户拍板）：豆包 = 纯「快速打开客户端」入口。网页会话 cookie 下 detail
    // 返回残缺数据（额度恒 0、签到状态不可信），额度可见也做不实——不加会话捕获探测，
    // 只在面板出示快捷按钮。
    entryOnly: true,       // 只出「打开豆包」按钮，无会话捕获 / 无探测 / 无账号行
    hint: '在豆包客户端（或网页）登录后捕获会话，CD 只读展示体验额度与每日签到状态（+200/天）；签到请在「打开豆包」里手动完成——活动在客户端内，CD 不代签；仅个人账号可参与（飞书企业号被排除），凭据只存本机。'
  },
  {
    id: 'lingxi',
    name: 'WPS 灵犀',
    provider: 'lingxi',
    label: 'WPS 灵犀',
    loginUrl: 'https://lingxi.kdocs.cn',
    homeUrl: 'https://lingxi.kdocs.cn',
    // 探测 = 任务列表接口本身（issue #53，提案者 2026-11-06 实测）：带会话 cookie 返 200
    // 含 data.tasks[]；未登录 401/403。签到状态在这里读（daily_check_in 的 status）。
    verify: 'api',
    cookieUrls: ['https://lingxi.kdocs.cn', 'https://www.kdocs.cn'],
    accountName: 'WPS 灵犀',
    hint: '登录 lingxi.kdocs.cn 后自动抓取每日签到状态与灵点余额（每天 100 灵点，七天一轮第七天 200）；CD 每日自动签到 + 推送 10Router 出余额卡，Cookie 只存本机（约 300+ 天有效期）。多号：各号走「网页版 / 粘贴捕获」分别登录捕获，按 WPS 账号 uid 分行并存；同一登录分区换号前先「清除已存会话」。',
  },
  // ⚠ 码道 CodeArts（issue #40）已于 2026-10-30 撤下，不再提供：
  //   华为云控制台会话受闲置超时 + WAF 指印（HWWAFSESID / browserCheckResult）绑定，
  //   浏览器里能靠 SPA 持续续期，本机无法续 —— 实测新鲜会话当日内即失效（网关回登录页），
  //   且登录窗关早一拍只能收到残缺会话（35 条 vs 完整 47 条）。
  //   签到要求「每天固定时刻会话有效」，而该会话有效期以小时计 —— 维持它需要用户每天
  //   重登一次浏览器，那就失去自动化意义。叠加新号可能接到推广电话，按「臭鸡蛋标准」撤下。
  //   若日后码道开放长期凭据（AK/SK 或 OAuth refresh），可按既有 cookieSites 结构重新接入。
];

export const getSite = (id) => COOKIE_SITES.find((s) => s.id === id) || null;

/** 按登录窗口 URL 找到对应站点配置（登录页或其同源首页） */
export function siteForLoginUrl(url) {
  const u = String(url || '');
  return COOKIE_SITES.find((s) => u.startsWith(s.loginUrl) || u.startsWith(s.homeUrl)) || null;
}

/** cookies.get({url}) 可能返回 host-only 与域级同名项——按 name 去重留后写者，拼成 handler 接受的 plain string */
export function serializeCookies(cookies) {
  const byName = new Map();
  for (const c of cookies || []) {
    if (c && typeof c.name === 'string' && c.name) byName.set(c.name, String(c.value ?? ''));
  }
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function probeUrl(site) {
  const env = process.env['CD_PROBE_' + site.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
  return env || site.probe.url;
}

function testProbeMatch(site, text) {
  if (!site?.probe?.match) return true;
  if (typeof site.probe.match === 'function') return Boolean(site.probe.match(text));
  return text.includes(site.probe.match);
}

/**
 * 探测一份会话 cookie 是否仍然有效。
 * 探测走 fetchJsonRace（跟随全局代理配置——Token Harbor 对大陆/港澳有封锁，出口代理是必须项）。
 * probe 支持 method / body（JSON API 探测，如豆包的 POST detail 接口——GET 打不到任务数据）。
 * @returns {Promise<{ok: boolean, reason?: 'invalid'|'no-match'|'http'|'network', status?: number, html?: string}>}
 */
export async function verifySiteCookie(site, cookie, { fetchImpl } = {}) {
  const url = probeUrl(site);
  const method = site.probe?.method || 'GET';
  const doFetch = fetchImpl || ((u, init) => fetchJsonRace(u, { headers: init.headers, method, body: site.probe?.body || undefined, timeoutMs: 12000, preferProxy: site.probe?.preferProxy === true }));
  try {
    const headers = { ...dashboardHeaders(site), Cookie: String(cookie || '') };
    if (site.probe?.body) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const r = await doFetch(url, { headers });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'invalid', status: r.status };
    if (r.status !== 200) return { ok: false, reason: 'http', status: r.status };
    const text = await r.text();
    if (!testProbeMatch(site, text)) {
      // 被挡回登录页 = 会话失效（与 10Router 的 AUTH_EXPIRED 分类对齐），不是「页面结构变化」
      return { ok: false, reason: looksLikeLoginPage(text) ? 'invalid' : 'no-match', status: r.status };
    }
    return { ok: true, status: r.status, html: text };
  } catch (e) {
    return { ok: false, reason: 'network', error: e?.message || String(e) };
  }
}

/**
 * 用「浏览器出品的 HTML」做探针(credit 桌面壳隐藏 Chromium 窗口的 probeHtml)——
 * 不经任何网络层,标记判定与网络探针完全同款(marker / 登录页壳分类),只做纯文本判断。
 */
export function verifyProbeHtml(site, html) {
  const text = String(html || '');
  if (!testProbeMatch(site, text)) {
    return { ok: false, reason: looksLikeLoginPage(text) ? 'invalid' : 'no-match' };
  }
  return { ok: true };
}


/** 从浏览器探针产 HTML 里抽登录身份(邮箱等);抽不到返 null(调用方按单例兜底)。 */
export function extractIdentity(site, html) {
  if (!site.identity || !site.identity.fromHtml) return null;
  const m = site.identity.fromHtml.exec(String(html || ''));
  return m && m[0] ? m[0] : null;
}

/** 从浏览器探针 HTML 里抽额度读数(site.quota.fromHtml);解析不出返 null,不影响既有行。 */
export function extractQuotaSnapshot(site, html) {
  if (!site.quota || typeof site.quota.fromHtml !== 'function') return null;
  try { return site.quota.fromHtml(html) || null; } catch { return null; }
}

/** 归户键的短哈希(不暴露身份原文;merge/dedupe 都只比对它) */
export function identityHashOf(value) {
  if (!value) return null;
  let h = 0;
  const s = String(value);
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) | 0) >>> 0;
  return 'ih' + h.toString(36);
}

/**
 * 行名是否属于「自动名家族」（站点默认名[+身份后缀] / Xiaomi MiMo (UID: …) / River AI (…) / ModelScope (…)）。
 * 自动名可以随身份解析升级（如「ModelScope (会话)」→「ModelScope (x@y.com)」）；
 * 不在家族里的名字视为**用户手改的备注名**（10R 同名认领键），一律不动——
 * 这层判定独立于 meta.renamed 标记，把历史改名（旧版无标记）也保护进来。
 */
export function isAutoGeneratedName(site, name) {
  const n = String(name || '');
  if (!n) return true;   // 无名 → 允许回填自动名
  const acc = String(site?.accountName || '');
  const escaped = acc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (acc && new RegExp(`^${escaped}(\\(.+\\))?$`).test(n))
    || /^Xiaomi MiMo \(UID: .+\)$/.test(n)
    || /^River AI \(.+\)$/.test(n)
    || /^ModelScope \(.+\)$/.test(n);
}
