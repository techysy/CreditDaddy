/**
 * QuWork（quwork.cn，人人租 QurWork 桌面端同一账号体系）协议客户端 —
 * 每日签到（积分）、额度（points_entitlement）、邀请码获取/填写（activate）。
 *
 * 协议整段照搬 10router `open-sse/shared/quwork/client.js`（2026-11-26 该仓已实测上线；
 * 协议源自开源 quwork-auth@0.1.0，github okdunli/quwork-auth，MIT）：
 *   账号网关  https://llm.rrzu.com（/api/user/self、/api/user/refresh、
 *             /api/user/daily-reward/status|claim、/api/user/activate、/api/user/invite/summary）
 *   推理网关  https://llm.quwork.cn/v1（CD 不做网关，仅收割 llmToken 备查，不消费）
 *   公共头    X-QurWork-Env: prod / X-QurWork-Version: 1.7.5
 *             （/api/user/activate 拒绝 < 1.6.5，与当前桌面端对齐）
 *   响应统一包 {success,data,message,code}；HTTP 405 = 阿里云 WAF 拦非大陆出口 IP。
 *
 * 凭据语义（本机 sqlite 快照 + 10R 口径双实锤）：
 *   accessToken = 账号 token（Bearer，签到/额度/激活全用它）；过期用 /api/user/refresh
 *     （GET，Bearer 旧 token）续期——**请求与响应都用同一字段名 token**，没有独立
 *     refreshToken 概念；续期结果经 ctx.onRefresh 回写账号库。
 *   llmToken（sk-…）= 推理 Bearer，QuWork 从不轮换，本客户端不碰。
 *
 * 网络：统一走 fetchJsonRace（配置了国内出站代理时直连/代理双路兜底——QuWork 网关
 * 只认大陆出口 IP，海外直连必吃 405），fetchImpl 注入供测试。
 *
 * 签到纪律：必须先查 status 再决定是否 claim（10R 同款「never blind-fires claim」），
 * wechat_required 单独归类，绝不盲打领取。
 *
 * CD 侧取舍（相对 10R 客户端）：短信登录 / 微信 OAuth 绑定 / 模型目录 / 推理探测
 * 都不需要（CD 只做收割+签到+邀请码），故不搬；阿里云滑块验证码因此也不接。
 */

import { createHash, randomBytes } from 'node:crypto';
import { QUWORK_AUTH_API, QUWORK_HEADERS, FETCH_TIMEOUT_MS } from './constants.js';
import { fetchJsonRace } from './zcodeClient.js';
import { t } from './i18n.js';

const norm = (v) => String(v ?? '').trim();

// 文案一律在调用时求值（t() 读当前 locale）：写成模块常量会在加载时锁死中文，
// 面板切英/日后这些错误就永远不翻译。
const wafHint = () => t('QuWork 网关拒绝（HTTP 405，阿里云 WAF 拦截非中国大陆 IP）——请在设置中配置国内出站代理或连接代理');
const errorHints = () => ({
  wechat_bind_required: t('请先绑定微信，再填写邀请码/兑换码'),
  client_version_too_low: t('QuWork 拒绝：客户端版本过低（client_version_too_low）'),
});

function authExpiredText() {
  return t('QuWork 登录已失效，请在客户端重新登录后重新本机导入');
}

/**
 * 调用 QuWork 账号网关并解包 {success,data,message,code}。
 * 返回 { auth, ok, status, data, message, code }——auth=false 表示凭据失效（调用方
 * 决定是续期重试还是报错），绝不静默吞错。
 */
