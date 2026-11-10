/**
 * 本机 WorkBuddy 客户端凭据 — 读取已登录账号、切换当前账号。
 *
 * WorkBuddy（与 CodeBuddy CLI / 插件共用）把会话存成明文 JSON：
 *   Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<认证ID>.info
 *   macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/
 *   Linux:   ~/.local/share/CodeBuddyExtension/Data/Public/auth/
 * 当前会话是 workbuddy-desktop.info（国际版客户端可能用其他认证 ID），带时间戳的同名文件是客户端留下的历史会话。
 * 文件结构：{ account: { uid, nickname, phoneNumber, enterpriseId… }, auth: { accessToken, refreshToken, expiresAt, domain… }, accounts: [...] }
 *
 * 切换账号：原子写入会话文件 + 删除同目录的 "<文件>.logged-out" 登出标记；
 * WorkBuddy 监听该文件，外部改动会被直接应用（客户端日志 "External change applied to session"）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { inspectToken } from './workbuddyClient.js';

// ===================== WorkBuddy 5.6+ $wbEncrypted 信封加解密 =====================

export function isWbEncrypted(val) {
  return !!val && typeof val === 'object' && !Array.isArray(val) && val.$wbEncrypted === 1 && typeof val.envelope === 'string';
}

export function buildEnvelopeAAD(env) {
  const FRAMING_FIELD = 2, FMT_FIELD = 'WBEV1', AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
  const lp = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([
    AAD_DOMAIN, Buffer.from([1]), lp(FMT_FIELD), lp('sym-v1'), u32(env.suite || 1),
    lp(env.keyId || ''), Buffer.from([FRAMING_FIELD]), Buffer.from([0]), Buffer.from([0]),
  ]);
}

export function openEnvelope(encObj, key) {
  const env = JSON.parse(Buffer.from(encObj.envelope, 'base64').toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(buildEnvelopeAAD(env));
  decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function sealEnvelope(plaintext, key, template = {}) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  const env = {
    suite: template.suite || 1,
    keyId: template.keyId || '',
    nonce: nonce.toString('base64'),
  };
  cipher.setAAD(buildEnvelopeAAD(env));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext || ''), 'utf8'), cipher.final()]);
  env.authTag = cipher.getAuthTag().toString('base64');
  env.ciphertext = ciphertext.toString('base64');
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify(env)).toString('base64'),
  };
}

let cachedMasterKey = null;
let masterKeyFailAt = 0;
let masterKeyInflight = null;
const KEY_RETRY_MS = 60000;

/**
 * 经 WorkBuddy 官方 Electron（ELECTRON_RUN_AS_NODE=1）子进程调用原生存储绑定提取密钥。
 * 内存缓存 + 在途去重，失败 60s 内退避；绝不写盘，绝不写日志。
 * 必须 async：spawnSync 会同步卡死事件循环——桌面壳把 daemon 跑在 Electron 主进程里，
 */
