#!/usr/bin/env node
/**
 * QoderDaddy CLI
 *   qoderdaddy daemon          启动守护进程（默认）
 *   qoderdaddy add <token>     添加账号（--cn 国内版 --name 名字）
 *   qoderdaddy list            查看账号
 *   qoderdaddy checkin         立即签到全部账号
 *   qoderdaddy remove <id>     删除账号
 *   qoderdaddy export/import   导出/导入账号
 *   qoderdaddy logs            查看签到状态（state.json）
 *   qoderdaddy help            显示帮助
 */

import { startDaemon } from '../src/daemon.js';
import { logger } from '../src/logger.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'daemon';

const HELP = `QoderDaddy — Qoder 多账号管理 + 每日 Credits 自动签到

用法:
  qoderdaddy daemon [--port 47860] [--host 127.0.0.1]   启动守护进程 + Web 面板
  qoderdaddy add <token> [--cn] [--name 名字]           添加账号（--cn 为国内版）
  qoderdaddy list                                       查看账号
  qoderdaddy checkin [--cn | --intl]                    立即签到
  qoderdaddy remove <id前缀>                             删除账号
  qoderdaddy export [file.json]                         导出账号（含明文 token）
  qoderdaddy import <file.json>                         导入账号
  qoderdaddy logs                                       查看签到状态
  qoderdaddy help                                       显示本帮助`;

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
      if (!token) { console.error('用法: qoderdaddy add <token> [--cn] [--name 名字]'); process.exit(1); }
      const { publicAccount } = await import('../src/store.js');
      const { addAccount } = await import('../src/accounts.js');
      const { account, duplicate } = await addAccount({
        token,
        provider: args.includes('--cn') ? 'qoder-cn' : 'qoder',
        name: flag('--name'),
      });
      if (duplicate) { console.error('该账号已存在'); process.exit(1); }
      console.log(account.verified ? '✓ token 校验通过' : '⚠ token 校验失败（仍会保存）：' + account.verifyError);
      console.log('✓ 已添加：', JSON.stringify(publicAccount(account), null, 2));
      break;
    }
    case 'list': {
      const { loadAccounts, publicAccount } = await import('../src/store.js');
      const accounts = await loadAccounts();
      if (accounts.length === 0) return console.log('（还没有账号，用 qoderdaddy add <token> 添加）');
      for (const a of accounts) {
        const p = publicAccount(a);
        console.log(`[${p.id.slice(0, 8)}] ${(p.name || '(未命名)').padEnd(16)} ${p.provider.padEnd(9)} ${p.tokenMasked}  ${p.lastCheckin ? '上次签到 ' + p.lastCheckin.slice(0, 16) : '未签到'}`);
      }
      break;
    }
    case 'checkin': {
      const { runCheckinTick } = await import('../src/checkin.js');
      const provider = args.includes('--cn') ? 'qoder-cn' : args.includes('--intl') ? 'qoder' : undefined;
      const { summary, results } = await runCheckinTick({ provider, skipIfCheckedToday: false });
      console.log(summary);
      for (const r of results) {
        console.log(`  ${r.status === 'checked-in' ? '✓' : r.status === 'failed' ? '✗' : '·'} ${r.account}（${r.provider}）${r.status === 'checked-in' ? ` +${r.claimedAmount} Credits` : r.error ? ' ' + r.error : r.message ? ' ' + r.message : ''}`);
      }
      break;
    }
    case 'remove': {
      const id = args[1];
      if (!id) { console.error('用法: qoderdaddy remove <id前缀>（id 见 qoderdaddy list）'); process.exit(1); }
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
      const { loadAccounts, exportPayload } = await import('../src/store.js');
      const out = args[1] || 'qoderdaddy-backup.json';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, JSON.stringify(exportPayload(await loadAccounts()), null, 2));
      console.log('✓ 已导出到', out, '（含明文 token，注意保管）');
      break;
    }
    case 'import': {
      const file = args[1];
      if (!file) { console.error('用法: qoderdaddy import <file.json>'); process.exit(1); }
      const { readFileSync } = await import('node:fs');
      const { importAccounts } = await import('../src/accounts.js');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const list = Array.isArray(data) ? data : data?.accounts;
      if (!Array.isArray(list)) { console.error('文件格式不对：应为 qoderdaddy export 导出的 JSON'); process.exit(1); }
      const { added, skipped } = await importAccounts(list);
      console.log(`✓ 导入完成：新增 ${added}，跳过 ${skipped}`);
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
