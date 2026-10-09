#!/usr/bin/env node
/**
 * CreditDaddy CLI
 *   creditdaddy daemon          启动守护进程（默认）
 *   creditdaddy add <token>     添加账号（--cn 国内版 --name 名字）
 *   creditdaddy list            查看账号
 *   creditdaddy checkin         立即领取全部账号
 *   creditdaddy remove <id>     删除账号
 *   creditdaddy export/import   导出/导入账号
 *   creditdaddy logs            查看领取状态（state.json）
 *   creditdaddy start/stop      后台运行（关掉终端不影响每日签到）
 *   creditdaddy status          查看后台运行状态
 *   creditdaddy help            显示帮助
 */

import { startDaemon } from '../src/daemon.js';
import { logger } from '../src/logger.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'daemon';
const DEFAULT_BG_PORT = 47860;   // 与 src/daemon.js 的 DEFAULT_PORT 一致

const HELP = `CreditDaddy — Qoder / WorkBuddy / ZCode / mirasim / 妙手 / Trae 多账号管理 + 每日积分自动领取

用法:
  creditdaddy daemon [--port 47860] [--host 127.0.0.1]   启动守护进程 + Web 面板
  creditdaddy add <token> [--cn] [--name 名字]           添加 Qoder 账号（--cn 为国内版）
  creditdaddy add <token> --workbuddy [--intl]           添加 WorkBuddy 账号（登录 token）
  creditdaddy list                                       查看账号
  creditdaddy checkin [--cn | --intl]                    立即领取
  creditdaddy remove <id前缀>                             删除账号
  creditdaddy export [file.json] --password 口令 [--cn|--intl]
                                                        导出账号（口令必填，至少 4 位；与 10router 迁移文件互通）
  creditdaddy import <file.json> [--password 口令]        导入 CreditDaddy / 10router 导出文件
  creditdaddy scan                                       导入本机 Qoder / WorkBuddy / ZCode / mirasim / 妙手 / Trae 客户端已登录的账号
  creditdaddy umid [install|remove]                      Qoder 设备身份组件（Linux / fnOS 国际版领取用）
  creditdaddy start [--port 47860] [--host 127.0.0.1]    后台启动（关掉终端也继续跑）
  creditdaddy stop                                       停止后台实例
  creditdaddy status                                     查看后台运行状态
  creditdaddy restart                                    重启后台实例
  creditdaddy logs                                       查看领取状态
  creditdaddy help                                       显示本帮助`;

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 面板访问地址（只监听回环时用 127.0.0.1，0.0.0.0 不能当访问地址用） */
function panelUrl(host, port) {
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${h}:${port}`;
}

/** 把运行时长说成人话（status 用） */
function humanUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/**
 * 优雅退出。之前 src/ 里一个 process.on 都没有，Ctrl+C 是 Node 默认的硬杀：
 * 状态文件留在原地（下次 start 会当成「已在运行」）、当天的日志既不落盘也不归档。
 */
function installShutdown({ server, background }) {
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    try { logger.info('CLI', `收到 ${signal}，正在退出…`); } catch {}
    try { (await import('../src/checkin.js')).stopScheduler(); } catch {}
    try { await server?.close(); } catch {}
    if (background) {
      // 只删自己写的状态文件：并发跑着第二个实例时别把它的状态抹掉
      try { const { clearRuntime } = await import('../src/bgdaemon.js'); await clearRuntime(process.pid); } catch {}
    }
    // 等归档流真的 close（gzip 完成）再退，否则今天的日志丢了
    try { await (await import('../src/logger.js')).closeArchiveStream(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 关掉终端会发 SIGHUP。后台实例（stdout 不是 TTY）本来就该在终端消失后活着，
  // 照着这个忽略；前台则当作用户要收摊。
  process.on('SIGHUP', () => { if (process.stdout.isTTY) shutdown('SIGHUP'); });
}

async function main() {
  switch (cmd) {
    case 'daemon': {
      const port = Number(flag('--port')) || Number(process.env.PORT) || undefined;
      const host = flag('--host') || process.env.HOST || undefined;
      const { server, port: boundPort } = await startDaemon(port, host);
      // 端口被占时 daemon 会自动 +1 重试，真正在听的是 boundPort；
      // 后台模式要把它记进状态文件，start/status 打印的必须是这个值
      const background = process.env.CREDITDADDY_BG === '1';
      if (background) {
        const { APP_VERSION } = await import('../src/constants.js');
        const { writeRuntime } = await import('../src/bgdaemon.js');
        await writeRuntime({
          pid: process.pid,
          port: boundPort,
          host: host || '127.0.0.1',
          startedAt: new Date().toISOString(),
          version: APP_VERSION,
        });
        logger.info('CLI', '已在后台运行');
      }
      const { startScheduler } = await import('../src/checkin.js');
      startScheduler();
      installShutdown({ server, background });
      logger.info('CLI', background ? '按 creditdaddy stop 停止' : '按 Ctrl+C 停止');
      break;
    }
    case 'start': {
      const { startBackground, backgroundLogFile } = await import('../src/bgdaemon.js');
      const { APP_VERSION } = await import('../src/constants.js');
      const port = Number(flag('--port')) || Number(process.env.PORT) || DEFAULT_BG_PORT;
      const host = flag('--host') || '127.0.0.1';
      console.log('正在后台启动 CreditDaddy…');
      const r = await startBackground({ port, host });
      if (r.error) { console.error('✗', r.error); process.exit(1); }
      const rec = r.rec;
      console.log(r.already ? '✓ 已在运行' : '✓ 已启动');
      console.log('  面板：', panelUrl(rec.host, rec.port));
      console.log('  进程：pid', rec.pid, '· 端口', rec.port, '· 版本', rec.version || APP_VERSION);
      console.log('  日志：', backgroundLogFile());
      console.log('  停止：creditdaddy stop');
      break;
    }
    case 'stop': {
      const { stopDaemon } = await import('../src/bgdaemon.js');
      const r = await stopDaemon();
      // 没在跑也算成功：脚本里 stop 之后紧接 start 不该因为「本来就没跑」而中断
      if (!r.stopped) {
        console.log(r.stale ? '· 清理了残留状态（进程已不在）' : '· 未在运行');
        break;
      }
      console.log('✓ 已停止（pid ' + r.rec.pid + '）');
      break;
    }
    case 'status': {
      const { statusRuntime } = await import('../src/bgdaemon.js');
      const s = await statusRuntime();
      if (!s.running) {
        console.log('· 未在运行');
        if (s.reason === 'no-state') {
          console.log('  启动：creditdaddy start');
        } else if (s.pidAlive) {
          // 进程在但端口不应答：多半卡在 listen 之前，或状态文件指向了旧实例
          console.log('  进程 pid ' + s.pid + ' 还在，但面板没有应答；建议 creditdaddy stop 后重启');
        }
        process.exit(1);
      }
      const startedMs = s.startedAt ? Date.now() - Date.parse(s.startedAt) : NaN;
      console.log('✓ 运行中');
      console.log('  面板：', panelUrl(s.host, s.port));
      console.log('  进程：pid', s.pid, '· 端口', s.port, '· 版本', s.probe?.version || s.version || '未知');
      console.log('  已运行：', humanUptime(startedMs));
      if (s.probe?.needsKey) console.log('  账号数：需面板密码（creditdaddy 设过访问密码）');
      else if (s.probe?.accountsCount != null) console.log('  账号数：', s.probe.accountsCount);
      if (s.probe?.nextTickAt) console.log('  下次签到：', new Date(s.probe.nextTickAt).toLocaleString());
      break;
    }
    case 'restart': {
      const { stopDaemon, startBackground, backgroundLogFile } = await import('../src/bgdaemon.js');
      await stopDaemon();
      const port = Number(flag('--port')) || Number(process.env.PORT) || DEFAULT_BG_PORT;
      const host = flag('--host') || '127.0.0.1';
      const r = await startBackground({ port, host });
      if (r.error) { console.error('✗', r.error); process.exit(1); }
      console.log('✓ 已重启');
      console.log('  面板：', panelUrl(r.rec.host, r.rec.port));
      console.log('  日志：', backgroundLogFile());
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
        console.log(`[${p.id.slice(0, 8)}] ${(p.name || '(未命名)').padEnd(16)} ${p.provider.padEnd(14)} ${p.tokenMasked}  ${p.lastCheckin ? '上次领取 ' + p.lastCheckin.slice(0, 16) : '未领取'}`);
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
      const { exportAccounts, buildExportPayload, TransferError } = await import('../src/transfer.js');
      const out = args[1] && !args[1].startsWith('--') ? args[1] : 'creditdaddy-secure-backup.json';
      const password = flag('--password');
      if (!password) { console.error('导出账号必须设置加密口令：creditdaddy export [file.json] --password 口令（至少 4 位）'); process.exit(1); }
      const provider = args.includes('--cn') ? 'qoder-cn' : args.includes('--intl') ? 'qoder' : undefined;
      const { writeFileSync } = await import('node:fs');
      let blob, count;
      try {
        const accounts = await loadAccounts();
        blob = exportAccounts(accounts, { password, provider });
        count = buildExportPayload(accounts, { provider }).accounts.length;
      } catch (e) {
        // 只 warn 后自然退出（exitCode），不 process.exit——硬退会吞掉归档流里还没落盘的那行
        logger.warn('CLI', `导出失败：${e instanceof TransferError ? e.code : e.message}`);
        console.error(e instanceof TransferError ? `导出失败：${e.message}` : e.message);
        process.exitCode = 1;
        break;
      }
      writeFileSync(out, JSON.stringify(blob, null, 2), { mode: 0o600 });
      // 与 daemon /api/export 同口径落审计日志（写盘成功后才记）；只记范围与条数，不记口令/token
      logger.info('CLI', `导出账号（${provider ? provider : '全部账号'}）：${count} 个 → ${out}`);
      console.log('✓ 已导出加密文件（10router 可直接导入）：', out);
      break;
    }
    case 'import': {
      const file = args[1];
      if (!file) { console.error('用法: creditdaddy import <file.json>'); process.exit(1); }
      const { readFileSync } = await import('node:fs');
      const { importAccounts } = await import('../src/accounts.js');
      const { parseImport, TransferError } = await import('../src/transfer.js');
      let parsed;
      try {
        parsed = parseImport(JSON.parse(readFileSync(file, 'utf8')), { password: flag('--password') });
      } catch (e) {
        if (e instanceof TransferError) {
          // 同上：warn 后自然退出，硬退 process.exit 会丢这行审计日志
          logger.warn('CLI', `导入失败（${file}）：${e.code}`);
          console.error(`导入失败：${e.message}`);
          process.exitCode = 1;
          break;
        }
        throw e;
      }
      const r = await importAccounts(parsed.accounts);
      logger.info('CLI', `导入完成（${parsed.source}）：新增 ${r.added}，续期 ${r.updated}，跳过 ${r.skipped + parsed.skipped}`);
      console.log(`✓ 导入完成（来源 ${parsed.source}）：新增 ${r.added}，续期 ${r.updated}，跳过 ${r.skipped + parsed.skipped}`);
      break;
    }
    case 'scan': {
      const { readQoderAppAccounts } = await import('../src/qoderApp.js');
      const { readWorkbuddySessions } = await import('../src/workbuddyLocal.js');
      const { liveToAccount: zcodeLive } = await import('../src/zcodeLocal.js');
      const { liveToAccount: mirasimLive } = await import('../src/mirasimLocal.js');
      const { liveToAccount: catpawLive } = await import('../src/catpawLocal.js');
      const { liveToAccount: traeLive } = await import('../src/traeLocal.js');
      const { addAccount } = await import('../src/accounts.js');
      const qa = await readQoderAppAccounts();
      const wb = readWorkbuddySessions();
      const skipped = [];
      let zAccount = null;
      try { zAccount = zcodeLive(); } catch (e) { skipped.push({ file: '~/.zcode/v2/credentials.json', error: e.message }); }
      let miraAccount = null;
      try { miraAccount = await mirasimLive(); } catch (e) { skipped.push({ file: '~/.mirasim/setting.json', error: e.message }); }
      let cpAccount = null;
      try { cpAccount = await catpawLive(); } catch (e) { skipped.push({ file: 'catpaw-moon/catx-credential.json', error: e.message }); }
      let traeAccount = null;
      try { traeAccount = await traeLive(); } catch (e) { skipped.push({ file: 'TRAE SOLO CN/User/globalStorage/storage.json', error: e.message }); }
      const records = [
        ...qa.accounts.map((c) => ({
          label: c.source,
          rec: { provider: c.provider, token: c.token, name: c.user.name || c.user.email, uid: c.user.id, email: c.user.email, refreshToken: c.refreshToken, expiresAt: c.expiresAt, source: 'local-app', meta: { qoderAuth: c.authJson, qoderAuthFile: c.file } },
        })),
        ...wb.accounts.map(({ file: _f, fileTime: _t, current, source, ...rec }) => ({
          label: source, rec: { ...rec, source: current ? 'workbuddy-current' : 'workbuddy-history' },
        })),
        ...(zAccount ? [{ label: 'ZCode 当前登录', rec: zAccount }] : []),
        ...(miraAccount ? [{ label: 'mirasim 当前登录', rec: miraAccount }] : []),
        ...(cpAccount ? [{ label: '妙手当前登录', rec: cpAccount }] : []),
        ...(traeAccount ? [{ label: 'Trae 当前登录', rec: traeAccount }] : []),
      ];
      for (const e of [...qa.errors, ...wb.errors, ...skipped]) console.log('⚠', e.file, e.error);
      if (!records.length) { console.log('（本机 Qoder / WorkBuddy / ZCode / mirasim / 妙手 / Trae 客户端未登录或未安装）'); break; }
      for (const { label, rec } of records) {
        const r = await addAccount(rec, { trusted: true });
        console.log(r.duplicate ? (r.updated ? '↻ 已更新' : '· 已存在') : '✓ 已导入', r.account.name || r.account.id, `（${label}）`);
      }
      break;
    }
    case 'umid': {
      const umid = await import('../src/qoderUmid.js');
      const sub = args[1] || 'status';
      if (sub === 'install') {
        console.log('正在从 npm 下载官方 @qoder-ai/qodercli 并提取设备身份组件（约 30MB）…');
        const m = await umid.installUmid();
        console.log(`✓ 已安装：qodercli ${m.version} / ${m.arch}，Qoder 国际版领取可用`);
      } else if (sub === 'remove') {
        umid.removeUmid();
        console.log('✓ 已移除设备身份组件');
      } else {
        const info = umid.umidInfo();
        if (!info.supported) console.log('当前平台不需要该组件（Windows / macOS 使用 Qoder 客户端自带的 runtime-info）');
        else if (info.installed) console.log(`已安装：qodercli ${info.installed.version} / ${info.installed.arch}（${info.installed.installedAt.slice(0, 10)}）`);
        else console.log('未安装。运行 creditdaddy umid install 安装后即可领取 Qoder 国际版');
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
