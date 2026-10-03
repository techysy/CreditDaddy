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

/** 把一份已关闭的日志 gzip 成 .log.gz（此时流已 flush、fd 已释放，可安全同步读），并按保留期清理过期归档 */
function gzipAndCleanup(file) {
  try {
    if (fsSync.existsSync(file)) {
      const raw = fsSync.readFileSync(file);
      if (raw.length) {
        fsSync.writeFileSync(file + '.gz', zlib.gzipSync(raw));
        fsSync.unlinkSync(file);
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

export function getLogs(limit = 100, tag = null) {
  const lines = tag ? ring.filter((l) => l.tag === tag) : ring;
  return lines.slice(-limit);
}

/** 测试收尾 / 进程退出用：关闭当前归档流，落盘后 gzip 归档并清理过期文件 */
export function closeArchiveStream() {
  if (archiveStream) {
    const prev = archiveStream;
    const prevFile = path.join(archiveDir, `daemon-${archiveDay}.log`);
    archiveStream = null;
    prev.on('error', () => {});
    prev.on('close', () => gzipAndCleanup(prevFile));
    prev.end();
  }
  archiveDay = null;
}
