/**
 * 10Router 通用额度推送接线（issue #24）——把 CD 解析好的额度数字 POST 到
 * `POST /api/external-quota/<source>`，10Router 配额页直接出卡。
 *
 * 信任模型与 10Router 侧一致：**载荷只带额度标量，永远不带凭据**。
 * cookie/token 的解析与保管都留在 CD 本机（10Router 的 externalQuota 白名单
 * 也会整体拒绝嵌套结构），所以这里每个 builder 出口前都过一遍 assertScalarOnly。
 *
 * 首批 source（issue #24「建议的首批接线」）：
 *  - `tokenharbor`  ：TH 免费额度网页读数（CD 已捕获的网页会话 → dashboard 解析）；
 *  - `minimax-free` ：MiniMax Code 免费线算力币/签到额度——挂在 10Router 的 minimax-free 提供商（订阅线 minimax-code 是 10R 自己的直连线，两者不同卡）
 *    路由卡走 CD 本地网关，配额只有 CD 查得到，推数字正好补它的盲区。
 *
 * 降级语义（issue #24）：会话失效 / 全部解析失败时改推 `message` 文字状态卡，
 * 卡片不消失但显示「需要重新登录」，比静默掉卡更可运维。
 */

import { logger } from './logger.js';
import { t } from './i18n.js';

const PUSH_TIMEOUT_MS = 15_000;
const MAX_ROWS = 20;   // 与 10Router EXTERNAL_QUOTA_MAX_ENTRIES 对齐

/** 载荷出口前的最后一道闸：行字段值只允许标量（10Router 对嵌套结构整体 400，这里提前失败并留日志） */
function assertScalarOnly(payload, source) {
  const isScalar = (v) => v === undefined || v === null || (typeof v !== 'object' && typeof v !== 'function');
  const bad = (pathStr) => { throw new Error(`external-quota ${source}: 非标量字段 ${pathStr}（10Router 会整体拒绝，凭据材料禁止入载荷）`); };
  for (const f of ['provider', 'label', 'plan', 'message', 'refreshUrl']) if (!isScalar(payload[f])) bad(f);
  for (const [k, row] of Object.entries(payload.quotas || {})) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) bad(`quotas.${k}`);
    for (const [f, fv] of Object.entries(row)) if (!isScalar(fv)) bad(`quotas.${k}.${f}`);
  }
}

/** 行 key 只允许 ASCII（10Router QUOTA_KEY_RE），账号名可能是中文——key 用序号，显示名走 name 字段 */
const rowKey = (i) => `acc${i + 1}`;

/**
 * 快照陈旧度标注（自愈闭环③）：builder 从快照回退（非 live）且快照距今 > 24h 时，
 * 副标题/行名带上数据时刻——避免把三个月前的陈粮当好粮挂卡面（auth 失效会拦死会话，
 * 但「一直没探测」的行不拦，标注是最后的可见性兜底）。
 * @returns {string} '' 或 '（数据 M-DD HH:mm）'
 */
export function snapshotAgeTag(snap) {
  const at = Date.parse(snap?.at || snap?.capturedAt || '');
  if (!Number.isFinite(at)) return '';
  const age = Date.now() - at;
  if (age < 24 * 3600_000) return '';
  const d = new Date(at);
  const p2 = (n) => String(n).padStart(2, '0');
  return t('（数据 {m}-{d} {hh}:{mm}）', { m: d.getMonth() + 1, d: d.getDate(), hh: p2(d.getHours()), mm: p2(d.getMinutes()) });
}

/**
 * 组装 tokenharbor 卡片载荷。
 * 数据源 = 捕获时浏览器探针 HTML 解析出的 `meta.quotaSnapshot`（issue #23 的隐藏窗探针
 * 是浏览器视角，能过风控；daemon 侧 Node fetch 拿空壳页——所以数字在捕获那一刻就解析入库，
 * 推送不再打网络）。快照过旧（超过 7 天，或 resetAt 已过期——TH 刷新后数字作废）按
 * 「读取失败」计数，全行皆旧时降级为文字状态卡提示重新捕获。
 * @param accounts CD 账号库里已捕获的 tokenharbor 网页会话账号
 */
