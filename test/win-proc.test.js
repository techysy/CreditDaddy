/**
 * winProc 全量快照探测的自证测试（#57）：CSV 解析（GBK 镜像名 / 引号转义 / INFO 行）、
 * 冷快照不阻塞、异步刷新落地后修正、TTL 过期重刷——tasklist 注入，无真实进程查询。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTasklist, parseTasklistCsv, procRunningCached, _setSnapshotForTests, _setTasklistForTests, _resetProcForTests } from '../src/winProc.js';

// tasklist 在中文系统控制台输出 GBK 字节：fixture 按字节拼——ASCII 行直接写，
// 「妙手.exe」行用 GBK 字节硬编码（C3EE CAD6，'妙手'.encode('gbk') 取得）。
// fixture 若用 UTF-8 编码中文，GBK 解码会得到乱码名——真机不会发生（真 tasklist 输出 GBK）。
const CSV = Buffer.concat([
  Buffer.from('"ZCode.exe","1234","Console","1","52,000 K"\r\n', 'utf8'),
  Buffer.from([0x22, 0xC3, 0xEE, 0xCA, 0xD6, 0x2E, 0x65, 0x78, 0x65, 0x22, 0x2C, 0x22, 0x35, 0x36, 0x37, 0x38, 0x22, 0x0D, 0x0A]),  // "妙手.exe","5678"
  Buffer.from('"MiniMax Code.exe","901","Console","1","12,000 K"\r\n', 'utf8'),
  Buffer.from('"Code.exe","1122","Console","1","88,000 K"\r\n', 'utf8'),
  Buffer.from('INFO: No tasks are running which match the specified criteria.', 'utf8'),
]);

beforeEach(() => {
  _resetProcForTests();
});

test('CSV 解析：首列镜像名（含空格 / 中文），INFO 行自然落空', () => {
  const names = parseTasklistCsv(decodeTasklist(CSV));
  assert.equal(names.size, 4);
  assert.ok(names.has('zcode.exe'));
  assert.ok(names.has('妙手.exe'), 'GBK 字节还原的中文镜像名');
  assert.ok(names.has('minimax code.exe'));
  assert.ok(names.has('code.exe'));
  assert.equal(parseTasklistCsv('').size, 0);
});

test('冷快照：首轮按「没在运行」且不 spawn 同步等待；异步刷新落地后修正', async () => {
  _setTasklistForTests(async () => CSV);
  // 首轮：冷快照 → false（绝不阻塞），但已触发异步刷新
  assert.equal(procRunningCached(['ZCode.exe']), false);
  await new Promise((r) => setTimeout(r, 30));   // 让异步刷新落地
  assert.equal(procRunningCached(['ZCode.exe']), true);
  assert.equal(procRunningCached(['妙手.exe']), true);
  assert.equal(procRunningCached(['minimax code.exe']), true);
  assert.equal(procRunningCached(['不存在.exe']), false);
});

test('快照未过期：直接读快照不刷新；过期后重刷能看到新进程', async () => {
  _setSnapshotForTests(['A.exe'], Date.now() - 5_000);   // 5s 前：新鲜
  assert.equal(procRunningCached(['A.exe']), true);
  assert.equal(procRunningCached(['B.exe']), false);

  _setSnapshotForTests(['A.exe'], Date.now() - 11_000);  // 11s 前：过期
  _setTasklistForTests(async () => Buffer.from('"B.exe","1","Console","1","1 K"', 'utf8'));
  assert.equal(procRunningCached(['B.exe']), false);      // 本轮仍读旧快照
  await new Promise((r) => setTimeout(r, 30));            // 异步刷新落地
  assert.equal(procRunningCached(['B.exe']), true);
  assert.equal(procRunningCached(['A.exe']), false);      // 旧进程已退出
});

test('tasklist 失败：不抛错，按「没在运行」继续，下轮重试', async () => {
  _setTasklistForTests(() => { throw new Error('boom'); });
  assert.equal(procRunningCached(['A.exe']), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(procRunningCached(['A.exe']), false);      // 仍失败也不抛
});
