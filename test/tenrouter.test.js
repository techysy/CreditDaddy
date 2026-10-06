import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 独立的数据目录与「家目录」：用量来源从假家目录里读
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-10r-'));
process.env.CREDITDADDY_HOME = path.join(root, 'data');
const home = path.join(root, 'home');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');   // 10r 来源库也从假家目录发现

const us = await import('../src/usageSync.js');
const tr = await import('../src/tenrouter.js');
const hasSqlite = await us.sqliteAvailable();
after(async () => {
  const { closeArchiveStream } = await import('../src/logger.js');
  closeArchiveStream();
  await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 30; i++) {
    try { fs.rmSync(root, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  // 删不掉不判失败（Windows 上句柄释放慢），打出残留内容便于排查
  try { console.error('[cleanup] 临时目录未能删除，残留：' + fs.readdirSync(path.join(root, 'data', 'logs')).join(', ')); } catch {}
});

function mockFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const r = await handler(String(url), init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

function writeMirasim(rows) {
  const dir = path.join(home, '.mirasim', 'insights');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage-2026-09.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('用量转换：与 10router-sync 插件同一口径', () => {
  const z = us.convertZcodeRow({ provider_id: 'account:bigmodel-start-plan', model_id: 'GLM-5', agent: 'a', status: 'cancelled', started_at: 1790000000000, input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 });
  assert.equal(z.provider, 'zcode-bigmodel-start-plan');
  assert.equal(z.status, 'error');
  assert.equal(z.cost, 0);
  assert.deepEqual(z.tokens, { prompt_tokens: 10, completion_tokens: 2, cache_read_input_tokens: 5 });

  const m = us.convertMirasimRow({ id: 'x', ts: '2026-09-24T00:00:00.000Z', provider: 'anthropic', input: 3, cacheRead: 100, cacheWrite: 7, output: 4, status: 200 });
  assert.equal(m.tokens.prompt_tokens, 110);   // 真实输入 = input + cacheRead + cacheWrite
  assert.equal(m.provider, 'mirasim-anthropic');

  assert.ok(us.isSelfHostedUpstream('127.0.0.1:20128', null));
  assert.ok(us.isSelfHostedUpstream('192.168.1.5:9000', 'http://192.168.1.5:20128'));
  assert.ok(!us.isSelfHostedUpstream('api.anthropic.com', 'http://127.0.0.1:20128'));
});

test('增量筛选：水位线往前重叠 2 天，返回新的最大时间戳', () => {
  const e = (d) => ({ timestamp: new Date(Date.UTC(2026, 8, d)).toISOString() });
  const all = [e(1), e(10), e(19), e(20)];
  assert.equal(us.selectSince(all, null).selected.length, 4);
  const r = us.selectSince(all, e(20).timestamp);
  assert.deepEqual(r.selected.map((x) => x.timestamp), [e(19).timestamp, e(20).timestamp]);
  assert.equal(r.maxTs, e(20).timestamp);
});

test('10Router 配置：地址规范化、key 脱敏、留空保持原 key、清除', async () => {
  assert.equal(tr.normalizeEndpoint('nas:20128/'), 'http://nas:20128');
  assert.throws(() => tr.normalizeEndpoint('http://'));
  await tr.updateConfig({ endpoint: '127.0.0.1:20128', key: 'sk-abcdefghijklmnop', syncEnabled: true, sources: ['mirasim', 'bogus'] });
  let c = await tr.publicConfig();
  assert.equal(c.configured, true);
  assert.equal(c.endpoint, 'http://127.0.0.1:20128');
  assert.equal(c.keyMasked, 'sk-ab…mnop');
  assert.deepEqual(c.sync.sources, ['mirasim']);
  assert.ok(!JSON.stringify(c).includes('sk-abcdefghijklmnop'));
  await tr.updateConfig({ key: '' });
  assert.equal(tr.loadConfig().key, 'sk-abcdefghijklmnop');
  const raw = fs.statSync(path.join(process.env.CREDITDADDY_HOME, 'tenrouter.json'));
  if (process.platform !== 'win32') assert.equal(raw.mode & 0o777, 0o600);
});

test('额度总览：带 key 请求、401 → key 无效、404 → 10Router 版本过旧', async () => {
  let mode = 'ok';
  const m = mockFetch((url) => {
    if (mode === '401') return { status: 401, body: { error: 'Unauthorized' } };
    if (mode === '404') return { status: 404, body: { error: 'not found' } };
    return { body: { generatedAt: '2026-09-24T00:00:00Z', connections: [{ id: 'c1', provider: 'claude', providerName: 'Claude', quotas: [{ name: 'weekly', used: 1, total: 10 }] }] } };
  });
  try {
    const q = await tr.fetchQuotas({ force: true });
    assert.equal(q.connections[0].providerName, 'Claude');
    assert.equal(m.calls[0].url, 'http://127.0.0.1:20128/api/usage/quotas?force=1');
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-abcdefghijklmnop');
    mode = '401';
    await assert.rejects(tr.fetchQuotas(), (e) => e.code === 'BAD_KEY');
    mode = '404';
    await assert.rejects(tr.fetchQuotas(), (e) => e.code === 'TOO_OLD');
    assert.deepEqual(await tr.testConnection(), { ok: true, quotas: false, warning: '这个 10Router 版本还没有额度总览接口，需要 10Router 1.2.1 及以上' });
  } finally { m.restore(); }
});

test('用量同步：首轮全量、第二轮只发增量，跳过经 10Router 中转的调用', async () => {
  writeMirasim([
    { id: 'a', ts: '2026-09-01T00:00:00.000Z', provider: 'anthropic', input: 1, output: 1, status: 200 },
    { id: 'b', ts: '2026-09-20T00:00:00.000Z', provider: 'openai-chat', input: 2, output: 2, status: 200 },
    { id: 'c', ts: '2026-09-20T01:00:00.000Z', provider: 'anthropic', input: 3, output: 3, status: 200, upstreamHost: '127.0.0.1:20128' },
    { id: 'd', ts: '2026-09-20T02:00:00.000Z', provider: 'anthropic', input: 0, output: 0, status: 500 },
  ]);
  const posted = [];
  const m = mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    posted.push(body.usageHistory);
    return { body: { imported: body.usageHistory.length, skipped: 2 } };
  });
  try {
    const r1 = await tr.runUsageSync();
    assert.match(m.calls[0].url, /\/api\/settings\/database\/import-usage$/);
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-abcdefghijklmnop');
    assert.deepEqual(posted[0].map((e) => e.meta.mirasimCallId), ['a', 'b']);   // c 经 10Router 中转，d 无 token
    assert.match(r1.summary, /新增 2 行，跳过 2 行重复/);   // 服务端去重结果直接显示出来

    writeMirasim([
      { id: 'a', ts: '2026-09-01T00:00:00.000Z', provider: 'anthropic', input: 1, output: 1, status: 200 },
      { id: 'b', ts: '2026-09-20T00:00:00.000Z', provider: 'openai-chat', input: 2, output: 2, status: 200 },
      { id: 'e', ts: '2026-09-21T00:00:00.000Z', provider: 'anthropic', input: 5, output: 5, status: 200 },
    ]);
    await tr.runUsageSync();
    assert.deepEqual(posted[1].map((e) => e.meta.mirasimCallId), ['b', 'e']);   // a 在水位线 - 2 天之前，不再重发
    assert.equal(tr.loadConfig().syncState.mirasim.lastTs, '2026-09-21T00:00:00.000Z');
    assert.equal((await tr.publicConfig()).lastSync.trigger, 'manual');
  } finally { m.restore(); }
});

test('用量同步：key 被拒时不再尝试其他来源，并记录失败', async () => {
  await tr.updateConfig({ sources: ['mirasim', 'zcode'] });
  const m = mockFetch(() => ({ status: 401, body: { error: 'nope' } }));
  try {
    tr.loadConfig();
    const r = await tr.runUsageSync();
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].status, 'failed');
    assert.match(r.summary, /1 个来源失败/);
  } finally { m.restore(); }
});

