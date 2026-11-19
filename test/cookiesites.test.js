/**
 * 通用 cookie 站点捕获（issue #23 —— tokenharbor 为首的配置驱动接入）回归：
 * - serializeCookies 去重与拼接形状（handler 接受的 plain string）
 * - verifySiteCookie 的四种结局（invalid / no-match / http / network）
 * - daemon 捕获端点的完整流：探测通过 → 入库去重 → 同步载荷形状（providerSpecificData.creditDaddyWebSession）
 * - tokenharbor 账号不得落进 Qoder 页签（productOf → 'tokenharbor' 守卫）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-csite-'));
// 预加载 logger：归档目录钉在本文件级临时 home（不随用例切换、也不会被逐用例 rm）。
// 否则第一个 import daemon 的用例里 logger 才初始化，归档流句柄开在用例临时目录上——
// Windows/libuv 允许 delete-pending 但目录在句柄关闭前不消失，fs.rm 必吃 ENOTEMPTY
// （Node 20 CI 确定性翻车，Node 24 时序碰巧赢）。
await import('../src/logger.js');

const { serializeCookies, getSite, siteForLoginUrl, verifySiteCookie, COOKIE_SITES } = await import('../src/cookieSites.js');
const { buildConnPayload, mapProviderId } = await import('../src/tenrouterAccounts.js');
const { productOf } = await import('../src/constants.js');

test('serializeCookies：同名按后者去重、拼成 plain string', () => {
  const out = serializeCookies([
    { name: 'a', value: '1' },
    { name: 'a', value: '2' },   // host-only 后写覆盖域级
    { name: 'b', value: 'x y' },
    { name: '' , value: 'drop' },
    null,
  ]);
  assert.equal(out, 'a=2; b=x y');
});

test('配置表：getSite / siteForLoginUrl 命中与未命中', () => {
  assert.equal(getSite('tokenharbor').provider, 'tokenharbor');
  assert.equal(getSite('nope'), null);
  assert.equal(siteForLoginUrl('https://tokenharbor.ai/login').id, 'tokenharbor');
  assert.equal(siteForLoginUrl('https://tokenharbor.ai/dashboard').id, 'tokenharbor');
  assert.equal(siteForLoginUrl('https://qoder.com/auth/login'), null);
});

test('verifySiteCookie：invalid / no-match / http / network 四种结局 + 登录页壳分类', async () => {
  const site = COOKIE_SITES[0];
  const fake = (status, text = '') => async () => ({ status, text: async () => text });
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(401) })).reason, 'invalid');
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(200, '<html>nothing here</html>') })).reason, 'no-match');
  // 会话过期被挡回登录页 = invalid(与 10Router AUTH_EXPIRED 分类对齐),不是 layout-change
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(200, '<html><title>Sign in</title><form>log in</form></html>') })).reason, 'invalid');
  assert.deepEqual((await verifySiteCookie(site, 'c', { fetchImpl: fake(500) })).reason, 'http');
  assert.equal((await verifySiteCookie(site, 'c', { fetchImpl: fake(200, '<html>Free allowance 20% used</html>') })).ok, true);
  const netFail = async () => { throw new Error('boom'); };
  assert.equal((await verifySiteCookie(site, 'c', { fetchImpl: netFail })).reason, 'network');
});

test('verifySiteCookie：探测按浏览器形头发送（裸 UA 会拿到空壳页误判 no-match）', async () => {
  const site = COOKIE_SITES[0];
  let seen = null;
  const spy = async (url, init) => { seen = init.headers; return { status: 200, text: async () => '<html>Free allowance 10% used</html>' }; };
  await verifySiteCookie(site, 'alive=1', { fetchImpl: spy });
  assert.ok(seen, 'fetch 必须被调用');
  assert.ok(/Chrome\//.test(seen['User-Agent'] || ''), '要有浏览器 UA(裸 undici UA 会被边缘节点喂空壳页)');
  assert.ok((seen['Accept'] || '').includes('text/html'), 'Accept 为 HTML');
  assert.ok((seen['Referer'] || '').startsWith('https://tokenharbor.ai'), 'Referer 带站点首页');
  assert.equal(seen['Cookie'], 'alive=1');
});

test('buildConnPayload：tokenharbor 按通用形状挂会话；qoder 老形状不回归；无会话仅带 CD 同步标记', () => {
  const th = { id: 'x1', provider: 'tokenharbor', token: 'a=b; c=d', name: 'Token Harbor 网页会话', meta: { cookieSiteSession: { cookie: 'a=b; c=d', capturedAt: '2026-10-11T00:00:00Z' } } };
    const p1 = buildConnPayload(th, 'tokenharbor-free');
  assert.equal(p1.provider, 'tokenharbor-free');
  // sync map must land on the monitor card (wallet card is /v1 transport, cookie doesn't belong there)
  assert.equal(mapProviderId('tokenharbor'), 'tokenharbor-free');

  const q = { id: 'x2', provider: 'qoder', token: 'jwt', uid: 'u123', name: 'Q', meta: { qoderWebSession: { cookie: 's=1', capturedAt: '2026-10-01T00:00:00Z' } } };
  const p2 = buildConnPayload(q, 'qoder');
  assert.equal(p2.providerSpecificData.creditDaddyWebSession.cookie, 's=1');
  assert.equal(p2.providerSpecificData.userId, 'u123');
  assert.equal(p2.providerSpecificData.creditDaddySync, true);

  // 无网页会话的连接（CodeBuddy 等）也带同步标记，10R 徽章据此区分「CD Sync / Native」
  const plain = { id: 'x3', provider: 'workbuddy', token: 't', name: 'W' };
  const p3 = buildConnPayload(plain, 'codebuddy-cn');
  assert.equal(p3.providerSpecificData.creditDaddySync, true);
  assert.equal(p3.providerSpecificData.creditDaddyWebSession, undefined);
});

test('tokenharbor 账号不落入 Qoder 页签（productOf 守卫，面板列表隔离）', () => {
  assert.equal(productOf('tokenharbor'), 'tokenharbor');
  assert.notEqual(productOf('tokenharbor'), 'qoder');
});

test('verifyProbeHtml：浏览器探针产 HTML 的纯文本判定(marker / 登录页壳)', async () => {
  const { verifyProbeHtml } = await import('../src/cookieSites.js');
  const site = COOKIE_SITES[0];
  assert.equal(verifyProbeHtml(site, '<html><h1>Free allowance 40% used</h1></html>').ok, true);
  assert.equal(verifyProbeHtml(site, '<html><form action="/login">Sign in</form></html>').reason, 'invalid');
  assert.equal(verifyProbeHtml(site, '<html><body>crypto challenge page</body></html>').reason, 'no-match');
});

test('daemon 捕获端点：探测通过入库去重；401 拒绝；/api/cookie-sites 报捕获时间', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-csite-e2e-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ panelKey: '', panelKeyHash: '' }));
  // 本地假站:探测地址由测试后门 CD_PROBE_TOKENHARBOR 指进来
  const fake = http.createServer((req, res) => {
    if (req.headers.cookie?.includes('alive=1')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Free allowance 40% used</html>'); }
    else { res.writeHead(401); res.end('no'); }
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const probePort = fake.address().port;

  const savedHome = process.env.CREDITDADDY_HOME;
  const savedProbe = process.env.CD_PROBE_TOKENHARBOR;
  process.env.CREDITDADDY_HOME = home;
  process.env.CD_PROBE_TOKENHARBOR = `http://127.0.0.1:${probePort}/dashboard`;
  let daemon;
  try {
    daemon = await import('../src/daemon.js');
    const { server, port } = await daemon.startDaemon(0, '127.0.0.1');
    try {
      const post = (body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/cookie-sites/tokenharbor/capture', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });

      const bad = await post({ cookie: 'dead=0', diag: { cookieCount: 1 } });
      assert.equal(bad.status, 401, '探测 401 必须回 401（会话不可用）');

      const ok1 = await post({ cookie: 'alive=1; theme=dark', diag: { cookieCount: 2 } });
      assert.equal(ok1.status, 200);
      assert.ok(ok1.body.accountId);

      // 第二次捕获同一站点 → 原位更新,不新增行(provider 单例合并)
      const ok2 = await post({ cookie: 'alive=1; theme=light', diag: { cookieCount: 2 } });
      assert.equal(ok2.status, 200);
      assert.equal(ok2.body.accountId, ok1.body.accountId, '同一站点重复捕获应原位更新');

      const sites = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/cookie-sites' }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
        req.end();
      });
      const row = sites.sites.find((x) => x.id === 'tokenharbor');
      assert.equal(row.accounts.length, 1, '每账号行:1 行');
      assert.equal(row.accounts[0].id, ok1.body.accountId);
      assert.ok(row.capturedAt, '捕获时间已回显');

      // 多账号轮换:换一份邮箱身份 → 新行;按身份再捕 → 原位轮换不重行
      const okA = await post({ cookie: 'alive=1', diag: { cookieCount: 1 }, probeHtml: '<html>yang@a.com <h1>Free allowance 10%</h1></html>' });
      assert.equal(okA.status, 200);
      const okB = await post({ cookie: 'alive=1', diag: { cookieCount: 1 }, probeHtml: '<html>other@b.com <h1>Free allowance 20%</h1></html>' });
      assert.equal(okB.status, 200);
      assert.notEqual(okB.body.accountId, okA.body.accountId, '不同身份必须成新行');
      const okA2 = await post({ cookie: 'alive=1', diag: { cookieCount: 1 }, probeHtml: '<html>yang@a.com <h1>Free allowance 30%</h1></html>' });
      assert.equal(okA2.body.accountId, okA.body.accountId, '同身份=凭证轮换,不重行');
      const sites2 = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/cookie-sites' }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
        req.end();
      });
      const row2 = sites2.sites.find((x) => x.id === 'tokenharbor');
      assert.equal(row2.accounts.length, 3, '两笔有身份 + 一笔无身份单例 = 3 行');

      const accounts = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8'));
      const rows = accounts.filter((a) => a.provider === 'tokenharbor');
      assert.equal(rows.length, 3, '单例 1 + 两身份 2,共 3 行,不重复建行');
      const names = rows.map((a) => a.name || '').sort().join('|');
      assert.ok(names.includes('yang@a.com') && names.includes('other@b.com'), '行名带身份后缀');
      const acc = rows.find((a) => !a.meta.identityHash);
      assert.equal(acc.token, 'alive=1; theme=light');
      assert.equal(acc.meta.cookieSiteSession.cookie, 'alive=1; theme=light');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env.CREDITDADDY_HOME = savedHome;
    if (savedProbe === undefined) delete process.env.CD_PROBE_TOKENHARBOR;
    else process.env.CD_PROBE_TOKENHARBOR = savedProbe;
    fake.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('手改备注名不被捕获/重探的自动名覆盖（含历史无标记改名）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-csite-rename-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ panelKey: '', panelKeyHash: '' }));
  // 探针页带邮箱：重探时会想抽身份并自动命名——手改名必须挡住
  const fake = http.createServer((req, res) => {
    if (req.headers.cookie?.includes('alive=1')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>yang@a.com <h1>Free allowance 20% used</h1></html>');
    } else { res.writeHead(401); res.end('no'); }
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const probePort = fake.address().port;
  const savedHome = process.env.CREDITDADDY_HOME;
  const savedProbe = process.env.CD_PROBE_TOKENHARBOR;
  process.env.CREDITDADDY_HOME = home;
  process.env.CD_PROBE_TOKENHARBOR = `http://127.0.0.1:${probePort}/dashboard`;
  let daemon;
  try {
    daemon = await import('../src/daemon.js');
    const { server, port } = await daemon.startDaemon(0, '127.0.0.1');
    try {
      const call = (method, p, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
      const readAcc = async (id) => {
        const accs = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8'));
        return accs.find((a) => a.id === id);
      };

      // 建行（自动名 Token Harbor 网页会话(yang@a.com)）
      const cap = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com <h1>Free allowance 20%</h1></html>',
      });
      assert.equal(cap.status, 200);
      const accId = cap.body.accountId;

      // ① 新改名（PATCH 打 renamed 标记）→ 重探 + 重捕不得覆盖
      const patch = await call('PATCH', `/api/accounts/${accId}`, { name: 'TH 主号' });
      assert.equal(patch.status, 200);
      assert.equal((await readAcc(accId)).meta.renamed, true, 'PATCH 需留 renamed 标记');

      const rp1 = await call('POST', '/api/cookie-sites/tokenharbor/reprobe', { accountId: accId });
      assert.equal(rp1.status, 200);
      assert.equal(rp1.body.results[0].ok, true);
      assert.equal((await readAcc(accId)).name, 'TH 主号', '重探不得覆盖手改备注名');

      await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com <h1>Free allowance 30%</h1></html>',
      });
      assert.equal((await readAcc(accId)).name, 'TH 主号', '重捕不得覆盖手改备注名');

      // ② 历史改名（旧版无 renamed 标记）→ 同样不得覆盖
      const accs = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8'));
      const row = accs.find((a) => a.id === accId);
      row.name = '历史改名';
      delete row.meta.renamed;
      await fs.writeFile(path.join(home, 'accounts.json'), JSON.stringify(accs, null, 2));

      const rp2 = await call('POST', '/api/cookie-sites/tokenharbor/reprobe', { accountId: accId });
      assert.equal(rp2.status, 200);
      assert.equal(rp2.body.results[0].ok, true);
      assert.equal((await readAcc(accId)).name, '历史改名', '历史改名（无 renamed 标记）也不得被自动名覆盖');

      // ③ 自动名仍可随身份升级：清空名后重探写回自动名
      const accs2 = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8'));
      const row2 = accs2.find((a) => a.id === accId);
      row2.name = null;
      delete row2.meta.renamed;
      await fs.writeFile(path.join(home, 'accounts.json'), JSON.stringify(accs2, null, 2));
      const rp3 = await call('POST', '/api/cookie-sites/tokenharbor/reprobe', { accountId: accId });
      assert.equal(rp3.body.results[0].ok, true);
      assert.match((await readAcc(accId)).name || '', /yang@a\.com/, '空名行重探应回填自动名');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env.CREDITDADDY_HOME = savedHome;
    if (savedProbe === undefined) delete process.env.CD_PROBE_TOKENHARBOR;
    else process.env.CD_PROBE_TOKENHARBOR = savedProbe;
    fake.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('会话槽（会话池）：slot 随捕获落 meta.cookieSlot；同身份异槽分行并存；GET 回显槽号', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-csite-slot-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ panelKey: '', panelKeyHash: '' }));
  const fake = http.createServer((req, res) => {
    if (req.headers.cookie?.includes('alive=1')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>yang@a.com <h1>Free allowance 10%</h1></html>'); }
    else { res.writeHead(401); res.end('no'); }
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const probePort = fake.address().port;
  const savedHome = process.env.CREDITDADDY_HOME;
  const savedProbe = process.env.CD_PROBE_TOKENHARBOR;
  process.env.CREDITDADDY_HOME = home;
  process.env.CD_PROBE_TOKENHARBOR = `http://127.0.0.1:${probePort}/dashboard`;
  let daemon;
  try {
    daemon = await import('../src/daemon.js');
    const { server, port } = await daemon.startDaemon(0, '127.0.0.1');
    try {
      const call = (method, p, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });

      // 槽 1（缺省）：不落 cookieSlot 标记（老行零迁移）
      const s1 = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', slot: 1, diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com <h1>Free allowance 10%</h1></html>',
      });
      assert.equal(s1.status, 200);
      const id1 = s1.body.accountId;

      // 槽 2 同身份：必须成新行（异槽不合并——「主号/小号各占一槽」的根基）
      const s2 = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', slot: 2, diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com <h1>Free allowance 20%</h1></html>',
      });
      assert.equal(s2.status, 200);
      assert.notEqual(s2.body.accountId, id1, '同身份异槽必须分行并存');
      const id2 = s2.body.accountId;

      // 槽 2 重复捕获：原位轮换，不重行
      const s2b = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', slot: 2, diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com <h1>Free allowance 30%</h1></html>',
      });
      assert.equal(s2b.body.accountId, id2, '同槽同身份=凭证轮换');

      // 槽 3 无身份（probeHtml 缺失走 Node 探测→无身份单例）：与槽 1 的无身份单例也不合并
      // ——但本用例槽 1 已有身份（probeHtml 带邮箱），这里 slot:3 无 probeHtml → 401 探测拒绝
      // （fake 站按 cookie 放行，无 probeHtml 走 verifySiteCookie 探测 → 活着）→ 无身份单例落槽 3
      const s3 = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', slot: 3, diag: { cookieCount: 1 },
      });
      assert.equal(s3.status, 200);
      assert.notEqual(s3.body.accountId, id1, '无身份行按槽隔离');

      const accs = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8'));
      const rows = accs.filter((a) => a.provider === 'tokenharbor');
      assert.equal(rows.length, 3, '三槽三行');
      const slotOf = (id) => rows.find((a) => a.id === id)?.meta?.cookieSlot;
      assert.equal(slotOf(id1), undefined, '槽 1 不落标记（缺省 = 既有分区）');
      assert.equal(slotOf(id2), 2, '槽 2 落 cookieSlot=2');
      assert.equal(slotOf(s3.body.accountId), 3, '槽 3 落 cookieSlot=3');

      // 越界槽号 → 归 1（守卫）
      const bad = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', slot: 99, diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com <h1>Free allowance 40%</h1></html>',
      });
      assert.equal(bad.status, 200);
      assert.equal(bad.body.accountId, id1, '越界槽号归 1，与槽 1 原位轮换');

      // 槽 7（旧上限内的合法号，现退役）→ 同样归 1：上限 6 由 daemon 与桌面壳双侧守卫
      const s7 = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', slot: 7, diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com <h1>Free allowance 40%</h1></html>',
      });
      assert.equal(s7.status, 200);
      assert.equal(s7.body.accountId, id1, '槽 7 越界归 1（上限 6，2026-11-19 用户定版）');

      // GET /api/cookie-sites 回显槽号（槽 1 缺省也显式回 1，面板徽章零特判）
      const sites = await call('GET', '/api/cookie-sites');
      const row = sites.body.sites.find((x) => x.id === 'tokenharbor');
      const slots = row.accounts.map((a) => a.cookieSlot).sort();
      assert.deepEqual(slots, [1, 2, 3], '槽号回显（槽 1 无标记行回 1；越界轮换未增行）');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env.CREDITDADDY_HOME = savedHome;
    if (savedProbe === undefined) delete process.env.CD_PROBE_TOKENHARBOR;
    else process.env.CD_PROBE_TOKENHARBOR = savedProbe;
    fake.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('网页会话账号「刷新积分」（/quota 端点）走重探语义：lastProbe 更新 + 余额回填（回归：原 productImpl undefined 崩 502、呼吸灯不动）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-quota-csite-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ panelKey: '', panelKeyHash: '' }));
  const fake = http.createServer((req, res) => {
    if (req.headers.cookie?.includes('alive=1')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>yang@a.com Free allowance 55% used</html>'); }
    else { res.writeHead(401); res.end('no'); }
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const probePort = fake.address().port;
  const savedHome = process.env.CREDITDADDY_HOME;
  const savedProbe = process.env.CD_PROBE_TOKENHARBOR;
  process.env.CREDITDADDY_HOME = home;
  process.env.CD_PROBE_TOKENHARBOR = `http://127.0.0.1:${probePort}/dashboard`;
  let daemon;
  try {
    daemon = await import('../src/daemon.js');
    const { server, port } = await daemon.startDaemon(0, '127.0.0.1');
    try {
      const call = (method, p, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });

      const cap = await call('POST', '/api/cookie-sites/tokenharbor/capture', {
        cookie: 'alive=1', diag: { cookieCount: 1 },
        probeHtml: '<html>yang@a.com Free allowance 55%</html>',
      });
      assert.equal(cap.status, 200);
      const accId = cap.body.accountId;

      // /quota 端点（产品页「刷新积分」按钮走的就是它）：?live=1 强制真探——
      // 回填 lastProbe + 余额快照。默认（无 live）读缓存零网络，面板 2 分钟自动轮询走那条。
      const q = await call('GET', `/api/accounts/${accId}/quota?live=1`);
      assert.equal(q.status, 200, `quota 端点应 200，实际 ${q.status} ${JSON.stringify(q.body)}`);
      // tokenharbor = HTML 探针站：统一结构 total=100、remaining=100-used（55% 用了 → 45）
      assert.ok(q.body.quota && Number(q.body.quota.remaining) === 45, 'quota 统一结构（HTML 站 remaining=100-used）');
      // HTML 探针站是百分比口径 → 带 unit='%' 回（面板 creditSum 按 unit 有无决定是否
      // 计入「剩余积分」合计——Token/USD/魔粒等不同量纲永不与产品积分相加）
      assert.equal(q.body.quota.unit, '%', 'HTML 站 quota 带 unit=%（排除出剩余积分合计）');

      const acc = JSON.parse(await fs.readFile(path.join(home, 'accounts.json'), 'utf8')).find((a) => a.id === accId);
      assert.equal(acc.meta.lastProbe?.ok, true, 'lastProbe 必须更新（呼吸灯才会转绿）');
      assert.equal(acc.meta.quotaSnapshot?.used, 55, '余额快照回填（HTML 站 = used 百分比）');

      // 缓存路径（无 ?live=1）：读 meta.quotaSnapshot 零上游请求——面板 2 分钟自动轮询走这条，
      // 频率治理的回归锚点。改了缓存读取语义或又接回 live 探测，这里立刻红。
      const qCache = await call('GET', `/api/accounts/${accId}/quota`);
      assert.equal(qCache.status, 200);
      assert.ok(qCache.body.quota && Number(qCache.body.quota.remaining) === 45, '缓存路径回同一数字（45）');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env.CREDITDADDY_HOME = savedHome;
    if (savedProbe === undefined) delete process.env.CD_PROBE_TOKENHARBOR;
    else process.env.CD_PROBE_TOKENHARBOR = savedProbe;
    fake.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ── 会话池 persistKey 白名单与站点 id 全表一致性（2026-11-19 用户实测 MiMo 会话槽失效回归钉）──
// desktop/main.js 的 IPC 校验正则必须认下 COOKIE_SITES 里每一个站点 id 构造出的分区名——
// [a-z0-9]+ 少了连字符时，xiaomi-mimo 这类带连字符 id 的 persistKey 被静默判非法回落 null，
// 所有槽开在同一个无痕分区、收割 slot 全缺省成 1（用户会话 2 登录的号全进会话 1）。
test('会话池 persistKey 白名单认下全部站点 id（含连字符）与槽号组合', async () => {
  const { COOKIE_SITES } = await import('../src/cookieSites.js');
  // 与 desktop/main.js open-auth-window / clear-cookie-site-session 的校验保持同一形状；
  // 这里的字面量是两处 IPC 正则的镜像，改桌面壳时若不同步这里立刻红。
  // 白名单是「不透传任意值」的字符集闸，不是槽号校验器（槽号语义由构造侧保证）：
  // x-s10 这类歧义串会命中 id 段，但它构造出的分区与任何真实槽都不同名，读不到别的槽数据。
  // 槽位上限 6（2026-11-19 用户定版「9 个太多了，6 个合适」）：桌面壳正则只收 -s2..s6
  const re = /^cookie-site-[a-z0-9-]+-s[2-6]$|^cookie-site-[a-z0-9-]+$/;
  const offenders = [];
  for (const site of COOKIE_SITES) {
    if (!re.test('cookie-site-' + site.id)) offenders.push(site.id + ' (槽1)');
    for (const s of [2, 5, 6]) {
      if (!re.test('cookie-site-' + site.id + '-s' + s)) offenders.push(site.id + ' (槽' + s + ')');
    }
  }
  assert.deepEqual(offenders, [], '以下站点 id 的 persistKey 过不了 IPC 白名单: ' + offenders.join(', '));
  // 反向：非法形态必须仍被拒（不透传任意值的安全语义不因放宽而丢失）。
  // 注意 cookie-site-x-s1 会整串命中（s1 被 id 段吞掉）——无害：面板构造的槽 1 key 本就不带
  // 后缀，-s1 形态只可能来自恶意输入，而它构造出的分区与任何真实槽都不同名，等价于开新池。
  assert.equal(re.test('cookie-site-../evil'), false);
  assert.equal(re.test(''), false);
  assert.equal(re.test('cookie-site-x'), true);
  // 歧义串（x-s10 / x-s2-extra 等）会被 id 段吞掉而命中——无害：它们构造出的分区与任何
  // 真实槽都不同名，读不到别的槽数据；槽号语义由构造侧（面板只从 COOKIE_SITES.id 拼 key）保证。
  assert.equal(re.test('cookie-site-x-s10'), true, '歧义串命中无害；槽号上限由构造侧保证');
  // s7/s9 歧义串被 id 段吞掉而命中——无害（同 x-s10：非真实槽名，读不到别的槽数据）；
  // 槽 7-9 退役的语义由 daemon capture 端点（slot≤6 归 1）与面板构造侧（候选列表到 6）保证
  assert.equal(re.test('cookie-site-x-s7'), true, '歧义串命中无害；槽 7 退役由 daemon/构造侧保证');
});

// ── Meoo 快照保鲜（2026-11-19 用户实测「都是手动领取+手动刷新，没有定时刷新」回归钉）──
// meoo 不推卡（no10rSync），被推送循环排除后快照只在捕获时与手动 ?live=1 更新——
// 现在推送循环里补了只拉不推的保鲜段（与灵犀 persistLive 同口径）。
test('推送循环为 meoo 账号保鲜快照：有效会话落余额+grants+探活绿，失效会话只落探活红不碰快照', async () => {
  const savedHome = process.env.CREDITDADDY_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cd-meoo-fresh-'));
  process.env.CREDITDADDY_HOME = home;
  try {
    const store = await import('../src/store.js');
    const oldAt = '2026-11-10T00:00:00.000Z';
    await store.saveAccounts([
      { id: 'm-ok', provider: 'meoo', name: 'Meoo 活号', meta: { cookieSiteId: 'meoo', cookieSiteSession: { cookie: 'a=b' }, quotaSnapshot: { used: 0, total: 500, at: oldAt } } },
      { id: 'm-dead', provider: 'meoo', name: 'Meoo 死号', meta: { cookieSiteId: 'meoo', cookieSiteSession: { cookie: 'dead=1' }, quotaSnapshot: { used: 0, total: 500, at: oldAt } } },
    ]);
    const fake = async (url) => {
      if (String(url).includes('entitlement/get')) {
        // 两号同 mock 无法区分——按 cookie 头分流
        return null;   // 占位：下方用闭包按账号分流（见 fetchImpl 传入两次调用）
      }
      return new Response('{}', { status: 404 });
    };
    const { runQuotaPush } = await import('../src/externalQuota.js');
    // 活号轮（fake 返回有效权益）
    const fakeOk = async () => new Response(JSON.stringify({
      success: true,
      data: { userPointInfo: { account: { availableBalance: 78983 }, activeGrants: [{ source: 'DAILY_LOGIN', total: 100, remaining: 60, expireAt: '2026-11-25T00:00:00Z' }] }, planCode: 'FREE' },
    }), { status: 200 });
    await runQuotaPush({ endpoint: 'http://127.0.0.1:1', key: 'x', accounts: await store.loadAccounts(), fetchImpl: fakeOk });
    await new Promise((r) => setTimeout(r, 300));
    const okRow = (await store.loadAccounts()).find((x) => x.id === 'm-ok');
    assert.equal(okRow.meta.quotaSnapshot.total, 78983, '活号快照被保鲜更新（500 → 78983）');
    assert.equal(Boolean(okRow.meta.meooGrants), true, 'grants 明细随保鲜落盘');
    assert.equal(okRow.meta.lastProbe?.ok, true, '探活转绿');
    assert.notEqual(okRow.meta.quotaSnapshot.at, oldAt, '快照时间戳刷新');

    // 死号轮（401 NEED_LOGIN）
    const fake401 = async () => new Response(JSON.stringify({ errCode: 'NEED_LOGIN' }), { status: 401 });
    await store.saveAccounts([{ id: 'm-dead2', provider: 'meoo', name: 'Meoo 死号2', meta: { cookieSiteId: 'meoo', cookieSiteSession: { cookie: 'dead=1' }, quotaSnapshot: { used: 0, total: 500, at: oldAt } } }]);
    await runQuotaPush({ endpoint: 'http://127.0.0.1:1', key: 'x', accounts: await store.loadAccounts(), fetchImpl: fake401 });
    await new Promise((r) => setTimeout(r, 300));
    const deadRow = (await store.loadAccounts()).find((x) => x.id === 'm-dead2');
    assert.equal(deadRow.meta.lastProbe?.ok, false, '死号探活转红');
    assert.equal(deadRow.meta.quotaSnapshot.total, 500, '死号快照不被触碰（保留旧数字）');
  } finally {
    process.env.CREDITDADDY_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
