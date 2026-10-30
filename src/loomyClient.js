/**
 * 讯飞 Loomy API 客户端 — 模型接口探活、账号信息校验与积分查询。
 *
 * 端点（协议逆向自 Loomy 客户端 points-service.js / account-service.js）：
 *   GET  https://loomyad.xunfei.cn/api/v1/models                     模型列表（Header: token）
 *   GET  {pointsBase}/api/v1/points/balance                          积分余额（Header: token）
 *        pointsBase 来自客户端 points-config：https://ossptest.voicecloud.cn/loomy/integration
 *   POST https://account.xfinfr.com/userinfo/query/baseInfo          会话校验 / 昵称（HMAC 签名，见 loomyAuth.js）
 *
 * 已知坑（2026-10-31 实测）：points/balance 对本机捕获的 session 返回 100002「登录已失效」，
 * 而同一 session 在认证层 baseInfo 是活的——积分后端的会话表与认证服务不同步（疑似只在客户端
 * 首次登录时初始化）。此时如实报「积分暂不可查」，绝不再拿 /models 的模型数量冒充积分
 * （v1.6.5 初版就是这么显示「剩余 13」的，口径全错）。
 */

import { fetchLoomyIdentity } from './loomyAuth.js';

export const LOOMY_BASE_URL = 'https://loomyad.xunfei.cn/api/v1';
/** 积分服务 base（客户端 points-config 默认值；可通过账号 meta.pointsBaseUrl 覆盖） */
export const LOOMY_POINTS_BASE = 'https://ossptest.voicecloud.cn/loomy/integration';

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
 * points/balance → 统一 quota。响应字段按客户端「积分详情」页口径：
 *   永久积分（长期） + 每日赠送积分（每日登录刷新为 5000，未用完部分）
 * 兼容多种字段名；每日上限默认 5000（客户端文案口径）。
 */
export function normalizePointsBalance(data) {
  const d = data?.data || data || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const hasAny = d && typeof d === 'object' && Object.keys(d).length > 0;
  const permanent = num(d.permanentPoints ?? d.longTermPoints ?? d.permanent ?? d.fixed_points);
  const daily = num(d.dailyPoints ?? d.dailyGiftPoints ?? d.daily ?? d.gift_points);
  const dailyLimit = num(d.dailyLimit ?? d.daily_limit) || (hasAny ? 5000 : 0);
  const total = num(d.currentBalance ?? d.totalPoints ?? d.balance) || (permanent + daily);
  const parts = [];
  if (permanent > 0) parts.push({ name: '永久积分', total: permanent, used: 0, remaining: permanent, expiresAt: null, recurring: false, unit: '积分' });
  if (daily > 0 || (hasAny && dailyLimit > 0)) {
    parts.push({ name: '每日赠送积分', total: dailyLimit, used: Math.max(0, dailyLimit - daily), remaining: daily, expiresAt: null, recurring: true, unit: '积分' });
  }
  return {
    total,
    used: Math.max(0, permanent + dailyLimit - total) || 0,
    remaining: total,
    unit: '积分',
    plan: null,
    parts,
    empty: total === 0 && parts.length === 0,
    exceeded: false,
  };
}

/** 积分余额查询。积分后端不认会话（100002）但认证层活着 → 抛「积分暂不可查」而非假数据。 */
export async function fetchLoomyPoints(account) {
  const token = sessionOf(account);
  if (!token) throw new Error('账号缺少 session token');

  let res;
  try {
    res = await fetch(`${pointsBaseOf(account)}/api/v1/points/balance`, {
      method: 'GET',
      headers: { token },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    const err = new Error(`Loomy 积分接口网络失败: ${e.message}`);
    err.transient = true;
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    const err = new Error('Loomy 积分接口鉴权失败');
    err.auth = true;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (data?.code === '100002' || data?.code === '020002') {
    // 积分后端不认此会话——回认证层确认会话真伪，把责任说清楚
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
    const err = new Error(`会话有效（${identity.nickname || identity.phone}），但积分服务未识别该会话——在 Loomy 客户端登录一次即可初始化积分档案`);
    err.pointsUnavailable = true;
    throw err;
  }
  if (data?.code && data.code !== '000000') {
    throw new Error(data.desc || data.message || `Loomy 积分接口错误 (${data.code})`);
  }
  return normalizePointsBalance(data);
}

/** quota 接口：CreditDaddy 配额总览 —— 真实积分口径，失败如实上抛 */
export async function fetchLoomyQuota(account) {
  return fetchLoomyPoints(account);
}