test('ZCode 数据库来源：只导出官方渠道（需要 node:sqlite）', { skip: !hasSqlite && 'node:sqlite 不可用（Node < 22.5）' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(home, '.zcode', 'cli', 'db');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'db.sqlite'));
  db.exec('CREATE TABLE model_usage (logical_request_id TEXT, provider_id TEXT, model_id TEXT, agent TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER)');
  const ins = db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('r1', 'builtin:bigmodel', 'GLM-5', 'zcode-agent', 'completed', 1790000000000, 1790000001000, 1000, 10, 5, 0, 0, 3);
  ins.run('r1', 'builtin:bigmodel', 'GLM-5', 'zcode-agent', 'completed', 1790000000000, 1790000001000, 1000, 10, 5, 0, 0, 3);   // 重复请求 id
  ins.run('r2', 'custom-uuid-123', 'x', 'zcode-agent', 'completed', 1790000002000, 1790000003000, 1000, 99, 9, 0, 0, 0);    // 自定义渠道
  db.close();
  const r = await us.collectSource('zcode');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].provider, 'zcode-bigmodel');
  assert.match(r.notes[0], /跳过 1 行/);
});

test('OpenCode 来源：1 小时内仍在更新的会话暂不同步（需要 node:sqlite）', { skip: !hasSqlite && 'node:sqlite 不可用（Node < 22.5）' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec('CREATE TABLE session (id TEXT, title TEXT, model TEXT, agent TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER)');
  const ins = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const now = Date.now();
  ins.run('s-done', '已结束', '{"id":"m1","providerID":"opencode"}', 'build', 0, 10, 5, 0, 0, 0, now - 5 * 3600e3, now - 3 * 3600e3);
  ins.run('s-live', '进行中', '{"id":"m1","providerID":"opencode"}', 'build', 0, 99, 9, 0, 0, 0, now - 2 * 3600e3, now - 60e3);
  db.close();
  const r = await us.collectSource('opencode');
  assert.deepEqual(r.entries.map((e) => e.meta.opencodeSessionId), ['s-done']);
  assert.match(r.notes[0], /暂不同步 1 个进行中的会话/);
});