export async function quworkApiRequest(path, {
  method = 'GET', accessToken, json, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const headers = { Accept: 'application/json', ...QUWORK_HEADERS };
  let body = null;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    const doIt = fetchImpl || ((u, init) => fetchJsonRace(u, { ...init, preferProxy: true }));
    res = await doIt(QUWORK_AUTH_API + path, { method, headers, body, timeoutMs });
  } catch (e) {
    return { auth: true, ok: false, status: 0, code: 'network', message: t('QuWork 网络请求失败：{err}', { err: e?.message || e }) };
  }
  const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: String(text).slice(0, 200) }; }
  if (res.status === 405) return { auth: true, ok: false, status: 405, code: 'waf_blocked', message: wafHint() };
  if (res.status === 401 || res.status === 403) {
    return { auth: false, ok: false, status: res.status, code: norm(payload?.code), message: norm(payload?.message) || authExpiredText() };
  }
  const failed = payload && typeof payload === 'object' && 'success' in payload && !payload.success;
  if (failed) {
    const code = norm(payload?.data?.error_code) || norm(payload.error_code) || norm(payload.code);
    return {
      auth: true, ok: false, status: res.status, code,
      message: errorHints()[code] || norm(payload.message) || code || t('QuWork 接口返回失败'),
      data: payload.data ?? null,
    };
  }
  if (!res.ok) return { auth: true, ok: false, status: res.status, code: `HTTP ${res.status}`, message: t('QuWork 接口 HTTP {s}', { s: res.status }) };
  const data = payload && typeof payload === 'object' && 'data' in payload ? (payload.data ?? {}) : payload;
  return { auth: true, ok: true, status: res.status, data, message: norm(payload?.message), code: norm(payload?.code) };
}

/**
 * 64-hex 设备标识（QuWork 形状，10R quworkDeviceIdentifier 同款算法）。
 * 每账号生成一次存 meta.quworkDeviceId 复用：/api/user/activate 与登录设备绑定，
 * 反复用随机值会让服务端看到「同一账号换机器」，激活行为不可预期。
 */
export function quworkDeviceIdentifier(seed) {
  const value = norm(seed) || randomBytes(32).toString('hex');
  return createHash('sha256').update(JSON.stringify({
    ns: 'quwork.device-identifier', version: 1, platform: 'other', source: 'generated', value,
  })).digest('hex');
}

/** /api/user/self：账号资料（aff_code 邀请码、wechat_bound、points_entitlement 积分） */
export async function quworkSelfInfo(accessToken, opts = {}) {
  return quworkApiRequest('/api/user/self', { ...opts, accessToken });
}

/**
 * /api/user/refresh（GET，Bearer 旧 access token）续期。
 * 成功返回 { accessToken, expiresAt(ISO) }；失败返回 null（调用方继续用旧 token 报错）。
 */
export async function quworkRefreshAccess(accessToken, opts = {}) {
  const r = await quworkApiRequest('/api/user/refresh', { ...opts, accessToken });
  if (!r.ok) return null;
  const next = norm(r.data?.token);
  if (!next) return null;
  const exp = Number(r.data?.expire);
  const expiresAt = exp > 0 ? new Date(exp * 1000).toISOString() : new Date(Date.now() + 2 * 3600_000).toISOString();
  return { accessToken: next, expiresAt };
}

/** 签到状态查询（领取得先门控，绝不盲打 claim） */
export async function quworkDailyRewardStatus(accessToken, opts = {}) {
  return quworkApiRequest('/api/user/daily-reward/status', { ...opts, accessToken });
}

export async function quworkDailyRewardClaim(accessToken, opts = {}) {
  return quworkApiRequest('/api/user/daily-reward/claim', { ...opts, method: 'POST', accessToken, json: {} });
}

/**
 * status 门控领取（10R quworkClaimDailyReward 同口径）：
 *   wechat_required + can_claim → 提示去客户端绑微信（不做盲领）
 *   claimed / can_claim=false   → 今日已领
 *   其余                        → POST claim，granted 才计成功
 * @returns { outcome: 'claimed'|'done'|'wechat_required'|'failed', claimed, points, message, authExpired? }
 */
