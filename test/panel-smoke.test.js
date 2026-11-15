import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 面板启动冒烟：scripts/panel-boot-smoke.cjs 在子进程里跑（零依赖 vm 执行桩），
// 断言退出码 0 + 输出含 PANEL BOOT OK。覆盖两轮实测抓到的运行时错误类：
// 未声明变量（syncable）、已删节点的空引用（cnt-meoo）、渲染断言（到期口径）。
test('面板启动冒烟：panel.html 内联脚本可执行、启动链跑通、到期口径渲染', async () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'panel-boot-smoke.cjs');
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { timeout: 30_000 });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, buf }));
  });
  assert.match(out.buf, /PANEL BOOT OK/, '面板启动冒烟未通过：\n' + out.buf.slice(-600));
  assert.equal(out.code, 0);
});