export function buildTokenHarborPayload(accounts, { now = Date.now() } = {}) {
  const rows = {};
  let failed = 0;
  for (const a of (accounts || []).slice(0, MAX_ROWS)) {
    const snap = a.meta?.quotaSnapshot;
    const snapAt = Date.parse(snap?.at || a.meta?.cookieSiteSession?.capturedAt || '');
    const stale = !snap || !Number.isFinite(Number(snap.used))
      || (Number.isFinite(snapAt) && now - snapAt > 7 * 86_400_000)
      || (snap.resetAt && Date.parse(snap.resetAt) <= now);   // 重置点已过，读数作废
    if (!stale) {
      const i = Object.keys(rows).length;
      const remaining = Math.max(0, 100 - Number(snap.used));
      rows[rowKey(i)] = {
        name: (a.name || 'Token Harbor').slice(0, 80),
        used: Number(snap.used),
        total: 100,
        remainingPercentage: remaining,
        percentScale: 100,
        resetAt: typeof snap.resetAt === 'string' ? snap.resetAt.slice(0, 64) : undefined,
        recurring: true,
        displayRemaining: true,
      };
    } else failed++;
  }
  const payload = { provider: 'tokenharbor', label: 'Token Harbor Free' };
  if (Object.keys(rows).length) {
    payload.quotas = rows;
    payload.plan = 'Free Tier';
    if (failed) payload.label = t('Token Harbor Free（{n} 个会话读取失败）', { n: failed }).slice(0, 100);
  } else {
    payload.message = t('Token Harbor 网页会话失效或未捕获，请在 CreditDaddy「网页会话」页重新登录捕获');
  }
  assertScalarOnly(payload, 'tokenharbor');
  return payload;
}

/** 下一个「业务日零点」（MiniMax 按 UTC+8 刷新），ISO 字符串 */
export function nextUtc8Midnight(now = new Date()) {
  const ms = now.getTime() + 8 * 3600_000;
  const dayMs = 86_400_000;
  return new Date((Math.floor(ms / dayMs) + 1) * dayMs - 8 * 3600_000).toISOString();
}

/** 生成单个 MiniMax 账号的外配额卡 source id */
export function buildMiniMaxAccountSource(account) {
  const rawId = account.uid || account.id || 'default';
  const clean = String(rawId).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 18);
  return `minimax-free-${clean || 'acc'}`.slice(0, 32);
}

/**
 * 组装单个 MiniMax 账号的单卡载荷（minimax-code 同款单值卡）：
 * 单账号独立一张卡，卡面副标题为账号名称（如「主」、「备」），
 * 单行 Credits 储值余额，右侧带有只读连续签到徽章。
 */
export function buildMiniMaxAccountPayload(account, quotaData, checkinData, { resetAt } = {}) {
  const source = buildMiniMaxAccountSource(account);
  const remaining = Number(quotaData?.remaining ?? quotaData?.total);
  const label = String(account?.name || account?.uid || 'MiniMax').slice(0, 100);
  const payload = {
    provider: 'minimax-free',
    label,
    plan: quotaData?.plan || 'Free',
  };

  if (Number.isFinite(remaining) && !quotaData?.error) {
    const row = {
      name: 'Credits',
      used: 0,
      total: Math.max(remaining, 0) || 0.000001,
      displayRemaining: true,
      isCreditBalance: true,
      recurring: true,
      resetAt: resetAt || nextUtc8Midnight(),
    };
    if (checkinData) {
      if (checkinData.checkedToday !== undefined) row.checkinToday = checkinData.checkedToday === true;
      if (Number.isFinite(checkinData.streakDays) && checkinData.streakDays > 0) {
        row.streakDays = checkinData.streakDays;
      }
    }
    payload.quotas = { credits: row };
  } else {
    payload.message = quotaData?.error || t('MiniMax 账号额度暂不可查（凭据失效需在 CreditDaddy 重新登录，或官方接口异常稍后自动重试）');
  }
  assertScalarOnly(payload, source);
  return { source, payload };
}

