/**
 * 端口选择与「端口遮蔽」回归（2026-11-25 事故：用户的主程序变成测试环境）。
 *
 * 现场：面板标题栏数据目录显示 `%TEMP%\qoder-current-viCLBf\cd`、账号只剩测试桩——
 * 正式安装版没在服务用户，服务用户的是一个测试实例。
 *
 * 两层根因，本文件逐层钉死：
 *  1. `startDaemon(0)` 的 0 被 `Number(port) || DEFAULT_PORT` 折叠成 47860。
 *     测试家族（daemon-listen / cookiesites / announcements / qoder-current-token /
 *     quota-refresh / hardening / croli-retired）全按 `startDaemon(0)` 写，本意是
 *     「系统给个空闲端口」，实际每一个都在抢正式安装版的默认端口。
 *  2. Windows 上同一端口 0.0.0.0 通配绑定与 127.0.0.1 精确绑定【可以共存】
 *     （实测双向都成功，EADDRINUSE 不触发），回环流量归精确绑定方。正式实例开了
 *     局域网网关时听在 0.0.0.0:47860，测试实例绑 127.0.0.1:47860 不报错却把本机
 *     面板流量整个接管。原有版本自探依赖 `/api/status` 的 version 字段，而面板访问
 *     密码开启时该接口回 401 且无 version → 防线失明。
 *     daemon.json 单实例守护按数据目录找活实例，两边目录不同 → 互看不见，也挡不住。
 *
 * 修复：port=0 原样交给 OS；listen 成功后用 netstat 数同一端口上的其他监听 PID
 * （与鉴权无关、不依赖对方应答），有则本机让位换端口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-portshadow-'));

const { startDaemon, parseListeningPids, foreignListenerPids } = await import('../src/daemon.js');
const { closeArchiveStream } = await import('../src/logger.js');

const DEFAULT_PORT = 47860;

/** 起一个只占端口的子进程（独立 PID，模拟「另一个实例」）；返回 { port, stop } */
async function holdPort(host, port) {
  const child = spawn(process.execPath, ['-e', `
    const http = require('http');
    const s = http.createServer((q, r) => r.end('holder'));
    s.listen(${port}, '${host}', () => process.stdout.write(String(s.address().port) + '\\n'));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const bound = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('holder 启动超时')), 8000);
    child.stdout.on('data', (d) => {
      buf += String(d);
      const m = /(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('holder 退出 ' + code)); });
  });
  return { port: bound, pid: child.pid, stop: () => { try { child.kill(); } catch {} } };
}

test('startDaemon(0) 用系统空闲端口，绝不落到默认端口 47860', async () => {
  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    assert.notEqual(port, DEFAULT_PORT, 'port=0 被折叠成默认端口 = 测试实例会抢正式安装版的端口');
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, '应拿到合法端口，实际 ' + port);
  } finally {
    server.close();
  }
});

test('parseListeningPids：只取该端口 LISTENING 的 TCP 行，IPv6 形态与 PID 去重正确', () => {
  const sample = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:47860          0.0.0.0:0              LISTENING       41316',
    '  TCP    127.0.0.1:47860        0.0.0.0:0              LISTENING       99001',
    '  TCP    [::]:47860             [::]:0                 LISTENING       41316',
    '  TCP    127.0.0.1:47860        127.0.0.1:52110        ESTABLISHED     99001',
    '  TCP    0.0.0.0:47861          0.0.0.0:0              LISTENING       777',
    '  UDP    0.0.0.0:47860          *:*                                    888',
  ].join('\r\n');
  assert.deepEqual(parseListeningPids(sample, 47860), [41316, 99001], '去重后按出现顺序；ESTABLISHED / UDP 不计');
  assert.deepEqual(parseListeningPids(sample, 47861), [777], '端口精确匹配，不串到相邻端口');
  assert.deepEqual(parseListeningPids(sample, 1), [], '无人监听时为空');
  assert.deepEqual(parseListeningPids('', 47860), [], '空输入不抛');
  assert.deepEqual(parseListeningPids('  TCP    0.0.0.0:4786', 47860), [], '残行不抛');
});

test('Windows：同端口通配/精确绑定可共存，且 netstat 探针能看见对方（遮蔽事故的判据）', { skip: process.platform !== 'win32' && '依赖 Windows 绑定语义' }, async () => {
  const holder = await holdPort('0.0.0.0', 0);
  try {
    // ① 遮蔽确实成立：另一个进程已占 0.0.0.0:P，我们再绑 127.0.0.1:P 不报错
    const shadow = http.createServer((q, r) => r.end('shadow'));
    const coexist = await new Promise((resolve) => {
      shadow.once('error', (e) => resolve('error:' + e.code));
      shadow.once('listening', () => resolve('bound'));
      shadow.listen(holder.port, '127.0.0.1');
    });
    try {
      assert.equal(coexist, 'bound', '本用例的前提是 Windows 允许同端口共存绑定；若变成 EADDRINUSE 说明平台语义变了，防线需要重估');
    } finally {
      shadow.close();
    }
    // ② 版本自探会失明的场景下，netstat 探针必须指出「这端口上还有别人」
    const pids = await foreignListenerPids(holder.port);
    assert.ok(pids.includes(holder.pid), `应发现持有者 pid ${holder.pid}，实得 ${JSON.stringify(pids)}`);
    assert.ok(!pids.includes(process.pid), '不得把本进程算作外来者');
  } finally {
    holder.stop();
  }
});

test('Windows：端口被另一实例占着时，startDaemon 让位换端口，绝不共端口双活', { skip: process.platform !== 'win32' && '依赖上一条的 Windows 绑定语义' }, async () => {
  const holder = await holdPort('0.0.0.0', 0);
  try {
    const { server, port } = await startDaemon(holder.port, '127.0.0.1');
    try {
      assert.notEqual(port, holder.port,
        `对方已在 0.0.0.0:${holder.port} 监听，本机却仍绑上同一端口 = 回环流量会被对方接管（11-25 事故形态）`);
      assert.ok(port > holder.port || port < DEFAULT_PORT, '应顺延到相邻端口，实际 ' + port);
    } finally {
      server.close();
    }
  } finally {
    holder.stop();
  }
});

test('端口空闲时不误判为外来监听（让位判定不能一刀切）', async () => {
  // 只钉一件事：netstat 探针不得把干净端口误报成有人监听——误报会让每次启动都白漂一个端口。
  // （端口确实不可用时由原有 EADDRINUSE +1 重试处理，daemon-listen.test.js 已覆盖。）
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const ownPort = probe.address().port;
  try {
    assert.deepEqual(await foreignListenerPids(ownPort), [], '本进程自己监听时不得算外来者');
  } finally {
    // 必须真的关掉：留一个在听的 socket 会把事件循环吊死，整个测试文件永不退出
    await new Promise((r) => probe.close(r));
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await foreignListenerPids(ownPort), [], '端口释放后仍不应有外来监听者');
});

test.after(async () => {
  await closeArchiveStream();
  try { await fs.rm(process.env.CREDITDADDY_HOME, { recursive: true, force: true }); } catch {}
});
