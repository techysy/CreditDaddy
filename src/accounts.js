/**
 * 账号新增 / 导入的统一入口 — daemon、CLI、设备码登录、本机扫描导入共用。
 *
 * 网络校验（userinfo）在锁外完成；去重 + 入库在 withAccounts 串行队列内完成，
 * 并发请求（如签到轮与添加账号同时发生）不会互相覆盖。
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
 * 新增一个账号。
 * @param {{name?: string, provider: string, token: string}} input
 * @param {{verify?: boolean, trusted?: boolean}} opts
 *   verify  调用 userinfo 校验 token 并补全昵称（默认 true，失败仍会保存）
 *   trusted token 来源已可信（如设备码登录），直接标记 verified
 * @returns {Promise<{account: object, duplicate: boolean}>} duplicate=true 时 account 为已存在的记录
 */
export async function addAccount(input, { verify = true, trusted = false } = {}) {
  const account = normalizeAccountInput(input);

  // 先快速查重，避免为已存在的账号发网络请求
  const existing = findDuplicate(await loadAccounts(), account.provider, account.token);
  if (existing) return { account: existing, duplicate: true };

  if (trusted) {
    account.verified = true;
  } else if (verify) {
    try {
      const ui = await fetchUserinfo(account);
      if (!account.name) account.name = displayNameFrom(ui);
      account.verified = true;
    } catch (e) {
      account.verified = false;
      account.verifyError = e.message;
    }
  }

  return withAccounts((accounts) => {
    const dup = findDuplicate(accounts, account.provider, account.token);
    if (dup) return { account: dup, duplicate: true };
    accounts.push(account);
    return { account, duplicate: false };
  });
}

/** 批量导入（导出文件或 [{name,provider,token}]），不做网络校验 */
export function importAccounts(list) {
  return withAccounts((accounts) => {
    let added = 0, skipped = 0;
    for (const item of list) {
      try {
        const account = normalizeAccountInput(item);
        if (findDuplicate(accounts, account.provider, account.token)) { skipped++; continue; }
        accounts.push(account);
        added++;
      } catch { skipped++; }
    }
    return { added, skipped };
  });
}
