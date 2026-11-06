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
