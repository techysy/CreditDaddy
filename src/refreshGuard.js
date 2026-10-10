/**
 * 凭据刷新公共守卫（所有 provider 的 401-刷新通路共用）。
 *
 * refreshToken 是一次性的、刷新即轮换：两路并发各自拿同一条链去刷新，必然一个成功一个
 * invalid_grant——面板每 2 分钟一轮额度查询和每小时签到轮曾因此互相误伤。两个护栏：
 *
 *  1) in-flight 合并：同一账号的并发刷新只跑一次 refreshFn，后到者共享同一份结果；
 *  2) 失效链熔断：某条 refreshToken 被服务端作废（401 / invalid_grant / 12153），
 *     在它被换新（重新登录、本机导入、或刷新成功后链自然更新）之前不再自动重试，
 *     也不会再打出几十上百次无效请求（2026-10-09 实记录 400+ 次）。
 *
 * 消 bug 的调用约定：
 *  - refreshFn 内部可以再写 account（把新 token/refreshToken 落回对象），调用方负责持久化；
 *  - 认证失效的判定：err.authInvalid === true 或 err.auth === true（cold 有 provider 用两种标记）；
 *  - deadMessage / deadNotice 均为可被 i18n 直接命中的字符串模板。
 */

const inFlight = new Map();   // accountKey → Promise（共享给并发的后来者）
const deadFp = new Map();     // accountKey → 已被服务端作废的 refreshToken

function keyOf(account) {
  return String(account.id || account.refreshToken || account.token || 'anon');
}

/** 该账号当前持有的 refreshToken 是否已被记为失效链。凭据换新（链指纹变化）自动放行。 */
export function refreshFpDead(account) {
  const fp = account.refreshToken;
  return typeof fp === 'string' && fp.length > 0 && deadFp.get(keyOf(account)) === fp;
}

/** 测试专用：清空进程内守卫状态 */
export function __resetRefreshGuardForTests() {
  inFlight.clear();
  deadFp.clear();
}

/**
 * @param {object} account 账号（至少含 id / refreshToken；refreshFn 要拿的都是它字段）
 * @param {(account: object) => Promise<object>} refreshFn 真刷新：成功后返回新凭据
 * @param {{ log?: (msg: string) => void | string, deadMessage?: string, deadNotice?: string }} [ctx]
 */
export function withRefreshDedupe(account, refreshFn, ctx = {}) {
  const key = keyOf(account);
  const inflight = inFlight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    if (refreshFpDead(account)) {
      const err = new Error(ctx.deadMessage || '凭据链已被服务端作废，等待重新登录或重新导入该账号');
      err.authInvalid = true;
      err.dead = true;
      throw err; // 静默快拒：不再打服务端，不重复刷日志（首次失效时已提示）
    }
    try {
      return await refreshFn(account);
    } catch (err) {
      if ((err?.authInvalid || err?.auth) && typeof account.refreshToken === 'string' && account.refreshToken.length > 0) {
        deadFp.set(key, account.refreshToken);
        if (ctx.deadNotice !== undefined && ctx.log) {
          try { ctx.log(ctx.deadNotice || '凭据链已失效，将不再自动重试（重新登录或重新导入该账号后自动恢复）'); } catch {}
        }
      }
      throw err;
    }
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}
