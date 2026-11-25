import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-ann-'));

const {
  ANNOUNCEMENTS_CANDIDATE_URLS,
  ANNOUNCEMENTS_CACHE_TTL_MS,
  createAnnouncementsService,
  getBundledAnnouncements,
} = await import('../src/announcements.js');
const { startDaemon } = await import('../src/daemon.js');
const { closeArchiveStream } = await import('../src/logger.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('announcements.json：数据结构与首期公告字段完备', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'announcements.json'), 'utf8'));
  assert.ok(raw._format && typeof raw._format === 'object', '缺少 _format 规范说明');
  assert.match(String(raw.updatedAt || ''), /^\d{4}-\d{2}-\d{2}$/, 'updatedAt 应为 YYYY-MM-DD');
  assert.ok(Array.isArray(raw.items) && raw.items.length >= 3 && raw.items.length <= 10, '首期应包含 3~10 条公告');

  const ids = new Set();
  for (const it of raw.items) {
    assert.ok(typeof it.id === 'string' && it.id.length > 0 && !ids.has(it.id), `id 必须唯一且非空: ${it.id}`);
    ids.add(it.id);
    assert.match(it.date, /^\d{4}-\d{2}-\d{2}$/, `date 须为 YYYY-MM-DD: ${it.id}`);
    assert.ok(['feature', 'promo', 'info', 'warning', 'critical'].includes(it.level), `非法 level: ${it.level}`);
    assert.ok(typeof it.title === 'string' && it.title.length > 0);
    assert.ok(typeof it.body === 'string' && it.body.length > 0);
    assert.ok(typeof it.titleEn === 'string' && it.titleEn.length > 0);
    assert.ok(typeof it.bodyEn === 'string' && it.bodyEn.length > 0);
    if (it.link) assert.match(it.link, /^https:\/\//);
  }

  const allText = raw.items.map((x) => `${x.title} ${x.body}`).join('\n');
  assert.match(allText, /GitHub Releases/, '应包含 GitHub Releases 官方渠道声明');
  assert.match(allText, /豆包.*个人|飞书企业/, '应包含豆包仅限个人账号/飞书企业号不支持说明');
  assert.match(allText, /Croli.*下架|移除/, '应包含 Croli 产品线已下架说明');
});

test('announcements 服务：候选源顺序正确（GitHub raw → fastly → cdn → Gitee）', () => {
  assert.equal(ANNOUNCEMENTS_CANDIDATE_URLS[0], 'https://raw.githubusercontent.com/techysy/CreditDaddy/refs/heads/main/announcements.json');
  assert.equal(ANNOUNCEMENTS_CANDIDATE_URLS[1], 'https://fastly.jsdelivr.net/gh/techysy/CreditDaddy@main/announcements.json');
  assert.equal(ANNOUNCEMENTS_CANDIDATE_URLS[2], 'https://cdn.jsdelivr.net/gh/techysy/CreditDaddy@main/announcements.json');
  assert.equal(ANNOUNCEMENTS_CANDIDATE_URLS[3], 'https://gitee.com/techysy/CreditDaddy/raw/main/announcements.json');
});

test('announcements 服务：TTL 缓存、非阻塞后台刷新与 ?check=1 强制刷新', async () => {
  let now = 1_000_000;
  let remoteVersion = 1;
  const calls = [];
  const svc = createAnnouncementsService({
    bundledFeed: { updatedAt: '2026-11-25', items: [{ id: 'bundled-1', date: '2026-11-25', level: 'info', title: '兜底公告' }] },
    candidateUrls: ['https://primary.test/announcements.json'],
    ttlMs: ANNOUNCEMENTS_CACHE_TTL_MS,
    nowFn: () => now,
    fetchImpl: async (url) => {
      calls.push(url);
      const v = remoteVersion;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          updatedAt: '2026-11-25',
          items: [{ id: `remote-${v}`, date: '2026-11-25', level: 'feature', title: `远程公告 v${v}` }],
        }),
      };
    },
  });

  // 1. 首次非 check 请求：立即返回兜底，后台异步刷新
  const first = await svc.getAnnouncements({ check: false });
  assert.equal(first.items[0].id, 'bundled-1', '首次过期应非阻塞先返回随包兜底');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1, '后台刷新应被触发一次');

  // 2. TTL 内再次请求：命中内存缓存，不发新请求
  now += 60 * 1000;
  const cached = await svc.getAnnouncements({ check: false });
  assert.equal(cached.items[0].id, 'remote-1');
  assert.equal(calls.length, 1, 'TTL 内不得重复请求远端');

  // 3. TTL 过期后非 check：先返回旧缓存，同时非阻塞后台刷新
  remoteVersion = 2;
  now += ANNOUNCEMENTS_CACHE_TTL_MS + 1000;
  const staleImmediate = await svc.getAnnouncements({ check: false });
  assert.equal(staleImmediate.items[0].id, 'remote-1', '过期时非 check 仍应立即返回旧缓存');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 2, '过期后应触发后台刷新');
  const refreshed = await svc.getAnnouncements({ check: false });
  assert.equal(refreshed.items[0].id, 'remote-2');

  // 4. ?check=1 强制同步刷新，并发请求复用同一飞行中 promise
  remoteVersion = 3;
  const [a, b] = await Promise.all([
    svc.getAnnouncements({ check: true }),
    svc.getAnnouncements({ check: true }),
  ]);
  assert.equal(a.items[0].id, 'remote-3');
  assert.equal(b.items[0].id, 'remote-3');
  assert.equal(calls.length, 3, '并发 check=1 应单飞去重');
});

