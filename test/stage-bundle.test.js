import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * 打包暂存门禁测试（1.8.4-test.25「暂无公告」事故防复发）：
 * 事故链 = 本地按 runbook 手敲的暂存命令漏拷 announcements.json（CI 的命令有它），
 * 随包兜底整份丢失 → 在线源又因未 push 全 404 → 面板拿到空列表还覆盖了 localStorage 缓存。
 * 这里锁住四件事：暂存清单与 CI 一致、公告兜底缺失/非法必定报错、漏重暂存能抓到、
 * 真暂存能产出合法目录。暂存一律写到临时目录，不碰仓库里的 desktop/server/。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 CI 的 `cp -r <源...> <目标目录>/` 里取出源清单（末项是落地目录，不算源） */
const cpSources = (yml) => {
  const hits = [...yml.matchAll(/^\s*cp -r (.+)$/gm)].map((m) =>
    m[1].trim().split(/\s+/).filter((x) => x && !x.startsWith('#')).slice(0, -1));
  return hits[hits.length - 1];
};
const { TARGETS, checkStaged, inspectAnnouncements, stageBundle, gate } = await import('../scripts/stage-bundle.js');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'cd-stage-'));

test('暂存清单与 CI 的 Stage 步骤一致（防止本地/CI 两套拷贝清单再次漂移）', async () => {
  const readCp = async (f) => cpSources(await fsp.readFile(path.join(ROOT, '.github', 'workflows', f), 'utf8'));
  const desktop = await readCp('build-desktop-win.yml');
  const fnos = await readCp('build-fpk.yml');
  assert.ok(desktop, 'build-desktop-win.yml 未找到 cp -r 暂存步骤，脚本与本测试需同步更新');
  assert.ok(fnos, 'build-fpk.yml 未找到 cp -r 暂存步骤，脚本与本测试需同步更新');

  assert.deepEqual([...TARGETS.desktop.entries].sort(), [...desktop].sort(), 'desktop 暂存清单与 CI 不一致');
  assert.deepEqual([...TARGETS.fnos.entries].sort(), [...fnos].sort(), 'fnos 暂存清单与 CI 不一致');

  // 事故主角必须在两边清单里
  assert.ok(TARGETS.desktop.entries.includes('announcements.json'));
  assert.ok(TARGETS.fnos.entries.includes('announcements.json'));
});

