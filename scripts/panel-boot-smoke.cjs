#!/usr/bin/env node
/**
 * 面板启动冒烟（零依赖 vm 执行桩）：
 *   - 从 src/panel.html 收集真实 id 集合：$() 查不存在的 id 返回 null——
 *     「节点已删但 JS 还在引用」的空引用类 bug（cnt-meoo）在启动即抛；
 *   - 未声明变量（syncable 类）在 vm 沙箱里必抛 ReferenceError；
 *   - fetch 按 URL mock，启动链（loadStatus → loadAccounts → loadCookieSites →
 *     loadSettings → 网关 load → loadLogs）全部跑通；
 *   - 断言：/api/status 被请求、网页会话行渲染出「至 <最早到期>」的统一口径。
 *
 * 用法：node scripts/panel-boot-smoke.js   （退出码 0 = 通过）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'panel.html'), 'utf8');

// ── 1. 收集 HTML 里的真实 id ──
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

// ── 2. 提取内联脚本 ──
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) { console.error('PANEL BOOT FAIL: no inline script'); process.exit(1); }

// ── 3. 元素桩 ──
const elements = new Map();
function makeElement(id) {
  const el = {
    id, tagName: 'DIV', children: [], listeners: {},
    _innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    hidden: false, src: '', alt: '', title: '', placeholder: '', type: '', multiple: false,
    dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }),
    classList: { add(){}, remove(){}, toggle(){ return true; }, contains(){ return false; } },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(){}, dispatchEvent(){ return true; },
    setAttribute(){}, getAttribute(){ return null; }, hasAttribute(){ return false; }, removeAttribute(){},
    appendChild(c){ this.children.push(c); return c; }, removeChild(){}, remove(){},
    insertAdjacentHTML(){}, focus(){}, blur(){}, click(){}, reset(){}, scrollIntoView(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    closest(){ return null; },
    getBoundingClientRect(){ return { width: 0, height: 0, top: 0, left: 0 }; },
    contains(){ return false; }, select(){},
    options: [], selectedOptions: [],
  };
  Object.defineProperty(el, 'innerHTML', { get(){ return this._innerHTML || ''; }, set(v){ this._innerHTML = String(v); } });
  return el;
}
const elemFor = (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); };

// ── 4. document stub（真实 id 命中缓存；未知 id 返回 null——空引用类 bug 的探针）──
const document = {
  getElementById(id) { return ids.has(id) ? elemFor(id) : null; },
  querySelector(sel) { const m = /^#([\w-]+)$/.exec(sel); return (m && ids.has(m[1])) ? elemFor(m[1]) : makeElement('sel:' + sel); },
  querySelectorAll(sel) { return []; },
  createElement(tag) { const el = makeElement('created-' + tag); el.tagName = String(tag).toUpperCase(); return el; },
  createTextNode(t){ return { textContent: t }; },
  addEventListener(type, fn) { if (type === 'error') this._onerror = fn; },
  removeEventListener(){},
  body: null, documentElement: null, hidden: false, title: '',
  head: null, cookie: '',
};
document.body = makeElement('body');
document.documentElement = makeElement('html');
document.head = makeElement('head');

// ── 5. fetch mock：按 URL 前缀返回最小 JSON ──
// denyOn：模拟 daemon 的 fail-closed 访问控制（未设面板访问密码时非本机来源一律 403），
// 用来断言「读不到」不再被渲染成「没配过/没有」（见 panel.html accessNoticeHtml）。
const fetchCalls = [];
let denyOn = false;
const DENY_MSG = '未设置面板访问密码时，面板账号接口仅允许本机访问——请在「设置 → 通用 → 面板访问密码」设置密码后再从局域网访问';
const NOW = '2026-11-16T01:00:00.000Z';
function jsonFor(url) {
  const u = String(url);
  if (u.includes('/api/status')) {
    return { accounts: [{ id: 'a1', provider: 'meoo', product: 'meoo', name: 'Meoo (#187)', uid: '379626', token: '', meta: {} }],
      cookieSites: [], settings: {}, quotas: {}, todayByProduct: {}, scheduler: { zcode: { lastTick: null } },
      version: 'smoke', zcodeClient: null, workbuddyCurrentUid: null, catpawCurrentUid: null,
      qoderClient: null, traeClient: null, loomyClient: null, dumateClient: null, autoclawClient: null, minimaxClient: null,
      zcodeCurrentUid: null, traeCurrentUid: null };
  }
  if (u.includes('/api/cookie-sites')) {
    return { sites: [
      { id: 'meoo', name: 'Meoo 秒悟', label: 'Meoo 秒悟', loginUrl: 'https://meoo.com', hint: '',
        accounts: [{ id: 'a1', name: 'Meoo 秒悟(379***584)', quota: { total: 22983 },
          meooGrants: { grants: [{ expireAt: '2026-11-19T00:00:00.000Z' }, { expireAt: '2026-11-21T00:00:00.000Z' }], at: NOW }, capturedAt: NOW }],
        no10rSync: true },
      { id: 'lingxi', name: 'WPS 灵犀', label: 'WPS 灵犀', loginUrl: 'https://lingxi.kdocs.cn', hint: '',
        accounts: [{ id: 'a2', name: 'WPS 灵犀(192***197)', quota: { total: 1800 },
          lingxiPacks: { packs: [{ balance: 1800, expireAt: '2026-12-10T00:00:00.000Z' }], at: NOW }, capturedAt: NOW }] }],
    };
  }
  // mirasim 现行额度口径（真机 2026-11-25 抓的响应结构）：断言渲染用，见下方 MIRA_BASE
  if (/\/api\/accounts\/[^/]+\/quota/.test(u)) return { quota: MIRA_QUOTA };
  if (u.includes('/api/accounts')) return { accounts: [{ id: 'm1', provider: 'mirasim', product: 'mirasim', name: 'ShiYanG Yu', uid: 'usr_1f3b', token: '', meta: {}, hasRefreshToken: true }] };
  if (u.includes('/api/usage/quotas')) return { quotas: { connections: [] }, totals: {} };
  if (u.includes('/api/logs')) return { logs: [] };
  return {};
}
async function fetchMock(url, init) {
  fetchCalls.push(String(url));
  if (denyOn) {
    return {
      ok: false, status: 403,
      headers: new Map(),
      json: async () => ({ error: DENY_MSG }),
      text: async () => JSON.stringify({ error: DENY_MSG }),
    };
  }
  const j = jsonFor(url);
  return {
    ok: true, status: 200,
    headers: new Map(),
    json: async () => JSON.parse(JSON.stringify(j)),
    text: async () => JSON.stringify(j),
  };
}

// ── 6. 沙箱 ──
// mirasim 现行「额度」口径的响应结构（真机 2026-11-25 抓样），断言段会替换其内容
let MIRA_QUOTA = {
  unit: '额度', total: 10.01, used: 2.36, remaining: 7.65, remainingPercentage: 76.4, percent: 23.6,
  plan: 'GO', planExpiresAt: '2027-04-23T15:59:59.000Z', earliestExpiresAt: '2027-02-22T15:03:06.833Z',
  lots: [
    { name: '邀请奖励', total: 5, remaining: 0, expiresAt: '2027-02-21T16:10:53.083Z', recurring: false },
    { name: '邀请奖励', total: 10, remaining: 7.64, expiresAt: '2027-02-22T15:03:06.833Z', recurring: false },
    { name: '原有余额', total: 0.01, remaining: 0.01, expiresAt: '2027-04-23T15:59:59.000Z', recurring: false },
  ],
  space: { remaining: 0, balance: 0, payer: 'personal' },
  agentSources: [
    { id: 'antigravity', label: 'Antigravity', source: 'local' },
    { id: 'claude', label: 'Claude Code', source: 'local' },
    { id: 'pi', label: 'Pi', source: 'local' },
    { id: 'qwen', label: 'Qwen Code', source: 'local' },
    { id: 'zcode', label: 'ZCode CLI', source: 'local' },
  ],
  windows: [{ name: '30d', rawName: '30d', total: 1501, used: 735.82, remaining: 765.18, percent: 49, remainingPercentage: 51, unit: '', resetAt: null, expiresAt: null, recurring: true }],
  bottleneck: null, empty: false, exceeded: false, partial: false,
};
const MIRA_BASE = MIRA_QUOTA;
const errors = [];
const unhandled = [];
const sandbox = {
  console: { log(){}, warn(){}, error(m){ errors.push(String(m)); }, info(){}, debug(){}, table(){}, group(){} },
  document, fetch: fetchMock,
  localStorage: { _s: {}, getItem(k){ return this._s[k] ?? null; }, setItem(k, v){ this._s[k] = String(v); }, removeItem(k){ delete this._s[k]; }, clear(){ this._s = {}; }, key(){ return null; }, get length(){ return 0; } },
  sessionStorage: { getItem(){ return null; }, setItem(){}, removeItem(){}, clear(){}, key(){ return null; }, get length(){ return 0; } },
  location: { href: 'http://127.0.0.1:47860/', origin: 'http://127.0.0.1:47860', protocol: 'http:', host: '127.0.0.1:47860', hostname: '127.0.0.1', port: '47860', search: '', pathname: '/', hash: '', reload(){}, assign(){}, replace(){} },
  history: { back(){}, forward(){}, pushState(){}, replaceState(){}, state: null },
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'smoke', platform: 'smoke', language: 'zh', onLine: true },
  alert(){}, confirm(){ return true; }, prompt(){ return null; }, open(){ return null; }, close(){}, scroll(){}, scrollTo(){},
  matchMedia: undefined,
  URL, Blob, Event, CustomEvent: Event, AbortController, AbortSignal: globalThis.AbortSignal, NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }, FormData: class {},
  requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout,
  getComputedStyle: () => ({ getPropertyValue(){ return ''; } }),
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  performance: { now(){ return Date.now(); } },
  crypto: globalThis.crypto,
  structuredClone, TextEncoder, TextDecoder,
  __errors: errors, __unhandled: unhandled,
  addEventListener(type, fn) { if (type === 'error') this._onerror = fn; if (type === 'unhandledRejection') this._onunhandled = fn; },
  removeEventListener(){}, dispatchEvent(){ return true; },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);

// ── 7. 执行 ──
process.on('unhandledRejection', (e) => unhandled.push(String((e && e.message) || e)));
let ran = false;
try {
  for (const s of scripts) vm.runInContext(s, ctx, { filename: 'panel.html' });
  ran = true;
} catch (e) {
  console.error('PANEL BOOT FAIL: script threw at vm.run:', e.message);
  console.error(e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : '');
  process.exit(1);
}

// ── 8. 异步链冲刷与断言 ──
const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));
(async () => {
  for (let i = 0; i < 40; i++) { await flush(); if (i % 4 === 3) await new Promise((r) => setTimeout(r, 10)); }
  const calls = fetchCalls.join('\n');
  const asserts = [];
  const check = (cond, msg) => { if (!cond) asserts.push(msg); };

  check(ran, '脚本未执行');
  check(calls.includes('/api/status'), '启动链未请求 /api/status');
  check(calls.includes('/api/cookie-sites'), '启动链未请求 /api/cookie-sites');
  check(calls.includes('/api/accounts'), '启动链未请求 /api/accounts');
  check(calls.includes('/api/settings'), '启动链未请求 /api/settings');
  check(calls.includes('/api/logs'), '启动链未请求 /api/logs');

  // 网页会话行渲染断言（统一口径：资源包 + 最早到期）——boot 落在仪表盘视图，
  // 显式触发网页会话页渲染后再断言
  try { ctx.renderCookieSites(); } catch (e) { asserts.push('renderCookieSites: ' + e.message); }
  try { ctx.renderFreePool(); } catch (e) { asserts.push('renderFreePool: ' + e.message); }
  const csBody = (elements.get('free-pool-body') || {})._innerHTML || '';
  check(csBody.includes('最早 2026-11-19 到期'), 'meoo 行未渲染最早到期');
  check(csBody.includes('至 2026-12-10 到期'), 'lingxi 行未渲染最早到期');

  // mirasim 现行「额度」口径渲染断言（走真实加载链：/api/accounts → loadQuotas → renderProd）：
  // 逐笔剩余额与绝对到期日 + 「最早一笔 … 到期」，且绝不能再出现「N 天后重置」——
  // 老 /v1/limits 的 30d 窗口 reset_at 是 2126 年占位值，按周期倒计时渲染会算出「36492 天后重置」
  const MIRA_HTML = () => (elements.get('list') || {})._innerHTML || '';
  // 顶层 const/let 不挂在 sandbox 对象上，只能按词法环境求值，故用 runInContext 读写 state
  const evalIn = (expr) => vm.runInContext(expr, ctx, { filename: 'smoke-assert' });
  const step = async (q) => {
    MIRA_QUOTA = q;
    evalIn('state.quotas = {}');
    await ctx.loadQuotas();
    await flush(); await flush();
  };
  try {
    evalIn("state.view = 'mirasim'; true");
    await step({ ...MIRA_BASE });
    const html = MIRA_HTML();
    check(html.includes('7.65'), 'mirasim 主数未渲染个人额度余额 7.65');
    check(html.includes('剩 7.64 / 10'), 'mirasim 未渲染逐笔剩余额');
    check(html.includes('2027-02-22 到期'), 'mirasim 未渲染逐笔到期日');
    check(html.includes('最早一笔 2027-02-22 到期'), 'mirasim 未渲染「最早一笔 … 到期」');
    check(html.includes('空间额度 余 0'), 'mirasim 未渲染空间额度');
    check(!/天后重置/.test(html), 'mirasim 又出现「N 天后重置」（占位 reset_at 泄漏）');
    check(!/\b30d\b/.test(html), 'mirasim 仍在展示老 30d 窗口行');
    // 各智能体单独设了来源（读自本机 person-agent-routes.json）：列名前 3 个 + 「等 5 个」
    check(html.includes('Antigravity、Claude Code、Pi 等 5 个 单独设了额度来源'), 'mirasim 未渲染「单独设了额度来源」提示');

    // 降级：个人额度接口读不到 → 显示「—」，不编一个 0 出来
    await step({ ...MIRA_BASE, partial: true, total: 0, remaining: 0, used: 0, lots: [], earliestExpiresAt: null });
    const degraded = MIRA_HTML();
    check(degraded.includes('<b>—</b>'), 'mirasim 降级态未显示「—」');
    check(!degraded.includes('7.65'), 'mirasim 降级态仍带旧余额');

    // 用尽态
    await step({ ...MIRA_BASE, remaining: 0, used: 10.01, remainingPercentage: 0, exceeded: true, bottleneck: { name: '个人额度' }, lots: [], earliestExpiresAt: null });
    check(MIRA_HTML().includes('个人额度已用尽'), 'mirasim 用尽态文案缺失');

    // 真机 2026-11-26 态：笔全部扣穿（lots 有、remaining 全 0），老 30d 窗口仍在响应里
    // ——不得退回渲染窗口行，也不得出现负数余额
    await step({
      ...MIRA_BASE, total: 10, used: 10, remaining: 0, remainingPercentage: 0, exceeded: true,
      bottleneck: { name: '个人额度' }, earliestExpiresAt: null, partial: false,
      lots: MIRA_BASE.lots.map((l) => ({ ...l, remaining: 0 })),
    });
    const spentAll = MIRA_HTML();
    check(spentAll.includes('个人额度已用尽'), 'mirasim 笔全部用尽未显示用尽态');
    check(!/\b30d\b/.test(spentAll), 'mirasim 笔全部用尽时退回老 30d 窗口行（截图里的旧口径）');
    // 只看渲染成文本的负数（>-0.02）；SVG path 的 d="…-2.64…" 是图标数据，不算
    check(!/>\s*-\s*\d/.test(spentAll), 'mirasim 渲染出负数余额');
  } catch (e) {
    asserts.push('mirasim 渲染断言: ' + e.message);
  }
  // ── 第二轮：模拟 daemon fail-closed（未设面板访问密码时的非本机来源一律 403）──
  // 「读不到」必须明确说出来，且**不得**再渲染成「接入 10Router」引导页/空态（用户投诉的根因）。
  // 面板里 state / tr 是顶层 const（不挂在 globalThis 上），只能在上下文内操作
  denyOn = true;
  fetchCalls.length = 0;
  const run = (code) => vm.runInContext(code, ctx, { filename: 'smoke-denied' });
  try {
    await run(`(async () => {
      await loadTrConfig(); await loadAccounts(); await loadCookieSites(true); await loadSettings();
      state.view = 'tenrouter'; render();
    })()`);
  } catch (e) { asserts.push('拒绝场景渲染抛错: ' + e.message); }
  await flush(); await flush();
  const trBody = (elements.get('tr-panel') || {})._innerHTML || '';
  check(trBody.includes('读不到 10Router 配置'), '10Router 页未显示「读不到」提示');
  check(trBody.includes('并没有被删除'), '提示未说明配置未被删除');
  check(trBody.includes('http://127.0.0.1:47860'), '提示缺少本机访问出路');
  check(trBody.includes('面板访问密码'), '提示缺少设置访问密码的出路');
  check(!trBody.includes('接入 10Router'), '读不到时仍渲染成「接入 10Router」引导页');
  check(!trBody.includes('正在读取 10Router 供应商额度'), '读不到时仍显示额度加载态');
  const cntTr = (elements.get('cnt-tenrouter') || {}).textContent;
  check(cntTr === '!', '导航计数未标为「读不到」：' + cntTr);
  try { await run(`(async () => { state.view = 'dash'; render(); })()`); }
  catch (e) { asserts.push('dash 拒绝场景抛错: ' + e.message); }
  const prods = (elements.get('prods') || {})._innerHTML || '';
  check(prods.includes('10Router'), '仪表盘 10Router 卡在读不到时仍消失');
  check(prods.includes('读不到'), '仪表盘 10Router 卡未标注读不到');
  const banner = (elements.get('access-note') || {})._innerHTML || '';
  check(banner.includes('读不到：'), '顶部横幅未汇总读不到的区块：' + banner.slice(0, 80));
  check(fetchCalls.includes('/api/tenrouter'), '拒绝场景未请求 /api/tenrouter');
  // 「配置 10Router」弹窗：字段全空时必须有说明，否则看着就像配置被清空（用户截图那一处）
  try { await run(`(async () => { openTrSettings(); openTrSync(); })()`); }
  catch (e) { asserts.push('设置/同步弹窗抛错: ' + e.message); }
  // 元素桩的 style 是恒返回 '' 的 Proxy，display 判不了，只断言文案
  const loadNote = String((elements.get('tr-load-note') || {}).textContent || '');
  check(loadNote.includes('读不到已保存的配置'), '「配置 10Router」弹窗未说明读不到：' + loadNote.slice(0, 80));
  check(String((elements.get('tr-sync-status') || {}).textContent || '').includes('读不到已保存的同步设置'),
    '用量同步弹窗未说明读不到');
  // 账号会话页：首屏就读不到（无旧数据可留）时不能渲染成「暂无可捕获的供应商」
  try { await run(`(async () => { state.cookieSites = []; state.view = 'free'; render(); })()`); }
  catch (e) { asserts.push('free 页抛错: ' + e.message); }
  check(String((elements.get('free-pool-body') || {})._innerHTML || '').includes('读不到账号会话站点'),
    '账号会话页读不到时仍显示空态');
  // 产品页：读不到账号时不能显示「还没有账号，点添加」（账号像被删了）
  try { await run(`(async () => { state.view = 'qoder'; render(); })()`); }
  catch (e) { asserts.push('产品页拒绝场景抛错: ' + e.message); }
  const listHtml = String((elements.get('list') || {})._innerHTML || '');
  check(listHtml.includes('读不到账号列表'), '产品页读不到账号时仍显示「还没有账号」空态');
  check(!listHtml.includes('还没有 Qoder 账号'), '产品页读不到时仍渲染添加引导');
  check(String((elements.get('s-count') || {}).textContent || '') === '!', '产品页账号统计未标读不到');

  const wiring = unhandled.filter((e) => /ReferenceError|TypeError|is not defined|Cannot read/.test(e));
  const toastEl = elements.get('toast');
  if (toastEl && toastEl.textContent) console.log('TOAST: ' + toastEl.textContent);
  const bootBusy = elements.get('boot-busy');
  if (bootBusy) console.log('BOOT-BUSY innerHTML:', (bootBusy._innerHTML || '').slice(0, 100));
  for (const e of asserts) console.error('ASSERT: ' + e);
  for (const e of unhandled) console.error('UNHANDLED: ' + e.slice(0, 120));

  if (asserts.length || wiring.length || unhandled.length) {
    console.error('PANEL BOOT FAIL: ' + asserts.length + ' asserts, ' + wiring.length + ' wiring errors, ' + unhandled.length + ' unhandled');
    process.exit(1);
  }
  console.log('PANEL BOOT OK: ' + fetchCalls.length + ' api calls, cookie-sites 统一到期口径, fail-closed 读不到提示到位, 无 wiring 异常');
  process.exit(0);
})();