test('MiMo 来源：未定型的消息暂不同步，缺时间戳的行直接跳过（需要 node:sqlite）', { skip: !hasSqlite && 'node:sqlite 不可用（Node < 22.5）' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(home, '.local', 'share', 'mimocode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'mimocode.db'));
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  const ins = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
  const now = Date.now();
  const msg = (id, time, tokens = { input: 10, output: 5 }) => [id, 's1', now - 3 * 3600e3, JSON.stringify({ role: 'assistant', providerID: 'mimo', modelID: 'm1', agent: 'a', tokens, time })];
  ins.run(...msg('done-3h', { created: now - 4 * 3600e3, completed: now - 3 * 3600e3 }));
  ins.run(...msg('fresh-10m', { created: now - 20 * 60e3, completed: now - 10 * 60e3 }));   // 刚完成：token 还可能回填
  ins.run(...msg('no-done', { created: now - 3 * 3600e3 }));                                 // 完成时间缺失：可能还在写
  ins.run('no-ts', 's1', null, JSON.stringify({ role: 'assistant', providerID: 'mimo', modelID: 'm1', tokens: { input: 1, output: 1 }, time: {} }));   // 连时间戳都没有：不能用 Date.now() 兜底
  db.close();
  const r = await us.collectSource('mimo');
  assert.deepEqual(r.entries.map((e) => e.meta.mimoMessageId), ['done-3h']);   // 同步后端点时间戳来自消息本身
  assert.ok(r.entries[0].timestamp.startsWith('2026') || !Number.isNaN(Date.parse(r.entries[0].timestamp)));
  assert.match(r.notes.join(' '), /暂不同步 2 行未定型的消息/);
  assert.match(r.notes.join(' '), /跳过 1 行缺时间戳的消息/);
});

test('缺时间戳的行不能转换：绝不用 Date.now() 兜底（每次同步都会变成“新行”）', () => {
  assert.equal(us.convertZcodeRow({ provider_id: 'builtin:x', model_id: 'm', input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(us.convertOpencodeSession({ id: 's', tokens_input: 1, tokens_output: 1 }), null);
  assert.equal(us.convertMimoMessage({ id: 'm' }, { role: 'assistant', tokens: { input: 1, output: 1 } }), null);
});

// ── 妙手（CatPaw）云端用量 ──

function writeAccounts(list) {
  fs.mkdirSync(process.env.CREDITDADDY_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CREDITDADDY_HOME, 'accounts.json'), JSON.stringify(list));
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('妙手云端用量：按天聚合行的口径与本地正午锚点', () => {
  const acc = { id: 'acc-1', name: '主号', provider: 'catpaw', token: 'tok-1' };
  const row = us.convertCatpawDaily('2026-09-27', 12345, acc);
  assert.equal(row.provider, 'catpaw-catx');
  assert.equal(row.model, 'unknown');
  assert.equal(row.connectionId, 'catpaw-acc-1');   // 参与 10R 行签名，分账号去重
  assert.deepEqual(row.tokens, { prompt_tokens: 12345, completion_tokens: 0 });   // 云端无拆分，整包记输入
  assert.equal(row.cost, 0);
  const d = new Date(row.timestamp);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 27);
  assert.equal(us.convertCatpawDaily('2026-09-27', 1, acc, 'GLM-5.3-FlashX').model, 'GLM-5.3-FlashX');
});

test('妙手云端用量：当天桶与 0 token 天不入账，单账号失败不拖垮整轮', async () => {
  const todayKey = dayKey();
  const yKey = dayKey(new Date(Date.now() - 86400e3));
  writeAccounts([
    { id: 'acc-1', name: '主号', provider: 'catpaw', token: 'tok-1' },
    { id: 'acc-2', name: '小号', provider: 'catpaw', token: 'tok-2' },
    { id: 'q1', provider: 'qoder', token: 'x' },
  ]);
  const m = mockFetch((url, init) => {
    if (init.headers['X-Auth-Token'] === 'tok-2') return { status: 401, body: { code: 401, message: '未登录', data: null } };
    return { body: { code: 0, message: 'success', data: { daily: [
      { date: yKey, totalTokens: 100 },
      { date: todayKey, totalTokens: 999 },        // 当天桶随用随涨，隔天再入账
      { date: dayKey(new Date(Date.now() - 3 * 86400e3)), totalTokens: 0 },
    ] }, errorCode: null } };
  });
  try {
    const r = await us.collectSource('catpaw', { catpawModel: 'GLM-5.3-FlashX' });
    assert.equal(r.files, 2);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].tokens.prompt_tokens, 100);
    assert.equal(r.entries[0].model, 'GLM-5.3-FlashX');
    assert.match(r.notes[0], /1 个妙手账号用量拉取失败/);

    const d = await us.detectSources();
    const catpaw = d.find((x) => x.id === 'catpaw');
    assert.equal(catpaw.found, true);
    assert.equal(catpaw.files, 2);
  } finally { m.restore(); }
});

test('妙手云端用量：按天桶增长只发差量，桶没长不重发（整包重发会被 10R 当新行）', async () => {
  const yKey = dayKey(new Date(Date.now() - 86400e3));
  writeAccounts([{ id: 'acc-1', name: '主号', provider: 'catpaw', token: 'tok-1' }]);
  let total = 100;
  const m = mockFetch(() => ({ body: { code: 0, message: 'success', data: { daily: [{ date: yKey, totalTokens: total }] }, errorCode: null } }));
  try {
    const r1 = await us.collectSource('catpaw', { sentTotals: {} });
    assert.equal(r1.entries.length, 1);
    assert.equal(r1.entries[0].tokens.prompt_tokens, 100);
    total = 150;   // 云端按天桶补录增长
    const r2 = await us.collectSource('catpaw', { sentTotals: r1.nextSentTotals });
    assert.equal(r2.entries.length, 1);
    assert.equal(r2.entries[0].tokens.prompt_tokens, 50);   // 只发增量，不是整包 150
    assert.notEqual(r2.entries[0].timestamp, r1.entries[0].timestamp);   // 差量段错开秒，签名不同
    const r3 = await us.collectSource('catpaw', { sentTotals: r2.nextSentTotals });
    assert.equal(r3.entries.length, 0);   // 桶没长：一行都不发
    total = 140;   // 云端回撤
    const r4 = await us.collectSource('catpaw', { sentTotals: r3.nextSentTotals });
    assert.equal(r4.entries.length, 0);
  } finally { m.restore(); }
});

// ── 账号同步到 10Router 连接 ──

const ta = await import('../src/tenrouterAccounts.js');
const { openTransfer } = await import('../src/transfer.js');

test('账号同步映射表：qoder / WorkBuddy 系列映射，zcode 等留待后续', () => {
  assert.equal(ta.mapProviderId('qoder'), 'qoder');
  assert.equal(ta.mapProviderId('qoder-cn'), 'qoder-cn');
  assert.equal(ta.mapProviderId('workbuddy'), 'codebuddy-cn');
  assert.equal(ta.mapProviderId('workbuddy-intl'), 'codebuddy-intl');
  assert.equal(ta.mapProviderId('zcode'), null);
  assert.equal(ta.mapProviderId('mirasim'), null);
  assert.equal(ta.mapProviderId('catpaw'), null);
});

test('账号同步：apikey 通道逐账号建连接，同名 409 记已存在，无映射产品跳过', async () => {
  const m = mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.name === 'B') return { status: 409, body: { error: 'exists' } };
    return { status: 201, body: { connection: { id: 'x' } } };
  });
  try {
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', key: 'sk-x',
      accounts: [
        { id: '1', provider: 'qoder', token: 't1', name: 'A' },
        { id: '2', provider: 'qoder', token: 't2', name: 'B' },
        { id: '3', provider: 'zcode', token: 't3', name: 'Z' },
      ],
    });
    assert.equal(r.channel, 'apikey');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].imported, 1);
    assert.equal(r.results[0].skipped, 1);
    assert.match(r.summary, /apikey 通道/);
    assert.match(r.summary, /跳过 zcode ×1/);
    assert.deepEqual(m.calls.map((c) => JSON.parse(c.init.body).provider), ['qoder', 'qoder']);
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-x');
  } finally { m.restore(); }
});

