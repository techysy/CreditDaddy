#!/usr/bin/env node
/**
 * 打包暂存（单一事实来源）——把服务端源码树拷进桌面壳 / fnOS 包的暂存目录。
 *
 * 为什么要有这个脚本：1.8.4-test.25 安装包公告弹窗「暂无公告」事故（2026-11-25）——
 * CI 的 "Stage app bundle" 步骤带 announcements.json，而本地按 docs runbook 手敲的暂存
 * 命令漏了它，随包兜底公告整份丢失（在线源又因未 push 全 404），面板拿到空列表还把
 * localStorage 缓存覆盖掉，用户侧直接看不到任何公告。
 * 本地与 CI 从此共用本脚本，拷贝清单只维护这一份。
 *
 * 用法：
 *   node scripts/stage-bundle.js desktop                 → desktop/server/（extraResources → resources/creditdaddy/）
 *   node scripts/stage-bundle.js fnos                    → fnos-packaging/app/server/
 *   node scripts/stage-bundle.js desktop --dest <dir>    暂存到指定目录（测试用）
 *   node scripts/stage-bundle.js --check [desktop|fnos]  只校验不写（默认两个都查）
 *   node scripts/stage-bundle.js gate                    发版门禁：源 + 暂存 + 打包产物三层校验
 *
 * 校验规则：暂存目录必须含合法 announcements.json（items 非空数组），清单文件齐备，
 * 且与源树逐字节一致（既抓漏拷，也抓「改了源码忘了重暂存」和「上轮残留没清干净」）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 暂存目标：默认目录 + 拷贝清单（与 .github/workflows 的 Stage 步骤一一对应，由测试锁定） */
export const TARGETS = {
  desktop: {
    dest: path.join(ROOT, 'desktop', 'server'),
    entries: ['bin', 'src', 'package.json', 'announcements.json', 'README.md', 'CHANGELOG.md'],
    optional: ['CHANGELOG.en.md', 'CHANGELOG.ja.md', 'CHANGELOG.ko.md'],
  },
  fnos: {
    dest: path.join(ROOT, 'fnos-packaging', 'app', 'server'),
    entries: ['bin', 'src', 'package.json', 'announcements.json', 'README.md'],
    optional: [],
  },
};

const readIf = (p) => { try { return fs.readFileSync(p); } catch { return null; } };

/** 递归收集目录内文件，返回相对该目录的路径；跳过运行期残留的 .tmp-* 目录 */
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory() && /^\.tmp-/.test(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs).map((f) => path.join(ent.name, f)));
    else out.push(ent.name);
  }
  return out;
}

function copyEntry(srcAbs, dstAbs) {
  if (fs.statSync(srcAbs).isDirectory()) {
    for (const rel of walk(srcAbs)) {
      const to = path.join(dstAbs, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(srcAbs, rel), to);
    }
  } else {
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.copyFileSync(srcAbs, dstAbs);
  }
}

/**
 * 公告随包兜底合法性：文件存在、JSON 可解析、items 是非空数组且条目字段齐。
 * 空 items 视为不合法——打包时公告正文为空等于没有兜底。
 */