export async function getWorkbuddyMasterKey(clientPath) {
  if (cachedMasterKey) return cachedMasterKey;
  if (masterKeyFailAt && Date.now() - masterKeyFailAt < KEY_RETRY_MS) return null;
  if (masterKeyInflight) return masterKeyInflight;
  const exe = clientPath || detectWorkbuddy().clientPath;
  if (!exe) return null;
  // #52 防线：被污染的缓存值（如 workbuddy-switch 的 exe）绝不能拉起——非 Electron
  // 程序不消费 -e 参数，会弹出自己的 GUI 窗口 2 秒后被 kill（报告者实测复现现象）。
  if (!looksLikeWbElectronClient(exe)) {
    masterKeyFailAt = Date.now();
    return null;
  }

  const code = [
    "const b = process._linkedBinding('electron_browser_workbuddy_storage');",
    "const p = JSON.parse(b.loggerGet());",
    "if (p && typeof p.atRestSecretKey === 'string') process.stdout.write(p.atRestSecretKey);",
  ].join('\n');
  masterKeyInflight = new Promise((resolve) => {
    let child = null;
    const settle = (key) => {
      try { child?.kill(); } catch {}
      masterKeyInflight = null;
      if (key) {
        cachedMasterKey = crypto.createHash('sha256').update(key, 'utf8').digest();
        masterKeyFailAt = 0;
        resolve(cachedMasterKey);
      } else {
        masterKeyFailAt = Date.now();
        resolve(null);
      }
    };
    const timer = setTimeout(() => settle(null), 5000);
    try {
      child = cp.spawn(exe, ['-e', code], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', () => { clearTimeout(timer); settle(null); });
      child.on('close', (statusCode) => {
        clearTimeout(timer);
        const keyRaw = out.trim();
        settle(statusCode === 0 && keyRaw.length >= 16 ? keyRaw : null);
      });
    } catch {
      clearTimeout(timer);
      settle(null);
    }
  });
  return masterKeyInflight;
}

export function resetMasterKeyCacheForTest(key = null) {
  cachedMasterKey = key;
  masterKeyFailAt = 0;
}

/** 深度解密 JSON 中的 $wbEncrypted 信封，返回包含明文的深拷贝（异步：取钥需起子进程） */
export async function decryptSessionJson(session, clientPath) {
  if (!session || typeof session !== 'object') return session;
  let key = null;
  const clone = JSON.parse(JSON.stringify(session));

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (isWbEncrypted(v)) {
        if (!key) key = getWorkbuddyMasterKey(clientPath);
        if (key) {
          try {
            node[k] = openEnvelope(v, key);
          } catch {
            /* 解密失败保留原信封 */
          }
        }
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  };

  walk(clone);
  // walk 内取到的 key 是 Promise（getWorkbuddyMasterKey 首次异步），等待后再逐信封解密
  const resolvedKey = await key;
  if (resolvedKey) {
    const walkDecrypt = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walkDecrypt); return; }
      for (const [k, v] of Object.entries(node)) {
        if (isWbEncrypted(v)) {
          try { node[k] = openEnvelope(v, resolvedKey); } catch { /* 保留原信封 */ }
        } else if (v && typeof v === 'object') walkDecrypt(v);
      }
    };
    walkDecrypt(clone);
  }
  return clone;
}

// ===================== 凭据与会话管理 =====================

export function workbuddyAuthDir() {
  const home = os.homedir();
  const tail = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), ...tail);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', ...tail);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), ...tail);
}

const CURRENT_RE = /^[a-z0-9-]+\.info$/i;           // workbuddy-desktop.info
const HISTORY_RE = /^[a-z0-9-]+\.\d{4}-.*\.info$/i;  // workbuddy-desktop.<时间戳>.<pid>.<uuid>.info

/** 会话 JSON → 账号记录（供 addAccount），不含网络请求。
 * 异步：含 $wbEncrypted 信封时需起 WorkBuddy 子进程取钥解密——
 * 绝不用 spawnSync（会同步卡死 Electron 主进程事件循环 → 客户端「未响应」）。 */
