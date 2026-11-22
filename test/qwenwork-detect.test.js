/**
 * 千问办公客户端探测：exe 在 <install>\<ver>\ 版本子目录下（形如 2.1.0-26111906），
 * 国内版 QwenWorkCN / 国际版 QwenWork 目录互不混淆，数据目录各自独立。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const qa = await import('../src/qwenworkApp.js');

function touch(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function withFakeWindowsDirs(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenwork-detect-'));
  const keys = ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'APPDATA'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.LOCALAPPDATA = path.join(root, 'Local');
  process.env.ProgramFiles = path.join(root, 'PF');
  process.env['ProgramFiles(x86)'] = path.join(root, 'PF86');
  process.env.APPDATA = path.join(root, 'Roaming');
  try { return fn(root); } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('版本子目录布局：取最高版本的 exe，版本号来自目录名', { skip: process.platform !== 'win32' }, () => {
  withFakeWindowsDirs((root) => {
    const inst = path.join(root, 'Local', 'Programs', 'QwenWorkCN');
    touch(path.join(inst, '2.1.0-26111906', 'QwenWorkCN.exe'));
    touch(path.join(inst, '2.0.5-26090102', 'QwenWorkCN.exe'));
    const cn = qa.detectQwenworkApps().find((a) => a.provider === 'qwenwork-cn');
    assert.equal(cn.installed, true);
    assert.equal(cn.version, '2.1.0-26111906', '取最高版本目录');
    assert.ok(cn.exe.includes(path.join('2.1.0-26111906', 'QwenWorkCN.exe')));
  });
});

test('国际版目录不会被当成国内版（QwenWork vs QwenWorkCN）', { skip: process.platform !== 'win32' }, () => {
  withFakeWindowsDirs((root) => {
    touch(path.join(root, 'Local', 'Programs', 'QwenWork', '1.2.1-26092107', 'QwenWork.exe'));
    touch(path.join(root, 'Local', 'Programs', 'QwenWorkCN', '2.1.0-26111906', 'QwenWorkCN.exe'));
    const [intl, cn] = ['qwenwork', 'qwenwork-cn'].map((p) => qa.detectQwenworkApps().find((a) => a.provider === p));
    assert.ok(intl.exe.includes(`${path.sep}QwenWork${path.sep}`));
    assert.ok(cn.exe.includes(`${path.sep}QwenWorkCN${path.sep}`));
  });
});

test('signedIn 看 auth-v2.dat；legacy auth.dat 不算登录依据', { skip: process.platform !== 'win32' }, () => {
  withFakeWindowsDirs((root) => {
    const inst = path.join(root, 'Local', 'Programs', 'QwenWorkCN');
    touch(path.join(inst, '2.1.0-26111906', 'QwenWorkCN.exe'));
    const data = path.join(root, 'Roaming', 'QwenWorkCN');
    touch(path.join(data, 'auth.dat'), 'placeholder');
    let cn = qa.detectQwenworkApps().find((a) => a.provider === 'qwenwork-cn');
    assert.equal(cn.signedIn, false, 'auth.dat 是 SDK 占位，不作为登录依据');
    touch(path.join(data, 'auth-v2.dat'), 'v10xxx');
    cn = qa.detectQwenworkApps().find((a) => a.provider === 'qwenwork-cn');
    assert.equal(cn.signedIn, true);
    assert.equal(cn.dataDir, data);
  });
});
