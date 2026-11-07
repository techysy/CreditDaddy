/**
 * Windows 进程探测的公共实现。
 *
 * `tasklist.exe` 的输出跟随控制台代码页：中文系统上是 GBK，按 latin1/utf8 解码会得到乱码，
 * 于是「没有运行的任务」那行匹配不上 → 探测函数把「进程不存在」误判成「正在运行」。
 * （曾经真的踩过：qoderApp 用 latin1，中文 Windows 上 qoderRunning() 恒为 true，
 *  导致切换永远报「Qoder 正在运行」，强制切换还会空等 11 秒。）
 * 统一走这里，避免每个产品各写一份、各错一种。
 *
 * ## 两个口径（#57：同步 tasklist 阻塞 Electron 主进程）
 *
 * - [`anyProcRunning`]——**同步精确**：每次调用自己 spawn 一次 tasklist（~700ms）。
 *   给「守卫 / 终止」路径用：switchTo 的「客户端运行中则拒绝切换」、terminateXxx 的
 *   早退与等待循环（必须看到进程消失，不能用 10 秒前的快照）。频率低（用户动作触发），
 *   阻塞可接受，**语义上不容许陈旧值**。
 * - [`procRunningCached`]——**快照轮询**：读一张全量 `tasklist /NH /FO CSV` 快照
 *   （10s TTL），过期时**异步**刷新、绝不阻塞事件循环；冷快照按「没在运行」，
 *   下一轮轮询自动修正。给 /api/status 这类面板轮询用——桌面壳把 daemon 跑在
 *   Electron 主进程里，这里每多一次同步 spawn，UI 就多卡 0.7 秒（#57 实测 7 次串行 4.5s）。
 *   **任何「拿运行状态去决定能不能写凭据」的判断都不许用这条**，冷快照的 false
 *   会让运行中的客户端被覆盖（丢号风险）。
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** tasklist 的 Buffer 输出 → 字符串（GBK 优先，解码器不可用时退回 utf8） */
export function decodeTasklist(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}

/** tasklist 在「无匹配」时输出的那行（各语言版本） */
const NO_TASKS = /No Tasks|没有运行的任务|没有找到|没有任务/i;

/**
 * 任一 exe 是否在运行（同步精确口径）。
 * @param {string|string[]} exes
 * @returns {boolean} 查不到（命令不存在 / 超时）一律按「没在运行」处理，不阻塞调用方
 */
export function anyProcRunning(exes) {
  if (process.platform !== 'win32') return false;
  for (const exe of [].concat(exes)) {
    try {
      const out = decodeTasklist(execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exe}`, '/NH'],
        { windowsHide: true, encoding: 'buffer', timeout: 8000 }));
      if (!NO_TASKS.test(out)) return true;
    } catch { /* 查不到就换下一名 */ }
  }
  return false;
}

// ── 全量快照（轮询口径） ──

const SNAP_TTL_MS = 10_000;
const snapshot = { names: null, at: 0 };   // Set<小写镜像名> / 生成时刻；names=null = 冷快照
let inflight = null;
let tasklistForTests = null;               // 测试注入：(args) => Buffer，替代真 tasklist
let testMode = false;                      // 任一测试钩子被调用即置位：放行非 Windows 平台的平台短路（快照逻辑本身与平台无关）

/** CSV 首列（镜像名，可能带空格/中文）→ 小写集合；其余行（INFO 提示等）自然落空。 */
export function parseTasklistCsv(text) {
  const names = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

function applyOutput(buf) {
  snapshot.names = parseTasklistCsv(decodeTasklist(buf));
  snapshot.at = Date.now();
}

function refreshSnapshotSync() {
  try {
    const buf = tasklistForTests
      ? tasklistForTests(['/NH', '/FO', 'CSV'])
      : execFileSync('tasklist.exe', ['/NH', '/FO', 'CSV'],
        { windowsHide: true, encoding: 'buffer', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    applyOutput(buf);
  } catch {
    // 保留旧快照；从未成功过就置空集 + at=0（永远算 stale），下一轮再试
    if (!snapshot.names) { snapshot.names = new Set(); snapshot.at = 0; }
  }
  return snapshot;
}

async function refreshSnapshotAsync() {
  try {
    const buf = tasklistForTests
      ? await tasklistForTests(['/NH', '/FO', 'CSV'])   // 测试注入可返回 Promise，模真异步
      : (await execFileP('tasklist.exe', ['/NH', '/FO', 'CSV'],
        { windowsHide: true, encoding: 'buffer', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
    applyOutput(buf);
  } catch {
    if (!snapshot.names) { snapshot.names = new Set(); snapshot.at = 0; }
  }
}

/**
 * 任一 exe 是否在运行（快照轮询口径，见模块头「两个口径」）。
 * 快照过期触发**异步**刷新；本调用永远不 spawn、不阻塞。冷快照返回 false。
 */
export function procRunningCached(exes) {
  // 非 Windows 没有快照可探——但测试模式下要放行，否则注入式测试在 Linux CI 上
  // 永远读到短路 false（win-proc.test.js 313/314 红的根因；只看 tasklistForTests
  // 会漏掉只 _setSnapshotForTests 的用例）
  if (process.platform !== 'win32' && !testMode) return false;
  if (!snapshot.names || Date.now() - snapshot.at > SNAP_TTL_MS) {
    if (!inflight) inflight = refreshSnapshotAsync().finally(() => { inflight = null; });
    if (!snapshot.names) return false;   // 冷快照：本轮按「没在运行」，刷新落地后修正
  }
  return [].concat(exes).some((exe) => snapshot.names.has(String(exe).toLowerCase()));
}

/** 测试钩子：注入快照内容与时刻（绕开真 tasklist）。 */
export function _setSnapshotForTests(names, at = Date.now()) {
  testMode = true;
  snapshot.names = new Set([].concat(names).map((n) => String(n).toLowerCase()));
  snapshot.at = at;
}
/** 测试钩子：注入 tasklist 输出（Buffer），替代真实进程查询。 */
export function _setTasklistForTests(fn) { testMode = true; tasklistForTests = fn; }
/** 测试钩子：清空快照与注入。 */
export function _resetProcForTests() {
  snapshot.names = null;
  snapshot.at = 0;
  inflight = null;
  tasklistForTests = null;
  testMode = false;
}