export async function sessionToAccount(rawSession, source, clientPath) {
  // 如果会话包含 $wbEncrypted 信封，先进行安全解密
  const session = await decryptSessionJson(rawSession, clientPath);
  const token = session?.auth?.accessToken;
  if (typeof token !== 'string' || !token) return null;
  const info = inspectToken(token);
  if (!info.provider) return null;
  const acc = session.account || {};
  const auth = session.auth || {};
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  // 手机号：优先未脱敏的 phoneNumber；若被客户端脱敏（含 *）或为空，回退到从 JWT 解析的大陆手机号
  const rawPhone = typeof acc.phoneNumber === 'string' ? acc.phoneNumber.trim() : '';
  const isRedacted = rawPhone.includes('*');
  const phone = (!rawPhone || isRedacted) ? (info.phone || rawPhone || null) : rawPhone;

  // 原 rawSession 结构原样保留在 meta.session，便于切换账号时原汁原味还原
  const rawAuth = rawSession?.auth || auth;
  const { accessToken: _a, refreshToken: _r, ...authRest } = rawAuth;
  return {
    provider: info.provider,
    token,
    refreshToken: auth.refreshToken || null,
    expiresAt: iso(auth.expiresAt) || info.expiresAt,
    uid: acc.uid || info.uid,
    name: acc.nickname || acc.name || null,
    email: acc.email || null,
    source,
    meta: {
      domain: auth.domain || info.host,
      enterpriseId: acc.enterpriseId || null,
      phone,
      refreshExpiresAt: iso(auth.refreshExpiresAt),
      session: {
        account: rawSession?.account || acc,
        auth: authRest,
        accounts: Array.isArray(rawSession?.accounts) ? rawSession.accounts : (session.accounts || []),
        ...(Array.isArray(rawSession?.allAccounts || session.allAccounts) ? { allAccounts: rawSession?.allAccounts || session.allAccounts } : {}),
      },
    },
  };
}

/**
 * 读取本机 WorkBuddy 会话：当前会话 + 历史会话（按 uid 去重，保留最新）。
 * @returns {{ dir, accounts: Array<{...账号记录, current: boolean, file, fileTime}>, errors }}
 */
export async function readWorkbuddySessions(options = {}) {
  const dir = options.dir || workbuddyAuthDir();
  const clientPath = options.clientPath !== undefined ? options.clientPath : detectWorkbuddy().clientPath;
  const out = { dir, accounts: [], errors: [] };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const byUid = new Map();
  // 密钥只取一次给整个目录用：缓存未命中时首个加密文件触发一次子进程（异步不阻塞），
  // 之后的文件全部走内存缓存；明文文件在密钥不可用时仍可正常收割
  let keyPromise = null;
  for (const name of names) {
    if (!CURRENT_RE.test(name) && !HISTORY_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const current = !HISTORY_RE.test(name);
      if (current && fs.existsSync(`${file}.logged-out`)) continue;   // 已登出
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rec = await sessionToAccount(parsed, current ? 'WorkBuddy 当前登录' : 'WorkBuddy 历史会话', clientPath);
      if (!rec) continue;
      const fileTime = fs.statSync(file).mtimeMs;
      const item = { ...rec, current, file, fileTime };
      const prev = byUid.get(rec.uid);
      if (!prev || (current && !prev.current) || (current === prev.current && fileTime > prev.fileTime)) byUid.set(rec.uid, item);
    } catch (e) {
      out.errors.push({ file, error: e.message });
    }
  }
  void keyPromise;
  out.accounts = [...byUid.values()].sort((a, b) => b.current - a.current || b.fileTime - a.fileTime);
  return out;
}

/**
 * 国内/国际两个桌面端各自的当前登录 uid（未登录的档位为 null）。
 * 两者是独立会话文件（workbuddy-desktop.info / workbuddy-desktop-ai.info），可同时各有一个 current；
 * 会话归属按 provider 区分（workbuddy=国内 realm 签发 / workbuddy-intl=国际 realm）。
 */
export async function currentWorkbuddyUids() {
  const accounts = (await readWorkbuddySessions()).accounts;
  return {
    cn: accounts.find((a) => a.current && a.provider !== 'workbuddy-intl')?.uid || null,
    intl: accounts.find((a) => a.current && a.provider === 'workbuddy-intl')?.uid || null,
  };
}

/** 当前国内版 WorkBuddy 客户端登录的 uid（国际版用 currentWorkbuddyUids().intl）。异步：见 readWorkbuddySessions。 */
export async function currentWorkbuddyUid() {
  return (await currentWorkbuddyUids()).cn;
}

