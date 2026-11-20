/**
 * Croli（croli.net，Clerk 账号体系）每日签到 + 积分余额抓取。
 *
 * 接口（2026-11-20 桌面客户端 app.asar bundle 与本机实测，协议沉淀见
 * 记忆 croli-protocol-reverse.md）：
 *   GET  https://ds.croli.net/credits/v1/ops/home
 *        任务中心全量 → { enabled, serverTime, programs: [{ id, key, name,
 *        status, tasks: [{ id, key, eventKey, periodUnit, periodKey, progress,
 *        target, status, claimMode, milestones: [{index,credits,status}],
 *        streak: {current,longest,nextBonusAt,nextBonusCredits} }] }] }
 *   POST https://ds.croli.net/credits/v1/ops/checkin  { taskId }
 *        → { alreadyCheckedIn, creditsAwarded, streak, nextResetAt }
 *   GET  https://ds.croli.net/credits/v1/account/balance
 *        → { balance, trial: { active, dailyLimitCredits, usedCredits,
 *            remainingCredits, remainingResets, nextResetAt, endsAt } }
 *   GET  https://ds.croli.net/credits/v1/account/ledger?limit&before
 *        → 积分流水（reason: signup_bonus / daily_checkin / ops_task_reward /
 *          invite_reward / client_login_bonus …）
 *   POST https://ds.croli.net/credits/v1/invite/code  { rotate:false }
 *        → { inviteCode, inviterRewardCredits, inviteeRewardCredits }
 *
 * 凭据 = Clerk access token（JWT，iss https://clerk.croli.net，24h 短命），
 * 本机来源两选一：
 *   1. 桌面客户端 %APPDATA%\Croli\auth.json（access_token/refresh_token/expires_at，
 *      sidecar croli-server.exe 用 refresh_token 自动轮换回写——token 随时新鲜，
 *      本机导入即拿即用，与 DuMate 本地导入同思路）
 *   2. CD 自造 OAuth PKCE 登录（croliAuth.js，协议同桌面端：
 *      clerk.croli.net/oauth/authorize + /oauth/token，loopback 回调）
 *
 * 会话失效统一 HTTP 401 {"code":"unauthenticated"}；token 过期且无 refresh
 * 凭据时按「凭据已失效，请重新登录/重新本机导入」处理，不重试、不猜。
 *
 * 首版边界：每日签到（ops/checkin，streak 信息带回）+ 余额展示（balance +
 * trial 剩余）；不推 10Router 外部配额卡（10R 无 croli 渠道口径）。
 */

import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { t } from './i18n.js';

export const CROLI_CREDITS_BASE = 'https://ds.croli.net/credits';
export const CROLI_OPS_HOME_URL = `${CROLI_CREDITS_BASE}/v1/ops/home`;
export const CROLI_CHECKIN_URL = `${CROLI_CREDITS_BASE}/v1/ops/checkin`;
export const CROLI_BALANCE_URL = `${CROLI_CREDITS_BASE}/v1/account/balance`;
export const CROLI_INVITE_CODE_URL = `${CROLI_CREDITS_BASE}/v1/invite/code`;
export const CROLI_INVITE_REDEEM_URL = `${CROLI_CREDITS_BASE}/v1/invite/redeem`;

/** daily-checkin 任务的 key（taskId 服务端编号可能调整，按 key 找行再取 id） */
export const CROLI_CHECKIN_TASK_KEY = 'daily-checkin';

