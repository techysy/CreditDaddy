/**
 * 账号新增 / 导入的统一入口 — daemon、CLI、设备码登录、本机导入、文件导入共用。
 *
 * 网络校验（userinfo）在锁外完成；去重 + 入库在 withAccounts 串行队列内完成，
 * 并发请求（如签到轮与添加账号同时发生）不会互相覆盖。
 * 同一 provider 下 uid 相同但 token 不同 → 视为 token 续期，原地更新而不是新增。
 */

import { normalizeAccountInput, findDuplicate, loadAccounts, withAccounts } from './store.js';
import { productImpl, displayNameFrom } from './providers.js';

export { displayNameFrom };

/**
 * 用新记录刷新已存在账号（保留 id / 名字 / 签到记录）：
 *   token 不同 → 续期（换 token + 凭据元数据）；token 相同 → 只补全缺失的 uid / 邮箱 / 有效期 / refreshToken
 * 返回是否有变化。
 */
function refreshExisting(existing, incoming) {
  let changed = false;
  const set = (k, v) => { if (v && existing[k] !== v) { existing[k] = v; changed = true; } };
  if (existing.token !== incoming.token) {
    set('token', incoming.token);
    set('refreshToken', incoming.refreshToken);
    set('expiresAt', incoming.expiresAt);
    if (incoming.verified !== undefined) existing.verified = incoming.verified;
  } else {
    if (!existing.refreshToken) set('refreshToken', incoming.refreshToken);
    if (!existing.expiresAt) set('expiresAt', incoming.expiresAt);
  }
  if (!existing.uid) set('uid', incoming.uid);
  if (!existing.email) set('email', incoming.email);
  // 产品元数据（如 WorkBuddy 会话 / 域名）以最新导入为准
  const incomingMeta = incoming.meta && Object.keys(incoming.meta).length ? incoming.meta : null;
  if (incomingMeta && JSON.stringify({ ...existing.meta, ...incomingMeta }) !== JSON.stringify(existing.meta || {})) {
    existing.meta = { ...(existing.meta || {}), ...incomingMeta };
    changed = true;
  }
  if (changed) existing.updatedAt = new Date().toISOString();
  return changed;
}

/** 在锁内合并一条记录：新增 / 续期 / 重复 */
function mergeInto(accounts, account) {
  const dup = findDuplicate(accounts, account.provider, account.token, account.uid);
  if (!dup) {
    accounts.push(account);
    return { account, duplicate: false, updated: false };
  }
  const updated = refreshExisting(dup, account);
  return { account: dup, duplicate: true, updated };
}

/**
 * 新增一个账号。
 * @param {{name?, provider, token, uid?, email?, refreshToken?, expiresAt?, source?}} input
 * @param {{verify?: boolean, trusted?: boolean}} opts
 *   verify  调用 userinfo 校验 token 并补全昵称 / uid / 邮箱（默认 true，失败仍会保存）
 *   trusted token 来源已可信（如设备码登录、本机客户端），直接标记 verified
 * @returns {Promise<{account, duplicate: boolean, updated: boolean}>}
 *   duplicate=true 时 account 为已存在的记录；updated=true 表示已用新 token 续期
 */
export async function addAccount(input, { verify = true, trusted = false } = {}) {
  const account = normalizeAccountInput(input);

  // 先快速查重：完全相同的 token 无需再发网络请求（只在锁内补全缺失的元数据）
  const existing = findDuplicate(await loadAccounts(), account.provider, account.token);
  if (existing && existing.token === account.token) return withAccounts((accounts) => mergeInto(accounts, account));

  if (trusted) {
    account.verified = true;
  } else if (verify) {
    try {
      const info = await productImpl(account.provider).verify(account);
      if (!account.name && info.name) account.name = info.name;
      if (!account.uid && info.uid) account.uid = info.uid;
      if (!account.email && info.email) account.email = info.email;
      account.verified = true;
    } catch (e) {
      account.verified = false;
      account.verifyError = e.message;
    }
  }

  return withAccounts((accounts) => mergeInto(accounts, account));
}

/**
 * 批量导入（已解析的记录数组，见 transfer.parseImport），不做网络校验。
 * @returns {Promise<{added, updated, skipped}>}
 */
export function importAccounts(list) {
  return withAccounts((accounts) => {
    let added = 0, updated = 0, skipped = 0;
    for (const item of list) {
      try {
        const r = mergeInto(accounts, normalizeAccountInput(item));
        if (!r.duplicate) added++;
        else if (r.updated) updated++;
        else skipped++;
      } catch { skipped++; }
    }
    return { added, updated, skipped };
  });
}

/**
 * token 刷新后的回写上下文（传给 productImpl(...).checkin / quota 的 ctx）：
 * 新 token 立即写回账号库；若该账号正是 WorkBuddy 客户端当前登录的账号，同步写回客户端会话文件，
 * 避免客户端手里被轮换掉的旧 refreshToken 失效导致掉线。
 */
export function refreshContext(account, log) {
  return {
    onRefresh: async (creds) => {
      account.token = creds.token;
      account.refreshToken = creds.refreshToken;
      account.expiresAt = creds.expiresAt;
      await withAccounts((accounts) => {
        const cur = accounts.find((a) => a.id === account.id);
        if (!cur) return;
        cur.token = creds.token;
        cur.refreshToken = creds.refreshToken;
        cur.expiresAt = creds.expiresAt;
        if (creds.refreshExpiresAt) cur.meta = { ...(cur.meta || {}), refreshExpiresAt: creds.refreshExpiresAt };
        cur.updatedAt = new Date().toISOString();
      });
      log?.('token 已刷新');
      if (account.provider.startsWith('workbuddy')) {
        const { currentWorkbuddyUid, writeWorkbuddySession } = await import('./workbuddyLocal.js');
        try {
          if (account.uid && currentWorkbuddyUid() === account.uid) {
            writeWorkbuddySession(account);
            log?.('已同步新 token 到 WorkBuddy 客户端');
          }
        } catch (e) { log?.('同步到 WorkBuddy 客户端失败：' + e.message); }
      }
    },
  };
}
