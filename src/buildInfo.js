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