export async function quworkClaimDailyReward(accessToken, opts = {}) {
  const st = await quworkDailyRewardStatus(accessToken, opts);
  if (!st.auth) return { outcome: 'failed', claimed: false, points: 0, authExpired: true, message: st.message || authExpiredText() };
  if (!st.ok) return { outcome: 'failed', claimed: false, points: 0, message: st.message || t('QuWork 签到状态查询失败：{err}', { err: st.code || 'network' }) };
  const s = st.data || {};
  if (s.wechat_required && s.can_claim) {
    return { outcome: 'wechat_required', claimed: false, points: 0, message: t('今日签到需先在 QuWork 客户端绑定微信') };
  }
  if (s.claimed === true || s.can_claim === false) {
    return { outcome: 'done', claimed: false, points: 0, message: t('今日已签到'), status: s };
  }
  const cl = await quworkDailyRewardClaim(accessToken, opts);
  if (!cl.auth) return { outcome: 'failed', claimed: false, points: 0, authExpired: true, message: cl.message || authExpiredText() };
  if (!cl.ok) {
    // 并发轮/服务端已记账：错误码含 already/claimed/signed 归「已领」，其余算失败
    const code = String(cl.code || '');
    if (/already|claimed|signed|received/i.test(code) || /已领|已签到|已领取/.test(String(cl.message || ''))) {
      return { outcome: 'done', claimed: false, points: 0, message: t('今日已签到') };
    }
    return { outcome: 'failed', claimed: false, points: 0, message: cl.message || t('QuWork 签到失败：{err}', { err: code || 'network' }) };
  }
  const after = cl.data || {};
  if (after.granted) {
    const points = Number(after.points ?? 0) || 0;
    return {
      outcome: 'claimed', claimed: true, points,
      message: points > 0 ? t('签到成功（+{n} 积分）', { n: points }) : t('签到成功'),
      status: after,
    };
  }
  return { outcome: 'done', claimed: false, points: 0, message: t('今日已签到'), status: after };
}

