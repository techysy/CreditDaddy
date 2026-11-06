/**
 * 讯飞 Loomy API 客户端 — 模型接口探活、账号信息校验与积分查询。
 *
 * 端点（协议逆向自 Loomy 客户端 points-service.js / LoginPage，2026-10-31 从 app.asar 实证）：
 *   GET  https://loomyad.xunfei.cn/api/v1/models                     模型列表（Header: token）
 *   GET  {pointsBase}/api/v1/points/records?pageNo=1&pageSize=1&recordType=all
 *        积分余额（Header: token）——客户端没有 /points/balance 端点！余额字段就挂在
 *        records 响应 data.data 上：balance（永久积分）/ dailyBalance（每日赠送剩余）/
 *        dailyLimitPoints（每日上限）/ dailyConsumedPoints / dailyRemainingPoints。
 *        V2 records（/api/v2/points/records?direction&granularity）同样带 balance/dailyBalance。
 *   POST {pointsBase}/api/v1/points/first-login  body {}              积分档案初始化（幂等，
 *        客户端每次手机号登录成功后必调；100002 时补调一次再重试余额）
 *        pointsBase = https://loomyad.xunfei.cn（生产；2026-10-31 实测 wire 证据：客户端运行期
 *        只连 loomyad 不连 ossptest，且同一 session 在 loomyad 上 records 直接返回
 *        code=000000、balance=10500 与客户端 UI 一致）
 *   POST https://account.xfinfr.com/userinfo/query/baseInfo          会话校验 / 昵称（HMAC 签名，见 loomyAuth.js）
 *
 * 已知坑（2026-10-31 实测）：客户端 points-config.js 的 DEFAULT_BASE_URL 是
 * ossptest.voicecloud.cn/loomy/integration —— 那是开发/测试环境，积分会话表与生产独立，
 * 拿生产 session 打它必得 100002「登录已失效」（认证层 baseInfo 却是活的，极具迷惑性）。
 * 生产积分服务与 models/auth 同域 loomyad.xunfei.cn。之前 100002 的真正根因就是打错了环境，
 * 而不是会话失效。V1 records 响应不回 dailyLimitPoints（客户端 UI 的 /5000 上限来自文案口径）。
 * 无论如何，绝不再拿 /models 的模型数量冒充积分（v1.6.5 初版显示「剩余 13」就是这么来的）。
 */

import { fetchLoomyIdentity } from './loomyAuth.js';

export const LOOMY_BASE_URL = 'https://loomyad.xunfei.cn/api/v1';
/** 积分服务 base（生产域，与 models/auth 同域；可通过账号 meta.pointsBaseUrl 覆盖） */
export const LOOMY_POINTS_BASE = 'https://loomyad.xunfei.cn';
/** 客户端 points-config 的测试环境默认值——会话表独立，别用（留作显式覆盖的参考） */
export const LOOMY_POINTS_BASE_TEST = 'https://ossptest.voicecloud.cn/loomy/integration';

function pointsBaseOf(account) {
  const v = String(account?.meta?.pointsBaseUrl || '').trim();
  return v || LOOMY_POINTS_BASE;
}

function sessionOf(account) {
  const token = account?.token || account?.apiKey || account?.session;
  return String(token || '').trim();
}