/**
 * 组装 minimax-code 卡片载荷（历史兼容多行卡方法）：
 * 每账号一行「存量」——`used=0 / total=剩余算力币 / displayRemaining=true`，
 * `resetAt` 给次日零点（免费线每日刷新口径）。全部查询失败时降级为文字状态卡。
 * 每行可带只读签到状态（checkinToday / streakDays）——10R 白名单放行后卡面显示「今日已签」；
 * 旧版 10R 无此字段自动忽略（向前兼容）。签到动作不进 10R（只读边界，方案 B）。
 * @param fetchQuota 注入的「account → 归一化额度」查询器（生产 = fetchMiniMaxQuota）
 * @param fetchCheckin 注入的「account → 签到状态」查询器（生产 = fetchMiniMaxCheckinStatus；测试可注入）
 */
export async function buildMiniMaxPayload(accounts, fetchQuota, { resetAt, fetchCheckin } = {}) {
  const rows = {};
  let failed = 0;
  for (const a of accounts.slice(0, MAX_ROWS)) {
    let q = null;
    try { q = await fetchQuota(a); } catch { failed++; continue; }
    const remaining = Number(q?.remaining);
    if (!Number.isFinite(remaining) || q?.error) { failed++; continue; }
    const i = Object.keys(rows).length;
    const row = {
      name: (a.name || a.uid || 'MiniMax').slice(0, 80),
      used: 0,
      total: Math.max(remaining, 0) || 0.000001,   // total 必须 >0（10Router positiveNumber）；0 余额给最小正数让卡片显示「耗尽」
      displayRemaining: true,
      // 算力币是储值余额不是订阅包：10R 按单值卡渲染（无 X/Y 进度条与重置倒计时，
      // 与 minimax-code 订阅线 Credits 卡同款）。10R 旧版无此字段自动忽略。
      isCreditBalance: true,
      recurring: true,
      resetAt: resetAt || nextUtc8Midnight(),
    };
    // 签到状态（可选注入，fetch 失败 / 无注入则不带——字段缺席即「状态未知」，10R 不画徽章）
    if (fetchCheckin) {
      try {
        const c = await fetchCheckin(a);
        if (c) {
          row.checkinToday = c.checkedToday === true;
          if (Number.isFinite(c.streakDays) && c.streakDays > 0) row.streakDays = c.streakDays;
        }
      } catch { /* 状态未知就不带 */ }
    }
    rows[rowKey(i)] = row;
  }
  // label 是数据标识不是 UI 文案——不随 CD 面板语言翻译（面板设英文时曾把
  // label 推成英文，10R 卡面副标题跟着变英文）。显示侧翻译由 10R 负责。
  const payload = { provider: 'minimax-free', label: 'MiniMax Code 免费额度' };
  if (Object.keys(rows).length) {
    payload.quotas = rows;
    payload.plan = 'Free';
    if (failed) payload.label = `MiniMax Code 免费额度（${failed} 个账号查询失败）`.slice(0, 100);
  } else {
    payload.message = t('MiniMax 账号额度暂不可查（凭据失效需在 CreditDaddy 重新登录，或官方接口异常稍后自动重试）');
  }
  assertScalarOnly(payload, 'minimax-free');
  return payload;
}

/**
 * 推一张卡：POST /api/external-quota/<source>（Bearer 虚拟 key）。
 * 与 tenrouter.call 同样的重定向纪律——虽然载荷不含凭据，key 也不能被 307 重放到别处。
 * refreshUrl 随载荷下发（外配额卡「刷新配额」按钮的回调地址；HMAC 签名无裸令牌）。
 */
async function pushOne({ endpoint, key, source, payload, fetchImpl, refreshUrl }) {
  const doFetch = fetchImpl || fetch;
  const body = refreshUrl ? { ...payload, refreshUrl } : payload;
  assertScalarOnly(body, source);
  const res = await doFetch(`${endpoint.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/external-quota/${source}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    redirect: 'error',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}${data?.error ? '：' + data.error : ''}`);
  return data || { ok: true };
}