/** /api/user/self → 积分账面（points_entitlement.total_points 即当前余额） */
export function quworkPointsFromSelf(self) {
  const e = self?.points_entitlement ?? self?.pointsEntitlement ?? {};
  const n = (v) => (v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  return {
    total: n(e.total_points ?? e.totalPoints),
    limited: n(e.limited_points ?? e.limitedPoints),
    permanent: n(e.permanent_points ?? e.permanentPoints),
  };
}

/** 额度卡（统一结构）：积分为累计池，limited/permanent 作明细行 */
export async function fetchQuworkQuota(account, { fetchImpl } = {}) {
  const token = norm(account?.token);
  if (!token) {
    const e = new Error(t('QuWork 凭据缺失，请重新本机导入'));
    e.auth = true;
    throw e;
  }
  const r = await quworkSelfInfo(token, { fetchImpl });
  if (!r.auth) {
    const e = new Error(r.message || authExpiredText());
    e.auth = true;
    throw e;
  }
  if (!r.ok) throw new Error(r.message || t('QuWork 额度读取失败：{err}', { err: r.code || 'network' }));
  const self = r.data || {};
  const pts = quworkPointsFromSelf(self);
  const balance = Math.max(0, pts.total ?? 0);
  const parts = [{ name: t('积分余额'), total: balance, used: 0, remaining: balance }];
  for (const [v, label] of [[pts.limited, t('限时积分')], [pts.permanent, t('永久积分')]]) {
    if (Number.isFinite(v) && v > 0 && Math.abs(v - pts.total) > 1e-6) {
      parts.push({ name: t('{label}（含于余额）', { label }), total: v, used: 0, remaining: v });
    }
  }
  return {
    unit: t('积分'),
    total: balance,
    used: 0,
    remaining: balance,
    parts,
    exceeded: balance <= 0,
  };
}

/**
 * 添加账号校验（providers.js verify 契约：**失败抛错**让 addAccount 落 verified=false；
 * 返回 {name, uid, email} 补全资料）。/api/user/self 200 即凭据有效。
 * display_name 真机上是手机号——name 只在非纯数字时取，避免整串手机号进账号名。
 */
export async function verifyQuworkAccount(account, opts = {}) {
  const token = norm(account?.token);
  if (!token) throw new Error(t('缺少 QuWork 凭据'));
  const r = await quworkSelfInfo(token, opts);
  if (!r.auth || !r.ok) {
    const e = new Error(r.message || r.code || t('QuWork 身份验证失败'));
    e.auth = !r.auth;
    throw e;
  }
  const u = r.data || {};
  const raw = norm(u.display_name || u.nickname || u.username);
  return {
    uid: u.id === undefined || u.id === null ? null : String(u.id),
    name: (/^\d{11}$/.test(raw) ? '' : raw) || null,
    email: norm(u.email) || null,
  };
}

/**
 * 每日签到（providers.js 挂点）。返回形状对齐 checkin.js 约定：
 *   checked-in: claimedAmount=本次积分；streakDays 回签到**前**口径（+1 由调度器做）
 *   balanceAfter: 领取后余额（自 self 快照——签到链路本就打 self，无需额外请求）
 */
export async function checkinQuwork(account, ctx = {}) {
  const token = norm(account?.token);
  if (!token) {
    return { status: 'failed', authExpired: true, message: t('QuWork 凭据缺失，请重新本机导入') };
  }
  const fetchImpl = ctx?.fetchImpl;
  const opts = { fetchImpl };

  // accessToken 已过期 → 先续期一轮（10R withAccess 同款：失败不阻断，用旧 token 打一次拿真实错误）
  let live = token;
  const expMs = Date.parse(account?.expiresAt || '');
  if (Number.isFinite(expMs) && expMs <= Date.now()) {
    const fresh = await quworkRefreshAccess(token, opts);
    if (fresh) {
      live = fresh.accessToken;
      try {
        await ctx?.onRefresh?.({ token: fresh.accessToken, refreshToken: null, expiresAt: fresh.expiresAt });
        ctx?.log?.(t('QuWork accessToken 已续期'));
      } catch { /* 回写失败不阻断本轮领取 */ }
    }
  }

  const r = await quworkClaimDailyReward(live, opts);
  // 凭据失效且还没续过期 → 续期重试一轮（客户端里账号可能刚被刷新过）
  if (r.authExpired && live === token) {
    const fresh = await quworkRefreshAccess(token, opts);
    if (fresh) {
      live = fresh.accessToken;
      try {
        await ctx?.onRefresh?.({ token: fresh.accessToken, refreshToken: null, expiresAt: fresh.expiresAt });
        ctx?.log?.(t('QuWork accessToken 已续期'));
      } catch {}
      const again = await quworkClaimDailyReward(live, opts);
      return mapCheckinOutcome(again, account, ctx, live, fetchImpl);
    }
  }
  return mapCheckinOutcome(r, account, ctx, live, fetchImpl);
}

async function mapCheckinOutcome(r, account, ctx, token, fetchImpl) {
  if (r.outcome === 'claimed') {
    let balanceAfter;
    try {
      const self = await quworkSelfInfo(token, { fetchImpl });
      const pts = self.ok ? quworkPointsFromSelf(self.data) : null;
      if (pts && Number.isFinite(pts.total)) balanceAfter = pts.total;
    } catch { /* 余额拿不到不阻断领取结果 */ }
    const streak = Number(r.status?.streak_days ?? r.status?.streak ?? r.status?.continuous_days);
    return {
      status: 'checked-in',
      message: r.message,
      claimedAmount: r.points,
      amount: r.points,
      // 服务端若回连续天数：统一回「签到前」口径（checkin.js 落库时 +1）
      ...(Number.isFinite(streak) ? { streakDays: Math.max(0, streak - 1) } : {}),
      ...(Number.isFinite(balanceAfter) ? { balanceAfter } : {}),
    };
  }
  if (r.outcome === 'done') return { status: 'already', message: r.message };
  if (r.outcome === 'wechat_required') {
    return { status: 'limited', message: r.message || t('请先绑定微信，再领取每日签到') };
  }
  return { status: 'failed', ...(r.authExpired ? { authExpired: true } : {}), message: r.message || t('QuWork 签到失败') };
}

/** 我的邀请码：self.aff_code（登录即有，6 位数字）+ invite/summary 的进度（best-effort） */
export async function fetchQuworkMyInviteCode(accessToken, { fetchImpl } = {}) {
  const token = norm(accessToken);
  if (!token) return { auth: true, ok: false, error: t('缺少 QuWork 凭据') };
  const r = await quworkSelfInfo(token, { fetchImpl });
  if (!r.auth) return { auth: false, ok: false, error: r.message || authExpiredText() };
  if (!r.ok) return { auth: true, ok: false, error: r.message || r.code || 'network' };
  let self = r.data || {};
  // 邀请进度独立查询，失败不影响码本身
  let count = null, rewardPoints = null, maxInvite = null, summaryCode = '';
  try {
    const s = await quworkApiRequest('/api/user/invite/summary', { accessToken: token, fetchImpl });
    if (s.ok) {
      const d = s.data || {};
      const num = (...vs) => {
        for (const v of vs) if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
        return null;
      };
      // 真机 summary 字段（2026-11-26 实测 uid 8491）：{ invite_code, invited_count, points, quota }
      count = num(d.invited_count, d.invite_count, d.total_invited, d.count, d.total);
      rewardPoints = num(d.total_points, d.reward_points, d.total_reward_points, d.points);
      maxInvite = num(d.max_invite_count, d.max_invites, d.invite_limit, d.quota);
      summaryCode = norm(d.invite_code);
    }
  } catch { /* summary 口径缺失时只回码 */ }
  const per = Number(self.per_invite_points ?? self.invite_reward_points);
  return {
    auth: true, ok: true,
    // aff_code 为首选；万一是历史号缺字段，summary.invite_code 兜底（真机两者同为 230548）
    code: norm(self.aff_code ?? self.affCode) || summaryCode || null,
    count, rewardPoints,
    perInvitePoints: Number.isFinite(per) && per > 0 ? per : null,
    maxInvite: Number.isFinite(maxInvite) && maxInvite > 0 ? maxInvite : null,
  };
}

const CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * 填写邀请码 / 积分兑换码 / 订单号（同一 /api/user/activate 端点，10R quworkActivateCode 同款）。
 * deviceId 每账号固定（调用方从 meta 取，缺失时现造并回传供落库）。
 */
export async function redeemQuworkCode(accessToken, code, { deviceId, fetchImpl } = {}) {
  const c = norm(code);
  if (!c) return { ok: false, error: t('邀请码不能为空') };
  if (!CODE_RE.test(c)) return { ok: false, error: t('请输入有效的邀请码/兑换码（字母、数字）') };
  const token = norm(accessToken);
  if (!token) return { ok: false, authExpired: true, error: t('缺少 QuWork 凭据') };
  // deviceId 缺失时现造一个随机值并随结果回传——调用方负责落库，下次复用
  let dev = norm(deviceId);
  if (!/^[0-9a-f]{64}$/.test(dev)) dev = quworkDeviceIdentifier();
  const r = await quworkApiRequest('/api/user/activate', {
    method: 'POST', accessToken: token, fetchImpl,
    json: { invite_code: c, device_identifier: dev, device_uuid: '' },
  });
  if (!r.auth) return { ok: false, authExpired: true, error: r.message || authExpiredText(), deviceId: dev };
  if (!r.ok) return { ok: false, error: r.message || r.code || t('QuWork 激活失败'), code: r.code, deviceId: dev };
  return { ok: true, message: r.message || t('激活成功'), result: r.data ?? null, deviceId: dev };
}

/** 账号身份（收割去重键，10R quworkIdentity 同款）：uid 优先 */
export function quworkIdentity({ uid, phone, llmToken } = {}) {
  if (norm(uid)) return `quwork-user-${norm(uid)}`;
  if (norm(phone)) return `quwork-phone-${createHash('sha256').update(norm(phone)).digest('hex').slice(0, 16)}`;
  return `quwork-key-${createHash('sha256').update(norm(llmToken)).digest('hex').slice(0, 16)}`;
}
