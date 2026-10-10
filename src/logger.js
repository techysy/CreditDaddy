/** 轻量日志：环形缓冲（供面板查看）+ 控制台输出 + 按日期归档落盘 */

const RING_SIZE = 300;
const ring = [];

// ─── 按日期归档：logs/daemon-YYYY-MM-DD.log（跨天自动换文件，历史自动 gzip） ───
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { t } from './i18n.js';
import { PROVIDER_LABEL } from './constants.js';

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
let jsonlStream = null;
let jsonlFile = null;

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
      if (jsonlStream) {
        const prevj = jsonlStream;
        const prevjFile = jsonlFile;
        jsonlStream = null;
        prevj.on('error', () => {});
        prevj.on('close', () => gzipAndCleanup(prevjFile));
        prevj.end();
      }
      archiveStream = fsSync.createWriteStream(path.join(archiveDir, `daemon-${day}.log`), { flags: 'a' });
      jsonlFile = path.join(archiveDir, `daemon-${day}.jsonl`);
      jsonlStream = fsSync.createWriteStream(jsonlFile, { flags: 'a' });
      archiveDay = day;
    }
    archiveStream.write('[' + line.at + '] ' + line.level.toUpperCase() + ' [' + line.tag + '] ' + line.msg + '\n');
    // 结构化副行（JSONL）：key+args 原样落盘，读取侧按当前语言重渲染（历史也能切语言）
    jsonlStream.write(JSON.stringify({ at: line.at, level: line.level, tag: line.tag, msg: line.msg, key: line.key, args: line.args }) + '\n');
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
      const m = /^daemon-(\d{4}-\d{2}-\d{2})\.(?:log|jsonl)(\.gz)?$/.exec(name);
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

export function log(level, tag, msg, args) {
  const rendered = t(String(msg), args);
  const line = { at: ts(), level, tag, msg: rendered, key: args ? String(msg) : null, args: args || null };
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
  archiveLine(line);
  const prefix = level === 'error' ? '✗' : level === 'warn' ? '!' : '·';
  console.error(`[${line.at}] ${prefix} [${tag}] ${line.msg}`);
}