// 客户端可执行文件候选（VS Code 系安装惯例：%LOCALAPPDATA%\Programs\<名>\<名>.exe）。
// 「已安装」只认 exe：凭据目录不能当依据——CreditDaddy 自己切换时 mkdir 也会把目录建出来
// （无客户端时静默切换留下的空壳目录），拿目录判断会把没装客户端的机器误报成已安装。
const CLIENT_CANDIDATES = process.platform === 'win32'
  ? [
      ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
      ['Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'],
      ['Programs', 'CodeBuddy CN', 'CodeBuddy CN.exe'],
      ['Programs', 'CodeBuddy', 'CodeBuddy.exe'],
      ['WorkBuddy', 'WorkBuddy.exe'],
      ['WorkBuddyAI', 'WorkBuddyAI.exe'],
      ['CodeBuddy CN', 'CodeBuddy CN.exe'],
      ['CodeBuddy', 'CodeBuddy.exe'],
    ]
  : process.platform === 'darwin'
    ? [
        '/Applications/WorkBuddy.app',
        '/Applications/WorkBuddy AI.app',
        '/Applications/CodeBuddy CN.app',
        '/Applications/CodeBuddy.app',
      ]
    : [];

// ── 自定义安装路径发现（issue #46） ──
// 客户端装在 D:/E: 盘或自定义目录时，CLIENT_CANDIDATES 的固定路径全部落空，面板误判「未安装」
// 并硬拦切换。这里按「注册表 Uninstall 键 → 进程路径」两路兜底。
//
// ⚠️ 性能铁律（1.6.6 白屏事故）：detectWorkbuddy 是**同步函数**且被 /api/status 每轮调用，
// 绝不能在里面 spawn 子进程（spawnSync 起 PowerShell/reg 会卡住 Electron 主进程消息泵）。
// 因此这里只做**零子进程**的注册表文件级读取：直接解析 NTUSER.DAT / SOFTWARE hive 不可行，
// 所以改走「持久缓存 + 异步预热」——异步发现结果写进模块级缓存，detectWorkbuddy 只读缓存。
let discoveredClientPath = null;   // 异步发现到的自定义安装路径（进程内缓存）
let discoverPromise = null;        // 在途去重

/** 候选 exe 是否像「真 WorkBuddy/CodeBuddy Electron 客户端」（issue #52 防误判闸）：
 *  - 文件名排除：同厂工具（workbuddy-switch 等）名字里带产品词但不是客户端；
 *  - Electron 二进制校验：真客户端内嵌 electron.exe 图标资源，Rust/原生 GUI 程序没有——
 *    零子进程（读文件字节，不起进程），误判的代价是 getWorkbuddyMasterKey 把
 *    非 Electron exe 当 Electron 拉起来（弹自己的 GUI 窗口 2 秒后被 kill，#52 现象）。 */