function croliHeaders(token, { json = false } = {}) {
  const h = {
    Authorization: `Bearer ${String(token || '').trim()}`,
    Accept: 'application/json',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function isAuthExpired(status, payload) {
  if (status === 401 || status === 403) return true;
  return payload?.code === 'unauthenticated';
}

/**
 * 统一 GET/JSON。返回 { auth, ok, status, data, code }：
 *   auth=false = 凭据失效（401/403/unauthenticated），ok=false 其余失败。
 */
async function croliRequest(url, token, { method = 'GET', body, fetchImpl } = {}) {
  const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, timeoutMs: FETCH_TIMEOUT_MS }));
  let res;
  try {
    res = await doIt(url, {
      method,
      headers: croliHeaders(token, { json: body !== undefined }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { auth: true, ok: false, status: 0, code: 'network', message: e?.message || String(e) };
  }
  const payload = await res.json().catch(() => null);
  if (isAuthExpired(res.status, payload)) {
    return { auth: false, ok: false, status: res.status, code: payload?.code || 'unauthenticated' };
  }
  if (res.status !== 200) {
    return { auth: true, ok: false, status: res.status, code: payload?.code || `HTTP ${res.status}`, message: payload?.message };
  }
  return { auth: true, ok: true, status: 200, data: payload };
}

/** 任务中心全量（签到状态 / streak / 其它任务的 progress 都在这里） */
export async function fetchCroliOpsHome(token, { fetchImpl } = {}) {
  return croliRequest(CROLI_OPS_HOME_URL, token, { fetchImpl });
}

/** 积分余额 + trial 免费额度 */
export async function fetchCroliBalance(token, { fetchImpl } = {}) {
  return croliRequest(CROLI_BALANCE_URL, token, { fetchImpl });
}

/** 从 ops/home 里抽出 daily-checkin 任务行（找不到返回 null） */
export function croliCheckinTask(opsHome) {
  for (const prog of opsHome?.programs || []) {
    for (const task of prog.tasks || []) {
      if (task.key === CROLI_CHECKIN_TASK_KEY || task.eventKey === CROLI_CHECKIN_TASK_KEY) return task;
    }
  }
  return null;
}

/**
 * 每日签到：先 ops/home 找 daily-checkin 任务（拿 taskId 与今日状态），
 * 未完成才 POST ops/checkin。幂等：status=claimed 时直接 already。
 */
export async function checkinCroli(account, ctx = {}) {
  const token = account?.token;
  if (!token) {
    return { status: 'failed', authExpired: true, message: t('Croli 凭据缺失，请重新本机导入或浏览器登录') };
  }
  const fetchImpl = ctx?.fetchImpl;

  const home = await fetchCroliOpsHome(token, { fetchImpl });
  if (!home.auth) {
    return { status: 'failed', authExpired: true, message: t('Croli 凭据已失效（{code}），请重新本机导入或浏览器登录', { code: home.code || 'unauthenticated' }) };
  }
  if (!home.ok) {
    return { status: 'failed', message: t('Croli 任务中心读取失败：{err}', { err: home.code || 'network' }) };
  }
  const task = croliCheckinTask(home.data);
  if (!task) {
    // 服务端没有 daily-checkin 任务（活动下线 / 结构变化）——如实报告，不猜 taskId
    return { status: 'no-activity', message: t('任务中心无每日签到活动（可能已下线）') };
  }

  // 余额旁路（失败不影响领取结果）
  let balanceAfter;
  try {
    const bal = await fetchCroliBalance(token, { fetchImpl });
    if (bal.ok && Number.isFinite(bal.data?.balance)) balanceAfter = bal.data.balance;
  } catch { /* 余额拿不到不阻断 */ }

  if (task.status === 'claimed' || task.progress >= task.target) {
    return { status: 'already', message: t('今日已签到'), ...(balanceAfter !== undefined ? { balanceAfter } : {}) };
  }

  try {
    const r = await croliRequest(CROLI_CHECKIN_URL, token, { method: 'POST', body: { taskId: task.id }, fetchImpl });
    if (!r.auth) {
      return { status: 'failed', authExpired: true, message: t('Croli 凭据已失效（{code}），请重新本机导入或浏览器登录', { code: r.code || 'unauthenticated' }) };
    }
    if (!r.ok) {
      // 并发领取已被服务端记过 / 活动暂停：按服务端话术归类
      const code = String(r.code || '');
      if (/already|checked/i.test(code)) return { status: 'already', message: t('今日已签到') };
      return { status: 'failed', message: t('Croli 签到失败：{err}', { err: code || 'network' }) };
    }
    const awarded = Number(r.data?.creditsAwarded) || 0;
    const streak = r.data?.streak;
    ctx?.log?.(t('Croli 签到成功'));
    return {
      status: 'checked-in',
      message: awarded > 0 ? t('签到成功（+{n} 积分）', { n: awarded }) : t('签到成功'),
      claimedAmount: awarded,
      amount: awarded,
      streakDays: Number.isFinite(Number(streak?.current)) ? Number(streak.current) : undefined,
      ...(balanceAfter !== undefined ? { balanceAfter } : {}),
    };
  } catch (e) {
    return { status: 'failed', message: t('Croli 签到失败：{err}', { err: e?.message || 'network' }) };
  }
}

/**
 * 积分余额快照（额度卡口径）：balance 为主，trial 每日免费额度并入提示行。
 * parts：[积分余额] + [今日免费额度（剩余/上限）]。
 */
export async function fetchCroliQuota(account, { fetchImpl } = {}) {
  const token = account?.token;
  if (!token) {
    const err = new Error(t('Croli 凭据缺失，请重新本机导入或浏览器登录'));
    err.auth = true;
    throw err;
  }
  const bal = await fetchCroliBalance(token, { fetchImpl });
  if (!bal.auth) {
    const err = new Error(t('Croli 凭据已失效（{code}），请重新本机导入或浏览器登录', { code: bal.code || 'unauthenticated' }));
    err.auth = true;
    throw err;
  }
  if (!bal.ok) {
    throw new Error(t('Croli 余额读取失败：{err}', { err: bal.code || 'network' }));
  }
  const d = bal.data || {};
  const balance = Number(d.balance) || 0;
  const trial = d.trial || {};
  const parts = [{ name: t('积分余额'), total: balance, used: 0, remaining: balance }];
  if (trial.active && Number(trial.dailyLimitCredits) > 0) {
    const limit = Number(trial.dailyLimitCredits);
    const used = Number(trial.usedCredits) || 0;
    parts.push({
      name: t('今日免费额度'),
      total: limit,
      used,
      remaining: Math.max(0, Number.isFinite(Number(trial.remainingCredits)) ? Number(trial.remainingCredits) : Math.max(0, limit - used)),
      recurring: true,
      expiresAt: trial.nextResetAt || undefined,
    });
  }
  return {
    unit: '积分',
    total: parts.reduce((s, p) => s + p.total, 0),
    used: parts.reduce((s, p) => s + p.used, 0),
    remaining: parts.reduce((s, p) => s + p.remaining, 0),
    parts,
    exceeded: balance <= 0,
  };
}

/** 身份验证（addAccount verify 调用）：balance 200 即凭据有效；顺带带出 ops/home 里的账号线索 */
export async function verifyCroliAccount(account, { fetchImpl } = {}) {
  const token = account?.token;
  if (!token) return { auth: false, ok: false, error: t('缺少 Croli 凭据') };
  const bal = await fetchCroliBalance(token, { fetchImpl });
  if (!bal.auth) return { auth: false, ok: false, error: t('Croli 凭据已失效，请重新本机导入或浏览器登录') };
  if (!bal.ok) return { auth: true, ok: false, error: bal.code || 'network' };
  // uid：Clerk JWT 的 sub（user_…），归户稳定且不需要额外请求
  let uid = null;
  try {
    const seg = String(token).split('.');
    if (seg.length === 3) uid = JSON.parse(Buffer.from(seg[1], 'base64url').toString('utf8'))?.sub || null;
  } catch { /* JWT 解析失败不阻断 */ }
  return { auth: true, ok: true, uid, name: null };
}

/** uid 脱敏（user_3MMY… → use****5jz） */
export function maskCroliUserId(id) {
  const s = String(id ?? '');
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-3);
  if (s.length >= 4) return s.slice(0, 1) + '****' + s.slice(-1);
  return '****';
}

/**
 * 我的邀请码：POST /v1/invite/code {rotate:false}（实测 2026-11-20：
 * → { inviteCode, inviterRewardCredits:2500, inviteeRewardCredits:3000 }；
 * rotate=true 会换新码（旧码作废），CD 一律 rotate:false 只读不轮换）
 */
export async function fetchCroliMyInviteCode(token, { fetchImpl } = {}) {
  if (!token) return { auth: true, ok: false, error: t('缺少 Croli 凭据') };
  const r = await croliRequest(CROLI_INVITE_CODE_URL, token, { method: 'POST', body: { rotate: false }, fetchImpl });
  if (!r.auth) return { auth: false, ok: false, error: t('Croli 凭据已失效，请重新本机导入或浏览器登录') };
  if (!r.ok) return { auth: true, ok: false, error: r.code || 'network' };
  return {
    auth: true,
    ok: true,
    code: r.data?.inviteCode || null,
    inviterRewardCredits: Number(r.data?.inviterRewardCredits) || null,
    inviteeRewardCredits: Number(r.data?.inviteeRewardCredits) || null,
  };
}

/** 兑换邀请码：POST /v1/invite/redeem {inviteCode, source}（好友安装并完成首个任务后双方得积分） */
export async function redeemCroliInviteCode(token, code, { fetchImpl } = {}) {
  const clean = String(code || '').trim();
  if (!clean) return { ok: false, error: t('邀请码不能为空') };
  const r = await croliRequest(CROLI_INVITE_REDEEM_URL, token, { method: 'POST', body: { inviteCode: clean, source: 'task_center' }, fetchImpl });
  if (!r.auth) return { ok: false, authExpired: true, error: t('Croli 凭据已失效，请重新本机导入或浏览器登录') };
  if (!r.ok) {
    // 服务端错误码（bundle 口径）：已兑换过 / 码不存在 / 自己的码等——code 即话术
    return { ok: false, error: r.code || 'network' };
  }
  return { ok: true, message: r.data?.message || '', result: r.data ?? null };
}
