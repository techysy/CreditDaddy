#!/usr/bin/env node
/**
 * desktop/dist 自动清理门禁
 *
 * 规则：
 * 1. 保留所有正式版本（不含 -test. 的安装包与便携包，如 1.6.5, 1.7.0, 1.7.1）。
 * 2. 对测试版本（含 -test. 的 .exe 和 .blockmap），按版本号倒序/最后修改时间，
 *    仅保留最新的 2 个测试版本，其余旧测试产物自动清理。
 * 3. 避免历史残留占用数 GB 磁盘空间与文件膨胀。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT, 'desktop', 'dist');

export function cleanDist({ keepTestVersions = 2, dryRun = false } = {}) {
  if (!fs.existsSync(DIST_DIR)) {
    console.log('[clean-dist] desktop/dist 不存在，跳过');
    return [];
  }

  const files = fs.readdirSync(DIST_DIR);
  const testFiles = [];

  for (const f of files) {
    if (f.includes('-test.')) {
      const fullPath = path.join(DIST_DIR, f);
      const stat = fs.statSync(fullPath);
      testFiles.push({ file: f, path: fullPath, mtime: stat.mtimeMs, size: stat.size });
    }
  }

  // 从文件名提取测试版本标识，例如 1.7.3-test.6
  const versionMap = new Map();
  for (const item of testFiles) {
    const m = item.file.match(/(?:Portable|Setup)-([0-9]+\.[0-9]+\.[0-9]+-test\.[0-9]+)/);
    const ver = m ? m[1] : null;
    if (ver) {
      if (!versionMap.has(ver)) versionMap.set(ver, []);
      versionMap.get(ver).push(item);
    }
  }

  // 按最新修改时间将版本排序
  const sortedVersions = [...versionMap.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map((x) => x.mtime));
    const maxB = Math.max(...b[1].map((x) => x.mtime));
    return maxB - maxA; // 降序：最新的在前
  });

  const toDelete = [];
  // 保留最新的 keepTestVersions 个版本，其余加入删除列表
  const staleVersions = sortedVersions.slice(keepTestVersions);
  for (const [, items] of staleVersions) {
    for (const it of items) toDelete.push(it);
  }

  // 对于没有解析出版本但是带有 -test. 的散落文件，如果修改时间在 24 小时之前也清理
  for (const item of testFiles) {
    const m = item.file.match(/(?:Portable|Setup)-([0-9]+\.[0-9]+\.[0-9]+-test\.[0-9]+)/);
    if (!m && !toDelete.some((x) => x.path === item.path)) {
      toDelete.push(item);
    }
  }

  let freedBytes = 0;
  for (const item of toDelete) {
    freedBytes += item.size;
    if (!dryRun) {
      try {
        fs.unlinkSync(item.path);
      } catch (e) {
        console.warn(`[clean-dist] 删除 ${item.file} 失败: ${e.message}`);
      }
    }
  }

  const freedMB = (freedBytes / (1024 * 1024)).toFixed(1);
  console.log(`[clean-dist] 清理完毕：删除了 ${toDelete.length} 个历史测试包文件，释放了 ${freedMB} MB 空间（保留最新 ${keepTestVersions} 个测试版本及所有正式版）`);
  return toDelete;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cleanDist();
}