function looksLikeWbElectronClient(exePath) {
  const p = String(exePath || '');
  const base = path.basename(p).replace(/\.exe$/i, '');
  // 文件名黑名单：第三方/衍生工具（不区分大小写，workbuddy-switch / wb-switch-rust 等全拦）
  if (/switch|launcher|uninstall|setup|crashpad|updater|squirrel/i.test(base)) return false;
  // Electron 指纹：官方客户端由 electron-builder 打包，exe 内嵌 'Electron' 的 PE 资源段。
  // 读文件头 2MB 扫 ASCII 'Electron'——Electron exe 必中，Rust/Go/原生 GUI 基本不会误含。
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(2 * 1024 * 1024);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.slice(0, bytes).includes('Electron');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** 异步预热：注册表 / 进程探测（唯一允许起子进程的地方，且绝不阻塞调用方）。
 * 契约：**永远返回 Promise**（已发现 / 非 win32 时 resolve 现状）——调用方都挂 .catch，
 * 返回 null/undefined 会在 NAS 与已预热的 Windows 机器上直接 TypeError（1.7.0 审计发现）。 */
export function warmWorkbuddyClientPath() {
  if (process.platform !== 'win32' || discoveredClientPath) return Promise.resolve(discoveredClientPath);
  if (discoverPromise) return discoverPromise;
  discoverPromise = (async () => {
    try {
      // ① 注册表 Uninstall 键：DisplayIcon / InstallLocation 指向真实安装目录。
      //    /f 模糊搜索会误命中名字含产品词的第三方工具（#52：workbuddy-switch 的
      //    DisplayIcon 指 wb-switch-rust.exe，曾被当客户端缓存 → 反复弹窗），
      //    所以命中后必须过 looksLikeWbElectronClient 双闸才入缓存。
      const out = await new Promise((resolve) => {
        cp.execFile('reg', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'WorkBuddy', '/d'],
          { encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout) => resolve(err ? '' : String(stdout)));
      });
      let hits = String(out).match(/DisplayIcon\s+REG_SZ\s+([^\r\n]+)/gi) || [];
      // CodeBuddy 是另一个产品名，再查一次
      const out2 = await new Promise((resolve) => {
        cp.execFile('reg', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'CodeBuddy', '/d'],
          { encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout) => resolve(err ? '' : String(stdout)));
      });
      hits = hits.concat(String(out2).match(/DisplayIcon\s+REG_SZ\s+([^\r\n]+)/gi) || []);
      for (const line of hits) {
        // DisplayIcon 常见值：D:\Apps\WorkBuddy\WorkBuddy.exe / "...\WorkBuddy.exe",0
        const raw = line.replace(/^DisplayIcon\s+REG_SZ\s+/i, '').trim().replace(/^"(.*)"(?:,\d+)?$/, '$1').replace(/,\d+$/, '');
        if (/\.exe$/i.test(raw) && fs.existsSync(raw) && looksLikeWbElectronClient(raw)) { discoveredClientPath = raw; return; }
      }
      // ② 运行中的进程路径（客户端已启动但注册表没写 DisplayIcon 的情况）——同闸
      const ps = await new Promise((resolve) => {
        cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-Process -Name 'WorkBuddy','WorkBuddyAI','CodeBuddy*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique"],
          { encoding: 'utf8', windowsHide: true, timeout: 4000 },
          (err, stdout) => resolve(err ? '' : String(stdout)));
      });
      for (const line of String(ps).split(/\r?\n/)) {
        const p = line.trim();
        if (/\.exe$/i.test(p) && fs.existsSync(p) && looksLikeWbElectronClient(p)) { discoveredClientPath = p; return; }
      }
    } catch { /* 探测失败只是保持「未发现」，不影响既有候选路径判定 */ }
  })().finally(() => { discoverPromise = null; });
  return discoverPromise;
}

/** 测试用：注入/清除自定义安装路径缓存 */
export function _setDiscoveredClientPathForTest(p) { discoveredClientPath = p || null; }

/**
 * 本机 WorkBuddy / CodeBuddy 客户端探测（面板「客户端：未安装」提示与切换拦截用）。
 * Linux / NAS 没有已知安装路径，退而用「凭据目录里有会话文件」判定——
 * 会话文件只有客户端登录后才写，纯 Token 导入的机器不会产生。
 * 同步、零子进程：自定义路径由 warmWorkbuddyClientPath() 异步预热进缓存（issue #46）。
 */
