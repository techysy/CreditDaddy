/** 轻量日志：环形缓冲（供面板查看）+ 控制台输出 */

const RING_SIZE = 300;
const ring = [];

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
  const prefix = level === 'error' ? '✗' : level === 'warn' ? '!' : '·';
  console.error(`[${line.at}] ${prefix} [${tag}] ${line.msg}`);
}

export const logger = {
  info: (tag, msg) => log('info', tag, msg),
  warn: (tag, msg) => log('warn', tag, msg),
  error: (tag, msg) => log('error', tag, msg),
  debug: (tag, msg) => log('debug', tag, msg),
};

export function getLogs(limit = 100) {
  return ring.slice(-limit);
}
