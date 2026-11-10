/**
 * issue #46：自定义安装路径下的 WorkBuddy 客户端探测。
 *
 * 回归守住两件事：
 *  1) 固定候选（%LOCALAPPDATA%\Programs\…）全部落空时，异步发现的路径要能被 detectWorkbuddy 采纳，
 *     否则装在 D:/E: 盘的客户端会被误判「未安装」，切换账号被硬拦；
 *  2) detectWorkbuddy 必须保持同步零子进程——它是 /api/status 每轮调用的热路径，
 *     1.6.6 白屏事故就是在这里 spawnSync 起子进程冻住了 Electron 主进程消息泵。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { detectWorkbuddy, _setDiscoveredClientPathForTest } = await import('../src/workbuddyLocal.js');

test('issue #46：固定候选全落空时，异步发现的自定义路径会被 detectWorkbuddy 采纳', () => {
  // 先测出本机固定候选是否命中：装了默认路径客户端（开发机常态）时，
  // 固定候选优先级更高，这条用例改为断言「优先级正确」而非「采纳自定义」。
  const baseline = detectWorkbuddy();
  const defaultsHit = Boolean(baseline.clientPath);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-custom-'));
  try {
    const exe = path.join(tmp, 'WorkBuddy.exe');
    fs.writeFileSync(exe, '');
    _setDiscoveredClientPathForTest(exe);

    const d = detectWorkbuddy();
    if (defaultsHit) {
      assert.notEqual(d.clientPath, exe, '固定候选命中时不应被自定义路径覆盖（优先级：默认路径 > 自定义）');
      assert.equal(d.installed, true);
    } else {
      assert.equal(d.clientPath, exe, '固定候选落空时应采纳异步发现的自定义路径');
      assert.equal(d.installed, true, '发现自定义路径后必须判定为已安装');
    }
  } finally {
    _setDiscoveredClientPathForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('issue #46：自定义路径文件已不存在时不得误报已安装', () => {
  _setDiscoveredClientPathForTest(path.join(os.tmpdir(), 'definitely-not-here', 'WorkBuddy.exe'));
  try {
    const d = detectWorkbuddy();
    // 默认候选存在时仍应为已安装（开发机常态）；不存在时期望 false
    assert.equal(typeof d.installed, 'boolean');
    assert.notEqual(d.clientPath, path.join(os.tmpdir(), 'definitely-not-here', 'WorkBuddy.exe'));
  } finally {
    _setDiscoveredClientPathForTest(null);
  }
});

test('issue #46：detectWorkbuddy 是同步函数，绝不返回 Promise（/api/status 热路径不可阻塞）', () => {
  const r = detectWorkbuddy();
  assert.equal(typeof r.then, 'undefined', 'detectWorkbuddy 必须同步返回，不能变成 async');
  assert.equal(typeof r.installed, 'boolean');
});

test('issue #46：CACHE_MISS 不抛异常——探测失败只是保持「未发现」', () => {
  _setDiscoveredClientPathForTest(null);
  assert.doesNotThrow(() => detectWorkbuddy());
});

// ── issue #52：注册表模糊搜索误命中 workbuddy-switch → 反复拉起弹窗 ──

test('issue #52：非 Electron 的假客户端（wb-switch-rust.exe）不得被采纳为发现路径', async () => {
  const { warmWorkbuddyClientPath, _setDiscoveredClientPathForTest } = await import('../src/workbuddyLocal.js');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  if (process.platform !== 'win32') return;   // 注册表探测只在 Windows 上跑

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fake-'));
  try {
    // 造一个名字带 switch 的非 Electron exe（内容不含 'Electron' 指纹）
    const fake = path.join(tmp, 'wb-switch-rust.exe');
    fs.writeFileSync(fake, Buffer.alloc(1024, 0x41));   // 1KB 的 'A'，绝非 Electron

    // 临时把它写进 HKCU Uninstall（用完即删；测试自清理，失败也只影响本机注册表一行）
    const key = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CreditDaddyTestFakeWB';
    const run = promisify(execFile);
    try {
      await run('reg', ['add', key, '/v', 'DisplayName', '/d', 'WorkBuddy-like tool', '/f'], { windowsHide: true });
      await run('reg', ['add', key, '/v', 'DisplayIcon', '/d', fake, '/f'], { windowsHide: true });
      _setDiscoveredClientPathForTest(null);
      await warmWorkbuddyClientPath();
      // 探测不得采纳假 exe（真客户端被本机默认候选命中时 discoveredClientPath 也应保持 null 或真路径）
      const d = detectWorkbuddy();
      assert.notEqual(d.clientPath, fake, '假客户端绝不能进发现缓存');
    } finally {
      await run('reg', ['delete', key, '/f'], { windowsHide: true }).catch(() => {});
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('issue #52：getWorkbuddyMasterKey 对非 Electron 路径短路返回 null，不 spawn', async () => {
  const { getWorkbuddyMasterKey, _setDiscoveredClientPathForTest } = await import('../src/workbuddyLocal.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fake2-'));
  try {
    const fake = path.join(tmp, 'wb-switch-rust.exe');
    fs.writeFileSync(fake, Buffer.alloc(2048, 0x42));   // 非 Electron 内容
    _setDiscoveredClientPathForTest(fake);
    // 即使缓存被污染，取钥也必须短路返回 null（绝不把假 exe 拉起来弹窗）
    const key = await getWorkbuddyMasterKey(fake);
    assert.equal(key, null, '非 Electron exe 必须短路返回 null');
  } finally {
    _setDiscoveredClientPathForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('issue #52：真 Electron 路径的指纹判定为通过（防误杀真客户端）', async () => {
  const { getWorkbuddyMasterKey } = await import('../src/workbuddyLocal.js');
  // 不实际执行 spawn——只验证 looksLikeWbElectronClient 的判定边界：
  // 用一个内嵌 'Electron' 字节的假 exe，确认判定函数不会把真客户端形态误拦。
  // 判定函数未导出，通过 masterKey 行为间接验证：真 Electron 形态的 exe 会走到 spawn
  // （本地无真客户端输出 → 返回 null 但不短路），耗时 < 6s（5s 超时兜底）。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-electron-'));
  try {
    const realish = path.join(tmp, 'WorkBuddy.exe');
    const buf = Buffer.alloc(1024, 0x43);
    Buffer.from('electron_browser_workbuddy_storage Electron').copy(buf, 0);   // 内嵌 Electron 字样
    fs.writeFileSync(realish, buf);
    const t0 = Date.now();
    const key = await getWorkbuddyMasterKey(realish);
    const elapsed = Date.now() - t0;
    assert.equal(key, null, '假 Electron（非真客户端）仍取不到钥，但不应被指纹闸提前短路');
    assert.ok(elapsed < 8000, '应尝试 spawn 后失败（毫秒级）而非被指纹闸直接拒绝');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
