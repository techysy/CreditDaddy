/**
 * Qoder 设备身份组件 —— 给没有 Qoder 客户端的 Linux（fnOS / NAS）提供国际版签到所需的风控身份。
 *
 * Qoder 国际版只向带 Cosy-MachineToken / Code / Type 的请求下发「每天领 100 Credits」，
 * 这三个值由 Qoder 的 UMID 程序（runtime-info）生成。桌面端客户端自带它；官方 CLI
 * @qoder-ai/qodercli 则把各平台的 UMID 二进制以 base64 内嵌在 bundle/qodercli.js 里，Linux x64 / arm64 都有。
 *
 * 这里在用户确认后从 npm 仓库下载官方 qodercli 包（校验 npm 的 sha512 integrity），
 * 按本机 CPU 架构取出对应的 ELF，试跑一次确认能产出身份，再存到 ~/.creditdaddy/qoder-umid/。
 * 不随 CreditDaddy 分发该二进制；调用方式与 qodercli 一致：runtime-info <env>，第一行输出 JSON。
 * env：国际版 4（SINGAPORE，qodercli 的全球区取值），国内版 0（ONLINE）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { dataDir } from './store.js';
import { logger } from './logger.js';

const PKG = '@qoder-ai/qodercli';
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
const ELF_MACHINE = { x64: 62, arm64: 183 };
const BUNDLE_ENTRY = 'package/bundle/qodercli.js';
const FETCH_TIMEOUT_MS = 180_000;
export const CLI_RISK_ENV = { qoder: 4, 'qoder-cn': 0 };

export function umidSupported(platform = process.platform, arch = process.arch) {
  return platform === 'linux' && Boolean(ELF_MACHINE[arch]);
}

const dir = () => path.join(dataDir(), 'qoder-umid');
const binPath = () => path.join(dir(), 'runtime-info');
const manifestPath = () => path.join(dir(), 'manifest.json');

/** 已安装的组件：{ path, version, arch, sha256, installedAt, registry }；未安装返回 null */
export function installedUmid() {
  if (!umidSupported()) return null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    if (!fs.existsSync(binPath()) || m.arch !== process.arch) return null;
    return { ...m, path: binPath() };
  } catch { return null; }
}

// ── 纯函数（便于单测） ──

/** 最小 tar 解析：按名字取一个普通文件的内容 */
export function tarEntry(tar, wanted) {
  let off = 0;
  const cstr = (b, s, n) => { const x = b.subarray(s, s + n); const z = x.indexOf(0); return x.subarray(0, z < 0 ? n : z).toString('utf8'); };
  let longName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h, 345, 155);
    let name = longName || (prefix ? prefix + '/' : '') + cstr(h, 0, 100);
    longName = null;
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') {   // pax 扩展头里的 path 覆盖下一个条目的名字
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if ((type === '0' || type === '\0') && name === wanted) return body;
  }
  return null;
}

/** 在 qodercli bundle 文本里找内嵌的 ELF（base64 字面量），按 e_machine 挑出本机架构 */
export function extractElf(jsText, machine) {
  const MARK = '"f0VMRgIB';   // "\x7fELF" + 64 位 + 小端 的 base64 开头
  let i = jsText.indexOf(MARK);
  while (i >= 0) {
    const start = i + 1;
    const end = jsText.indexOf('"', start);
    if (end < 0) break;
    const head = Buffer.from(jsText.slice(start, start + 28), 'base64');
    if (head.length >= 20 && head.readUInt16LE(18) === machine) {
      return Buffer.from(jsText.slice(start, end), 'base64');
    }
    i = jsText.indexOf(MARK, end);
  }
  return null;
}

/** npm integrity（sha512-<base64>）校验 */
export function checkIntegrity(buf, integrity) {
  const m = /^sha512-(.+)$/.exec(String(integrity || '').split(/\s+/)[0]);
  if (!m) return false;
  return crypto.createHash('sha512').update(buf).digest('base64') === m[1];
}

// ── 安装 ──

async function fetchBuf(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function testRun(file) {
  return new Promise((resolve, reject) => {
    execFile(file, [String(CLI_RISK_ENV.qoder)], { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout).split('\n')[0]);
        if (typeof j.machineToken === 'string' && j.machineToken && j.machineCode && j.machineType) return resolve(j);
      } catch {}
      reject(new Error('组件试运行失败' + (err ? '：' + err.message : '（输出里没有设备身份）')));
    });
  });
}

let installing = null;

/** 下载官方 qodercli 包并提取本机架构的 UMID；并发调用共用同一次安装 */
export function installUmid() {
  if (!installing) installing = doInstall().finally(() => { installing = null; });
  return installing;
}
export const umidInstalling = () => Boolean(installing);

async function doInstall() {
  if (!umidSupported()) throw new Error(`当前平台（${process.platform}/${process.arch}）不需要或不支持该组件`);
  const errors = [];
  for (const registry of REGISTRIES) {
    try {
      const meta = JSON.parse((await fetchBuf(`${registry}/${PKG.replace('/', '%2f')}/latest`)).toString('utf8'));
      const { tarball, integrity } = meta.dist || {};
      if (!tarball || !integrity) throw new Error('包元数据缺少 tarball / integrity');
      logger.info('UMID', `下载 ${PKG}@${meta.version}（${registry}）`);
      const tgz = await fetchBuf(tarball);
      if (!checkIntegrity(tgz, integrity)) throw new Error('下载内容与 npm integrity 不一致');
      const bundle = tarEntry(zlib.gunzipSync(tgz), BUNDLE_ENTRY);
      if (!bundle) throw new Error(`包里没有 ${BUNDLE_ENTRY}（qodercli 结构可能变化）`);
      const elf = extractElf(bundle.toString('latin1'), ELF_MACHINE[process.arch]);
      if (!elf) throw new Error(`qodercli ${meta.version} 里没有 ${process.arch} 的 UMID 程序（结构可能变化）`);

      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
      const tmp = binPath() + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, elf, { mode: 0o755 });
      try { await testRun(tmp); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      fs.renameSync(tmp, binPath());
      const manifest = {
        version: meta.version, arch: process.arch, registry,
        sha256: crypto.createHash('sha256').update(elf).digest('hex'),
        installedAt: new Date().toISOString(),
      };
      fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      logger.info('UMID', `设备身份组件已安装：qodercli ${meta.version} / ${process.arch}`);
      return { ...manifest, path: binPath() };
    } catch (e) {
      errors.push(`${registry}：${e.message}`);
      logger.warn('UMID', `从 ${registry} 安装失败：${e.message}`);
    }
  }
  throw new Error('设备身份组件安装失败 —— ' + errors.join('；'));
}

export function removeUmid() {
  fs.rmSync(dir(), { recursive: true, force: true });
}

/** 面板 / 状态接口用的摘要 */
export function umidInfo() {
  const m = installedUmid();
  return {
    supported: umidSupported(),
    installing: umidInstalling(),
    installed: m ? { version: m.version, arch: m.arch, installedAt: m.installedAt } : null,
  };
}
