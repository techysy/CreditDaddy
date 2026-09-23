#!/usr/bin/env node
/**
 * CreditDaddy CLI
 *   creditdaddy daemon          启动守护进程（默认）
 *   creditdaddy add <token>     添加账号（--cn 国内版 --name 名字）
 *   creditdaddy list            查看账号
 *   creditdaddy checkin         立即签到全部账号
 *   creditdaddy remove <id>     删除账号
 *   creditdaddy export/import   导出/导入账号
 *   creditdaddy logs            查看签到状态（state.json）
 *   creditdaddy help            显示帮助
 */

import { startDaemon } from '../src/daemon.js';
import { logger } from '../src/logger.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'daemon';

const HELP = `CreditDaddy — Qoder 多账号管理 + 每日 Credits 自动签到

用法:
  creditdaddy daemon [--port 47860] [--host 127.0.0.1]   启动守护进程 + Web 面板
  creditdaddy add <token> [--cn] [--name 名字]           添加 Qoder 账号（--cn 为国内版）
  creditdaddy add <token> --workbuddy [--intl]           添加 WorkBuddy 账号（登录 token）
  creditdaddy list                                       查看账号
  creditdaddy checkin [--cn | --intl]                    立即签到
  creditdaddy remove <id前缀>                             删除账号
  creditdaddy export [file.json] [--password 口令] [--cn|--intl]
                                                        导出账号；带口令则加密（与 10router 迁移文件互通）
  creditdaddy import <file.json> [--password 口令]        导入 CreditDaddy / 10router 导出文件
  creditdaddy scan                                       导入本机 Qoder / WorkBuddy 客户端已登录的账号
  creditdaddy logs                                       查看签到状态
  creditdaddy help                                       显示本帮助`;

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  switch (cmd) {
    case 'daemon': {
      const port = Number(flag('--port')) || Number(process.env.PORT) || undefined;
      const host = flag('--host') || process.env.HOST || undefined;
      await startDaemon(port, host);
      const { startScheduler } = await import('../src/checkin.js');
      startScheduler();
      logger.info('CLI', '按 Ctrl+C 停止');
      break;
    }
    case 'add': {
      const token = args[1];
      if (!token) { console.error('用法: creditdaddy add <token> [--cn] [--name 名字]'); process.exit(1); }
      const { publicAccount } = await import('../src/store.js');
      const { addAccount } = await import('../src/accounts.js');
      const wbFlag = args.includes('--workbuddy');
      const provider = wbFlag
        ? (args.includes('--intl') ? 'workbuddy-intl' : 'workbuddy')
        : (args.includes('--cn') ? 'qoder-cn' : 'qoder');
      const { account, duplicate } = await addAccount({ token, provider, name: flag('--name') });
      if (duplicate) { console.error('该账号已存在'); process.exit(1); }
      console.log(account.verified ? '✓ token 校验通过' : '⚠ token 校验失败（仍会保存）：' + account.verifyError);
      console.log('✓ 已添加：', JSON.stringify(publicAccount(account), null, 2));
      break;
    }
    case 'list': {
      const { loadAccounts, publicAccount } = await import('../src/store.js');
      const accounts = await loadAccounts();
      if (accounts.length === 0) return console.log('（还没有账号，用 creditdaddy add <token> 添加）');
      for (const a of accounts) {
        const p = publicAccount(a);
        console.log(`[${p.id.slice(0, 8)}] ${(p.name || '(未命名)').padEnd(16)} ${p.provider.padEnd(14)} ${p.tokenMasked}  ${p.lastCheckin ? '上次签到 ' + p.lastCheckin.slice(0, 16) : '未签到'}`);
      }
      break;
    }
    case 'checkin': {
      const { runCheckinTick } = await import('../src/checkin.js');
      const provider = args.includes('--workbuddy')
        ? (args.includes('--intl') ? 'workbuddy-intl' : 'workbuddy')
        : args.includes('--cn') ? 'qoder-cn' : args.includes('--intl') ? 'qoder' : undefined;
      const { summary, results } = await runCheckinTick({ provider, skipIfCheckedToday: false });
      console.log(summary);
      for (const r of results) {
        console.log(`  ${r.status === 'checked-in' ? '✓' : r.status === 'failed' ? '✗' : '·'} ${r.account}（${r.provider}）${r.status === 'checked-in' ? ` +${r.claimedAmount} Credits` : r.error ? ' ' + r.error : r.message ? ' ' + r.message : ''}`);
      }
      break;
    }
    case 'remove': {
      const id = args[1];
      if (!id) { console.error('用法: creditdaddy remove <id前缀>（id 见 creditdaddy list）'); process.exit(1); }
      const { withAccounts } = await import('../src/store.js');
      const outcome = await withAccounts((accounts) => {
        const matches = accounts.filter((a) => a.id.startsWith(id));
        if (matches.length !== 1) return { count: matches.length };
        accounts.splice(accounts.indexOf(matches[0]), 1);
        return { count: 1, removed: matches[0] };
      });
      if (outcome.count === 0) { console.error('账号不存在'); process.exit(1); }
      if (outcome.count > 1) { console.error(`id 前缀 "${id}" 匹配到 ${outcome.count} 个账号，请输入更长的前缀`); process.exit(1); }
      console.log('✓ 已删除', outcome.removed.name || outcome.removed.id);
      break;
    }
    case 'export': {
      const { loadAccounts } = await import('../src/store.js');
      const { exportAccounts } = await import('../src/transfer.js');
      const out = args[1] && !args[1].startsWith('--') ? args[1] : 'creditdaddy-backup.json';
      const password = flag('--password');
      const provider = args.includes('--cn') ? 'qoder-cn' : args.includes('--intl') ? 'qoder' : undefined;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, JSON.stringify(exportAccounts(await loadAccounts(), { password, provider }), null, 2), { mode: 0o600 });
      console.log('✓ 已导出到', out, password ? '（已加密，10router 可直接导入）' : '（含明文 token，注意保管；加 --password 可加密）');
      break;
    }
    case 'import': {
      const file = args[1];
      if (!file) { console.error('用法: creditdaddy import <file.json>'); process.exit(1); }
      const { readFileSync } = await import('node:fs');
      const { importAccounts } = await import('../src/accounts.js');
      const { parseImport } = await import('../src/transfer.js');
      const parsed = parseImport(JSON.parse(readFileSync(file, 'utf8')), { password: flag('--password') });
      const r = await importAccounts(parsed.accounts);
      console.log(`✓ 导入完成（来源 ${parsed.source}）：新增 ${r.added}，续期 ${r.updated}，跳过 ${r.skipped + parsed.skipped}`);
      break;
    }
    case 'scan': {
      const { readQoderAppAccounts } = await import('../src/qoderApp.js');
      const { readWorkbuddySessions } = await import('../src/workbuddyLocal.js');
      const { addAccount } = await import('../src/accounts.js');
      const qa = await readQoderAppAccounts();
      const wb = readWorkbuddySessions();
      const records = [
        ...qa.accounts.map((c) => ({
          label: c.source,
          rec: { provider: c.provider, token: c.token, name: c.user.name || c.user.email, uid: c.user.id, email: c.user.email, refreshToken: c.refreshToken, expiresAt: c.expiresAt, source: 'local-app' },
        })),
        ...wb.accounts.map(({ file: _f, fileTime: _t, current, source, ...rec }) => ({
          label: source, rec: { ...rec, source: current ? 'workbuddy-current' : 'workbuddy-history' },
        })),
      ];
      for (const e of [...qa.errors, ...wb.errors]) console.log('⚠', e.file, e.error);
      if (!records.length) { console.log('（本机 Qoder / WorkBuddy 客户端未登录或未安装）'); break; }
      for (const { label, rec } of records) {
        const r = await addAccount(rec, { trusted: true });
        console.log(r.duplicate ? (r.updated ? '↻ 已更新' : '· 已存在') : '✓ 已导入', r.account.name || r.account.id, `（${label}）`);
      }
      break;
    }
    case 'logs': {
      const { loadState } = await import('../src/store.js');
      console.log('数据目录状态:', JSON.stringify(await loadState(), null, 2));
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.error(`未知命令: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