export function detectWorkbuddy() {
  const dir = workbuddyAuthDir();
  let dirExists = false;
  try { dirExists = fs.statSync(dir).isDirectory(); } catch { /* 未安装 / 从未登录 */ }
  let clientPath = null;
  for (const cand of CLIENT_CANDIDATES) {
    const p = process.platform === 'win32' && Array.isArray(cand)
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), ...cand)
      : cand;
    try { if (fs.existsSync(p)) { clientPath = p; break; } } catch { /* 下一个候选 */ }
  }
  // 固定候选全落空时用异步发现的路径（自定义盘符 / 目录，issue #46）
  if (!clientPath && discoveredClientPath) {
    try { if (fs.existsSync(discoveredClientPath)) clientPath = discoveredClientPath; } catch { /* ignore */ }
  }
  // signedIn 只做轻量文件判定（当前会话文件存在且无 logged-out 标记）：
  // 绝不在此调 readWorkbuddySessions——那会对加密会话起子进程解密（异步），
  // 而 detectWorkbuddy 是同步函数且被 /api/status 每轮调用，解密等待会拖慢状态轮
  let signedIn = false;
  if (dirExists) {
    const curFile = path.join(dir, 'workbuddy-desktop.info');
    try { signedIn = fs.existsSync(curFile) && !fs.existsSync(`${curFile}.logged-out`); } catch { /* 保持 false */ }
    if (!signedIn) {
      // 多认证 ID 形态（Tencent-Cloud.*.info 等非固定名）：目录里任一无登出标记的 .info 即视为登录态
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!CURRENT_RE.test(name) || name === 'workbuddy-desktop.info') continue;
          if (HISTORY_RE.test(name)) continue;
          if (!fs.existsSync(path.join(dir, `${name}.logged-out`))) { signedIn = true; break; }
        }
      } catch { /* 保持 false */ }
    }
  }
  return {
    dir,
    dirExists,
    clientPath,
    installed: Boolean(clientPath) || (CLIENT_CANDIDATES.length === 0 && signedIn),
    signedIn,
  };
}

/**
 * 构造 WorkBuddy 会话对象（当账号缺少 native session 时动态合成完整会话）
 */
export function buildWorkbuddySession(account) {
  const isIntl = account.provider === 'workbuddy-intl';
  const domain = account.meta?.domain || (isIntl ? 'www.codebuddy.ai' : 'www.codebuddy.cn');
  const uid = String(account.uid || '');
  const nickname = account.name || account.meta?.phone || 'User';
  const phone = account.meta?.phone ? String(account.meta.phone) : '';
  const phoneMasked = phone ? phone.slice(0, 3) + '****' + phone.slice(-4) : '';
  const accessToken = String(account.token || '');
  const refreshToken = String(account.refreshToken || '');
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : Date.now() + 30 * 86400e3;
  const now = Date.now();

  const origAccount = account.meta?.session?.account || {};
  const accountObj = {
    uid,
    nickname,
    uin: origAccount.uin || '',
    type: origAccount.type || 'personal',
    lastLogin: true,
    isCreator: false,
    isAdmin: false,
    pluginEnabled: true,
    deployStatus: { statusCode: 0, statusMsg: '', detailMsg: '' },
    accountType: '',
    sso: { domain: '', domainModifiedTimes: 0 },
    idp: '',
    areaInfoComplete: false,
    oneidAccountId: '',
    isCurrentOneIdEnterprise: false,
    isCurrentOneIdPersonal: true,
    isFirstLogin: false,
    phoneNumber: origAccount.phoneNumber || phoneMasked || phone,
    wechatOpenId: origAccount.wechatOpenId || '',
    mpOpenId: origAccount.mpOpenId || '',
    logOutEnable: false,
  };

  const authObj = {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    sessionState: account.meta?.session?.auth?.sessionState || '',
    scope: 'acr offline_access profile basic roles email web-origins',
    domain,
    lastRefreshTime: now,
    expiresAt,
    expiresIn: Math.round((expiresAt - now) / 1000),
    refreshExpiresIn: 5183999,
    refreshExpiresAt: expiresAt + 30 * 86400e3,
  };

  return {
    account: accountObj,
    auth: authObj,
    accounts: [accountObj],
    allAccounts: [accountObj],
  };
}