test('账号同步：OAuth 通道登录换会话，transfer 分组推送完整凭据', async () => {
  const seen = [];
  const m = mockFetch((url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith('/api/auth/login')) {
      return { status: 200, body: { success: true }, headers: { 'set-cookie': 'auth_token=abc123; Path=/; HttpOnly' } };
    }
    if (String(url).endsWith('/api/auth/logout')) return { status: 200, body: { success: true } };
    return { status: 200, body: { imported: 1, updated: 1, skipped: 0, failed: 0 } };
  });
  try {
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', key: 'sk-x', adminPassword: 'pw-1',
      accounts: [
        { id: '1', provider: 'workbuddy', token: 'tok-a', refreshToken: 'rf-a', name: 'W1', email: 'a@x' },
        { id: '2', provider: 'workbuddy-intl', token: 'tok-b', refreshToken: 'rf-b', name: 'W2' },
      ],
    });
    assert.equal(r.channel, 'oauth');
    assert.deepEqual(r.results.map((x) => x.provider), ['codebuddy-cn', 'codebuddy-intl']);
    assert.match(r.summary, /OAuth 通道/);
    assert.match(r.summary, /导入 2/);
    assert.match(r.summary, /更新 2/);

    const login = seen.find((s) => s.url.endsWith('/api/auth/login'));
    assert.equal(JSON.parse(login.init.body).password, 'pw-1');
    const imports = seen.filter((s) => s.url.endsWith('/api/oauth/transfer/import'));
    assert.equal(imports.length, 2);
    for (const s of imports) {
      assert.equal(s.init.headers.Cookie, 'auth_token=abc123');
      const body = JSON.parse(s.init.body);
      const payload = openTransfer(body.blob, body.passphrase);
      assert.equal(payload.accounts[0].refreshToken, body.provider === 'codebuddy-cn' ? 'rf-a' : 'rf-b');
      assert.ok(payload.accounts[0].accessToken);
    }
    assert.ok(seen.some((s) => s.url.endsWith('/api/auth/logout')));
  } finally { m.restore(); }
});

