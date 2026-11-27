/**
 * 产品线注册表 — 按账号 provider 分发签到 / 积分 / 校验。
 *
 * 每个产品实现（checkin 可缺省：该产品不参与每日签到，如 ZCode）：
 *   checkin(account, ctx) → { status: checked-in|already|limited|no-activity|failed, … }
 *   quota(account, ctx)   → { total, used, remaining, exceeded, parts: [{ name, total, used, remaining, expiresAt, recurring }] }
 *   verify(account)       → { name?, uid?, email? }（添加账号时补全资料，失败抛错）
 * ctx.onRefresh(creds)：产品在 token 刷新后回调，由调用方负责持久化。
 */

import { productOf } from './constants.js';
import { checkinOne as checkinQoder, fetchQuotaUsage, fetchUserinfo, fetchUsageDetail } from './qoderClient.js';
import { checkinWorkbuddy, fetchWorkbuddyQuota, inspectToken } from './workbuddyClient.js';
import { fetchZcodeQuota } from './zcodeClient.js';
import { fetchMirasimQuota, fetchMirasimProfile } from './mirasimClient.js';
import { fetchCatpawQuota, fetchCatpawProfile } from './catpawClient.js';
import { fetchTraeQuota, checkinTrae, verifyTraeAccount } from './traeClient.js';

/** Trae 国际账号判定：provider trae-intl 或旧线账号带 isIntl 标记（浏览器 OAuth / 本机导入都落这个键） */
const isTraeIntl = (account) => account?.provider === 'trae-intl' || Boolean(account?.meta?.isIntl);
import { fetchMiniMaxQuota, checkinMiniMax, verifyMiniMaxAccount } from './minimaxClient.js';
import { fetchDoubaoStatus, checkinDoubao, resolveDoubaoDevice } from './doubaoClient.js';
import { extractDoubaoUid } from './doubaoLocal.js';
import { checkinLingxi, fetchLingxiQuota } from './lingxiClient.js';
import { checkinMeoo, fetchMeooQuota } from './meooClient.js';
import { checkinDumate, fetchDumateQuota } from './dumateClient.js';
import { checkinCroli, fetchCroliQuota, verifyCroliAccount } from './croliClient.js';
import { readCroliCredential, croliSubOf } from './croliLocal.js';
import { refreshCroliToken } from './croliAuth.js';
import { checkinAutoclaw, fetchAutoclawQuotaForAccount, verifyAutoclawAccount } from './autoclawClient.js';
import { fetchLoomyQuota, verifyLoomyAccount } from './loomyClient.js';
import { fetchUserinfo as fetchQwenworkUserinfo, fetchQuotaUsage as fetchQwenworkQuota } from './qwenworkClient.js';
import { checkinQuwork, fetchQuworkQuota, verifyQuworkAccount } from './quworkClient.js';
/** 从 userinfo 响应中挑一个可读的显示名 */
export function displayNameFrom(ui) {
  const pick = [ui?.nickname, ui?.name, ui?.username, ui?.email]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  return pick || null;
}

/**
 * 千问办公 account-context → 统一积分结构。个人版是积分余额制（quota.total/used 常为
 * null，remaining = 剩余积分，实测 899.99）：一条余额行，
 * 套餐名（个人基础版等）挂 plan 字段给额度卡副标题用。
 * biz/团队账号 remaining 可能为 null 而 total/used 有值——按 10R 同接口口径用
 * total-used 兜底，别把 800 积分算成 0 并误判「已用尽」。
 */
export function normalizeQwenworkQuota(data) {
  const q = data?.quota || {};
  const plan = data?.plan || null;
  const total = Number(q.total);
  const used = Number(q.used);
  // 先显式判 null/undefined 再看数字——Number(null) 是 0 且 finite，直接 Number.isFinite
  // 会把显式 null 当成真 0
  const balance = q.remaining !== null && q.remaining !== undefined && Number.isFinite(Number(q.remaining))
    ? Number(q.remaining)
    : Number.isFinite(total) && total > 0 ? Math.max(0, total - (Number.isFinite(used) ? used : 0))
    : 0;
  const parts = [{ name: '积分余额', total: balance, used: 0, remaining: balance }];
  return {
    unit: '积分',
    plan: plan?.name || null,
    total: balance,
    used: 0,
    remaining: balance,
    parts,
    exceeded: Boolean(q.exceeded) || balance <= 0,
  };
}

