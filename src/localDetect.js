/**
 * 本机 Qoder 检测 — 安装探测 + 凭据扫描。
 *
 * Qoder IDE 是 VS Code 系（Electron），凭据散落在 userData 目录；
 * 另扫 ~/.qoder（CLI）。扫描纯本地进行，候选 token 只保留在内存，
 * 面板按 candidateId 导入，token 不在日志中输出。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// 候选内存表：candidateId → { token, providerGuess, file, at }（10 分钟过期）
const candidates = new Map();
const CAND_TTL_MS = 10 * 60 * 1000;

const TOKEN_RE = /\b(?:dt|pt)-[A-Za-z0-9_-]{16,}\b/g;

/** 纯函数：提取文本中的 Qoder token（去重）——供测试 */
export function extractTokens(text) {
  const found = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(String(text))) !== null) found.add(m[0]);
  return [...found];
}

function mask(token) {
  return token.slice(0, 5) + '...' + token.slice(-4);
}

function isWindows() { return process.platform === 'win32'; }
function isMac() { return process.platform === 'darwin'; }

/** 安装探测：IDE 可执行文件 + CLI */
export function detectInstalls() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

  const idePaths = isMac()
    ? ['/Applications/Qoder.app']
    : isWindows()
      ? [
          path.join(localAppData, 'Programs', 'Qoder', 'Qoder.exe'),
          path.join(programFiles, 'Qoder', 'Qoder.exe'),
        ]
      : ['/usr/bin/qoder', '/opt/Qoder/qoder', '/usr/share/qoder/qoder'];

  const ideDataDirs = isMac()
    ? [path.join(home, 'Library', 'Application Support', 'Qoder')]
    : isWindows()
      ? [path.join(appdata, 'Qoder')]
      : [path.join(home, '.config', 'Qoder')];

  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

  return {
    platform: process.platform,
    ide: idePaths.map((p) => ({ path: p, exists: exists(p) })),
    ideDataDirs: ideDataDirs.map((p) => ({ path: p, exists: exists(p) })),
    cliDir: { path: path.join(home, '.qoder'), exists: exists(path.join(home, '.qoder')) },
    installed: idePaths.some((p) => exists(p)),
  };
}

// 扫描时跳过的目录（缓存/噪音）
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'Cache', 'CachedData', 'CacheStorage', 'Code Cache',
  'GPUCache', 'logs', 'Crashes', 'crashpad', 'blob_storage', 'Service Worker',
  'History', 'DawnGraphiteCache', 'DawnWebGPUCache', 'SharedDictionary',
  'index', 'tmp', 'temp', 'workspaceStorage',
]);

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_MS = 6000;

/** 扫描目录集合，产出候选 token（含少量上下文以辅助辨认） */
export async function scanLocalTokens(dirs) {
  const deadline = Date.now() + MAX_MS;
  const found = new Map(); // token → { file, count }
  let scanned = 0;

  async function walk(dir, depth) {
    if (depth > 5 || scanned >= MAX_FILES || Date.now() > deadline) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (scanned >= MAX_FILES || Date.now() > deadline) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(p, depth + 1);
        continue;
      }
      let st;
      try { st = await fsp.stat(p); } catch { continue; }
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      scanned++;
      let text;
      try { text = await fsp.readFile(p, 'utf8'); } catch { continue; }
      for (const token of extractTokens(text)) {
        const prev = found.get(token);
        if (prev) prev.count++;
        else found.set(token, { file: p, count: 1 });
      }
    }
  }

  for (const d of dirs) {
    try { if (fs.existsSync(d) && fs.statSync(d).isDirectory()) await walk(d, 0); } catch {}
  }

  // 入库候选表（带 TTL）
  const now = Date.now();
  for (const [k, v] of candidates) if (v.at < now - CAND_TTL_MS) candidates.delete(k);

  const list = [];
  for (const [token, meta] of found) {
    const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    candidates.set(id, { token, file: meta.file, at: now });
    list.push({
      id,
      tokenMasked: mask(token),
      kind: token.startsWith('pt-') ? 'PAT' : 'device',
      file: meta.file,
      hits: meta.count,
    });
  }
  list.sort((a, b) => b.hits - a.hits);
  return { scanned, candidates: list.slice(0, 50) };
}

/** 按 candidateId 取回完整 token（导入用） */
export function takeCandidate(id) {
  const c = candidates.get(id);
  if (!c) return null;
  if (c.at < Date.now() - CAND_TTL_MS) { candidates.delete(id); return null; }
  return c.token;
}
