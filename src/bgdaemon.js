/**
 * CreditDaddy 后台守护 —— 让 `creditdaddy start` 把 daemon 丢到后台跑，终端可以随手关掉。
 *
 * 为什么不直接把日志接到 daemon-YYYY-MM-DD.log：
 *   同一个数据目录可能同时有多个实例（后台实例 + 用户手动跑的前台 daemon + 桌面版），
 *   它们以 O_APPEND 共享当天文件。logger.js 关闭流时会 gzip 并清空原文件；子进程那侧
 *   单独接 background.log，两个实例互不干扰，也避开 cleanupArchive 的文件名前缀约定。
 *
 * 状态落在 <数据目录>/daemon.json（不是 .pid），因为要记的不止 pid —— daemon 端口被占
 * 时会自动 +1 重试最多 10 次（见 daemon.js 的 EADDRINUSE 分支），真正在听的端口只有
 * startDaemon() resolve 后的 r.port 知道，所以由 daemon 进程自己写这个文件。
 *
 * 「在运行」= pid 存活 **且** 端口应答：pid 会被系统回收、文件会被手删，只查 pid 会误报；
 * 只查端口又会把同端口的桌面版误认成 CLI 实例。状态查询走带鉴权的 /api/status（不新增
 * 任何未鉴权端点），401 同样算「活着」—— 说明服务在，只是要面板密码。
 */

import { spawn, execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './store.js';
import { logger } from './logger.js';
import { t } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.join(__dirname, '..', 'bin', 'creditdaddy.js');
const DEFAULT_PORT = 47860;
const DEFAULT_HOST = '127.0.0.1';

// 后台启动最多等这么久：daemon 要读账号库、建 HTTP server、起签到定时器，冷启动慢一点正常
const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 250;
// /api/status 需要 DPAPI 解密与本机进程探测，冷机/高负载下单次可达 2-4s（实测 Windows 稳态 ~1.9s）。
// 2.5s 的探测超时和稳态耗时贴边，机器一忙就出现「探针永远超时 → 误判启动失败」的抖动，宽限到 8s。
const PROBE_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 8000;

/** 状态文件路径：跟随 store.js 的 dataDir()，尊重 CREDITDADDY_HOME */
export function runtimeFile() {
  return path.join(dataDir(), 'daemon.json');
}

/** 后台实例的 stdout/stderr 落点（与按日归档的 daemon-*.log 分开，见文件头） */
export function backgroundLogFile() {
  return path.join(dataDir(), 'logs', 'background.log');
}

/** 读状态文件。文件不存在 / 内容损坏都返回 null（调用方按「没有后台实例」处理） */
export function readRuntime() {
  try {
    const raw = fsSync.readFileSync(runtimeFile(), 'utf8');
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || !Number.isInteger(r.pid) || r.pid <= 0) return null;
    return r;
  } catch {
    return null;
  }
}

export async function writeRuntime(rec) {
  const file = runtimeFile();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
        logger.warn('BG', '写状态文件失败:{err}', { err: e?.message || e });
    return false;
  }
}

/** 删状态文件。仅当 pid 与自己一致时才删——避免把后一个实例的状态误删 */
export async function clearRuntime(expectedPid = null) {
  try {
    const cur = readRuntime();
    if (expectedPid != null && cur && cur.pid !== expectedPid) return false;
    await fs.unlink(runtimeFile());
    return true;
  } catch {
    return false;
  }
}

/**
 * 进程是否还活着。
 * ESRCH = 确实没有；EPERM = 在、只是当前用户无权发信号（不能当成已死）；
 * 抛到调用方的其他异常同样按「活着」处理——宁可多报一次运行中，也不要误杀。
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== 'ESRCH';
  }
}

/**
 * 面板访问密码，取值顺序与 daemon.js 的 initPanelKey 保持一致：
 * 面板设置里存的 panelKey 优先（用户可能已改过），环境变量兜底。
 */
