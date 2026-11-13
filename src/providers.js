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
import { fetchDoubaoStatus, checkinDoubao } from './doubaoClient.js';
import { checkinLingxi, fetchLingxiQuota } from './lingxiClient.js';
import { checkinMeoo, fetchMeooQuota } from './meooClient.js';
import { fetchLoomyQuota, verifyLoomyAccount } from './loomyClient.js';
/** 从 userinfo 响应中挑一个可读的显示名 */
export function displayNameFrom(ui) {
  const pick = [ui?.nickname, ui?.name, ui?.username, ui?.email]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  return pick || null;
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
      ctx.log?.('网页会话与账号不匹配，忽略资源包明细');
      return null;
    }
    return d;
  } catch (e) {
    if (e.auth) {
      await clearQoderWebSession(account, ctx);
      ctx.log?.('Qoder 网页会话已失效，无法显示逐资源包明细（面板里重新登录一次即可）');
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
    // 无 checkin：mirasim 额度按 5h/7d 滚动窗口分配，不设签到。
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
    checkin: (account) => checkinDoubao(account),
    quota: async (account) => {
      const cookie = account.meta?.cookieSiteSession?.cookie;
      const st = await fetchDoubaoStatus(cookie);
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
    // 网页会话捕获线：凭据是 meoo.com 会话 cookie（meta.cookieSiteSession.cookie，阿里云 SSO 登录）。
    // 「签到」= 调网页端同款 entitlement/init 触发每日首登积分（2000/天，约 6~7 天后过期）；
    // NEED_LOGIN 记失败并提示重新捕获。额度 = 积分余额（独立口径，unit '秒悟积分' 不进剩余积分合计）。
    checkin: (account) => checkinMeoo(account),
    quota: (account) => fetchMeooQuota(account),
  },
  loomy: {
    label: '讯飞 Loomy',
    quota: (account) => fetchLoomyQuota(account),
    verify: (account) => verifyLoomyAccount(account),
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
