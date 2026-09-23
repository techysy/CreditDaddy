/**
 * 账号新增 / 导入的统一入口 — daemon、CLI、设备码登录、本机导入、文件导入共用。
 *
 * 网络校验（userinfo）在锁外完成；去重 + 入库在 withAccounts 串行队列内完成，
 * 并发请求（如签到轮与添加账号同时发生）不会互相覆盖。
 * 同一 provider 下 uid 相同但 token 不同 → 视为 token 续期，原地更新而不是新增。
 */

import { normalizeAccountInput, findDuplicate, loadAccounts, withAccounts } from './store.js';
import { fetchUserinfo } from './qoderClient.js';

/** 从 userinfo 响应中挑一个可读的显示名 */
export function displayNameFrom(ui) {
  const pick = [ui?.nickname, ui?.name, ui?.username, ui?.email]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  return pick || null;
}

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
      const ui = await fetchUserinfo(account);
      if (!account.name) account.name = displayNameFrom(ui);
      if (!account.uid && typeof ui?.id === 'string') account.uid = ui.id;
      if (!account.email && typeof ui?.email === 'string' && ui.email) account.email = ui.email;
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