/**
 * 把账号写成 WorkBuddy 当前会话（切换账号）。需要账号带有导入时保存的会话信息。
 * 如果原模板是 $wbEncrypted 信封格式，写回时将自动封包为合法信封。
 * 若无保存过的会话信息，则用账号凭据动态合成完整会话。
 * 对国际版（workbuddy-intl）与国内版（workbuddy）自动分流并双写（workbuddy-desktop.info 与 workbuddy-desktop-ai.info），
 * 确保 WorkBuddy（国内端）与 WorkBuddyAI（国际端）均能实时应用切换。
 * @returns {{ file, previousUid }}
 */
export async function writeWorkbuddySession(account, { clientPath } = {}) {
  const s = account.meta?.session?.account ? account.meta.session : buildWorkbuddySession(account);
  if (!s?.account) throw new Error('该账号缺少 WorkBuddy 会话信息，请从本机重新导入后再切换');
  const dir = workbuddyAuthDir();
  fs.mkdirSync(dir, { recursive: true });

  const isIntlAccount = account.provider === 'workbuddy-intl' || s.auth?.domain?.includes('.ai');
  const primaryFileName = isIntlAccount ? 'workbuddy-desktop-ai.info' : 'workbuddy-desktop.info';
  const primaryFile = path.join(dir, primaryFileName);
  let previousUid = null;
  try { previousUid = JSON.parse(fs.readFileSync(primaryFile, 'utf8'))?.account?.uid || null; } catch {}

  const ms = (iso) => (iso ? new Date(iso).getTime() : undefined);
  const rawAuth = s.auth || {};

  // 获取加密主密钥（若目标环境或模板需要加密）
  let masterKey = await getWorkbuddyMasterKey(clientPath);

  // 待写入的文件列表：国际版优先写 workbuddy-desktop-ai.info 并兼顾 workbuddy-desktop.info；国内版写 workbuddy-desktop.info
  const targetFiles = isIntlAccount
    ? ['workbuddy-desktop-ai.info', 'workbuddy-desktop.info']
    : ['workbuddy-desktop.info'];

  for (const fileName of targetFiles) {
    const file = path.join(dir, fileName);
    let isEncryptedTemplate = isWbEncrypted(rawAuth.accessToken) || isWbEncrypted(rawAuth.refreshToken);
    let templateEnv = {};

    // 检查目标文件现有模板是否加密
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isWbEncrypted(existing.auth?.accessToken)) {
        isEncryptedTemplate = true;
        templateEnv = JSON.parse(Buffer.from(existing.auth.accessToken.envelope, 'base64').toString('utf8'));
      }
    } catch {}

    const keyId = templateEnv.keyId || (masterKey ? crypto.createHash('sha256').update(masterKey).digest('hex').slice(0, 16) : '9127dea1b44020a7');
    const sealOpts = { suite: 1, keyId };

    const accessPayload = isEncryptedTemplate && masterKey
      ? sealEnvelope(account.token, masterKey, sealOpts)
      : account.token;

    const refreshVal = account.refreshToken || rawAuth.refreshToken;
    const refreshPayload = isEncryptedTemplate && masterKey && refreshVal
      ? sealEnvelope(refreshVal, masterKey, sealOpts)
      : refreshVal;

    // 国际端 workbuddy-desktop-ai.info 中的 nickname 也是加密字段，写入时需同步封包
    const nickVal = account.name || s.account.nickname || 'User';
    const nickPayload = fileName.includes('-ai') && masterKey
      ? sealEnvelope(nickVal, masterKey, sealOpts)
      : nickVal;

    const session = {
      account: {
        ...s.account,
        nickname: nickPayload,
      },
      auth: {
        ...s.auth,
        accessToken: accessPayload,
        refreshToken: refreshPayload,
        expiresAt: ms(account.expiresAt) ?? s.auth?.expiresAt,
        lastRefreshTime: Date.now(),
      },
      accounts: s.accounts || [],
      ...(Array.isArray(s.allAccounts) ? { allAccounts: s.allAccounts } : {}),
    };

    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.unlinkSync(`${file}.logged-out`); } catch {}
  }

  return { file: primaryFile, previousUid };
}