test('账号同步：apikey 通道 qoder 新建连接挂上网页会话；缺会话的进摘要提醒（issue #44）', async () => {
  const m = mockFetch(() => ({ status: 201, body: { connection: { id: 'x' } } }));
  try {
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', key: 'sk-x',
      accounts: [
        { id: '1', provider: 'qoder', token: 't1', name: '有会话', uid: 'u-1',
          meta: { qoderWebSession: { cookie: 'session=live', capturedAt: '2026-10-01T00:00:00.000Z' } } },
        { id: '2', provider: 'qoder-cn', token: 't2', name: '没会话', uid: 'u-2' },
      ],
    });
    assert.equal(r.channel, 'apikey');
    assert.deepEqual(r.results.map((x) => [x.provider, x.imported]), [['qoder', 1], ['qoder-cn', 1]]);

    const b1 = m.calls.find((c) => JSON.parse(c.init.body).name === '有会话');
    const psd1 = JSON.parse(b1.init.body).providerSpecificData;
    assert.equal(psd1.userId, 'u-1');
    assert.equal(psd1.creditDaddyWebSession.cookie, 'session=live');
    assert.equal(psd1.creditDaddyWebSession.capturedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(psd1.creditDaddyWebSession.userId, 'u-1');

    const b2 = m.calls.find((c) => JSON.parse(c.init.body).name === '没会话');
    assert.equal(JSON.parse(b2.init.body).providerSpecificData, undefined, '无会话时不发送 providerSpecificData');

    // apikey 通道拿不到逐账号探测结果，本地缺会话的账号必须在摘要里点名
    assert.match(r.summary, /未带网页会话 1/);
    assert.match(r.summary, /没会话/);
    assert.ok(!/有会话，/.test(r.summary), '有会话的账号不被点名');
  } finally { m.restore(); }
});