test('announcements 服务：依次回源镜像并在全挂时兜底随包 announcements.json', async () => {
  const attempted = [];
  const svc = createAnnouncementsService({
    bundledFeed: getBundledAnnouncements(),
    candidateUrls: [
      'https://u1.test/a.json',
      'https://u2.test/a.json',
      'https://u3.test/a.json',
      'https://u4.test/a.json',
    ],
    fetchImpl: async (url) => {
      attempted.push(url);
      if (url.includes('u1')) throw new Error('network down');
      if (url.includes('u2')) return { ok: false, status: 502, json: async () => ({}) };
      if (url.includes('u3')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ updatedAt: '2026-11-25', items: [{ id: 'mirror-4', date: '2026-11-25', level: 'promo', title: 'Gitee 备源成功' }] }),
      };
    },
  });

  const okFeed = await svc.getAnnouncements({ check: true });
  assert.deepEqual(attempted, [
    'https://u1.test/a.json',
    'https://u2.test/a.json',
    'https://u3.test/a.json',
    'https://u4.test/a.json',
  ]);
  assert.equal(okFeed.items[0].id, 'mirror-4');

  // 全部镜像都不可用时，始终返回随包兜底
  const bundled = getBundledAnnouncements();
  const failSvc = createAnnouncementsService({
    bundledFeed: bundled,
    candidateUrls: ['https://bad1.test/a.json', 'https://bad2.test/a.json'],
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const fallbackFeed = await failSvc.getAnnouncements({ check: true });
  assert.equal(fallbackFeed.items.length, bundled.items.length);
  assert.equal(fallbackFeed.items[0].id, bundled.items[0].id);
});