/**
 * 删除一张外部配额卡：DELETE /api/external-quota/<source>
 */
export async function deleteExternalQuota({ endpoint, key, source, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  try {
    const res = await doFetch(`${endpoint.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/external-quota/${source}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 一轮额度推送。整体 fail-soft：
 * 任何一路失败只记日志，不影响主流程。
 * @param {object} opts
 * @param {string|string[]} [opts.onlySource]  只推这些 source（单卡回源传 string，重探传涉及的数组）；缺省推全部
 * @param {boolean} [opts.noRefreshUrl] 不附 refreshUrl（回调自调时防自环签发）
 * @param {boolean} [opts.noProbeMark] 跳过探活痕迹回写（回调路径防自环；缺省后台推送都写）
 * @returns {{ results: Array<{source: string, status: string, error?: string}> }}
 */
export async function runQuotaPush({ endpoint, key, accounts, fetchImpl, onlySource, noRefreshUrl, noProbeMark }) {
  const results = [];
  const only = Array.isArray(onlySource) ? onlySource : (onlySource ? [onlySource] : null);
  const { quotaRefreshUrl } = await import('./quotaRefresh.js');
  const rurl = async (source) => {
    if (noRefreshUrl) return undefined;
    try { return await quotaRefreshUrl(source); } catch { return undefined; }
  };
  // live 拉取失败的两类处置：
  //  - auth 失效（401/403，三家 fetch 都标 authExpired）→ liveData 带 authInvalid 交给
  //    builder 降级 message 状态卡（10R 卡面立刻可见「会话失效」），**不再回退旧快照**——
  //    死会话挂旧数字连 7 天 TTL 都不会过期（pushedAt 每轮刷新），10R 侧对失效是瞎的；
  //  - 网络抖动 / 5xx / 结构变化 → 保留旧快照数字（瞬时故障不该清空卡面）。
  const liveError = (b) => (b?.authExpired ? { error: b.error, authInvalid: true } : { error: b?.error });
  // 探活痕迹回写（自愈闭环①）：后台推送每轮 live 拉取都等于一次探测——结果顺手落
  // meta.lastProbe，面板呼吸灯就有真实心跳（不用等用户手点重探才更新）。fire-and-forget
  // 串行队列写入，绝不阻塞推送；回调路径（quota-refresh → onlySource）noProbeMark 跳过。
  // dead 账号低频重试（自愈闭环②）：lastProbe.status==='dead' 且距上次探测不足 6 小时
  // → 本轮跳过 live 拉取（少打上游），用快照/状态卡照常推卡；过期则再试一次——
  // 网站恢复/误判自愈时自动复活，用户无感。
  const DEAD_RETRY_MS = 6 * 60 * 60 * 1000;
  const probeMark = (a, ok, error) => {
    if (noProbeMark || !a?.id) return;
    const status = ok ? 'ok' : (/会话失效|401|403|会话不可用|重新登录/i.test(String(error || '')) ? 'dead' : 'warn');
    import('./store.js').then(({ withAccounts }) => withAccounts((list) => {
      const hit = list.find((x) => x.id === a.id);
      if (hit) hit.meta = { ...(hit.meta || {}), lastProbe: { ok: Boolean(ok), status, error: ok ? null : String(error || '').slice(0, 200), at: new Date().toISOString() } };
    })).catch(() => {});
  };
  const markRateLimited = (a, error) => {
    if (noProbeMark || !a?.id) return;
    import('./store.js').then(({ withAccounts }) => withAccounts((list) => {
      const hit = list.find((x) => x.id === a.id);
      if (hit) hit.meta = { ...(hit.meta || {}), lastProbe: { ok: false, status: 'dead', error: String(error || '').slice(0, 200), at: new Date().toISOString() } };
    })).catch(() => {});
  };
  // live 余额落库（面板 /quota 缓存路径的数据源）：推送循环每轮 live 拉到的数字顺手写回
  // meta.quotaSnapshot + 各家明细字段，缓存随推送节奏（默认 60 分钟）保鲜。无条件落盘——
  // 回调路径（quota-refresh → onlySource）拿的也是真数据，没理由只落 lastProbe 不落数字。
  const persistLive = (a, patch) => {
    if (!a?.id || !patch) return;
    import('./store.js').then(({ withAccounts }) => withAccounts((list) => {
      const hit = list.find((x) => x.id === a.id);
      if (hit) hit.meta = { ...(hit.meta || {}), ...patch };
    })).catch(() => {});
  };
  const deadSkip = (a) => {
    const lp = a.meta?.lastProbe;
    if (!lp || lp.ok || lp.status !== 'dead') return false;
    const at = Date.parse(lp.at || '');
    return Number.isFinite(at) && (Date.now() - at) < DEAD_RETRY_MS;
  };

  // 0. minimax-free（单账号单卡，minimax-code 同款单值卡：带签到徽章）
  //    国内（minimax）与国际（minimax-global，#54）都推免费线卡——10R 的 minimax-free 挂 CD 网关
  //    的免费体验线，订阅线额度卡由账号连接（#55 OAuth 通道）的同名认领接管，两者不冲突
  const mmAccounts = (accounts || []).filter((a) => (a.provider === 'minimax' || a.provider === 'minimax-global') && (a.token || a.refreshToken));
  if (mmAccounts.length) {
    // 一次性清理：按账号单卡（6ebcc52）之前的版本把全部账号聚在 source「minimax-free」
    // 一张多行卡上；升级用户的那张旧卡没人再推（也不该再推），不删会挂到 7 天 TTL 自然过期，
    // 期间与新的 per-account 卡并存（主/备 + 老聚合卡三张，2026-10-21 实测）。有账号可推时
    // 删一次旧 source，失败不阻断本轮推送（下轮还会再试）。
    if (!only) {
      const deleted = await deleteExternalQuota({ endpoint, key, source: 'minimax-free', fetchImpl });
      if (deleted) logger.info('10R', '旧版聚合卡 minimax-free 已清理（推送改为按账号单卡）');
    }
    const { fetchMiniMaxQuota, fetchMiniMaxCheckinStatus } = await import('./minimaxClient.js');
    for (const a of mmAccounts) {
      const { source } = buildMiniMaxAccountPayload(a, null);
      if (only && !only.includes(source)) continue;
      const skipDead = !only && deadSkip(a);
      let q = null;
      let c = null;
      if (!skipDead) {
        try { q = await fetchMiniMaxQuota(a); } catch (e) { q = { error: e.message }; }
        try { c = await fetchMiniMaxCheckinStatus(a); } catch {}
      }
      const { payload } = buildMiniMaxAccountPayload(a, q, c);
      try {
        const r = await pushOne({ endpoint, key, source, payload, fetchImpl, refreshUrl: await rurl(source) });
        results.push({ source, status: 'ok', entries: r.entries });
        logger.info('10R', '额度卡已推送：{source}（{n} 行）', { source, n: r.entries ?? (Object.keys(payload.quotas || {}).length || 0) });
      } catch (e) {
        results.push({ source, status: 'failed', error: e.message });
        logger.warn('10R', '额度卡推送失败 {source}:{err}', { source, err: e.message });
      }
    }
  }

  // 1. tokenharbor（issue #24：TH 免费额度网页读数）
  const thAccounts = (accounts || []).filter((a) => a.provider === 'tokenharbor' && a.meta?.cookieSiteId);
  if (thAccounts.length && (!only || only.includes('tokenharbor'))) {
    try {
      const payload = buildTokenHarborPayload(thAccounts);
      const r = await pushOne({ endpoint, key, source: 'tokenharbor', payload, fetchImpl, refreshUrl: await rurl('tokenharbor') });
      results.push({ source: 'tokenharbor', status: 'ok', entries: r.entries });
      logger.info('10R', '额度卡已推送：tokenharbor（{n} 行）', { n: r.entries ?? (Object.keys(payload.quotas || {}).length || 0) });
    } catch (e) {
      results.push({ source: 'tokenharbor', status: 'failed', error: e.message });
      logger.warn('10R', '额度卡推送失败 tokenharbor:{err}', { err: e.message });
    }
  }


  // 2. xiaomi-mimo（issue #26：小米 MiMo 控制台充值余额推送）
  const mimoAccounts = (accounts || []).filter((a) => (a.provider === 'xiaomi-mimo' || a.meta?.cookieSiteId === 'xiaomi-mimo') && a.token);
  if (mimoAccounts.length) {
    const { fetchXiaomiMimoBalance, buildXiaomiMimoQuotaPayload } = await import('./xiaomiMimoClient.js');
    for (const a of mimoAccounts) {
      // onlySource 先于 live 拉取判掉：单卡回调不该为别路 source 打上游
      // （mimo source 由账号元数据定，与 liveData 无关——纯函数取一次即可）
      const { source } = buildXiaomiMimoQuotaPayload(a);
      if (only && !only.includes(source)) continue;
      const skipDead = !only && deadSkip(a);   // 单卡回调（only）不跳过——用户显式刷新必须真试
      let liveData = null;
      if (skipDead) {
        liveData = { error: '会话已失效（后台低频重试等待中，跳过本轮 live 拉取）', authInvalid: true };
      } else {
        const uid = a.meta?.userId || a.uid || '';
        try {
          const b = await fetchXiaomiMimoBalance(a.token, uid, { fetchImpl });
          if (b.ok) {
            liveData = { balance: b.balance, cash: b.cash, voucher: b.voucher };
            persistLive(a, {
              mimoBalance: { balance: b.balance, cash: b.cash, voucher: b.voucher, at: new Date().toISOString() },
              quotaSnapshot: { used: 0, total: b.balance, isCreditBalance: true, at: new Date().toISOString() },
            });
          } else liveData = liveError(b);
          probeMark(a, b.ok, b.error);
        } catch (err) {
          liveData = { error: err.message };
          probeMark(a, false, err.message);
        }
      }
      const { payload } = buildXiaomiMimoQuotaPayload(a, liveData);
      try {
        assertScalarOnly(payload, source);
        const r = await pushOne({ endpoint, key, source, payload, fetchImpl, refreshUrl: await rurl(source) });
        results.push({ source, status: 'ok', entries: r.entries });
        logger.info('10R', '额度卡已推送：{source}（{n} 行）', { source, n: r.entries ?? (Object.keys(payload.quotas || {}).length || 0) });
      } catch (e) {
        results.push({ source, status: 'failed', error: e.message });
        logger.warn('10R', '额度卡推送失败 {source}:{err}', { source, err: e.message });
      }
    }
  }

  // 3. river（River AI 免费额度余额卡）——WorkOS 会话线，live 拉 /api/billing/account；
  //    过期自动刷新（单次轮换由 riverClient 内置落盘兜底），会话失效降级 message 状态卡。
  const riverAccounts = (accounts || []).filter((a) => (a.provider === 'river' || a.meta?.cookieSiteId === 'river') && (a.meta?.workosSession || a.token));
  if (riverAccounts.length) {
    const { fetchRiverBalance, buildRiverQuotaPayload } = await import('./riverClient.js');
    for (const a of riverAccounts) {
      // onlySource 先判：river 的 live 拉取可能触发 WorkOS 单次轮换，别路 source 不该付这个代价
      const { source } = buildRiverQuotaPayload(a);
      if (only && !only.includes(source)) continue;
      const skipDead = !only && deadSkip(a);   // 单卡回调不跳过——用户显式刷新必须真试
      let liveData = null;
      if (skipDead) {
        liveData = { error: '会话已失效（后台低频重试等待中，跳过本轮 live 拉取）', authInvalid: true };
      } else {
        try {
          const b = await fetchRiverBalance(a, { fetchImpl });
          if (b.ok) {
            liveData = { balance: b.balance };
            persistLive(a, {
              riverBalance: { balanceUsd: b.balance, at: new Date().toISOString() },
              quotaSnapshot: { used: 0, total: b.balance, isCreditBalance: true, at: new Date().toISOString() },
            });
          } else liveData = liveError(b);
          probeMark(a, b.ok, b.error);
        } catch (err) {
          liveData = { error: err.message };
          probeMark(a, false, err.message);
        }
      }
      const { payload } = buildRiverQuotaPayload(a, liveData);
      try {
        assertScalarOnly(payload, source);
        const r = await pushOne({ endpoint, key, source, payload, fetchImpl, refreshUrl: await rurl(source) });
        results.push({ source, status: 'ok', entries: r.entries });
        logger.info('10R', '额度卡已推送：{source}（{n} 行）', { source, n: r.entries ?? (Object.keys(payload.quotas || {}).length || 0) });
      } catch (e) {
        results.push({ source, status: 'failed', error: e.message });
        logger.warn('10R', '额度卡推送失败 {source}:{err}', { source, err: e.message });
      }
    }
  }

  // 4. modelsscope（CD#25：魔方余额卡）——havana 会话 cookie 读 /openapi/v1/magicubes/balance；
  //    每日额度自动发放（无签到动作端点），会话失效降级 message 状态卡。
  const msAccounts = (accounts || []).filter((a) => (a.provider === 'modelscope' || a.meta?.cookieSiteId === 'modelscope') && a.token);
  if (msAccounts.length) {
    const { fetchMagicubeBalance, fetchMagicubeLedger, buildModelScopeQuotaPayload } = await import('./modelscopeClient.js');
    for (const a of msAccounts) {
      // onlySource 先判：别路 source 不打魔搭上游
      const { source } = buildModelScopeQuotaPayload(a);
      if (only && !only.includes(source)) continue;
      const skipDead = !only && deadSkip(a);   // 单卡回调不跳过——用户显式刷新必须真试
      let liveData = null;
      if (skipDead) {
        liveData = { error: '会话已失效（后台低频重试等待中，跳过本轮 live 拉取）', authInvalid: true };
      } else {
        try {
          const b = await fetchMagicubeBalance(a.token, { fetchImpl });
          if (b.ok) {
            const ledger = await fetchMagicubeLedger(a.token, b.balance, { fetchImpl }).catch(() => null);
            liveData = { balance: b.balance, ledger };
            probeMark(a, true);
            persistLive(a, {
              msBalance: { amount: b.balance, today: ledger?.today ?? null, long: ledger?.long ?? null, at: new Date().toISOString() },
              quotaSnapshot: { used: 0, total: b.balance, isCreditBalance: true, at: new Date().toISOString() },
            });
          } else {
            liveData = liveError(b);
            probeMark(a, false, b.error);
          }
        } catch (err) {
          liveData = { error: err.message };
          probeMark(a, false, err.message);
        }
      }
      const { payload } = buildModelScopeQuotaPayload(a, liveData);
      try {
        assertScalarOnly(payload, source);
        const r = await pushOne({ endpoint, key, source, payload, fetchImpl, refreshUrl: await rurl(source) });
        results.push({ source, status: 'ok', entries: r.entries });
        logger.info('10R', '额度卡已推送：{source}（{n} 行）', { source, n: r.entries ?? (Object.keys(payload.quotas || {}).length || 0) });
      } catch (e) {
        results.push({ source, status: 'failed', error: e.message });
        logger.warn('10R', '额度卡推送失败 {source}:{err}', { source, err: e.message });
      }
    }
  }

  // 5. LongCat（issue #29：Token 资源包卡）——美团 SSO cookie 读平台 summary；
  //    储值卡 + 逐包明细（消耗顺序官方规则：购买包未动时先烧赠送包），会话失效降级 message 状态卡。
  const lcAccounts = (accounts || []).filter((a) => (a.provider === 'longcat' || a.meta?.cookieSiteId === 'longcat') && a.token);
  if (lcAccounts.length) {
    const { fetchLongcatPacks, longcatSnapshot, buildLongcatQuotaPayload } = await import('./longcatClient.js');
    for (const a of lcAccounts) {
      // onlySource 先判：别路 source 不打 LongCat 上游
      const { source } = buildLongcatQuotaPayload(a);
      if (only && !only.includes(source)) continue;
      const skipDead = !only && deadSkip(a);   // 单卡回调不跳过——用户显式刷新必须真试
      let liveData = null;
      if (skipDead) {
        liveData = { error: '会话已失效（后台低频重试等待中，跳过本轮 live 拉取）', authInvalid: true };
      } else {
        try {
          const b = await fetchLongcatPacks(a.token, { fetchImpl });
          if (b.ok) {
            liveData = { packs: b.packs };
            const lcTotal = b.packs.reduce((s, p) => s + Math.max(0, Number(p.remaining) || 0), 0);
            persistLive(a, {
              longcatPacks: longcatSnapshot(b.packs),
              quotaSnapshot: { used: 0, total: lcTotal, isCreditBalance: true, at: new Date().toISOString() },
            });
          } else liveData = liveError(b);
          probeMark(a, b.ok, b.error);
        } catch (err) {
          liveData = { error: err.message };
          probeMark(a, false, err.message);
        }
      }
      const { payload } = buildLongcatQuotaPayload(a, liveData);
      try {
        assertScalarOnly(payload, source);
        const r = await pushOne({ endpoint, key, source, payload, fetchImpl, refreshUrl: await rurl(source) });
        results.push({ source, status: 'ok', entries: r.entries });
        logger.info('10R', '额度卡已推送：{source}（{n} 行）', { source, n: r.entries ?? (Object.keys(payload.quotas || {}).length || 0) });
      } catch (e) {
        results.push({ source, status: 'failed', error: e.message });
        logger.warn('10R', '额度卡推送失败 {source}:{err}', { source, err: e.message });
      }
    }
  }

  // 6. WPS 灵犀（issue #53：灵点余额卡）——kdocs 会话 cookie 读任务列表/余额接口；
  //    单值储值卡（灵点只在灵犀界面消费，官方无 API，10R 卡仅展示余额数字）。
  const lxAccounts = (accounts || []).filter((a) => (a.provider === 'lingxi' || a.meta?.cookieSiteId === 'lingxi') && (a.token || a.meta?.cookieSiteSession?.cookie));
  if (lxAccounts.length) {
    const { fetchLingxiStatus, buildLingxiQuotaPayload } = await import('./lingxiClient.js');
    for (const a of lxAccounts) {
      const { source } = buildLingxiQuotaPayload(a);
      if (only && !only.includes(source)) continue;
      const skipDead = !only && deadSkip(a);
      let liveData = null;
      if (skipDead) {
        liveData = { error: '会话已失效（后台低频重试等待中，跳过本轮 live 拉取）', authInvalid: true };
      } else {
        try {
          const cookie = a.meta?.cookieSiteSession?.cookie || a.token;
          const st = await fetchLingxiStatus(cookie, { fetchImpl });
          if (st.auth) {
            liveData = { balance: st.balance };
            if (Number.isFinite(st.balance)) {
              persistLive(a, { quotaSnapshot: { used: 0, total: st.balance, isCreditBalance: true, at: new Date().toISOString() } });
            }
          } else liveData = liveError({ authExpired: true, error: '会话已失效' });
          probeMark(a, st.auth, st.code);
        } catch (err) {
          liveData = { error: err.message };
          probeMark(a, false, err.message);
        }
      }
      const { payload } = buildLingxiQuotaPayload(a, liveData);
      try {
        assertScalarOnly(payload, source);
        const r = await pushOne({ endpoint, key, source, payload, fetchImpl, refreshUrl: await rurl(source) });
        results.push({ source, status: 'ok', entries: r.entries });
        logger.info('10R', '额度卡已推送：{source}（{n} 行）', { source, n: r.entries ?? (Object.keys(payload.quotas || {}).length || 0) });
      } catch (e) {
        results.push({ source, status: 'failed', error: e.message });
        logger.warn('10R', '额度卡推送失败 {source}:{err}', { source, err: e.message });
      }
    }
  }

  return { results };
}
