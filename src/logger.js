/** 轻量日志：环形缓冲（供面板查看）+ 控制台输出 + 按日期归档落盘 */

const RING_SIZE = 300;
const ring = [];

// ─── 按日期归档：logs/daemon-YYYY-MM-DD.log（跨天自动换文件，历史自动 gzip） ───
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const ARCHIVE_RETENTION_DAYS = 7;   // .log.gz 归档保留天数，更早的自动清理

let archiveDir = null;
try {
  const explicit = process.env.CREDITDADDY_HOME || process.env.QODERDADDY_HOME;
  const base = explicit || path.join(os.homedir(), '.creditdaddy');
  archiveDir = path.join(base, 'logs');
  fsSync.mkdirSync(archiveDir, { recursive: true });
} catch { archiveDir = null; }

let archiveDay = null;
let archiveStream = null;

function archiveLine(line) {
  if (!archiveDir) return;
  try {
    const day = line.at.slice(0, 10);
    if (archiveDay !== day || !archiveStream) {
      if (archiveStream) {
        // 跨天 / 重启：把上一份流关闭，待其落盘完成（close 事件）后再 gzip
        const prev = archiveStream;
        const prevFile = path.join(archiveDir, `daemon-${archiveDay}.log`);
        archiveStream = null;
        prev.on('error', () => {});
        prev.on('close', () => gzipAndCleanup(prevFile));
        prev.end();
      }
      archiveStream = fsSync.createWriteStream(path.join(archiveDir, `daemon-${day}.log`), { flags: 'a' });
      archiveDay = day;
    }
    archiveStream.write('[' + line.at + '] ' + line.level.toUpperCase() + ' [' + line.tag + '] ' + line.msg + '\n');
  } catch { // 落盘失败不拖累主流程
  }
}

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 把一份已关闭的日志 gzip 成 .log.gz（此时流已 flush、fd 已释放，可安全同步读），并按保留期清理过期归档。
 *
 * ⚠️ 压缩后**截断**原文件而不是删除它：同一天的文件可能被另一个实例（前台 daemon /
 * 桌面版）以 O_APPEND 持有同一个 fd。删掉原文件后，POSIX 上它的后续写入会落进一个
 * 已无链接的 inode —— 别的实例还在正常跑，日志却静默消失。截断成 0 字节后 O_APPEND
 * 会从 0 重新追加，同一个 inode、同一批数据，谁都不会丢。
 */
function gzipAndCleanup(file) {
  try {
    if (fsSync.existsSync(file)) {
      const raw = fsSync.readFileSync(file);
      if (raw.length) {
        fsSync.writeFileSync(file + '.gz', zlib.gzipSync(raw));
        fsSync.truncateSync(file, 0);
      }
    }
  } catch {}
  cleanupArchive();
}

/** 清理超过保留期的 .log.gz 归档（以及残留的旧 .log），按文件名里的日期判断，不依赖 mtime */
function cleanupArchive() {
  if (!archiveDir) return;
  try {
    // 保留期按「文件名日期距今 N 天」算：今天与最近 7 天的归档都保留
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ARCHIVE_RETENTION_DAYS);
    cutoff.setHours(0, 0, 0, 0);
    for (const name of fsSync.readdirSync(archiveDir)) {
      const m = /^daemon-(\d{4}-\d{2}-\d{2})\.log(\.gz)?$/.exec(name);
      if (!m) continue;   // 只动本 daemon 的归档文件，不碰目录里其他文件
      const f = path.join(archiveDir, name);
      let fileDay;
      try { fileDay = new Date(m[1] + 'T00:00:00'); } catch { continue; }
      if (fileDay.getTime() < cutoff.getTime()) {
        try { fsSync.unlinkSync(f); } catch {}
      }
    }
  } catch {}
}

export function log(level, tag, msg) {
  const line = { at: ts(), level, tag, msg: String(msg) };
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
  archiveLine(line);
  const prefix = level === 'error' ? '✗' : level === 'warn' ? '!' : '·';
  console.error(`[${line.at}] ${prefix} [${tag}] ${line.msg}`);
}

export const logger = {
  info: (tag, msg) => log('info', tag, msg),
  warn: (tag, msg) => log('warn', tag, msg),
  error: (tag, msg) => log('error', tag, msg),
  debug: (tag, msg) => log('debug', tag, msg),
};

/**
 * 把各账号的失败结论压缩成「失败类型×次数」摘要，写进“全部失败”日志——
 * 网络抖动 / 验证码 / 额度 / 限流 / 拉黑 一眼可辨，不用再靠“有没有伴随 3012”去反推。
 * 三处网关共用同一口径；未知错误归入「上游错误」。
 */
export function summarizeAttempts(attempted) {
  if (!Array.isArray(attempted) || !attempted.length) return '';
  const buckets = new Map();
  for (const a of attempted) {
    const err = String(a && a.error ? a.error : '未知错误');
    let key;
    if (a && a.captcha) key = '验证码被拒';
    else if (/验证码/.test(err)) key = '验证码被拒';
    else if (/拉黑|凭据失效|JWT|Token 彻底失效|401/.test(err)) key = '账号拉黑';
    else if (/额度耗尽|额度不足|已打标/.test(err)) key = '额度耗尽';
    else if (/额度/.test(err)) key = '额度瞬时拒绝';
    else if (/429|限流/.test(err)) key = '429 限流';
    else if (/超时|timeout|timed out|连接|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|terminated|aborted|fetch failed|网络|建立事件流失败/.test(err)) key = '网络错误';
    else key = '上游错误';
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets.entries()].map(([k, n]) => `${k}×${n}`).join('、');
}

export function getLogs(limit = 100, tag = null) {
  // tag=null 是面板「运行日志」：网关调用日志（*-GW）刷屏快、口径不同，
  // 只在自己的标签页里展示，不混进运行日志；显式传 tag 的查询不受影响。
  const lines = tag ? ring.filter((l) => l.tag === tag) : ring.filter((l) => !(l.tag || '').endsWith('-GW'));
  return lines.slice(-limit);
}

/**
 * 测试收尾 / 进程退出用：关闭当前归档流，落盘后 gzip 归档并清理过期文件。
 *
 * 返回 Promise，等流真正 close（gzip 已完成）才 resolve —— 优雅退出路径紧接着就要
 * process.exit()，不等的话回调根本没机会跑，今天的日志既不落盘也不归档。
 * 调用方不 await（测试里就是）也完全兼容，只是没人等它。
 */
export function closeArchiveStream() {
  if (!archiveStream) return Promise.resolve();
  const prev = archiveStream;
  const prevFile = path.join(archiveDir, `daemon-${archiveDay}.log`);
  archiveStream = null;
  archiveDay = null;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    prev.on('error', done);
    prev.on('close', () => { gzipAndCleanup(prevFile); done(); });
    // 兜底：万一 close 事件不来（fd 被外部占住），不让退出流程永远挂在这里
    const timer = setTimeout(done, 2000);
    timer.unref?.();
    prev.end(done);
  });
}
