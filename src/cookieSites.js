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
    hint: '登录后 dashboard 才有 Free allowance 配额；凭据只存本机，同步到 10Router 点亮卡片。',
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
    hint: '登录后自动抓取 UID 与充值余额；推送到 10Router 显示余额卡片。',
  },
  {
    id: 'crowllm',
    name: 'CrowLLM',
    provider: 'crowllm',
    label: 'CrowLLM',
    // one-hub/new-api 系中转：钱包额度（含活动赠送）只在登录后的 /api/user/self（quota
    // 字段，500000 quota = $1），连接的 chat key 读不到（/v1/dashboard/billing/subscription
    // 恒回假上限 100000000，2026-11-21 实测）——与 tokenharbor/lingxi 同款，凭据只能是
    // 账号会话 Cookie。登录入口走邀请码池轮换（与 croli/meoo 同口径），未带码回退主链接。
    loginUrl: 'https://crowllm.com/sign-up',
    loginUrls: [
      'https://crowllm.com/sign-up?aff=xGk0',
      'https://crowllm.com/sign-up?aff=quJ8',
      'https://crowllm.com/sign-up?aff=tEjJ',
      'https://crowllm.com/sign-up?aff=6CNM',
      'https://crowllm.com/sign-up?aff=T9Tu',
    ],
    homeUrl: 'https://crowllm.com',
    cookieUrls: ['https://crowllm.com'],
    // 凭据现实（2026-11-21 全部实测）：钱包数据端点 /api/user/self 只认登录签发的
    // 15 分钟 JWT（Authorization Bearer）——无 session Cookie、无刷新端点、无令牌
    // 生成 UI、密码登录带 Turnstile，服务端自动化全线不通。唯一出路 = 真浏览器：
    // persist 分区里的 GitHub 会话让 SPA 静默重跑 OAuth → JWT 进页面内存 → 捕获走
    // **HTML 探针**（隐藏窗渲染 /wallet 等钱包数字出现，DOM 里抽快照）+ **CDP 嗅探**
    // （desktop 侧拦 XHR 的 Authorization 头拿 JWT，storage 同形键 `crowllm:access-jwt`
    // 交给 daemon 实时拉 /api/user/self——比 DOM 解析准，身份/余额一并取回）。
    probe: {
      url: 'https://crowllm.com/wallet',
      // 钱包页渲染完成的标记（SPA 静默 OAuth 需要几秒，probeViaHiddenWindow 轮询等）；
      // 中英 UI 都容。CF challenge 页 / 登录页壳不含这些标记 → 继续轮询或判失效。
      match: (text) => /可用总数|Total available|赠送额度|Gift/i.test(text),
    },
    quota: { fromHtml: parseCrowllmWalletHtml },
    noReprobe: true,   // 服务端 HTML 探针进 CF 盾——重探必假阴性；续期 = 登录窗静默重跑 OAuth
    accountName: 'CrowLLM',
    hint: '登录 crowllm.com（GitHub/Google/Discord/邮箱）后自动抓取钱包余额与赠送额度；GitHub 会话记住后，后续登录窗打开即静默完成。推 10Router 免费额度页出卡，聊天连接仍用 10R 侧的 API key。',
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
    hint: '登录后自动抓取魔方（Magicube）余额；每日额度自动发放无需签到，余额数字推 10Router 出卡。',
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
    hint: '登录后自动抓取会话与 Billing 余额（$25 免费额度）；推送 10Router 只带余额数字，会话过期自动刷新。',
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
    hint: '登录后自动抓取 Token 资源包余量与逐包明细；推送 10Router 只带 token 数字，会话 cookie 只存本机。',
  },
  {
    id: 'doubao',
    name: '豆包',
    provider: 'doubao',
    label: '豆包',
    loginUrl: 'https://www.doubao.com',
    homeUrl: 'https://www.doubao.com',
    localImportOnly: true, // 撤掉无意义的网页版与粘贴捕获，直接提供本机客户端导入
    // 探测 = 任务面板数据接口本身（issue #32）：POST detail 带会话 cookie
    // 返 200 {code:0}，未登录返 200 {code:710012001,"login invalid"}。
    // 本机客户端会话（doubaoLocal 解密）自带合法客户端指纹与完整 session，可稳定通过风控并拿到真实体验额度与签到发放。
    verify: 'api',
    cookieUrls: ['https://www.doubao.com', 'https://doubao.com'],
    accountName: '豆包',
    hint: '每日自动签到（+200 额度/天）与体验额度监控。支持直接点击右上角「本机导入」（读取解密本机豆包桌面客户端 Session）。',
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
    hint: '每日自动签到（+100 灵点，七天一轮第七天 200）+ 推送 10Router 出余额卡。多号分别捕获即分行并存。',
  },
  // Meoo 秒悟回退账号会话线（1.8.0 实测：OAuth refresh token 单次轮换，与 10R 共享后
  // 任一侧轮换即作废另一侧副本——CD 端恒 invalid_token 无法自动续期）。凭据 =
  // meoo.com 账号会话 Cookie（阿里云 SSO 手机号 + 短信登录后由浏览器写入），
  // 不支持 Meoo CLI 的 OAuth Bearer。会话失效统一 401 / NEED_LOGIN，重新登录捕获即可。
  {
    id: 'meoo',
    name: 'Meoo 秒悟',
    provider: 'meoo',
    label: 'Meoo 秒悟',
    // 登录窗落地页随机轮换维护者邀请码（同 Loomy/DuMate 邀请码池口径）：新账号经此注册
    // 即归因到对应码；老账号登录时该参数无副作用。loginUrl 保留为无参回退（siteForLoginUrl
    // 按前缀匹配，带 inviteCode 的查询串不影响站点识别）。
    loginUrl: 'https://meoo.com',
    loginUrls: [
      'https://meoo.com/?inviteCode=Raxntxwk',
      'https://meoo.com/?inviteCode=ycDdBjLV',
      'https://meoo.com/?inviteCode=2i2N6e2y',
    ],
    homeUrl: 'https://meoo.com',
    // 探测 = 权益接口本身（2026-11-13 实测）：带会话 cookie 返 { success:true, data:{ userPointInfo… } }；
    // 未登录 401 { errCode:'NEED_LOGIN' }。身份走 /api/v1/user/me 的 user_id（多号归户）。
    // 每日首登积分由 entitlement/init 触发（网页端登录后同款调用），CD 每日代调一次。
    verify: 'api',
    cookieUrls: ['https://meoo.com'],
    accountName: 'Meoo 秒悟',
    no10rSync: true,       // 10R 的 meoo 连接由 10R 侧自行管理（扫码 / 控制面 Key），CD 不重复出卡
    hint: '登录 meoo.com（阿里云账号 + 短信）后捕获会话；CD 每日自动领取首登积分并展示余额。会话失效时请重新登录捕获，Cookie 只存本机。',
  },

  {
    id: 'dumate',
    name: 'DuMate',
    provider: 'dumate',
    label: 'DuMate',
    // 独立的浏览器登录线：个人版登录入口 = 客户端 login-config 现网值
    // （from=oa_dumate 标记个人版渠道，登录成功落 console.bce.baidu.com 会话）。
    // 与「本机导入」（本地解密客户端 auth.json）互为两条独立凭据线，凭据同形可互认归户。
    // hideFromWebPage：DuMate 已是完整产品线，登录线入口在其自身页「添加账号 → 网页版」，
    // 账号会话页不再列出（API 与捕获机制保持全量，cookieSiteCapture 仍走本条目）。
    loginUrl: 'https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F',
    homeUrl: 'https://www.dumate.cn',
    verify: 'api',
    cookieUrls: ['https://console.bce.baidu.com', 'https://login.bce.baidu.com', 'https://www.dumate.cn'],
    accountName: 'DuMate',
    hint: '在登录窗完成个人版登录后自动捕获会话；也可走「添加账号 → 本机导入」。CD 每日自动领取登录赠送积分，可一键同步到 10Router。',
    hideFromWebPage: true,
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

/**
 * CrowLLM 钱包页 DOM → 快照读数。SPA 渲染出的数字是本地化美元串（"$110"、"$1,234.5"），
 * 「可用总数」= 付费 + 赠送总额、「赠送额度」= earned 拆分（存在才出）。与
 * /api/user/self 的字段映射（earned_quota/quota）同口径，只是来源从 XHR JSON 换成
 * DOM 文本——探针窗拿不到 XHR 响应体时的兜底。
 * @returns {{ used: number, total: number, isCreditBalance: true, giftUsd: number|null } | null}
 */
export function parseCrowllmWalletHtml(html) {
  const text = String(html || '');
  const money = (re) => {
    const m = re.exec(text);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  // 主读数：优先「可用总数」，退化到页面上第一个「$N」大额数字（免费目录可用）
  let total = money(/(?:可用总数|Total available)[\s\S]{0,300}?\$\s*([\d,]+(?:\.\d+)?)/i);
  if (total === null) total = money(/\$\s*([\d,]{2,}(?:\.\d+)?)/);
  if (total === null) return null;
  const gift = money(/(?:赠送额度|Gift)[\s\S]{0,300}?\$\s*([\d,]+(?:\.\d+)?)/i);
  return { used: 0, total, isCreditBalance: true, giftUsd: gift };
}

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