export async function readPanelKey() {
  try {
    const { loadSettings } = await import('./store.js');
    const s = await loadSettings();
    if (typeof s.panelKey === 'string' && s.panelKey) return s.panelKey;
  } catch { /* 读不到就退到环境变量 */ }
  return process.env.CREDITDADDY_PASSWORD || process.env.QODERDADDY_PASSWORD || '';
}

/**
 * 探一次 /api/status。200 与 401 都算 reachable（详见文件头）。
 * 不带 Origin，能过 daemon 的 rejectForeignRequest（非浏览器客户端不受该校验约束）。
 */
export function probeStatus(rec, timeoutMs = PROBE_TIMEOUT_MS) {
  const port = Number(rec?.port);
  const host = rec?.host || DEFAULT_HOST;
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve({ reachable: false });

  return new Promise((resolve) => {
    const req = http.request(
      { host: probeHost, port, path: '/api/status', method: 'GET', headers: { Host: `${probeHost}:${port}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const reachable = res.statusCode === 200 || res.statusCode === 401;
          let body = null;
          if (res.statusCode === 200) {
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
          }
          resolve({
            reachable,
            status: res.statusCode,
            needsKey: res.statusCode === 401,
            version: body?.version || null,
            accountsCount: Number.isInteger(body?.accountsCount) ? body.accountsCount : null,
            nextTickAt: body?.scheduler?.nextTickAt || null,
          });
        });
      },
    );
    // 401 也要把面板密码带上再试一次：daemon 可能在跑但设了访问密码，
    // 拿不到 version 不影响「在运行」的判定，但要账号数就得认证。
    req.on('error', () => resolve({ reachable: false }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ reachable: false }); });
    readPanelKey().then((key) => {
      if (key) req.setHeader('x-qd-key', key);
      req.end();
    });
  });
}

/** 后台实例的完整状态：文件 + 进程 + 端口三处都查 */
export async function statusRuntime() {
  const rec = readRuntime();
  if (!rec) return { running: false, reason: 'no-state' };
  const pidAlive = isAlive(rec.pid);
  let probe = pidAlive ? await probeStatus(rec) : { reachable: false };
  // pid 还在但立刻探不通 = 大概率正在启动途中的瞬断（listening 刚触发、首个请求还没排到）。
  // 只多等一拍再探一次：错了方向是放行双实例（状态互写）比错一刀拦死更危险
  if (pidAlive && !probe.reachable) {
    await new Promise((r) => setTimeout(r, 350));
    probe = await probeStatus(rec);
  }
  return { running: pidAlive && probe.reachable, pidAlive, probe, ...rec };
}

/**
 * 端口已被别的东西占了？（和「本 daemon 已在上一个端口跑着」是两回事）
 * 后台启动前先探，避免子进程悄悄漂到 47861 让用户摸不着面板在哪。
 */
/**
 * 端口是否已被别的东西占了？（和「本 daemon 已在上一个端口跑着」是两回事）
 *
 * 用「自己试着 bind 一下」判断，而不是发 HTTP 请求探活：非 HTTP 的程序（数据库、
 * 别的服务）占着端口时不会回话，HTTP 探测会一直等到超时，然后误报「端口空闲」，
 * 子进程就这么悄悄漂到了下一个端口，用户摸不着面板到底在哪。绑一下立刻 close，
 * 唯一目的就是拿到 EADDRINUSE 这个答案。
 */
export function portTaken(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (e) => resolve(e?.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    try {
      probe.listen(port, host);
    } catch {
      resolve(true);
    }
  });
}

/** 等后台实例真正开始应答（子进程要先写状态文件，再能被探到） */
async function waitReady(timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = readRuntime();
    if (rec && isAlive(rec.pid)) {
      const probe = await probeStatus(rec);
      if (probe.reachable) return { ok: true, rec, probe };
    }
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  return { ok: false };
}

/**
 * 后台拉起 daemon。
 * 已有一个活着的实例就直接返回（幂等）——脚本里 `start` 连跑两次不该起两个服务。
 */
export async function startBackground({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const cur = await statusRuntime();
  if (cur.running) return { already: true, rec: cur };

  const stale = readRuntime();
  if (stale) await clearRuntime();   // 残留状态（进程已死 / 端口失联），先清掉再起

  if (await portTaken(port, host)) {
    return { already: false, error: `端口 ${port} 已被其他程序占用` };
  }

  const logFile = backgroundLogFile();
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
  } catch { /* 目录建不了就退回继承父进程 stdio，daemon 本身不受影响 */ }

  let out = 'ignore';
  let logFd = null;
  try {
    logFd = fsSync.openSync(logFile, 'a');
    out = logFd;
  } catch { /* 落不了盘就让 daemon 继承 stdio */ }

  let child;
  try {
    child = spawn(process.execPath, [CLI_ENTRY, 'daemon', '--port', String(port), '--host', host], {
      detached: true,            // 独立进程组：关掉终端不影响它
      windowsHide: true,         // Windows 上不要弹控制台窗口
      stdio: ['ignore', out, out],
      env: { ...process.env, CREDITDADDY_BG: '1' },   // 让 daemon 知道自己跑在后台
    });
  } catch (e) {
    if (logFd != null) try { fsSync.closeSync(logFd); } catch {}
    return { already: false, error: `启动失败：${e?.message || e}` };
  }

  if (logFd != null) try { fsSync.closeSync(logFd); } catch {}
  child.unref();   // 父进程立刻可以退出，子进程继续活着

  const ready = await waitReady();
  if (!ready.ok) {
    // 没等到应答：把刚起的进程收掉，否则会留一个查不到状态的孤儿
    await killPid(child.pid);
    return { already: false, error: `启动超时（${Math.round(READY_TIMEOUT_MS / 1000)}s），日志见 ${logFile}` };
  }
  return { already: false, rec: ready.rec };
}

/**
 * 杀掉一个 pid。
 * Windows 没有进程组概念，process.kill(-pid) 会直接抛 EINVAL，所以用 taskkill /T 杀进程树；
 * taskkill 不可用（精简系统 / 容器）时退回单杀。
 */
export async function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 10_000,
      });
      return true;
    } catch { /* 进程可能已经没了，或 taskkill 不可用 */ }
  }
  try {
    // POSIX 下 detached 起的子进程自成进程组，-pid 才能连它自己拉起的子进程一起收掉
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch { /* 不是组长或已退出 */ }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** 端口是否已从监听状态退下 */
async function waitPortFree(port, host = DEFAULT_HOST, timeoutMs = STOP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portTaken(port, host))) return true;
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  return false;
}

/**
 * 等进程真正从进程表里消失。
 * SIGTERM 只是投递信号，handler 跑完 + 内核回收之间还有几十毫秒到几秒的窗口——
 * 端口先释放、pid 后回收是常态。不等它就报 stopped:true，调用方紧接着的
 * isAlive(pid) 仍会读到 true，误判「停不干净」。
 */
async function waitPidDead(pid, timeoutMs = STOP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  return false;
}

/**
 * 停掉后台实例。
 * 没在跑也正常返回（幂等）——脚本里 `stop` 后紧接 `start` 不该因为「本来就没跑」而中断。
 */
export async function stopDaemon() {
  const rec = readRuntime();
  if (!rec) return { stopped: false, reason: 'no-state' };

  if (!isAlive(rec.pid)) {
    await clearRuntime();
    return { stopped: false, reason: 'not-running', stale: true };
  }

  await killPid(rec.pid);
  const free = await waitPortFree(rec.port, rec.host);
  // 端口释放不等于进程退出：SIGTERM 只是投递，handler 收尾 + 内核回收还有窗口。
  // 必须等到 pid 真的没了再报 stopped，否则调用方紧接着 isAlive(pid) 仍读到 true。
  const dead = await waitPidDead(rec.pid);
  await clearRuntime();
  if (!free) logger.warn('BG', '端口 {port} 迟迟没有释放,进程可能仍在收尾', { port: rec.port });
  if (!dead) logger.warn('BG', '进程 {pid} 在 {sec}s 内没有退出干净', { pid: rec.pid, sec: Math.round(STOP_TIMEOUT_MS / 1000) });
  return { stopped: true, rec, portFree: free, pidDead: dead };
}
