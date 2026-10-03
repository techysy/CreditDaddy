/**
 * Windows 进程探测的公共实现。
 *
 * `tasklist.exe` 的输出跟随控制台代码页：中文系统上是 GBK，按 latin1/utf8 解码会得到乱码，
 * 于是「没有运行的任务」那行匹配不上 → 探测函数把「进程不存在」误判成「正在运行」。
 * （曾经真的踩过：qoderApp 用 latin1，中文 Windows 上 qoderRunning() 恒为 true，
 *  导致切换永远报「Qoder 正在运行」，强制切换还会空等 11 秒。）
 * 统一走这里，避免每个产品各写一份、各错一种。
 */

import { execFileSync } from 'node:child_process';

/** tasklist 的 Buffer 输出 → 字符串（GBK 优先，解码器不可用时退回 utf8） */
export function decodeTasklist(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}

/** tasklist 在「无匹配」时输出的那行（各语言版本） */
const NO_TASKS = /No Tasks|没有运行的任务|没有找到|没有任务/i;

/**
 * 任一 exe 是否在运行。
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