test('inspectAnnouncements：合法/缺文件/坏 JSON/items 空数组/条目缺字段都能识别', async () => {
  const ok = inspectAnnouncements(path.join(ROOT, 'announcements.json'));
  assert.equal(ok.ok, true);
  assert.ok(ok.count >= 3, '随包兜底公告应至少 3 条');

  const dir = await tmp();
  try {
    assert.match(inspectAnnouncements(path.join(dir, 'nope.json')).reason, /不存在/);

    const badJson = path.join(dir, 'bad.json');
    await fsp.writeFile(badJson, '{ this is not json');
    assert.match(inspectAnnouncements(badJson).reason, /JSON 解析失败/);

    const emptyItems = path.join(dir, 'empty.json');
    await fsp.writeFile(emptyItems, JSON.stringify({ items: [] }));
    assert.match(inspectAnnouncements(emptyItems).reason, /items 为空/);

    const noItems = path.join(dir, 'noitems.json');
    await fsp.writeFile(noItems, JSON.stringify({ updatedAt: '2026-11-25' }));
    assert.match(inspectAnnouncements(noItems).reason, /缺少 items 数组/);

    const brokenItem = path.join(dir, 'broken-item.json');
    await fsp.writeFile(brokenItem, JSON.stringify({ items: [{ title: '没有 id' }] }));
    assert.match(inspectAnnouncements(brokenItem).reason, /缺 id\/title/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('stageBundle → checkStaged：产物合法；漏拷 announcements.json 必报错（复现 test.25 包内状态）', async () => {
  const dir = await tmp();
  const dest = path.join(dir, 'server');
  try {
    const r = stageBundle('desktop', { dest });
    assert.ok(r.announcements >= 3);
    assert.ok(fs.existsSync(path.join(dest, 'announcements.json')), '暂存目录必须带 announcements.json');
    const staged = JSON.parse(fs.readFileSync(path.join(dest, 'announcements.json'), 'utf8'));
    assert.equal(staged.items.length, r.announcements);
    assert.ok(fs.existsSync(path.join(dest, 'build.json')), '暂存应生成构建身份 build.json');
    assert.equal(checkStaged('desktop', { dest }).ok, true, checkStaged('desktop', { dest }).problems.join(' | '));

    // 把兜底删掉 = test.25 的包内状态 → 必须报错并指名 announcements.json
    await fsp.rm(path.join(dest, 'announcements.json'));
    const miss = checkStaged('desktop', { dest });
    assert.equal(miss.ok, false);
    assert.ok(miss.problems.some((p) => /暂存缺 announcements\.json/.test(p)), miss.problems.join(' | '));
    assert.ok(miss.problems.some((p) => /announcements\.json 不可用/.test(p)), miss.problems.join(' | '));
    assert.equal(gate({ dests: { desktop: dest } }).ok, false, 'gate 也必须拦住暂存缺兜底');

    // 补回后应通过；再模拟「改了源码没重暂存」与「上轮残留文件」
    await fsp.copyFile(path.join(ROOT, 'announcements.json'), path.join(dest, 'announcements.json'));
    assert.equal(checkStaged('desktop', { dest }).ok, true);
    await fsp.writeFile(path.join(dest, 'src', 'daemon.js'), '// stale copy\n');
    assert.ok(checkStaged('desktop', { dest }).problems.some((p) => /与源树不一致/.test(p)));
    await fsp.writeFile(path.join(dest, 'src', 'ghostModule.js'), 'export const g = 1;\n');
    assert.ok(checkStaged('desktop', { dest }).problems.some((p) => /残留/.test(p)));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('源树 announcements.json 非法（缺文件/空 items）时：拒绝暂存且 gate 失败', async () => {
  const dir = await tmp();
  // 造一个假的“源树”：只放必要文件，把 announcements.json 写成空 items
  const srcRoot = path.join(dir, 'src-root');
  const dest = path.join(dir, 'server');
  try {
    await fsp.mkdir(srcRoot, { recursive: true });
    await fsp.cp(path.join(ROOT, 'bin'), path.join(srcRoot, 'bin'), { recursive: true });
    await fsp.cp(path.join(ROOT, 'src'), path.join(srcRoot, 'src'), { recursive: true });
    for (const f of ['package.json', 'README.md', 'CHANGELOG.md']) {
      await fsp.copyFile(path.join(ROOT, f), path.join(srcRoot, f));
    }
    await fsp.writeFile(path.join(srcRoot, 'announcements.json'), JSON.stringify({ items: [] }));

    assert.throws(() => stageBundle('desktop', { dest, srcRoot }), /announcements\.json 不可用/);
    assert.equal(fs.existsSync(dest), false, '非法源树不应产出暂存目录');

    const g = gate({ srcRoot });
    assert.equal(g.ok, false, '源树公告为空时 gate 必须失败');
    assert.ok(g.lines.some((l) => /源树 announcements\.json 不可用/.test(l)), g.lines.join(' | '));

    // 源树整份缺文件同样要拦住
    await fsp.rm(path.join(srcRoot, 'announcements.json'));
    assert.throws(() => stageBundle('desktop', { dest, srcRoot }), /文件不存在/);
    assert.equal(gate({ srcRoot }).ok, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('checkStaged：暂存目录不存在时给出可执行提示', async () => {
  const dir = await tmp();
  try {
    const r = checkStaged('desktop', { dest: path.join(dir, 'never-staged') });
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /不存在/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