test('账号同步：OAuth 通道回显 10Router 的会话探测失败清单（issue #44）', async () => {
  const m = mockFetch((url) => {
    if (String(url).endsWith('/api/auth/login')) {
      return { status: 200, body: { success: true }, headers: { 'set-cookie': 'auth_token=tk; Path=/' } };
    }
    if (String(url).endsWith('/api/auth/logout')) return { status: 200, body: { success: true } };
    return {
      status: 200,
      body: {
        imported: 2, updated: 0, skipped: 0, failed: 0,
        webSessions: { checked: 2, ok: 1, failed: 1, failures: [{ id: 'c2', name: '旧登录', reason: 'HTTP 401' }] },
      },
    };
  });
  try {
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', adminPassword: 'pw',
      accounts: [
        { id: '1', provider: 'qoder', token: 't1', name: '新登录', uid: 'u-1', meta: { qoderWebSession: { cookie: 'a', capturedAt: '2026-10-01T00:00:00.000Z' } } },
        { id: '2', provider: 'qoder', token: 't2', name: '旧登录', uid: 'u-2', meta: { qoderWebSession: { cookie: 'b', capturedAt: '2026-08-01T00:00:00.000Z' } } },
      ],
    });
    assert.equal(r.channel, 'oauth');
    assert.deepEqual(r.results[0].webSessions.failures, [{ id: 'c2', name: '旧登录', reason: 'HTTP 401' }]);
    assert.match(r.summary, /网页会话已失效 1/);
    assert.match(r.summary, /旧登录/);
    assert.ok(!r.summary.includes('未带网页会话'), '两组都带会话 → 不重复报缺失');
  } finally { m.restore(); }
});

