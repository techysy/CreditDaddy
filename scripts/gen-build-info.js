#!/usr/bin/env node
/**
 * 生成 build.json/x 构建身份文件（#21）
 *
 * 用法:node scripts/gen-build-info.js <输出路径>
 *   - CI:环境变量 GITHUB_SHA / GITHUB_REF_NAME 优先,channel=release(仅当 tag 触发)
 *   - 本地:git rev-parse 兜底,channel=local;工作区有未提交改动时标 dirty:true
 *
 * 每个发布产物（桌面 exe/dmg、npm 包、fnOS fpk）都应在打包前调用一次并随包;
 * /api/status 与更新平局裁决只读它,缺文件 = 老行为(不暴露、不误报)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) { console.error('usage: node scripts/gen-build-info.js <outfile>'); process.exit(1); }

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

const isTagRun = Boolean(process.env.GITHUB_REF_NAME && /^v\d/.test(process.env.GITHUB_REF_NAME));
const info = {
  version,
  commit: process.env.GITHUB_SHA ? String(process.env.GITHUB_SHA).slice(0, 7) : git('rev-parse', '--short=7', 'HEAD'),
  branch: process.env.GITHUB_REF_NAME || git('branch', '--show-current') || 'HEAD',
  builtAt: new Date().toISOString(),
  channel: isTagRun ? 'release' : 'local',
};
if (!process.env.GITHUB_SHA) info.dirty = Boolean(git('status', '--porcelain'));

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log(`build info → ${out}:`, JSON.stringify(info));
