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

const { startDaemon, pickBindablePort } = await import('../src/daemon.js');
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
  // 先占住 P 和 P+1：daemon 占用失败时是按 P+1 顺延的（最多试 10 次），
  // 只占 P 的话它会顺利落到 P+1，测的就不是「顺延」而是「一撞就过」了。
  // 顺带躲开 Windows 保留端口段——listen(0) 拿到 7541 时 P+1=7542 可能落在
  // excludedportrange 里，bind 直接 EACCES，测试偶发红（与本用例要测的行为无关）。
  const blocker = net.createServer();
  const blocker2 = net.createServer();
  const base = await new Promise((r) => { blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)); });
  const taken = base >= 65530 ? base - 2 : base;   // 别顶到端口上限，P+1 还得留出来
  await new Promise((r) => blocker.close(r));
  await new Promise((r) => blocker.listen(taken, '127.0.0.1', r));
  await new Promise((r) => blocker2.listen(taken + 1, '127.0.0.1', r));

  let opened;
  let port;
  try {
    ({ server: opened, port } = await startDaemon(taken, '127.0.0.1'));
  } finally {
    blocker.close();
    blocker2.close();
  }
  try {
    assert.ok(port > taken + 1, `应顺延到 ${taken + 2} 或更后，实际 ${port}（${taken} / ${taken + 1} 都被占着）`);
    assert.equal(typeof port, 'number');
  } finally {
    opened.close();
  }
});

test('pickBindablePort：跳过系统保留段（WSL2 镜像网络把 47860~47870 圈走时选 47871）', () => {
  // WSL2 镜像网络模式的 Hyper-V excludedportrange 会圈走一段端口，bind 落进去直接 EACCES
  assert.equal(pickBindablePort(47860, [[47860, 47870]]), 47871, '保留段 47860~47870 应跳到 47871');
  assert.equal(pickBindablePort(47860, []), 47860, '无保留段时原样返回起始端口（稳定，不漂）');
  assert.equal(pickBindablePort(47860, [[47850, 47859]]), 47860, '保留段在起始端口之前不影响');
  assert.equal(pickBindablePort(47860, [[47860, 47860], [47862, 47862]]), 47861, '逐段跳过，取第一个空口');
  assert.equal(pickBindablePort(47860, [[47860, 50000]]), 50001, '超大保留段也能逃出');
  assert.equal(pickBindablePort(0, []), 47860, 'start=0 回退 DEFAULT_PORT（0 不是合法目标）');
});

test('ZCode 网关数据面路由：规范路径 /gateway/zcode/v1/messages 与旧别名都命中（405 而非 404）', async () => {
  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    // GET 落到 handleGateway 会因非 POST 返回 405；未命中路由则是 404
    for (const p of ['/gateway/zcode/v1/messages', '/gateway/v1/messages', '/v1/messages']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(res.status, 405, `${p} 应命中 ZCode 网关（405），实得 ${res.status}`);
    }
    const miss = await fetch(`http://127.0.0.1:${port}/gateway/unknown/v1/messages`);
    assert.equal(miss.status, 404, '未注册路径仍应 404');
  } finally {
    server.close();
  }
});

test('系统管理接口：POST /api/system/restart 触发已注册的 restartHandler', async () => {
  const { startDaemon, setRestartHandler } = await import('../src/daemon.js');
  let restartCalled = false;
  setRestartHandler(() => { restartCalled = true; });

  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/restart`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // 等待 500ms 后验证 handler 是否被调用
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(restartCalled, true, 'restartHandler 应在延迟后被调用');
  } finally {
    setRestartHandler(null);
    server.close();
  }
});

test.after(() => closeArchiveStream());

test('畸形请求行回 400 而不是崩进程（10router#114 同款崩溃面：async handler 里 new URL 同步 throw → unhandledRejection → Node ≥15 杀进程）', async () => {
  const { server, port } = await startDaemon(0, '127.0.0.1');
  const rejections = [];
  const onRejection = (e) => rejections.push(String(e?.message || e));
  process.on('unhandledRejection', onRejection);
  try {
    // 原始 socket 发一条 URL 里带空格的畸形请求行（new URL 必抛），
    // 随后立即再发一条正常请求——进程若被杀，第二条永远不会回来
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => { buf += d; });
      sock.on('error', reject);
      sock.on('close', () => resolve(buf));
      sock.on('connect', () => {
        sock.write('GET /bad request-line HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        setTimeout(() => sock.end(), 300);
      });
    });
    assert.ok(raw.includes('400'), '畸形请求行应回 400，实际: ' + JSON.stringify(raw.slice(0, 60)));

    // 进程还活着：正常请求可达（若 handler 抛了 unhandledRejection 且没兜住，这里是拿不到响应的）
    const alive = await fetch(`http://127.0.0.1:${port}/api/cookie-sites`);
    assert.ok(alive.status === 200 || alive.status === 401, '后续正常请求应可达（进程未被杀）');
    // 给漏网的 rejection 一拍浮出的机会
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rejections.length, 0, '不得产生 unhandledRejection: ' + rejections.join(' | '));
  } finally {
    process.removeListener('unhandledRejection', onRejection);
    server.close();
  }
});
