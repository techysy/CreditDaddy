/** 轻量日志：环形缓冲（供面板查看）+ 控制台输出 + 按日期归档落盘 */

const RING_SIZE = 300;
const ring = [];

// ─── 按日期归档：logs/daemon-YYYY-MM-DD.log（跨天自动换文件） ───
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
      if (archiveStream) archiveStream.end();
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

/** 测试收尾用：归档流的句柄不关，测试进程的临时目录在 Windows 上删不掉 */
export function closeArchiveStream() {
  try { archiveStream?.end(); } catch {}
  archiveStream = null;
  archiveDay = null;
}
