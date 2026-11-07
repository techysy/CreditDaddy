/** 构建身份（#21）:读随包 build.json 与「同版本新构建」平局裁决。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读包根的 build.json(scripts/gen-build-info.js 生成)。文件不存在 / 损坏 → null,
 * 调用方一律按「无构建身份」回退(不展示、不参与更新判定)。
 */
export function loadBuildInfo(baseDir) {
  const root = baseDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const b = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
    if (!b || typeof b.commit !== 'string') return null;
    return b;
  } catch { return null; }
}

/**
 * semver 相等时的平局裁决:线上是「同版本但更新的构建」吗?
 * 仅在双侧都有构建身份、commit 不同、builtAt 更晚,且本机是 release 渠道时成立;
 * 本地 dev / dirty / 缺元数据一律 false(永不误报「你有旧版」)。
 */
export function isNewerRebuild(installed, released) {
  if (!installed || !released) return false;
  if (installed.channel !== 'release') return false;
  if (!installed.commit || !released.commit || installed.commit === released.commit) return false;
  const tNew = Date.parse(released.builtAt || '');
  const tOld = Date.parse(installed.builtAt || '');
  return Number.isFinite(tNew) && Number.isFinite(tOld) && tNew > tOld;
}

/**
 * 版本号比较(semver 口径):主 / 次 / 补丁逐段比较,其次预发布——**预发布 < 正式版**
 * (1.7.1-test.4 < 1.7.1),预发布标识符逐个比、纯数字按数值(test.2 < test.10)。
 * 旧实现 parseInt('1-test')===1 把预发布段整段丢掉,测试包被当成同号正式版,
 * 「检查更新」永远说已是最新,测试包用户升不上同号正式版(1.7.1-test.4 → 1.7.1 用户实测)。
 * 解析不了的一律 false:宁可不报新版本,不误报。
 */
export function isNewerVersion(next, cur) {
  const parse = (s) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(s ?? '').trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? null : m[4].split('.') } : null;
  };
  const a = parse(next);
  const b = parse(cur);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  if (!a.pre && !b.pre) return false;   // 同号正式版
  if (!a.pre) return true;              // next 是正式版、cur 是预发布 → 新
  if (!b.pre) return false;             // next 是预发布、cur 是正式版 → 不更新(预发布 < 正式版)
  for (let i = 0; i < a.pre.length || i < b.pre.length; i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return false;  // 前缀相同,短的一方更小(semver: alpha < alpha.1)
    if (y === undefined) return true;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) > Number(y); }
    else if (nx !== ny) return nx;      // semver:数字标识符 < 字母标识符
    else if (x !== y) return x > y;
  }
  return false;
}