/** 验证 Loomy 凭据有效性并获取可用模型数量 */
export async function fetchLoomyModels(token) {
  if (!token) throw new Error('缺少 Loomy session token');
  const res = await fetch(`${LOOMY_BASE_URL}/models`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      token: String(token).trim(),
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 401 || res.status === 403) {
    const err = new Error('Loomy session 已过期或无效，请在 Loomy 客户端重新登录');
    err.auth = true;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Loomy /models 接口返回失败: HTTP ${res.status} ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  if (data?.code === '100002') {
    const err = new Error('Loomy 提示缺少 token 或鉴权失败');
    err.auth = true;
    throw err;
  }

  const models = data?.data || data?.models || [];
  return models;
}

/** verify 接口：添加账号时的基本资料校验（优先认证层 baseInfo 拿昵称，/models 只做能力面确认） */
export async function verifyLoomyAccount(account) {
  const token = sessionOf(account);
  if (!token) throw new Error('账号缺少 session token');

  // 会话真伪以认证层为准（models 网关与认证服务口径可能不一致）
  let identity = null;
  try {
    identity = await fetchLoomyIdentity(token);
  } catch (e) {
    if (e.auth) {
      const err = new Error('Loomy session 已失效，请重新登录（短信验证码或客户端本机导入）');
      err.auth = true;
      throw err;
    }
    // 认证层抖动：退回 models 探活，别让一次网络抖动挡导入
    await fetchLoomyModels(token);
  }

  const phone = identity?.phone || account?.phone || '';
  const uid = identity?.userid || account?.uid || account?.userid || null;
  const nickname = identity?.nickname || null;

  const displayName = nickname
    ? `Loomy (${nickname})`
    : phone
      ? `Loomy (${String(phone).slice(0, 3)}****${String(phone).slice(-4)})`
      : uid
        ? `Loomy (${String(uid).slice(-6)})`
        : 'Loomy 账号';

  return { name: displayName, uid, email: null };
}

/**
 * records V1 → 统一 quota。字段与客户端「积分详情」页完全同源（侧边栏
 * permanentPointsLabel=ly(balance)、dailyPointsLabel=ly(dailyBalance)）：
 *   永久积分 = balance（服务端总账，客户端就把它标成「永久积分」）
 *   每日赠送积分 = dailyBalance / dailyLimitPoints（每日登录自动刷新为 5000）
 * 兼容少量旧字段名；每日上限缺省按客户端文案口径 5000。
 */
export function normalizePointsBalance(data) {
  const d = data?.data || data || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const permanent = num(d.balance ?? d.permanentPoints ?? d.currentBalance ?? d.longTermPoints);
  const daily = num(d.dailyBalance ?? d.dailyPoints ?? d.dailyGiftPoints);
  // 每日上限：服务端显式给了就用它的值（哪怕是 0）；没给才按客户端文案口径缺省 5000——
  // 且只在账号确实有积分活动时缺省，零余额空号不再被捏造出「0/5000 已用 5000」的幻影额度
  const limitRaw = d.dailyLimitPoints ?? d.dailyLimit ?? d.daily_limit;
  const hasLimit = limitRaw !== undefined && limitRaw !== null && limitRaw !== '';
  const dailyLimit = hasLimit ? num(limitRaw) : ((permanent > 0 || daily > 0) ? 5000 : 0);
  // 总额 = 永久 + 每日上限（容量口径），remaining = 永久 + 每日剩余（余额口径）——
  // 两者相等会让进度条恒满、used 段永远看不见（#审查）
  const total = permanent + dailyLimit;
  const remaining = permanent + daily;
  const parts = [];
  if (permanent > 0) parts.push({ name: '永久积分', total: permanent, used: 0, remaining: permanent, expiresAt: null, recurring: false, unit: '积分' });
  // 服务端上报的 dailyConsumedPoints 存在即直读（哪怕是 0——「今日确实没消耗」），
  // 缺字段才按 dailyLimit - daily 倒推；|| 链会把如实上报的 0 当缺失，
  // 倒推出「已用 2000」的幻影（#42）。顶层 used 同口径：永久积分无消耗数据，总已用 = 每日已用。
  const hasConsumed = d.dailyConsumedPoints !== undefined && d.dailyConsumedPoints !== null;
  const dailyUsed = hasConsumed ? num(d.dailyConsumedPoints) : Math.max(0, dailyLimit - daily);
  if (daily > 0 || dailyLimit > 0) {
    parts.push({ name: '每日赠送积分', total: dailyLimit, used: dailyUsed, remaining: daily, expiresAt: null, recurring: true, unit: '积分' });
  }
  return {
    total,
    used: dailyUsed,
    remaining,
    unit: '积分',
    plan: null,
    parts,
    empty: total === 0 && parts.length === 0,
    exceeded: false,
  };
}

const LOOMY_POINTS_OK_CODES = new Set(['000000', 0, '0']);

async function pointsRecordsCall(base, token) {
  let res;
  try {
    res = await fetch(`${base}/api/v1/points/records?pageNo=1&pageSize=1&recordType=all`, {
      method: 'GET',
      headers: { token },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    const err = new Error(`Loomy 积分接口网络失败: ${e.message}`);
    err.transient = true;
    throw err;
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  // 会话失效的业务码放行给上层（first-login 重试 / 如实报错），其余 HTTP/解析失败都要显性报错，
  // 绝不让 5xx/HTML 错误页被吞成「空余额」
  if (data?.code === '100002' || data?.code === '020002') return data;
  if (!res.ok) {
    throw new Error(`Loomy 积分接口 HTTP ${res.status}: ${(data?.desc || data?.message || text.slice(0, 120) || '').trim()}`);
  }
  if (!data) throw new Error(`Loomy 积分接口返回了非 JSON 数据 (HTTP ${res.status})`);
  return data;
}

/** 积分档案初始化（客户端登录后必调的 first-login，幂等）。尽力而为，失败交给余额重试暴露。 */
export async function fetchLoomyFirstLogin(account) {
  const token = sessionOf(account);
  if (!token) throw new Error('账号缺少 session token');
  await pointsFirstLogin(pointsBaseOf(account), token);
}

async function pointsFirstLogin(base, token) {
  try {
    await fetch(`${base}/api/v1/points/first-login`, {
      method: 'POST',
      headers: { token, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(12000),
    });
  } catch { /* 初始化失败不阻断流程 */ }
}

/** 积分余额查询：records V1（余额字段挂在响应上）→ 100002 时按客户端协议补 first-login 再重试一次。 */
export async function fetchLoomyPoints(account) {
  const token = sessionOf(account);
  if (!token) throw new Error('账号缺少 session token');
  const base = pointsBaseOf(account);

  let data = await pointsRecordsCall(base, token);

  if (data?.code === '100002' || data?.code === '020002') {
    await pointsFirstLogin(base, token);
    data = await pointsRecordsCall(base, token);
  }

  if (data?.code === '100002' || data?.code === '020002') {
    // 仍不认此会话——回认证层确认会话真伪，把责任说清楚
    let identity = null;
    try {
      identity = await fetchLoomyIdentity(token);
    } catch (e) {
      if (e.auth) {
        const err = new Error('Loomy session 已失效，请重新登录');
        err.auth = true;
        throw err;
      }
      throw new Error('Loomy 积分接口与认证服务均不可达，请稍后重试');
    }
    const err = new Error(`会话有效（${identity.nickname || identity.phone}），但积分服务始终不认该会话（已按客户端协议补做 first-login 初始化）——请在 Loomy 客户端重新登录一次`);
    err.pointsUnavailable = true;
    throw err;
  }
  if (data?.code && !LOOMY_POINTS_OK_CODES.has(data.code)) {
    throw new Error(data.desc || data.message || `Loomy 积分接口错误 (${data.code})`);
  }
  return normalizePointsBalance(data);
}

/** quota 接口：CreditDaddy 配额总览 —— 真实积分口径，失败如实上抛 */
export async function fetchLoomyQuota(account) {
  return fetchLoomyPoints(account);
}

/** 邀请码激活状态：GET /api/v1/points/activation → {activated, appliedInvitationCode?}（实测响应形状） */
export async function fetchLoomyActivation(account) {
  const token = sessionOf(account);
  if (!token) throw new Error('账号缺少 session token');
  let res;
  try {
    res = await fetch(`${pointsBaseOf(account)}/api/v1/points/activation`, {
      method: 'GET',
      headers: { token },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    const err = new Error(`Loomy 激活状态查询网络失败: ${e.message}`);
    err.transient = true;
    throw err;
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (data?.code === '100002' || data?.code === '020002') {
    const err = new Error('Loomy session 已失效，请重新登录');
    err.auth = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Loomy 激活状态查询 HTTP ${res.status}: ${(data?.desc || data?.message || text.slice(0, 120) || '').trim()}`);
  }
  if (!data) throw new Error(`Loomy 激活状态查询返回了非 JSON 数据 (HTTP ${res.status})`);
  if (data?.code && !LOOMY_POINTS_OK_CODES.has(data.code)) {
    throw new Error(data.desc || data.message || `Loomy 激活状态查询错误 (${data.code})`);
  }
  const d = data?.data || {};
  return { activated: Boolean(d.activated), appliedInvitationCode: d.appliedInvitationCode || null };
}

/**
 * 我的邀请码列表：GET /api/v1/invitation-codes → data.data.list[]（协议逆向自客户端
 * points-service.queryInvitationCodes + 设置页「邀请有礼」，2026-11-06 从 app.asar 实证）。
 * 客户端 bundle 里按 {code, usedCount, limit} 解析，但生产端实测（2026-11-06）字段是
 * {inviteCode, usedCount, maxUses, status}——两种形状都归一化，以实测 wire 为准。
 * 客户端在列表为空时会先调 first-login 初始化积分档案再重查（新号可能还没建档）。
 */
export async function fetchLoomyMyInviteCodes(account) {
  const token = sessionOf(account);
  if (!token) throw new Error('账号缺少 session token');
  let res;
  try {
    res = await fetch(`${pointsBaseOf(account)}/api/v1/invitation-codes`, {
      method: 'GET',
      headers: { token },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    const err = new Error(`Loomy 邀请码查询网络失败: ${e.message}`);
    err.transient = true;
    throw err;
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (data?.code === '100002' || data?.code === '020002') {
    const err = new Error('Loomy session 已失效，请重新登录');
    err.auth = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Loomy 邀请码查询 HTTP ${res.status}: ${(data?.desc || data?.message || text.slice(0, 120) || '').trim()}`);
  }
  if (!data) throw new Error(`Loomy 邀请码查询返回了非 JSON 数据 (HTTP ${res.status})`);
  if (data?.code && !LOOMY_POINTS_OK_CODES.has(data.code)) {
    throw new Error(data.desc || data.message || `Loomy 邀请码查询错误 (${data.code})`);
  }
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  return list
    .map((x) => {
      const limit = Number(x?.maxUses ?? x?.limit) || 0;
      return {
        id: String(x?.id ?? x?.inviteCode ?? x?.code ?? ''),
        code: String(x?.inviteCode || x?.code || '').trim(),
        usedCount: Number(x?.usedCount) || 0,
        limit,
        status: String(x?.status || '').trim(),
      };
    })
    .filter((x) => x.code);
}

/** 绑定邀请码：POST /api/v1/points/activation {inviteCode} → 服务端 +5000 永久积分（每号一次） */
export async function bindLoomyInviteCode(account, code) {
  const token = sessionOf(account);
  if (!token) throw new Error('账号缺少 session token');
  const clean = String(code || '').trim();
  if (!clean) throw new Error('缺少邀请码');
  let res;
  try {
    res = await fetch(`${pointsBaseOf(account)}/api/v1/points/activation`, {
      method: 'POST',
      headers: { token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteCode: clean }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const err = new Error(`Loomy 邀请码绑定网络失败: ${e.message}`);
    err.transient = true;
    throw err;
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (data?.code === '100002' || data?.code === '020002') {
    const err = new Error('Loomy session 已失效，请重新登录');
    err.auth = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Loomy 邀请码绑定 HTTP ${res.status}: ${(data?.desc || data?.message || text.slice(0, 120) || '').trim()}`);
  }
  if (!data) throw new Error(`Loomy 邀请码绑定返回了非 JSON 数据 (HTTP ${res.status})`);
  if (data?.code && !LOOMY_POINTS_OK_CODES.has(data.code)) {
    const err = new Error(data.desc || data.message || `邀请码绑定失败 (${data.code})`);
    err.serverCode = data.code;
    throw err;
  }
  return { bound: true, desc: data.desc || null, data: data.data || {} };
}