/** Qoder /api/v2/quota/usage → 统一积分结构；detail 为网页端逐资源包明细（可选，已按 uid 校验） */
export function normalizeQoderQuota(q, detail = null) {
  const names = [['userQuota', '套餐额度', true], ['addOnQuota', '附加额度', false], ['orgResourcePackage', '组织资源包', false]];
  const fmtExpiry = (v) => (Number(v) > 0 && Number(v) < 253400000000000 ? new Date(Number(v)).toISOString() : null);
  let parts = names
    .map(([k, name, recurring]) => ({ x: q?.[k], name, recurring }))
    .filter(({ x }) => x && Number(x.total) > 0)
    .map(({ x, name, recurring }) => ({
      name, recurring,
      total: Number(x.total) || 0,
      used: Number(x.used) || 0,
      remaining: Number(x.remaining) || 0,
      expiresAt: fmtExpiry(q?.expiresAt),
    }));
  // 网页端明细可用时按「每个资源包一条」展开（含各自到期时间），比聚合值更精确
  const detailParts = detail ? detailQuotaParts(detail, fmtExpiry) : null;
  if (detailParts) parts = detailParts;
  const sum = (k) => Math.round(parts.reduce((s, p) => s + p[k], 0) * 100) / 100;
  return { total: sum('total'), used: sum('used'), remaining: sum('remaining'), parts, exceeded: Boolean(q?.isQuotaExceeded) };
}

/** 网页端用量明细的分组 → 统一 parts（组内为空 / 全 0 时返回 null 让调用方回落聚合数据） */
const DETAIL_SOURCE_NAME = {
  PLAN: '套餐额度',
  RESOURCE_PACKAGE_SOURCE_BONUS: '获赠资源包',
  RESOURCE_PACKAGE_SOURCE_PURCHASE: '购买资源包',
  RESOURCE_PACKAGE_SOURCE_ORG: '组织资源包',
};
function detailQuotaParts(detail, fmtExpiry) {
  const groups = [['plan_quota', '套餐额度', true], ['resource_package_quota', '资源包', false], ['dedicated_resource_package_quota', '组织资源包', false]];
  const parts = [];
  for (const [key, fallbackName, recurring] of groups) {
    const rows = detail?.[key]?.quota_detail;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const total = Number(r?.limit_value) || 0;
      if (total <= 0) continue;
      parts.push({
        name: DETAIL_SOURCE_NAME[r?.source] || fallbackName,
        recurring,
        total,
        used: Number(r?.used_value) || 0,
        remaining: Number(r?.remaining_value) || 0,
        expiresAt: fmtExpiry(r?.expires_at),
      });
    }
  }
  return parts.length ? parts : null;
}

/**
 * 网页端逐资源包明细（best-effort）：无会话 Cookie 返回 null；
 * 会话失效（401/403）时清除 Cookie 并回调 ctx.onWebSessionExpired 提示重新登录，同样回落。
 * 明细里的 user_id 与账号 uid 不一致时丢弃（防止把别人的资源包显示到这个账号上）。
 */
async function qoderWebDetail(account, ctx = {}) {
  try {
    const d = await fetchUsageDetail(account);
    if (!d) return null;
    if (account.uid && d.user_id && d.user_id !== account.uid) {
      ctx.log?.('账号会话与账号不匹配，忽略资源包明细');
      return null;
    }
    return d;
  } catch (e) {
    if (e.auth) {
      await clearQoderWebSession(account, ctx);
      ctx.log?.('Qoder 账号会话已失效，无法显示逐资源包明细（面板里重新登录一次即可）');
    }
    return null;
  }
}

/** 删除账号上的网页会话 Cookie（失效时），并通知桌面壳可以重新抓取 */
async function clearQoderWebSession(account, ctx = {}) {
  const { withAccounts } = await import('./store.js');
  await withAccounts((list) => {
    const cur = list.find((a) => a.id === account.id);
    if (cur?.meta?.qoderWebSession) {
      const { qoderWebSession, ...meta } = cur.meta;
      cur.meta = meta;
      cur.updatedAt = new Date().toISOString();
      if (account.meta) delete account.meta.qoderWebSession;
    }
  });
  ctx.onWebSessionExpired?.();
}

