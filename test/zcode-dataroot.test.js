/**
 * ZCode 数据目录挪盘（setting.json 的 dataBaseDir）解析测试。
 * 上游只找 ~/.zcode，用户把数据挪到别的盘后会一直读到挪盘前的陈旧凭据文件：
 * 看到的是旧账号，切换还会被误判成「已是当前账号」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-zcode-'));
const home = path.join(tmp, 'home');
const moved = path.join(tmp, 'moved');
fs.mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
fs.mkdirSync(path.join(moved, '.zcode', 'v2'), { recursive: true });

// 陈旧副本留在 home 下，活文件在挪盘后的目录里
fs.writeFileSync(path.join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ marker: 'STALE' }));
fs.writeFileSync(path.join(moved, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ marker: 'LIVE' }));

process.env.ZCODE_HOME = home;
const { zcodePaths, detectZcode } = await import('../src/zcodeLocal.js');

test('dataBaseDir 指向别处时，凭据/配置都按挪盘后的根目录解析', () => {
  fs.writeFileSync(path.join(home, '.zcode', 'v2', 'setting.json'), JSON.stringify({ dataBaseDir: moved }));
  const p = zcodePaths();
  assert.equal(p.credentials, path.join(moved, '.zcode', 'v2', 'credentials.json'));
  assert.equal(JSON.parse(fs.readFileSync(p.credentials, 'utf8')).marker, 'LIVE', '不能读到 home 下的陈旧副本');
  assert.equal(p.config, path.join(moved, '.zcode', 'v2', 'config.json'));
  assert.equal(p.telemetry, path.join(moved, '.zcode', 'v2', 'telemetry-state.json'));
  // 引导信息本身仍在 home 下
  assert.equal(p.setting, path.join(home, '.zcode', 'v2', 'setting.json'));
  assert.equal(p.home, home, '加密密钥仍按 home 派生，不随数据目录挪动');
});

test('没有 dataBaseDir（或值不是绝对路径）时回落到 home，行为与改动前一致', () => {
  for (const v of [undefined, '', '   ', 'relative/path', 42]) {
    fs.writeFileSync(path.join(home, '.zcode', 'v2', 'setting.json'), JSON.stringify(v === undefined ? {} : { dataBaseDir: v }));
    assert.equal(zcodePaths().credentials, path.join(home, '.zcode', 'v2', 'credentials.json'), `dataBaseDir=${JSON.stringify(v)} 应回落 home`);
  }
  fs.rmSync(path.join(home, '.zcode', 'v2', 'setting.json'));
  assert.equal(zcodePaths().credentials, path.join(home, '.zcode', 'v2', 'credentials.json'), 'setting.json 缺失也应回落');
  assert.equal(detectZcode().exists, true, '回落后仍能读到 home 下的凭据');
});