test('账号同步：旧版 10Router 无探测结果时，缺会话仍按本地信息提醒（issue #44）', async () => {
  const m = mockFetch((url) => {
    if (String(url).endsWith('/api/auth/login')) {
      return { status: 200, body: { success: true }, headers: { 'set-cookie': 'auth_token=tk; Path=/' } };
    }
    if (String(url).endsWith('/api/auth/logout')) return { status: 200, body: { success: true } };
    return { status: 200, body: { imported: 2, updated: 0, skipped: 0, failed: 0 } };   // 无 webSessions 字段
  });
  try {
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', adminPassword: 'pw',
      accounts: [
        { id: '1', provider: 'qoder', token: 't1', name: 'A', uid: 'u-1' },
        { id: '2', provider: 'qoder', token: 't2', name: 'B', uid: 'u-2' },
        { id: '3', provider: 'workbuddy', token: 't3', name: 'W' },
      ],
    });
    assert.equal(r.results[0].webSessions, null);
    assert.match(r.summary, /未带网页会话 2（A、B/);
    assert.ok(!r.summary.includes('W'), '非 qoder 账号不参与会话提醒');
  } finally { m.restore(); }
});

test('配置版本迁移：旧来源快照自动并入新增来源，显式保存后以保存值为准', async () => {
  const f = path.join(process.env.CREDITDADDY_HOME, 'tenrouter.json');
  const orig = JSON.parse(fs.readFileSync(f, 'utf8'));
  try {
    // 旧版保存的来源快照：用户手动关掉了 opencode / mimo
    fs.writeFileSync(f, JSON.stringify({ ...orig, sync: { enabled: false, sources: ['zcode', 'mirasim'] } }));
    let c = tr.loadConfig();
    assert.deepEqual([...c.sync.sources].sort(), ['10r', 'mirasim', 'zcode']);   // 新增来源默认并入，手动关掉的不复活
    await tr.updateConfig({ sources: ['mirasim'] });
    c = tr.loadConfig();
    assert.deepEqual(c.sync.sources, ['mirasim']);   // 显式保存过勾选结果后不再自动并入
  } finally {
    fs.writeFileSync(f, JSON.stringify(orig));
  }
});