export function inspectAnnouncements(file) {
  const buf = readIf(file);
  if (buf === null) return { ok: false, reason: `文件不存在: ${file}` };
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { return { ok: false, reason: `JSON 解析失败: ${e.message}` }; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return { ok: false, reason: '缺少 items 数组' };
  if (parsed.items.length === 0) return { ok: false, reason: 'items 为空（随包兜底等于没有）' };
  if (!parsed.items.every((it) => it && typeof it.id === 'string' && it.id && typeof it.title === 'string' && it.title)) {
    return { ok: false, reason: '存在缺 id/title 的公告条目' };
  }
  return { ok: true, count: parsed.items.length };
}

/** 源树 announcements.json 是门禁基准 */
export function checkSourceAnnouncements(srcRoot = ROOT) {
  return inspectAnnouncements(path.join(srcRoot, 'announcements.json'));
}

/** 校验暂存目录：清单齐备 + 与源树内容一致 */
export function checkStaged(target, { dest, srcRoot = ROOT } = {}) {
  const cfg = TARGETS[target];
  if (!cfg) return { ok: false, problems: [`未知暂存目标: ${target}`] };
  const dir = dest || cfg.dest;
  const relDir = path.relative(ROOT, dir) || dir;
  const problems = [];
  if (!fs.existsSync(dir)) {
    return { ok: false, problems: [`${relDir} 不存在（打桌面包前必须先暂存）`] };
  }
  for (const entry of [...cfg.entries, ...cfg.optional]) {
    const srcAbs = path.join(srcRoot, entry);
    if (!fs.existsSync(srcAbs)) {
      if (cfg.optional.includes(entry)) continue;
      problems.push(`源树缺少 ${entry}`);
      continue;
    }
    const dstAbs = path.join(dir, entry);
    if (!fs.existsSync(dstAbs)) { problems.push(`暂存缺 ${entry}`); continue; }
    if (fs.statSync(srcAbs).isDirectory()) {
      const srcFiles = walk(srcAbs).sort();
      const dstFiles = walk(dstAbs).sort();
      const missing = srcFiles.filter((f) => !dstFiles.includes(f));
      const extra = dstFiles.filter((f) => !srcFiles.includes(f));
      const stale = dstFiles.filter((f) => {
        const a = readIf(path.join(srcAbs, f));
        const b = readIf(path.join(dstAbs, f));
        return a !== null && b !== null && !a.equals(b);
      });
      if (missing.length) problems.push(`${entry}/ 缺 ${missing.length} 个文件，例如 ${missing[0]}`);
      if (extra.length) problems.push(`${entry}/ 有 ${extra.length} 个源树已不存在的残留（上轮暂存没清干净），例如 ${extra[0]}`);
      if (stale.length) problems.push(`${entry}/ 有 ${stale.length} 个文件与源树不一致（改了源码未重暂存），例如 ${stale[0]}`);
    } else {
      const a = readIf(srcAbs), b = readIf(dstAbs);
      if (a && b && !a.equals(b)) problems.push(`${entry} 与源树内容不一致`);
    }
  }
  const ann = inspectAnnouncements(path.join(dir, 'announcements.json'));
  if (!ann.ok) problems.push(`announcements.json 不可用：${ann.reason}`);
  if (!fs.existsSync(path.join(dir, 'build.json'))) problems.push('缺 build.json（构建身份，暂存时应生成）');
  return { ok: problems.length === 0, problems, dir };
}

/** 执行暂存：先删后拷（避免源码已删/改名的文件残留在包里），随后生成 build.json 并自检 */
export function stageBundle(target, { dest, srcRoot = ROOT } = {}) {
  const cfg = TARGETS[target];
  if (!cfg) throw new Error(`未知暂存目标: ${target}`);
  const srcCheck = checkSourceAnnouncements(srcRoot);
  if (!srcCheck.ok) throw new Error(`源树 announcements.json 不可用：${srcCheck.reason}`);

  const dir = dest || cfg.dest;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const entry of [...cfg.entries, ...cfg.optional]) {
    const srcAbs = path.join(srcRoot, entry);
    if (!fs.existsSync(srcAbs)) {
      if (cfg.optional.includes(entry)) continue;
      throw new Error(`源树缺少 ${entry}`);
    }
    copyEntry(srcAbs, path.join(dir, entry));
    copied++;
  }

  // 构建身份写进暂存目录，随包给 /api/status.build 与「同版本新构建」判定使用
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-build-info.js'), path.join(dir, 'build.json')], { cwd: ROOT, stdio: 'pipe' });

  const verify = checkStaged(target, { dest: dir, srcRoot });
  if (!verify.ok) throw new Error(`暂存后自检失败：\n  ${verify.problems.join('\n  ')}`);
  console.log(`[stage-bundle] ${target} → ${path.relative(ROOT, dir)}/：${copied} 项，公告兜底 ${srcCheck.count} 条`);
  return { copied, announcements: srcCheck.count, dest: dir };
}

/**
 * 发版门禁（release-check.sh 调用）：源 → 各暂存目录 → 桌面构建产物三层都查。
 * 暂存目录 / win-unpacked 不存在时按「尚未打包」跳过对应层，源树必须合法。
 */
export function gate({ dests = {}, srcRoot = ROOT } = {}) {
  const lines = [];
  let failed = false;
  const fail = (msg) => { lines.push(`✗ ${msg}`); failed = true; };

  const src = checkSourceAnnouncements(srcRoot);
  if (!src.ok) fail(`源树 announcements.json 不可用：${src.reason}`);
  else lines.push(`✓ 源树 announcements.json：${src.count} 条`);

  for (const target of Object.keys(TARGETS)) {
    const dir = dests[target] || TARGETS[target].dest;
    if (!fs.existsSync(dir)) { lines.push(`ℹ ${target} 暂存目录不存在，跳过（打包时由本脚本生成）`); continue; }
    const r = checkStaged(target, { dest: dir, srcRoot });
    if (!r.ok) fail(`${target} 暂存目录：${r.problems.join('；')}`);
    else lines.push(`✓ ${target} 暂存目录与源树一致，含 announcements.json 兜底`);
  }

  const unpackedDir = path.join(ROOT, 'desktop', 'dist', 'win-unpacked', 'resources', 'creditdaddy');
  const unpacked = path.join(unpackedDir, 'announcements.json');
  if (fs.existsSync(unpacked)) {
    const a = inspectAnnouncements(unpacked);
    if (!a.ok) fail(`打包产物 announcements.json 不可用：${a.reason}`);
    else lines.push(`✓ 打包产物 resources/creditdaddy/announcements.json：${a.count} 条`);
  } else if (fs.existsSync(unpackedDir)) {
    fail('desktop/dist/win-unpacked/resources/creditdaddy/ 里没有 announcements.json（随包兜底丢失）');
  } else {
    lines.push('ℹ 未见 desktop/dist 构建产物，跳过产物层校验');
  }

  return { ok: !failed, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flagOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--dest');
  const target = positional[0];

  if (target === 'gate' || (positional.length === 0 && args.includes('--check'))) {
    const g = gate();
    g.lines.forEach((l) => console.log(`[stage-bundle] ${l}`));
    process.exit(g.ok ? 0 : 1);
  }
  if (!TARGETS[target]) {
    console.error('usage: node scripts/stage-bundle.js <desktop|fnos|gate|--check> [--dest <dir>]');
    process.exit(2);
  }
  const dest = flagOf('--dest');
  try {
    if (args.includes('--check')) {
      const r = checkStaged(target, { dest });
      if (!r.ok) { console.error(`[stage-bundle] ${target} 暂存校验失败：`); r.problems.forEach((p) => console.error('  ✗ ' + p)); process.exit(1); }
      console.log(`[stage-bundle] ${target} 暂存校验通过（含 announcements.json 兜底）`);
    } else {
      stageBundle(target, { dest });
    }
  } catch (e) {
    console.error(`[stage-bundle] ${e.message}`);
    process.exit(1);
  }
}