// 客户端 sidecar 会轮换 Clerk 凭据；仅对当前同 uid 的账号读取最新快照。
// 其它账号保留各自的旧快照，绝不拿当前登录的凭据覆盖它们。
const croliRenewals = new Map();
async function currentCroliAccount(account, ctx) {
  const live = readCroliCredential();
  const uid = account.uid || croliSubOf(account.token);
  if (live && uid && croliSubOf(live.accessToken) === uid) {
    if (live.expired) throw new Error('Croli 客户端凭据已过期，等待客户端自动续期或在客户端重新登录');
    if (live.accessToken !== account.token || live.refreshToken !== account.refreshToken) {
      const creds = { token: live.accessToken, refreshToken: live.refreshToken,
        expiresAt: live.expiresAt ? new Date(live.expiresAt).toISOString() : account.expiresAt };
      if (ctx?.onRefresh) await ctx.onRefresh(creds);
      else Object.assign(account, creds);
    }
    return account;
  }
  if (account.refreshToken && Number.isFinite(Date.parse(account.expiresAt))
    && Date.parse(account.expiresAt) < Date.now() + 5 * 60_000) {
    let renewal = croliRenewals.get(uid);
    if (!renewal) {
      renewal = (async () => {
        const tok = await refreshCroliToken(account.refreshToken, { fetchImpl: ctx?.refreshFetchImpl });
        if (!tok.refresh_token || croliSubOf(tok.access_token) !== uid) throw new Error('Croli 续期返回的账号身份不匹配，请重新授权');
        return { token: tok.access_token, refreshToken: tok.refresh_token,
          expiresAt: new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() };
      })();
      croliRenewals.set(uid, renewal);
      renewal.finally(() => { if (croliRenewals.get(uid) === renewal) croliRenewals.delete(uid); }).catch(() => {});
    }
    const creds = await renewal;
    if (ctx?.onRefresh) await ctx.onRefresh(creds);
    else Object.assign(account, creds);
  }
  return account;
}

export const prepareCroliAccount = currentCroliAccount;