test('10Router 本机来源：行转换带 gatewaySync 标记与出处（同 10router-sync 插件）', () => {
  const native = us.convertRouterRow({
    timestamp: '2026-09-29T10:00:00.000Z', provider: 'zcode-free', model: 'glm-5.3-flash',
    connectionId: 'conn-1', apiKey: null, endpoint: 'http://127.0.0.1:47860/gateway',
    promptTokens: 100, completionTokens: 20, cost: 0.5, status: 'ok',
    tokens: JSON.stringify({ prompt_tokens: 100, completion_tokens: 20 }),
    meta: null,
  }, 'C:/appdata/10router/db/data.sqlite');
  assert.equal(native.meta.source, '10r');
  assert.equal(native.meta.gatewaySync, true, '原生行应标记为网关同步');
  assert.equal(native.meta.sourceDbPath, 'C:/appdata/10router/db/data.sqlite');
  assert.equal(native.meta.sourceConnectionId, 'conn-1');
  assert.equal(native.connectionId, null, '源实例的连接 uuid 不进列');
  assert.equal(native.promptTokens, 100);
  assert.equal(native.cost, 0.5, '原生行的真实计费原样保留');

  const imported = us.convertRouterRow({
    timestamp: '2026-09-29T10:05:00.000Z', provider: 'zcode-bigmodel', model: 'GLM-5',
    promptTokens: 5, completionTokens: 1, status: 'ok',
    meta: JSON.stringify({ source: 'zcode', imported: true }),
  }, 'C:/appdata/10router/db/data.sqlite');
  assert.ok(!('gatewaySync' in imported.meta), '源实例自己导入的行不打 gatewaySync');
  assert.equal(imported.meta.imported, true, 'imported 标记原样保留');
  assert.equal(imported.meta.syncedFrom, 'creditdaddy');
});

test('10Router 本机来源：读实例库、跳过无时间戳行；回环地址自动跳过（需要 node:sqlite）', { skip: !hasSqlite && 'node:sqlite 不可用（Node < 22.5）' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  // sourcePaths 按平台发现：win32 走 APPDATA，其余走 ~/.10router
  const dir = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', '10router', 'db')
    : path.join(home, '.10router', 'db');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  db.exec('CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT, meta TEXT)');
  const ins = db.prepare('INSERT INTO usageHistory (timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('2026-09-29T10:00:00.000Z', 'zcode-free', 'glm-5.3-flash', 'c1', 'http://127.0.0.1:47860/gateway', 100, 20, 0, 'ok', '{}', null);
  ins.run(null, 'zcode-free', 'glm-5.3-flash', 'c2', 'x', 1, 1, 0, 'ok', '{}', null);   // 无时间戳
  ins.run('2026-09-29T10:01:00.000Z', 'zcode-bigmodel', 'GLM-5', 'c3', 'x', 5, 1, 0, 'ok', '{}', JSON.stringify({ source: 'zcode', imported: true }));
  db.close();

  // 地址指向远端聚合端 → 正常同步
  const r = await us.collectSource('10r', { endpoint: 'http://192.168.31.101:20127' });
  assert.equal(r.entries.length, 2, '无时间戳的行应被跳过');
  assert.ok(r.entries[0].meta.gatewaySync, '原生行带 gatewaySync');
  assert.ok(!r.entries[1].meta.gatewaySync, '已导入行不带 gatewaySync');
  assert.match(r.notes.join(''), /无时间戳/);

  // 地址指向本机 → 同实例防护：自己导自己只会把存量行打成 imported
  const guard = await us.collectSource('10r', { endpoint: 'http://127.0.0.1:20128' });
  assert.equal(guard.entries.length, 0);
  assert.match(guard.notes.join(''), /回环|自己/);
});

test('来源版本迁移：v2 配置自动并入 10r，不复活已禁用的旧来源', () => {
  const file = path.join(process.env.CREDITDADDY_HOME, 'tenrouter.json');
  fs.mkdirSync(process.env.CREDITDADDY_HOME, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    endpoint: 'http://nas:20127', key: 'sk-x',
    sync: { enabled: true, sources: ['zcode', 'mimo'], sourcesVersion: 2 }, syncState: {}, lastSync: null,
  }));
  const c = tr.loadConfig();
  assert.ok(c.sync.sources.includes('10r'), '新来源应默认并入');
  assert.ok(c.sync.sources.includes('zcode') && c.sync.sources.includes('mimo'), '已有勾选保留');
  assert.ok(!c.sync.sources.includes('catpaw'), '用户没勾的旧来源不复活');
  assert.equal(c.sync.sourcesVersion, 3);
});
