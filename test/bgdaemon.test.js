/**
 * 后台守护（start/stop/status）的回归测试。
 *
 * 房规：CREDITDADDY_HOME 必须在 top-level await import 之前设好——src/logger.js 在模块
 * 作用域就读它算 archiveDir（见 test/daemon-listen.test.js 的同款写法）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-bg-'));
process.env.CREDITDADDY_HOME = HOME;

const bg = await import('../src/bgdaemon.js');
const { closeArchiveStream } = await import('../src/logger.js');

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'creditdaddy.js');

/** 借一个系统分配的空闲端口号（用完即弃，只为让测试之间不撞车） */
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CREDITDADDY_HOME: HOME },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test.after(async () => {
  await bg.stopDaemon();
  await closeArchiveStream();
});

// ── 状态文件 ──

test('状态文件读写往返', async () => {
  const rec = { pid: process.pid, port: 47860, host: '127.0.0.1', startedAt: new Date().toISOString(), version: '1.0.0' };
  assert.equal(await bg.writeRuntime(rec), true);
  assert.deepEqual(bg.readRuntime(), rec);
});

test('状态文件不存在或损坏时返回 null，不抛异常', async () => {
  await bg.clearRuntime();
  assert.equal(bg.readRuntime(), null);
  await fs.writeFile(bg.runtimeFile(), '{ 这不是 json', 'utf8');
  assert.equal(bg.readRuntime(), null);
  await fs.writeFile(bg.runtimeFile(), JSON.stringify({ pid: '不是数字' }), 'utf8');
  assert.equal(bg.readRuntime(), null, 'pid 非法时不应被当成有效状态');
});

test('clearRuntime 带 pid 时不会误删别人的状态', async () => {
  await bg.writeRuntime({ pid: 111, port: 1, host: '127.0.0.1' });
  assert.equal(await bg.clearRuntime(222), false, 'pid 不匹配时不该删');
  assert.equal(bg.readRuntime()?.pid, 111);
  assert.equal(await bg.clearRuntime(111), true);
  assert.equal(bg.readRuntime(), null);
});

// ── 进程存活判定 ──

test('isAlive：本进程为真、已退出的子进程为假', async () => {
  assert.equal(bg.isAlive(process.pid), true);
  assert.equal(bg.isAlive(0), false);
  assert.equal(bg.isAlive(-1), false);
  assert.equal(bg.isAlive(null), false);
  // 已经 exit 的子进程：pid 会被回收（Windows 上要等句柄释放，故给一点余量）
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  if (dead.status === 0) assert.equal(bg.isAlive(dead.pid), false);
});

// ── 端口占用：必须靠 bind 判断，不能靠 HTTP 探活 ──

test('portTaken 靠 bind 判断——非 HTTP 程序占着端口也算占用', async () => {
  const port = await freePort();
  assert.equal(await bg.portTaken(port, '127.0.0.1'), false, '空闲端口应为 false');

  // 一个只 accept、从不 respond 的裸 TCP server：HTTP 探测会超时误报「空闲」，
  // bind 才能正确看到 EADDRINUSE。这正是曾经的 bug。
  const hog = net.createServer(() => {});
  await new Promise((r) => hog.listen(port, '127.0.0.1', r));
  try {
    assert.equal(await bg.portTaken(port, '127.0.0.1'), true, '被裸 TCP 占用时必须为 true');
  } finally {
    await new Promise((r) => hog.close(r));
  }
});

test('端口被占时 startBackground 明确报错，且不留下状态文件', async () => {
  const port = await freePort();
  const hog = net.createServer(() => {});
  await new Promise((r) => hog.listen(port, '127.0.0.1', r));
  try {
    const r = await bg.startBackground({ port, host: '127.0.0.1' });
    assert.match(r.error || '', /已被其他程序占用/);
    assert.equal(fsSync.existsSync(bg.runtimeFile()), false, '启动失败不该留下状态文件');
  } finally {
    await new Promise((r) => hog.close(r));
  }
});

// ── 端到端：真的把 daemon 拉到后台 ──

test('startBackground 拉起真实后台实例，status 读得到、stop 收得干净', async () => {
  const port = await freePort();
  const r = await bg.startBackground({ port, host: '127.0.0.1' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.already, false);
  assert.equal(r.rec.port, port, '状态文件里必须是真正在听的端口');
  assert.ok(bg.isAlive(r.rec.pid));

  // 探针：能应答，且拿到版本与调度信息
  const probe = await bg.probeStatus(r.rec);
  assert.equal(probe.reachable, true);
  assert.equal(probe.status, 200);
  assert.ok(probe.version, '应能读到版本号');

  // 再 start 一次是幂等的，不该起第二个实例
  const again = await bg.startBackground({ port, host: '127.0.0.1' });
  assert.equal(again.already, true);
  assert.equal(again.rec.pid, r.rec.pid);

  // status 汇总为运行中
  const s = await bg.statusRuntime();
  assert.equal(s.running, true);
  assert.equal(s.pid, r.rec.pid);

  const stopped = await bg.stopDaemon();
  assert.equal(stopped.stopped, true);
  assert.equal(fsSync.existsSync(bg.runtimeFile()), false, '停止后状态文件应删除');
  // stopDaemon 内部已等 pid 死透才返回；这里的「立即断言」在高密度 CI runner 上是
  // TOCTOU——pid 可能被瞬时复用 / SIGCHLD 收尾窗口里 kill(pid,0) 又成功，fpk 与
  // ubuntu CI 各红过一轮。改为 ≤3s 宽限轮询，以「最终退出」为准。
  let pidDead = false;
  for (let i = 0; i < 30 && !pidDead; i++) {
    pidDead = !bg.isAlive(r.rec.pid);
    if (!pidDead) await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(pidDead, true, '进程应已退出');
});

test('stopDaemon 幂等：没有实例时不抛、不算失败', async () => {
  const r = await bg.stopDaemon();
  assert.equal(r.stopped, false);
  assert.equal(r.reason, 'no-state');
});

test('进程已死但状态文件残留时，status 判为未运行、stop 清掉残留', async () => {
  await bg.writeRuntime({ pid: 999999, port: 47860, host: '127.0.0.1', startedAt: new Date().toISOString() });
  const s = await bg.statusRuntime();
  assert.equal(s.running, false);
  assert.equal(s.pidAlive, false);
  const r = await bg.stopDaemon();
  assert.equal(r.stale, true);
  assert.equal(fsSync.existsSync(bg.runtimeFile()), false);
});

// ── CLI 表面 ──

test('CLI：status 未运行时退出码 1，stop 退出码 0（脚本可依赖）', () => {
  const st = runCli(['status']);
  assert.equal(st.code, 1);
  assert.match(st.out, /未在运行/);

  const sp = runCli(['stop']);
  assert.equal(sp.code, 0, 'stop 必须幂等：脚本里 stop 后接 start 不该中断');
});

test('CLI：后台启动的实例，父进程退出后仍在跑，能被新进程 stop 掉', async () => {
  const port = await freePort();
  const started = runCli(['start', '--port', String(port)]);
  assert.equal(started.code, 0, started.out);
  assert.match(started.out, new RegExp(String(port)), '输出里应含实际端口');

  // runCli 的子进程早已退出；实例应当独立活着
  const st = runCli(['status']);
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /运行中/);

  const sp = runCli(['stop']);
  assert.equal(sp.code, 0, sp.out);

  assert.equal(runCli(['status']).code, 1, '停止后 status 应退出码 1');
});