const PRODUCTS = {
  qoder: {
    label: 'Qoder',
    checkin: (account) => checkinQoder(account),
    quota: async (account, ctx = {}) => normalizeQoderQuota(await fetchQuotaUsage(account), await qoderWebDetail(account, ctx)),
    verify: async (account) => {
      const ui = await fetchUserinfo(account);
      return { name: displayNameFrom(ui), uid: typeof ui?.id === 'string' ? ui.id : null, email: ui?.email || null };
    },
  },
  // 千问办公：双线同构（gateway.qwenwork.ai / .cn），资料与配额都从 account-context 一次取全。
  // 无签到口径（个人版积分靠订阅/活动发放，没找到稳定的每日领取端点），调度器自动跳过。
  qwenwork: {
    label: '千问办公',
    quota: async (account) => normalizeQwenworkQuota(await fetchQwenworkQuota(account)),
    verify: async (account) => {
      const ui = await fetchQwenworkUserinfo(account);
      return { name: displayNameFrom(ui), uid: typeof ui?.id === 'string' ? ui.id : null, email: ui?.email || null };
    },
  },
  workbuddy: {
    label: 'WorkBuddy',
    // 国内版走 billing daily-checkin 签到；国际版无签到动作（原「活跃领取」线已删——
    // 逐日主动打上游对话接口博资格的机制整体下线，workbuddy-intl 产品线本身保留，额度查看照常）
    checkin: (account, ctx) => checkinWorkbuddy(account, ctx),
    quota: (account, ctx) => fetchWorkbuddyQuota(account, ctx),
    verify: async (account) => {
      const info = inspectToken(account.token);
      if (!info.provider) throw new Error('不是 WorkBuddy 的登录 token');
      if (info.provider !== account.provider) throw new Error(`token 属于${info.provider === 'workbuddy' ? '国内版' : '国际版'}，与所选版本不符`);
      return { uid: info.uid, name: info.name };
    },
  },
  zcode: {
    label: 'ZCode',
    // 无 checkin：ZCode 积分来自活动领取（需阿里云验证码），不做后台自动签到
    quota: (account) => fetchZcodeQuota(account),
    verify: async () => {
      throw new Error('ZCode 账号请通过「本机导入」添加（需要客户端的完整登录快照才能查询额度与切换）');
    },
  },
  mirasim: {
    label: 'mirasim',
    // 无 checkin：mirasim 现行额度是「个人额度按笔有效期 + 空间额度按成员分配」，无每日签到动作。
    // token 约 1 小时过期：quota 内部 401 时自动用 refreshToken 续期，
    // ctx.onRefresh（refreshContext）回写账号库后，这里再把新凭据同步回 setting.json（若该账号是客户端当前登录）。
    quota: async (account, ctx = {}) => {
      const mirasimLocal = await import('./mirasimLocal.js');
      const wrapped = {
        ...ctx,
        onRefresh: async (creds) => {
          await ctx.onRefresh?.(creds);
          try {
            const synced = await mirasimLocal.writeMirasimAuth({ uid: account.uid, token: creds.token, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt });
            if (synced) ctx.log?.('已同步新 token 到 mirasim 客户端');
          } catch (e) { ctx.log?.('同步到 mirasim 客户端失败：' + e.message); }
        },
      };
      return fetchMirasimQuota(account, wrapped);
    },
    verify: async (account) => {
      const p = await fetchMirasimProfile(account.token);
      return { name: p.name || p.email, uid: p.id, email: p.email };
    },
  },
  catpaw: {
    label: '妙手',
    // 无 checkin：妙手（美团 CatPaw）按套餐发放 Credits，无每日签到活动。
    // 凭据由妙手客户端登录管理（无对外 refresh）：401 时提示到客户端重新登录后重新本机导入。
    quota: (account) => fetchCatpawQuota(account),
    verify: async (account) => {
      const p = await fetchCatpawProfile(account.token);
      return { name: p.name, uid: p.userId, email: null };
    },
  },
  trae: {
    label: 'Trae',
    // 每日签到发 150 通用积分（7 天有效）。凭据线：本机客户端导入 + 浏览器 OAuth（授权码
    // + PKCE）双线。国际版账号（meta.isIntl / provider trae-intl）分流跳过签到与额度——
    // ug 签到接口只在 api.trae.cn 注册、pay 端点国际网关 404（10R traeCheckin 同口径结论），
    // 与其每天报错不如如实说「国际线无 API 口径」（用户拍板：国际版没必要做签到）。
    checkin: (account, ctx) => (isTraeIntl(account)
      ? { accountId: account.id, account: account.name || account.id, provider: account.provider, status: 'no-activity', message: 'Trae 国际线无每日签到（Dollar Usage 走官网 Usage 页，无 API 口径）' }
      : checkinTrae(account, ctx)),
    quota: (account) => {
      if (isTraeIntl(account)) {
        const e = new Error('Trae 国际线额度无 API 口径（Dollar Usage 只在 trae.ai 官网 Usage 页可见），不影响登录与 10Router 同步');
        e.quotaUnavailable = true;
        throw e;
      }
      return fetchTraeQuota(account);
    },
    verify: (account) => verifyTraeAccount(account),
  },
  minimax: {
    label: 'MiniMax',
    // token 约 1 小时过期：checkin / quota 内部 401 时用 refreshToken 自动续期（withMiniMaxAuth）。
    // 本机导入账号刷新前会重读 ~/.minimax auth.json 对齐客户端最新 refreshToken；
    // ctx.onRefresh 回写账号库后，这里再安全回写 auth.json（仅客户端未运行时，见 minimaxLocal.writeMiniMaxAuth）。
    // device 登录账号自持独立凭据链（无 meta.authRecordKey），writeMiniMaxAuth 对其 no-op，不与本机客户端互斥。
    // 国际版（minimax-global，#54）同协议同实现，仅域名不同——minimaxClient 按账号档位选端点。
    checkin: (account, ctx = {}) => checkinMiniMax(account, wrapMiniMaxRefresh(account, ctx)),
    quota: (account, ctx = {}) => fetchMiniMaxQuota(account, wrapMiniMaxRefresh(account, ctx)),
    verify: (account) => verifyMiniMaxAccount(account),
  },
  doubao: {
    label: '豆包',
    // 网页会话捕获线（issue #32）：凭据是 doubao.com 会话 cookie（meta.cookieSiteSession.cookie）。
    // 每日签到 +200 额度（服务端幂等）；「额度」= 活动累计获得点数（progress.total_amount），
    // 与其他产品线的套餐/积分口径不同，面板以独立产品页呈现。
    checkin: (account, ctx = {}) => checkinDoubao(account, ctx),
    quota: async (account) => {
      const cookie = account.meta?.cookieSiteSession?.cookie || account.token || account.cookie;
      const uid = extractDoubaoUid(cookie) || account.uid || '';
      const st = await fetchDoubaoStatus(cookie, uid, resolveDoubaoDevice(account));
      if (!st.auth) {
        const e = new Error('豆包会话已失效，请重新登录捕获');
        e.auth = true;
        throw e;
      }
      return {
        total: st.totalAmount,
        used: 0,
        remaining: st.totalAmount,
        exceeded: false,
        plan: null,
        planExpiresAt: null,
        parts: st.checkin ? [{
          name: '每日签到',
          total: st.checkin.rewardAmount,
          used: 0,
          remaining: st.checkin.checkedIn ? st.checkin.rewardAmount : 0,
          expiresAt: null,
          recurring: true,
          unit: '额度',
        }] : [],
        empty: st.totalAmount === 0 && !st.checkin,
      };
    },
  },
  lingxi: {
    label: 'WPS 灵犀',
    // 网页会话捕获线（issue #53）：凭据是 lingxi.kdocs.cn 会话 cookie（meta.cookieSiteSession.cookie）。
    // 每日签到 +100 灵点（七天一轮第七天 200）；灵点只能在灵犀界面消费，官方无 API——
    // 额度 = 灵点余额（独立口径，unit '灵点' 不进剩余积分合计）。claim 前必查任务状态
    // （幂等性提案者未验证，claimed 时绝不盲打 POST）。
    checkin: (account) => checkinLingxi(account),
    quota: (account) => fetchLingxiQuota(account),
  },
  meoo: {
    label: 'Meoo 秒悟',
    // 独立产品线（issue #65）：凭据 = OAuth 令牌（PKCE 回环）或控制面 Key（meoo_ak_），
    // 走 CLI 控制面 API（/open/v1/cli-compat/*），不走网页会话。
    // 「签到」无领取端点 = 登录等价动作 + totalGranted 增量核验（10R 同款算法）；
    // 额度 = 积分账面（unit '积分' 计入剩余积分合计），parts 按来源逐包带批次到期日。
    checkin: (account, ctx) => checkinMeoo(account, ctx),
    quota: (account, ctx) => fetchMeooQuota(account, ctx),
    verify: async (account) => {
      const { fetchMeooIdentity } = await import('./meooClient.js');
      const ident = await fetchMeooIdentity(account.token);
      if (!ident.auth) { const e = new Error(ident.error || 'Meoo 凭据已失效，请重新登录或更换控制面 Key'); e.auth = true; throw e; }
      if (!ident.ok) throw new Error(ident.error || 'Meoo 身份验证失败');
      return { name: ident.name || null, uid: ident.uid ? String(ident.uid) : null };
    },
  },
  dumate: {
    label: 'DuMate',
    // 凭据 = console.bce.baidu.com 会话 Cookie（BDUSS + bce-user-info），三条线同形：
    // 本机导入（解密客户端 auth.json）/ 扫码登录（纯 HTTP 二维码）/ 网页会话捕获（登录窗）。
    // 「签到」= 调控制台 loginBonus 领取每日登录赠送积分；验证 = user/info 取 bceUserId 身份。
    // 同步到 10Router 时直接作为 dumate 渠道的 apiKey 消费。
    checkin: (account, ctx) => checkinDumate(account, ctx),
    quota: (account) => fetchDumateQuota(account),
    verify: async (account) => {
      const { fetchDumateIdentity } = await import('./dumateClient.js');
      const ident = await fetchDumateIdentity(account.meta?.cookieSiteSession?.cookie || account.token);
      if (!ident.auth) { const e = new Error(ident.error || 'DuMate 会话已失效'); e.auth = true; throw e; }
      if (!ident.ok) throw new Error(ident.error || 'DuMate 身份验证失败');
      return { name: ident.displayName || null, uid: ident.uid ? String(ident.uid) : null };
    },
  },
  loomy: {
    label: '讯飞 Loomy',
    quota: (account) => fetchLoomyQuota(account),
    verify: (account) => verifyLoomyAccount(account),
  },
  croli: {
    label: 'Croli',
    checkin: async (account, ctx) => checkinCroli(await currentCroliAccount(account, ctx), ctx),
    quota: async (account, ctx) => fetchCroliQuota(await currentCroliAccount(account, ctx), ctx),
    verify: async (account) => {
      const v = await verifyCroliAccount(account);
      if (!v.auth) { const e = new Error(v.error || 'Croli 凭据已失效，请重新本机导入或浏览器登录'); e.auth = true; throw e; }
      if (!v.ok) throw new Error(v.error || 'Croli 身份验证失败');
      return { name: v.name || null, uid: v.uid ? String(v.uid) : null };
    },
  },
  quwork: {
    label: 'QuWork',
    // QuWork（人人租 QurWork 桌面端同账号体系，quwork.cn）：凭据线=本机导入（明文
    // SQLite auth_session 收割，客户端是单会话表、CD 只读不写回，不做切换）。
    // 每日签到领积分（status 门控，10R quworkClaimDailyReward 同款纪律：never blind-fire）；
    // 额度 = points_entitlement.total_points 积分余额；邀请码获取/填写走 /api/user/activate。
    // accessToken 过期由 checkin 内部 /api/user/refresh 续期并经 ctx.onRefresh 回写。
    // 无浏览器登录线：短信登录需阿里云滑块验证码，CD 不做（10R 也只在原生 modal 里做）。
    checkin: (account, ctx) => checkinQuwork(account, ctx),
    quota: (account) => fetchQuworkQuota(account),
    verify: (account) => verifyQuworkAccount(account),
  },
  // AutoClaw（智谱澳龙 / AutoGLM 桌面端）：国际版 autoclaw（Z.AI OAuth）+ 国内版 autoclaw-cn
  // （+86 短信码）两套独立账号体系，一个产品页。凭据 = 账号 JWT（access 约 24h）+ 轮换 rt。
  // 签到 = task-complete 领取每日签到积分（服务端幂等）；额度 = 纯积分账面（无总量无重置窗，
  // 读不到就报错，绝不报 0）。刷新纪律见 autoclawClient.js 文件头：本机快照优先、CD 只兜底代刷。
  // 整条线只读收割本机 auth.json，不做换号（switchTo 固定报错给指引）。
  autoclaw: {
    label: 'AutoClaw',
    checkin: (account, ctx) => checkinAutoclaw(account, ctx),
    quota: (account, ctx) => fetchAutoclawQuotaForAccount(account, ctx),
    verify: (account) => verifyAutoclawAccount(account),
  },
  // 码道 CodeArts（issue #40）已于 2026-10-30 撤下：华为云控制台会话受闲置超时 +
  // WAF 指印绑定，本机无法续期，实测当日内即失效，无法支撑每日定时签到。详见
  // cookieSites.js 末尾的口径说明。
};

/** 包裹 MiniMax 的 ctx.onRefresh：回写账号库后，安全同步新凭据回本机 auth.json（仅本机导入账号且客户端未运行时） */
function wrapMiniMaxRefresh(account, ctx = {}) {
  return {
    ...ctx,
    onRefresh: async (creds) => {
      await ctx.onRefresh?.(creds);
      try {
        const { writeMiniMaxAuth } = await import('./minimaxLocal.js');
        const synced = writeMiniMaxAuth({ ...account, ...creds });
        if (synced) ctx.log?.('已同步新 token 到 MiniMax 客户端');
      } catch {}
    },
  };
}

export function productImpl(provider) {
  return PRODUCTS[productOf(provider)];
}
