/**
 * startDaemon 的监听失败路径：必须 reject，不能返回一个永远不 settle 的 promise。
 * 之前只 log 不 settle，调用方（CLI / 桌面壳）会一直等下去，既不启动调度器也不退出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-listen-'));

const { startDaemon } = await import('../src/daemon.js');
const { closeArchiveStream } = await import('../src/logger.js');

/** 203.0.113.0/24 是 RFC 5737 保留的文档用网段，任何机器上都不会被分配 */
const UNASSIGNABLE = '203.0.113.7';

test('监听不可用地址时 startDaemon 会 reject（而不是永远挂着）', async () => {
  await assert.rejects(
    startDaemon(0, UNASSIGNABLE),
    (e) => {
      assert.ok(e instanceof Error, '应抛出 Error');
      assert.match(e.message, /无法监听/);
      return true;
    }
  );
});

test('监听失败后不会再 resolve（守护进程确实没起来）', async () => {
  const outcome = await Promise.race([
    startDaemon(0, UNASSIGNABLE).then(() => 'resolved', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('hung'), 2000)),
  ]);
  assert.equal(outcome, 'rejected');
});

test('端口被占用时仍能自动顺延到下一个可用端口', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  let opened;
  let port;
  try {
    ({ server: opened, port } = await startDaemon(taken, '127.0.0.1'));
  } finally {
    blocker.close();
  }
  try {
    assert.notEqual(port, taken, '应换到别的端口');
    assert.equal(typeof port, 'number');
  } finally {
    opened.close();
  }
});

test.after(() => closeArchiveStream());