test('daemon HTTP：GET /api/announcements 与 ?check=1 始终返回 200 合法结构', async () => {
  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/announcements`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /max-age=60/);
    const body = await res.json();
    assert.ok(Array.isArray(body.items) && body.items.length >= 3);

    const resCheck = await fetch(`http://127.0.0.1:${port}/api/announcements?check=1`);
    assert.equal(resCheck.status, 200);
    const bodyCheck = await resCheck.json();
    assert.ok(Array.isArray(bodyCheck.items) && bodyCheck.items.length >= 3);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('panel.html：捐赠反倒卖声明、公告按钮/弹窗、90天过滤、10条上限与中英文切换', async () => {
  const html = await fs.readFile(path.join(ROOT, 'src/panel.html'), 'utf8');

  // 1. #m-donate 反倒卖声明
  const donateBlock = html.slice(html.indexOf('id="m-donate"'), html.indexOf('id="m-announcements"'));
  assert.ok(donateBlock.includes('本软件永久免费开源，唯一官方发布渠道是 GitHub Releases——任何付费购买的版本均非官方。'));
  assert.ok(donateBlock.includes('https://github.com/techysy/CreditDaddy/releases'));

  // 2. 公告按钮在捐赠按钮左侧且含红点角标
  const annBtnPos = html.indexOf('id="announcements-btn"');
  const donateBtnPos = html.indexOf('id="donate-btn"');
  assert.ok(annBtnPos > 0 && donateBtnPos > annBtnPos, '公告按钮应位于捐赠支持按钮左侧');
  assert.ok(html.includes('id="announcements-badge"'));

  // 3. 五种等级色卡样式与狂野派适配存在
  for (const cls of ['.ann-card.lvl-critical', '.ann-card.lvl-warning', '.ann-card.lvl-promo', '.ann-card.lvl-feature', '.ann-card.lvl-info']) {
    assert.ok(html.includes(cls), `缺少样式 ${cls}`);
  }
  assert.ok(html.includes('html[data-theme="brutal"] .ann-card'));

  // 4. 在 vm 中验证前端公告数据处理逻辑（90 天过滤、10 条门禁、排序、中英文、已读持久化）
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);
  const store = {};
  const elements = new Map();
  const makeEl = (id) => ({
    id, _innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false,
    dataset: {}, style: new Proxy({}, { get: () => '', set: () => true }),
    classList: { add(){}, remove(){}, toggle(){ return false; }, contains(){ return false; } },
    addEventListener(){}, removeEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; },
    get innerHTML() { return this._innerHTML; }, set innerHTML(v) { this._innerHTML = String(v); },
  });
  const doc = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
    querySelector() { return makeEl('q'); },
    querySelectorAll() { return []; },
    createElement(t) { return makeEl(t); },
    addEventListener(){}, removeEventListener(){},
    documentElement: makeEl('html'), body: makeEl('body'), head: makeEl('head'),
  };
  const ctx = {
    console, document: doc,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    location: { href: 'http://127.0.0.1:47860/', origin: 'http://127.0.0.1:47860', search: '', pathname: '/', hash: '', reload(){} },
    navigator: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ items: [] }), text: async () => '{}' }),
    URL, Blob, Event, CustomEvent: Event, AbortController, AbortSignal: globalThis.AbortSignal,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }, FormData: class {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, queueMicrotask,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: undefined,
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(scriptMatch[1], ctx);

  const today = new Date().toISOString().slice(0, 10);
  const oldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rawItems = [
    { id: 'old', date: oldDate, level: 'critical', title: '过期公告' },
    { id: 'info-1', date: today, level: 'info', title: '信息卡', titleEn: 'Info Card', body: '中文正文', bodyEn: 'English Body', link: 'https://example.com' },
    { id: 'crit-1', date: today, level: 'critical', title: '紧急卡', titleEn: 'Critical Card', body: '紧急内容', bodyEn: 'Critical Body' },
  ];
  for (let i = 0; i < 10; i++) {
    rawItems.push({ id: `extra-${i}`, date: today, level: 'promo', title: `活动 ${i}`, body: '活动正文' });
  }
  const normalized = ctx.normalizeAnnouncementsFeed({ items: rawItems });
  assert.equal(normalized.some((x) => x.id === 'old'), false, '超过 90 天的公告应自动隐藏');
  assert.equal(normalized[0].id, 'crit-1', 'critical 应排在最前面');
  assert.equal(normalized[normalized.length - 1].id, 'info-1', 'info 应排在最后面');
  assert.equal(normalized.length, 12);

  // 未读红点只统计最新 10 条（MAX_DISPLAY = 10 → 9+）
  store['cd.announcements.cache'] = JSON.stringify({ items: normalized });
  assert.equal(ctx.computeUnreadAnnouncements(), 10);
  ctx.renderAnnouncementsBadge();
  assert.equal(doc.getElementById('announcements-badge').textContent, '9+');
  assert.equal(doc.getElementById('announcements-badge').hidden, false);

  // 全部标为已读后，红点清零且持久化到 localStorage
  ctx.markAnnouncementsSeen(normalized.map((x) => x.id));
  assert.equal(ctx.computeUnreadAnnouncements(), 0);
  assert.equal(doc.getElementById('announcements-badge').hidden, true);
  assert.ok(JSON.parse(store['cd.announcements.seen']).includes('crit-1'));

  // 英文切换：英文界面优先显示 titleEn/bodyEn 与 Learn more
  ctx.__testEnItems = [normalized[0], normalized[normalized.length - 1]];
  vm.runInContext(`
    state.locale = 'en';
    I18N_DICT = { '了解更多': 'Learn more', '仅展示最新 10 条公告，更早条目已自动隐藏。': 'Showing the latest 10 announcements — older entries are hidden.' };
    renderAnnouncementsBody(__testEnItems);
  `, ctx);
  const enHtml = doc.getElementById('announcements-body').innerHTML;
  assert.ok(enHtml.includes('Critical Card'));
  assert.ok(enHtml.includes('English Body'));
  assert.ok(enHtml.includes('Learn more'));
});

test.after(() => closeArchiveStream());
