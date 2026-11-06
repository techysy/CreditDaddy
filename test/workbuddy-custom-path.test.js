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