export const logger = {
  info: (tag, msg, args) => log('info', tag, msg, args),
  warn: (tag, msg, args) => log('warn', tag, msg, args),
  error: (tag, msg, args) => log('error', tag, msg, args),
  debug: (tag, msg, args) => log('debug', tag, msg, args),
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

/**
 * 运行期拼出的复合参数（如「[WorkBuddy 国内版] 账号名」）不可能整串进字典（账号名千变万化），
 * 其中已知的产品 / 区域标签按当前语言做子串替换，其余字段原样保留。
 */
// 除产品线标签外，失败摘要的桶标签（summarizeAttempts 产出，记进 {detail} 参数，形如「账号拉黑×2」）
// 同样是运行期复合串，整串无法进词典，按子串替换。
const ATTEMPT_BUCKETS = ['验证码被拒', '账号拉黑', '额度耗尽', '额度瞬时拒绝', '429 限流', '网络错误', '上游错误'];

function localizeEmbedded(text) {
  let out = text;
  for (const zh of [...Object.values(PROVIDER_LABEL), ...ATTEMPT_BUCKETS]) {
    if (!out.includes(zh)) continue;
    const tv = t(zh);
    if (tv !== zh) out = out.split(zh).join(tv);
  }
  return out;
}

/** 带运行时数字的既有消息（连签 11 天 / 第 1 天 +400 积分）：按模式还原成模板再按当前语言渲染 */
const ARG_PATTERNS = [
  [/^今日已签（连签 (\d+) 天）$/, '今日已签（连签 {n} 天）', (m) => ({ n: m[1] })],
  [/^今日第 (\d+) 天已签到（([\d.]+) \+ ([\d.]+) 积分）$/, '今日第 {d} 天已签到（{a} + {b} 积分）', (m) => ({ d: m[1], a: m[2], b: m[3] })],
  [/^签到成功第 (\d+) 天（\+(\d+) 积分）$/, '签到成功第 {d} 天（+{p} 积分）', (m) => ({ d: m[1], p: m[2] })],
  [/^今日已领取（\+(\d+) 积分）$/, '今日已领取（+{p} 积分）', (m) => ({ p: m[1] })],
  [/^本机今日国际版额度已由「(.+)」领取（Qoder 每台设备每天限领一次）$/, '本机今日国际版额度已由「{name}」领取（Qoder 每台设备每天限领一次）', (m) => ({ name: localizeEmbedded(m[1]) })],
];

/** 字符串参数的三级翻译：整串精确 → 模式还原模板 → 子串标签替换 */
function localizeArgString(v, ctx) {
  const tv = t(v, ctx);
  if (tv !== v) return tv;
  for (const [re, tpl, vars] of ARG_PATTERNS) {
    const m = re.exec(v);
    if (m) return t(tpl, vars(m));
  }
  return localizeEmbedded(v);
}

function localizeArgs(args) {
  if (!args) return args;
  const loc = {};
  for (const [k, v] of Object.entries(args)) loc[k] = typeof v === 'string' ? localizeArgString(v, args) : v;
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' ? localizeArgString(v, loc) : v;
  return out;
}

export function getLogs(limit = 100, tag = null) {
  // tag=null 是面板「运行日志」：网关调用日志（*-GW）刷屏快、口径不同，
  // 只在自己的标签页里展示，不混进运行日志；显式传 tag 的查询不受影响。
  const lines = tag ? ring.filter((l) => l.tag === tag) : ring.filter((l) => !(l.tag || '').endsWith('-GW'));
  return lines.slice(-limit).map((l) => (l.key ? { ...l, msg: t(l.key, localizeArgs(l.args)) } : l));
}


/**
 * 读取结构化归档（.jsonl；缺省读当日、最多 limit 条）并按当前语言重渲染。
 * 旧版本没有 .jsonl 时返回 []，调用方静默回退到环形缓冲。
 * 同时兼容已 gzip 的当日归档（.jsonl.gz）。
 */
export function readArchiveJsonl({ day = null, limit = 2000 } = {}) {
  if (!archiveDir) return [];
  const d = day || ts().slice(0, 10);
  const file = path.join(archiveDir, `daemon-${d}.jsonl`);
  const gz = file + '.gz';
  let raw = '';
  try {
    raw = fsSync.existsSync(file) ? fsSync.readFileSync(file, 'utf8') : '';
    if (!raw && fsSync.existsSync(gz)) raw = zlib.gunzipSync(fsSync.readFileSync(gz)).toString('utf8');
  } catch { return []; }
  if (!raw) return [];
  const lines = raw.split('\n').filter(Boolean).slice(-Math.max(1, Number(limit) || 2000));
  const out = [];
  for (const ln of lines) {
    try {
      const e = JSON.parse(ln);
      out.push({ at: e.at, level: e.level, tag: e.tag, msg: e.key ? t(e.key, localizeArgs(e.args)) : e.msg });
    } catch {}
  }
  return out;
}

/**
 * 测试收尾 / 进程退出用：关闭当前归档流，落盘后 gzip 归档并清理过期文件。
 *
 * 返回 Promise，等流真正 close（gzip 已完成）才 resolve —— 优雅退出路径紧接着就要
 * process.exit()，不等的话回调根本没机会跑，今天的日志既不落盘也不归档。
 * 调用方不 await（测试里就是）也完全兼容，只是没人等它。
 */
export function closeArchiveStream() {
  const prev = archiveStream;
  const prevJ = jsonlStream;
  const prevFile = archiveDay ? path.join(archiveDir, `daemon-${archiveDay}.log`) : null;
  const prevJFile = jsonlFile;
  archiveStream = null;
  jsonlStream = null;
  archiveDay = null;
  const closeOne = (stream, file) => new Promise((resolve) => {
    if (!stream) return resolve();
    let settled = false;
    const finish = (gzip) => { if (!settled) { settled = true; if (gzip) gzipAndCleanup(file); resolve(); } };
    stream.on('error', () => finish(false));
    // 只等 close 事件收尾（gzip 也在这里做）：end 的回调在 finish 阶段就触发，
    // 那时 close 还没来、.gz 还没生成——await 完断言会看到对象不齐（测试 #3 逮过）
    stream.on('close', () => finish(true));
    const timer = setTimeout(() => finish(false), 2000);  // 兜底：close 不来不挂死
    timer.unref?.();
    stream.end();
  });
  return Promise.all([closeOne(prev, prevFile), closeOne(prevJ, prevJFile)]);
}
