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
const eq = await import('../src/externalQuota.js');
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

  // mirasim 只同步官方中继行（viaRelay=true）——直连上游的行走的是本机 10Router，
  // 10R 已原生记账，再导就是同一批调用记两笔（2026-10-21 用户拍板）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-'));
  const file = path.join(dir, 'usage-2026-10.ndjson');
  const rows = [
    { id: 'r1', ts: '2026-10-20T00:00:00.000Z', provider: 'anthropic', model: 'claude-opus-5-5', viaRelay: true, upstreamHost: 'relay.mirasim.ai', input: 10, output: 2, status: 200 },
    { id: 'd1', ts: '2026-10-20T00:00:01.000Z', provider: 'anthropic', model: 'glm-5.3-flashx', viaRelay: false, upstreamHost: null, input: 99, output: 2, status: 200 },
    { id: 'r2', ts: String(Date.now() - 30 * 1000), provider: 'anthropic', model: 'claude-haiku-5-5', viaRelay: true, upstreamHost: 'relay.mirasim.ai', input: 5, output: 1, status: 200 },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  const cm = us.collectMirasim([file], 'http://192.168.31.101:20127');
  assert.equal(cm.entries.length, 1);   // 只剩官方中继行（r2 未定型不算）
  assert.equal(cm.entries[0].model, 'claude-opus-5-5');
  assert.ok(cm.notes.some((n) => n.includes('直连上游')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mirasim 双写去重：0-token 占位行不占坑，同 id 只发定型行（11-18 断供修复）', () => {
  // mirasim 自 2026-11-18 起对每次中继调用先写一行 0-token 占位行、随后写同 id 的定型行
  // （带 token 与 payer/relayMetered）。原先先到先得的 id 去重让占位行占坑后被 0-token
  // 过滤拦下、定型行反被当重复丢弃 → 该来源一行都发不出去。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-dup-'));
  const file = path.join(dir, 'usage-2026-11.ndjson');
  const relay = (o) => ({ provider: 'anthropic', model: 'claude-opus-5-5', viaRelay: true, upstreamHost: 'relay.mirasim.ai', status: 200, ...o });
  const PH = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  fs.writeFileSync(file, [
    // 真实顺序：占位行在前，定型行在后
    relay({ id: 'dup1', ts: '2026-11-20T00:00:00.000Z', ...PH }),
    relay({ id: 'dup1', ts: '2026-11-20T00:00:02.000Z', input: 12427, cacheRead: 100, output: 27, payer: 'personal', relayMetered: true }),
    // 乱序（定型行先到）也要取定型行
    relay({ id: 'dup2', ts: '2026-11-20T03:00:05.000Z', input: 5, output: 6 }),
    relay({ id: 'dup2', ts: '2026-11-20T03:00:00.000Z', ...PH }),
    // 只有占位行（调用没定型）：没有可记的量，不发
    relay({ id: 'only-ph', ts: '2026-11-20T04:00:00.000Z', ...PH }),
    // 无 id 的行照旧逐行处理（不参与合并）
    relay({ ts: '2026-11-20T05:00:00.000Z', input: 1, output: 1 }),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const cm = us.collectMirasim([file], 'http://192.168.31.101:20127');
  assert.deepEqual(cm.entries.map((e) => e.meta.mirasimCallId), ['dup1', 'dup2', null]);
  const d1 = cm.entries[0];
  assert.deepEqual(d1.tokens, { prompt_tokens: 12527, completion_tokens: 27, cache_read_input_tokens: 100 });   // 真实输入 = input + cacheRead + cacheWrite
  assert.equal(d1.timestamp, '2026-11-20T00:00:02.000Z', '时间戳以定型行为准（10R 行签名含 timestamp）');
  assert.equal(cm.entries[1].timestamp, '2026-11-20T03:00:05.000Z', '乱序时仍取定型行的时间戳');
  assert.equal(cm.entries.length, 3, '占位行单独存在的调用不发');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mirasim 直连：antigravity 例外放行，其余直连行仍按 10R 已记账跳过', () => {
  // 直连行的默认口径是「上游就是本机 10R，10R 已原生记账」（2026-10-21 拍板），
  // 但 antigravity 是 mirasim 内置 agent、直连 Google 官方，两侧都没留痕 → 必须发（2026-11-25 拍板纳入）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-direct-'));
  const file = path.join(dir, 'usage-2026-11.ndjson');
  const direct = (o) => ({ viaRelay: false, upstreamHost: null, status: 200, ...o });
  fs.writeFileSync(file, [
    direct({ id: 'ag1', ts: '2026-11-20T00:00:00.000Z', provider: 'antigravity', model: 'gemini-4-hydrogen', agent: 'antigravity', input: 8931, cacheRead: 356406, output: 3548, reasoning: 2745 }),
    direct({ id: 'ag2', ts: '2026-11-20T01:00:00.000Z', provider: 'antigravity', model: 'gemini-3.8-flash', input: 0, output: 0 }),   // 0-token：照旧不发
    direct({ id: 'glm', ts: '2026-11-20T02:00:00.000Z', provider: 'anthropic', model: 'glm-5.3-flashx', input: 99, output: 2 }),     // 直连 10R：跳过
    direct({ id: 'ag-on-10r', ts: '2026-11-20T03:00:00.000Z', provider: 'antigravity', model: 'gemini-4-hydrogen', upstreamHost: '192.168.31.101:20127', input: 50, output: 5 }),   // 将来 10R 上了 gemini 通道：本机过滤先拦，不双记
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const cm = us.collectMirasim([file], 'http://192.168.31.101:20127');
  assert.deepEqual(cm.entries.map((e) => e.meta.mirasimCallId), ['ag1'], '只有 antigravity 直连行发出');
  assert.deepEqual(cm.entries[0].tokens, { prompt_tokens: 365337, completion_tokens: 3548, cache_read_input_tokens: 356406, reasoning_tokens: 2745 });
  assert.equal(cm.entries[0].provider, 'mirasim-antigravity');
  assert.ok(cm.notes.some((n) => n.includes('直连上游')), '其余直连行仍计入跳过说明');
  assert.ok(cm.notes.some((n) => n.includes('经 10Router 中转')), '打到 10R 的 antigravity 行走本机过滤');
  fs.rmSync(dir, { recursive: true, force: true });
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

test('用量同步：首轮全量、第二轮只发增量，只同步官方中继行（viaRelay），直连 10R 的跳过', async () => {
  writeMirasim([
    { id: 'a', ts: '2026-09-01T00:00:00.000Z', provider: 'anthropic', input: 1, output: 1, status: 200, viaRelay: true, upstreamHost: 'relay.mirasim.ai' },
    { id: 'b', ts: '2026-09-20T00:00:00.000Z', provider: 'openai-chat', input: 2, output: 2, status: 200, viaRelay: true, upstreamHost: 'relay.mirasim.ai' },
    { id: 'c', ts: '2026-09-20T01:00:00.000Z', provider: 'anthropic', input: 3, output: 3, status: 200, viaRelay: false, upstreamHost: null },   // 直连 10R：跳过
    { id: 'd', ts: '2026-09-20T02:00:00.000Z', provider: 'anthropic', input: 0, output: 0, status: 500, viaRelay: true, upstreamHost: 'relay.mirasim.ai' },
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
    assert.deepEqual(posted[0].map((e) => e.meta.mirasimCallId), ['a', 'b']);   // c 直连 10R 跳过，d 无 token
    assert.match(r1.summary, /新增 2 行，跳过 2 行重复/);   // 服务端去重结果直接显示出来

    writeMirasim([
      { id: 'a', ts: '2026-09-01T00:00:00.000Z', provider: 'anthropic', input: 1, output: 1, status: 200, viaRelay: true, upstreamHost: 'relay.mirasim.ai' },
      { id: 'b', ts: '2026-09-20T00:00:00.000Z', provider: 'openai-chat', input: 2, output: 2, status: 200, viaRelay: true, upstreamHost: 'relay.mirasim.ai' },
      { id: 'e', ts: '2026-09-21T00:00:00.000Z', provider: 'anthropic', input: 5, output: 5, status: 200, viaRelay: true, upstreamHost: 'relay.mirasim.ai' },
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
  assert.equal(ta.mapProviderId('trae'), 'trae-cn');
  assert.equal(ta.mapProviderId('zcode'), null);
  assert.equal(ta.mapProviderId('mirasim'), null);
  assert.equal(ta.mapProviderId('catpaw'), null);
});

test('账号同步映射表：croli / quwork 各产品线一条（6b279d5d 合并曾静默丢掉 quwork 行）', () => {
  // QuWork 走面板密码的 transfer 通道建连接（10R 原生 quwork 渠道，authModes:['oauth']），
  // 映射行缺失时 syncAccountsTo10r 会静默跳过整条产品线——与 croli 当年被白名单挡掉同类，
  // 所以这两条必须显式钉住（映射表是 provider→10R 连接类型的唯一事实来源）。
  assert.equal(ta.mapProviderId('croli'), 'croli');
  assert.equal(ta.mapProviderId('quwork'), 'quwork');
  assert.equal(ta.mapProviderId('quwork-cn'), null, 'QuWork 单线，无 -cn 变体');
});

test('账号同步：trae → trae-cn（#56），国际版账号明说跳过不误推国内站', async () => {
  const m = mockFetch(() => ({ status: 201, body: { connection: { id: 'x' } } }));
  try {
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', key: 'sk-x',
      accounts: [
        { id: '1', provider: 'trae', token: 'cn-jwt', name: '国内版' },
        { id: '2', provider: 'trae', token: 'intl-jwt', name: '国际版', meta: { isIntl: true } },
      ],
    });
    assert.equal(r.channel, 'apikey');
    assert.deepEqual(r.results.map((x) => [x.provider, x.imported]), [['trae-cn', 1]]);
    assert.deepEqual(m.calls.map((c) => JSON.parse(c.init.body).provider), ['trae-cn']);
    assert.match(r.summary, /跳过 Trae 国际版 ×1/);
  } finally { m.restore(); }
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

test('账号同步：apikey 通道 qoder 新建连接挂上账号会话；缺会话的进摘要提醒（issue #44）', async () => {
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
    const psd2 = JSON.parse(b2.init.body).providerSpecificData;
    assert.equal(psd2.creditDaddySync, true, '无会话也带 CD 同步标记（10R 徽章据此区分来源）');
    assert.equal(psd2.creditDaddyWebSession, undefined, '无会话时不带账号会话');

    // apikey 通道拿不到逐账号探测结果，本地缺会话的账号必须在摘要里点名
    assert.match(r.summary, /未带账号会话 1/);
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
    assert.match(r.summary, /账号会话已失效 1/);
    assert.match(r.summary, /旧登录/);
    assert.ok(!r.summary.includes('未带账号会话'), '两组都带会话 → 不重复报缺失');
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
    assert.match(r.summary, /未带账号会话 2（A、B/);
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
    assert.deepEqual([...c.sync.sources].sort(), ['10r', 'croli', 'mirasim', 'qwenwork', 'zcode']);   // 新增来源默认并入（v4 croli / v5 qwenwork），手动关掉的不复活
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
    connectionId: 'conn-1', apiKey: 'sk-496f00***aa00', apiKeyHash: 'b'.repeat(64), endpoint: 'http://127.0.0.1:47860/gateway',
    promptTokens: 100, completionTokens: 20, cost: 0.5, status: 'ok',
    tokens: JSON.stringify({ prompt_tokens: 100, completion_tokens: 20 }),
    meta: null,
  }, 'C:/appdata/10router/db/data.sqlite');
  assert.equal(native.meta.source, '10r');
  assert.equal(native.meta.gatewaySync, true, '原生行应标记为网关同步');
  assert.equal(native.meta.sourceDbPath, 'C:/appdata/10router/db/data.sqlite');
  assert.equal(native.meta.sourceConnectionId, 'conn-1');
  assert.equal(native.connectionId, null, '源实例的连接 uuid 不进列');
  assert.equal(native.apiKeyHash, 'b'.repeat(64), '掩码 apiKey 必须随行带 hash（聚合端 apiKeyIdentity 校验）');
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
  db.exec('CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, apiKeyHash TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT, meta TEXT)');
  const ins = db.prepare('INSERT INTO usageHistory (timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('2026-09-29T10:00:00.000Z', 'zcode-free', 'glm-5.3-flash', 'c1', 'sk-496f00***aa00', 'a'.repeat(64), 'http://127.0.0.1:47860/gateway', 100, 20, 0, 'ok', '{}', null);
  ins.run(null, 'zcode-free', 'glm-5.3-flash', 'c2', null, null, 'x', 1, 1, 0, 'ok', '{}', null);   // 无时间戳
  ins.run('2026-09-29T10:01:00.000Z', 'zcode-bigmodel', 'GLM-5', 'c3', 'sk-dead00***beef', null, 'x', 5, 1, 0, 'ok', '{}', JSON.stringify({ source: 'zcode', imported: true }));   // 掩码无 hash：聚合端必拒，跳过
  db.close();

  // 地址指向远端聚合端 → 正常同步
  const r = await us.collectSource('10r', { endpoint: 'http://192.168.31.101:20127' });
  assert.equal(r.entries.length, 1, '无时间戳与「掩码 apiKey 无 hash」的行都应被跳过');
  assert.equal(r.entries[0].apiKeyHash, 'a'.repeat(64), 'apiKeyHash 随行透传（聚合端掩码校验必需）');
  assert.ok(r.entries[0].meta.gatewaySync, '原生行带 gatewaySync');
  assert.match(r.notes.join(''), /无时间戳/);
  assert.match(r.notes.join(''), /掩码/);

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
  assert.ok(c.sync.sources.includes('10r') && c.sync.sources.includes('croli'), '新来源应默认并入');
  assert.ok(c.sync.sources.includes('qwenwork'), 'v5 新增的千问办公来源也应自动并入（老配置不点名它就会被静默挡掉，妙手教训）');
  assert.ok(c.sync.sources.includes('zcode') && c.sync.sources.includes('mimo'), '已有勾选保留');
  assert.ok(!c.sync.sources.includes('catpaw'), '用户没勾的旧来源不复活');
  assert.equal(c.sync.sourcesVersion, 5);
});

test('quotaPush 配置：开关与频率保存、默认开启、最小频率 15 分钟', async () => {
  await tr.updateConfig({ quotaPushEnabled: false, quotaPushIntervalMin: 30 });
  let c = tr.loadConfig();
  assert.equal(c.quotaPush.enabled, false);
  assert.equal(c.quotaPush.intervalMin, 30);

  // 频率下限 15 分钟
  await tr.updateConfig({ quotaPushEnabled: true, quotaPushIntervalMin: 5 });
  c = tr.loadConfig();
  assert.equal(c.quotaPush.enabled, true);
  assert.equal(c.quotaPush.intervalMin, 15);

  const pub = await tr.publicConfig();
  assert.equal(pub.quotaPush.enabled, true);
  assert.equal(pub.quotaPush.intervalMin, 15);
});


test('accountSync 渠道版本迁移：老配置白名单快照自动并入新增渠道（qwenwork 0 连接事故口径）', () => {
  const file = path.join(process.env.CREDITDADDY_HOME, 'tenrouter.json');
  fs.mkdirSync(process.env.CREDITDADDY_HOME, { recursive: true });
  // 2026-11-23 事故同款：qwenwork 上线前保存的白名单（还有已摘除的 meoo），双线被静默滤掉
  fs.writeFileSync(file, JSON.stringify({
    endpoint: 'http://nas:20127', key: 'sk-x',
    accountSync: { enabled: true, providers: ['tokenharbor', 'qoder', 'workbuddy', 'meoo', 'lingxi'] },
  }));
  const c = tr.loadConfig();
  assert.ok(c.accountSync.providers.includes('qwenwork') && c.accountSync.providers.includes('qwenwork-cn'), '新渠道应默认并入');
  assert.ok(c.accountSync.providers.includes('croli'), 'croli 同批并入（30min access 重推吃同一白名单）');
  assert.ok(c.accountSync.providers.includes('qoder') && c.accountSync.providers.includes('meoo'), '已有勾选原样保留（含已下线渠道，不越权清理）');
  assert.equal(c.accountSync.providersVersion, 3, '写回当前版本，此后手动取消勾选不再被复活');
  // AutoClaw 双线（2026-11-26 口径 (a)）同样并入：当初这两行是**整体摘除**（渠道卡都不列），
  // 用户不可能手动取消过勾选，所以补进来不会复活用户明确关掉的渠道
  assert.ok(c.accountSync.providers.includes('autoclaw') && c.accountSync.providers.includes('autoclaw-cn'), 'AutoClaw 双线应默认并入');
  // QuWork（2026-11-27 定版）：映射行已恢复，白名单迁移一并补上，否则老配置的非空勾选
  // 快照会静默把 QuWork 账号滤掉、10R 侧永远建不出 quwork 连接
  assert.ok(c.accountSync.providers.includes('quwork'), 'QuWork 应默认并入');
  // 空数组 = 未做过勾选的老配置（全部候选渠道），无需迁移也不写版本
  fs.writeFileSync(file, JSON.stringify({
    endpoint: 'http://nas:20127', key: 'sk-x',
    accountSync: { enabled: true, providers: [] },
  }));
  const c2 = tr.loadConfig();
  assert.deepEqual(c2.accountSync.providers, []);
  assert.equal(c2.accountSync.providersVersion, undefined, '空清单不迁移（语义即全渠道）');
  // 已是当前版本的配置不再动（用户手动取消勾选的渠道不复活）
  fs.writeFileSync(file, JSON.stringify({
    endpoint: 'http://nas:20127', key: 'sk-x',
    accountSync: { enabled: true, providers: ['qoder'], providersVersion: 3 },
  }));
  const c3 = tr.loadConfig();
  assert.deepEqual(c3.accountSync.providers, ['qoder']);
  // 停在版本 1 的老配置：补 autoclaw 双线与 quwork，不复活它自己关掉的 qwenwork
  fs.writeFileSync(file, JSON.stringify({
    endpoint: 'http://nas:20127', key: 'sk-x',
    accountSync: { enabled: true, providers: ['qoder', 'qwenwork'], providersVersion: 1 },
  }));
  const c4 = tr.loadConfig();
  assert.deepEqual(c4.accountSync.providers.sort(), ['autoclaw', 'autoclaw-cn', 'qoder', 'qwenwork', 'quwork'].sort());
  assert.equal(c4.accountSync.providersVersion, 3);
});

test('accountSync 渠道开关：providers 白名单过滤账号、enabled=false 直接短路', async () => {
  // 白名单只含 workbuddy：qoder 账号应被滤掉，连接只推 codebuddy-cn
  const m = mockFetch((url, init) => {
    if (String(url).endsWith('/api/auth/login')) {
      return { status: 200, body: { success: true }, headers: { 'set-cookie': 'auth_token=abc; Path=/' } };
    }
    if (String(url).endsWith('/api/auth/logout')) return { status: 200, body: {} };
    return { status: 200, body: { imported: 1, updated: 0, skipped: 0, failed: 0 } };
  });
  try {
    await tr.updateConfig({ accountSyncEnabled: true, accountSyncProviders: ['workbuddy'] });
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', key: 'sk-x', adminPassword: 'pw',
      // 模拟 daemon 侧已按白名单过滤（qoder 被滤掉）
      accounts: [{ id: '1', provider: 'workbuddy', token: 'tok-w', name: 'W' }],
    });
    assert.deepEqual(m.calls.filter((c) => c.url.includes('transfer/import')).map((c) => c.init.body && JSON.parse(c.init.body).provider), ['codebuddy-cn']);
    assert.match(r.summary, /导入 1/);

    // enabled=false：daemon 侧短路（syncAccountsTo10r 本身无开关概念，短路在路由层）
    await tr.updateConfig({ accountSyncEnabled: false });
    const c = tr.loadConfig();
    assert.equal(c.accountSync.enabled, false);
    assert.deepEqual(c.accountSync.providers, ['workbuddy']);
  } finally { m.restore(); }
});

test('quotaPushDisabledProviders：排除渠道的账号被滤掉后不再出卡', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).includes('agent.minimax.cn')) {
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { remaining_credits: '88', plan_name: 'Free', is_pro_builder: false, expires_at: 0, usage_summary: null } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const fetchImpl = globalThis.fetch;
  try {
    await tr.updateConfig({ quotaPushDisabledProviders: ['minimax'] });
    // 模拟 pushQuotaCards 的过滤：disabled 含 minimax 时账号先被滤掉
    const c = tr.loadConfig();
    const accounts = [{ provider: 'minimax', name: 'MM', token: 'tok', refreshToken: 'r' }]
      .filter((a) => !(c.quotaPushDisabledProviders || []).includes(a.provider));
    await eq.runQuotaPush({ endpoint: 'http://127.0.0.1:20128', key: 'sk-t', accounts, fetchImpl });
    assert.ok(!calls.some((x) => x.url.includes('/minimax-free')), '排除渠道不应有任何推送');
    assert.equal(c.quotaPushDisabledProviders, c.quotaPushDisabledProviders, '配置读取一致');
  } finally { globalThis.fetch = realFetch; }
});

test('buildConnPayload：Trae 账号携带登录注册的设备指纹（10R 签到 9074 规避）', async () => {
  const { buildConnPayload } = await import('../src/tenrouterAccounts.js');
  const account = {
    id: 'tr-1', provider: 'trae', token: 'jwt.tok.sig', uid: 'u-9', name: 'Trae Test',
    meta: { traeDevice: { deviceId: '1234567890123456', machineId: 'm-uuid', privateKeyJwk: { kty: 'EC' } } },
  };
  const body = buildConnPayload(account, 'trae-cn');
  assert.equal(body.provider, 'trae-cn');
  assert.deepEqual(body.providerSpecificData.creditDaddyTraeDevice, { deviceId: '1234567890123456', machineId: 'm-uuid' });
  // 私钥绝不出本机
  assert.equal(body.providerSpecificData.creditDaddyTraeDevice.privateKeyJwk, undefined);
  // 无设备指纹的账号不带该字段
  const bare = buildConnPayload({ id: 'tr-2', provider: 'trae', token: 'jwt', uid: 'u-0' }, 'trae-cn');
  assert.equal(bare.providerSpecificData.creditDaddyTraeDevice, undefined);
  // 非纯数字设备号（老数据形状）不携带
  const weird = buildConnPayload({ id: 'tr-3', provider: 'trae', token: 'jwt', uid: 'u-1', meta: { traeDevice: { deviceId: 'not-digits' } } }, 'trae-cn');
  assert.equal(weird.providerSpecificData.creditDaddyTraeDevice, undefined);
});

test('账号同步：croli 走 OAuth 通道剥 refreshToken（rotating rt 只推 access，meoo test.12 口径）', async () => {
  const seen = [];
  const m = mockFetch((url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith('/api/auth/login')) {
      return { status: 200, body: { success: true }, headers: { 'set-cookie': 'auth_token=abc123; Path=/; HttpOnly' } };
    }
    if (String(url).endsWith('/api/auth/logout')) return { status: 200, body: { success: true } };
    return { status: 200, body: { imported: 0, updated: 1, skipped: 0, failed: 0 } };
  });
  try {
    const r = await ta.syncAccountsTo10r({
      endpoint: 'http://127.0.0.1:20127', key: 'sk-x', adminPassword: 'pw-1',
      accounts: [
        { id: '1', provider: 'croli', token: 'croli-access-jwt', refreshToken: 'croli-rotating-rt', uid: 'user_croliA', name: 'Croli A' },
        { id: '2', provider: 'qoder', token: 'qoder-access', refreshToken: 'qoder-reusable-rt', name: 'Q1' },
      ],
    });
    assert.equal(r.channel, 'oauth');
    const imports = seen.filter((s) => s.url.endsWith('/api/oauth/transfer/import'));
    assert.equal(imports.length, 2);
    for (const s of imports) {
      const body = JSON.parse(s.init.body);
      const payload = openTransfer(body.blob, body.passphrase);
      const acc = payload.accounts[0];
      if (body.provider === 'croli') {
        assert.equal(acc.refreshToken, null, 'croli 的 rotating rt 必须剥空——10R 只持 access');
        assert.equal(acc.accessToken, 'croli-access-jwt');
        assert.equal(acc.uid, 'user_croliA');
      } else {
        assert.equal(acc.refreshToken, 'qoder-reusable-rt', 'rt 可重复使用的 provider 照常全量同步');
      }
    }
  } finally { m.restore(); }
});

test('账号同步：croli 重推守门——未配置/渠道关/白名单排除均静默退出', async () => {
  assert.equal(await ta.resyncCroliAccessToken(null), null, '未配置');
  assert.equal(await ta.resyncCroliAccessToken({}), null, '无 endpoint');
  assert.equal(await ta.resyncCroliAccessToken({ endpoint: 'http://x', key: 'sk-x', accountSync: { enabled: false } }), null, '渠道关闭');
  assert.equal(
    await ta.resyncCroliAccessToken({ endpoint: 'http://x', key: 'sk-x', accountSync: { providers: ['qoder'] } }),
    null, '白名单不含 croli',
  );
});

test('账号同步：croli 重推——token 变化才推、成败都记基准、同 token 不重推', async () => {
  const seen = [];
  const m = mockFetch((url) => {
    if (String(url).endsWith('/api/auth/login')) {
      return { status: 200, body: { success: true }, headers: { 'set-cookie': 'auth_token=t; Path=/' } };
    }
    if (String(url).endsWith('/api/auth/logout')) return { status: 200, body: {} };
    return { status: 200, body: { imported: 0, updated: 1, skipped: 0, failed: 0 } };
  });
  try {
    const cfg = { endpoint: 'http://127.0.0.1:20127', key: 'sk-x', adminPassword: 'pw-1' };
    const acct = { provider: 'croli', token: 'access-v1', refreshToken: 'rt-never-synced', uid: 'user_croliA', name: 'Croli A' };
    const first = await ta.resyncCroliAccessToken(cfg, { account: acct });
    assert.equal(first.pushed, true, '首次推送');
    // 推的是剥离了 rt 的拷贝：原账号对象不能被改动
    assert.equal(acct.refreshToken, 'rt-never-synced');
    const same = await ta.resyncCroliAccessToken(cfg, { account: acct });
    assert.equal(same.pushed, false);
    assert.equal(same.reason, 'token-unchanged', '同 token 不重推（基准已记录）');
    // token 换新（官方 sidecar 轮换）→ 再次推送
    const renewed = { ...acct, token: 'access-v2' };
    const second = await ta.resyncCroliAccessToken(cfg, { account: renewed });
    assert.equal(second.pushed, true);
    const imports = m.calls.filter((s) => String(s.url).endsWith('/api/oauth/transfer/import'));
    assert.equal(imports.length, 2, 'v1 + v2 各推一次');
  } finally { m.restore(); }
});

test('croli 来源：convertCroliTurn 行定型（provider 固定、tokens 拆分、时区戳标准化）', () => {
  const e = us.convertCroliTurn({
    conversation_id: 42, turn_key: 'conv42-turn7', occurred_at: '2026-11-20T15:56:57.439+00:00',
    model: 'glm-5.3-flash', input_tokens: 100, output_tokens: 20,
    cache_creation_tokens: 5, cache_read_tokens: 900, total_tokens: 1025, duration_ms: 1234,
  });
  assert.equal(e.provider, 'croli');
  assert.equal(e.model, 'glm-5.3-flash');
  assert.equal(e.timestamp, '2026-11-20T15:56:57.439Z', '带时区 ISO → UTC 标准化');
  assert.equal(e.status, 'ok');
  assert.equal(e.cost, 0, '积分/trial 池计费，不按量');
  assert.deepEqual(e.tokens, { prompt_tokens: 100, completion_tokens: 20, cache_creation_tokens: 5, cache_read_tokens: 900 });
  assert.equal(e.endpoint, 'croli://conversation/42');
  assert.equal(e.meta.source, 'croli');
  assert.equal(e.meta.turnKey, 'conv42-turn7');
  assert.equal(us.convertCroliTurn({ ...{}, occurred_at: null, input_tokens: 1 }), null, '缺时间戳不能兜底 Date.now');
});

test('croli 来源：collectCroli 快照读 + turn_key 库内去重', async () => {
  if (!(await us.sqliteAvailable())) { console.log('skip: node:sqlite unavailable (CI Node 20)'); return; }
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'croli-test-'));
  try {
    const dbPath = path.join(dir, 'croli.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE token_usage_turn (id integer PRIMARY KEY AUTOINCREMENT, conversation_id integer NOT NULL, turn_key varchar NOT NULL, occurred_at timestamp_with_timezone_text NOT NULL, model varchar NULL, input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0, cache_creation_tokens bigint NOT NULL DEFAULT 0, cache_read_tokens bigint NOT NULL DEFAULT 0, total_tokens bigint NOT NULL DEFAULT 0, duration_ms bigint NOT NULL DEFAULT 0)`);
    db.prepare('INSERT INTO token_usage_turn (conversation_id, turn_key, occurred_at, model, input_tokens, output_tokens, cache_read_tokens, total_tokens, duration_ms) VALUES (?,?,?,?,?,?,?,?,?)').run(1, 't1', '2026-11-20T15:56:57.439+00:00', 'glm-5.3-flash', 100, 20, 900, 1020, 10);
    db.prepare('INSERT INTO token_usage_turn (conversation_id, turn_key, occurred_at, model, input_tokens, output_tokens, total_tokens) VALUES (?,?,?,?,?,?,?)').run(1, 't1', '2026-11-20T15:56:57.439+00:00', 'glm-5.3-flash', 100, 20, 120);  // 同 turn_key 重复行
    db.prepare('INSERT INTO token_usage_turn (conversation_id, turn_key, occurred_at, model, input_tokens, output_tokens, total_tokens) VALUES (?,?,?,?,?,?,?)').run(1, 't2', '2026-11-20T15:57:10.000+00:00', 'glm-5.3-flash', 50, 5, 55);
    db.close();
    const r = await us.collectSource('croli', { paths: { croli: [dbPath] } });
    assert.equal(r.entries.length, 2, '同 turn_key 只出一行');
    assert.equal(r.entries[0].meta.turnKey, 't1');
    assert.deepEqual(r.notes, []);
    assert.equal(r.files, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('croli 来源：sourcePaths 发现 croli.db（CROLI_DB 显式覆盖）', () => {
  const explicit = path.join(os.tmpdir(), 'croli-explicit-' + process.pid + '.db');
  fs.writeFileSync(explicit, 'x');
  const p = us.sourcePaths(os.homedir(), { APPDATA: path.join(os.tmpdir(), 'no-such-appdata-x'), CROLI_DB: explicit }, 'win32');
  assert.deepEqual(p.croli, [explicit]);
  fs.rmSync(explicit, { force: true });
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'croli-appdata-'));
  fs.mkdirSync(path.join(fakeAppData, 'Croli'), { recursive: true });
  fs.writeFileSync(path.join(fakeAppData, 'Croli', 'croli.db'), 'x');
  const p2 = us.sourcePaths(os.homedir(), { APPDATA: fakeAppData }, 'win32');
  assert.ok(p2.croli.some((f) => f.endsWith(path.join('Croli', 'croli.db'))), '默认路径含 %APPDATA%/Croli/croli.db');
  fs.rmSync(fakeAppData, { recursive: true, force: true });
});

// ── 千问办公双线账本（qwenwork） ──

test('千问办公来源：convertQwenworkSession 行定型（双线前缀、cost 照记源值、model JSON 解析）', () => {
  // 样本取自用户本机真实行的形状（测试只用内联数据，绝不读真实库）
  const e = us.convertQwenworkSession({
    id: 'ses_dfbe0e284ffeGFKHh8sSQUCxSP', title: '会话 A', agent: 'qwenwork',
    model: '{"id":"flash","providerID":"openai-compatible","variant":"low"}', cost: 0,
    tokens_input: 11175, tokens_output: 208, tokens_reasoning: 114, tokens_cache_read: 76800, tokens_cache_write: 0,
    time_created: 1795365477755, time_updated: 1795365507693,
  }, 'intl');
  assert.equal(e.provider, 'qwenwork-openai-compatible', '国际版前缀 qwenwork-');
  assert.equal(e.model, 'flash');
  assert.equal(e.endpoint, 'qwenwork://intl');
  assert.equal(e.timestamp, new Date(1795365477755).toISOString(), '时间戳取 time_created（会话级累计）');
  assert.equal(e.cost, 0);
  assert.deepEqual(e.tokens, { prompt_tokens: 11175, completion_tokens: 208, cache_read_input_tokens: 76800 });
  assert.equal(e.meta.source, 'qwenwork');
  assert.equal(e.meta.qwenworkLine, 'intl');
  assert.equal(e.meta.qwenworkSessionId, 'ses_dfbe0e284ffeGFKHh8sSQUCxSP');
  assert.equal(e.meta.reasoning_tokens, 114);
  assert.equal(e.meta.cache_write_tokens, 0);

  // 国内版同一模型也必须分开记（两条线的模型池重叠，不带归属就分不开是谁家的量）
  const cn = us.convertQwenworkSession({
    id: 'ses_de4660824ffe5vUH5I22J1JaQF', model: '{"id":"minimax-m3.1-flash","providerID":"anthropic","variant":"none"}',
    tokens_input: 37166, tokens_output: 194, tokens_cache_read: 3840,
    time_created: 1795759405019, time_updated: 1795759409404,
  }, 'cn');
  assert.equal(cn.provider, 'qwenwork-cn-anthropic');
  assert.equal(cn.endpoint, 'qwenwork://cn');
  assert.equal(cn.meta.qwenworkLine, 'cn');

  // cost 与 opencode 不同：国际版按量计费有源值，必须照记不归零
  const paid = us.convertQwenworkSession({
    id: 'ses_dff1ab5ebffe5EcW7NKPZPcZAd', model: '{"id":"qwen3.8-flash","providerID":"alibaba","variant":"low"}', cost: 0.00688707,
    tokens_input: 79773, tokens_output: 620, time_created: 1795311356436, time_updated: 1795315012526,
  }, 'intl');
  assert.equal(paid.cost, 0.00688707);

  // 缺时间戳不能用 Date.now() 兜底（每次同步都会变成新行）
  assert.equal(us.convertQwenworkSession({ id: 's', tokens_input: 1, tokens_output: 1 }), null);
  // model 不是 JSON / 缺 providerID 时退回品牌默认，不能整行丢
  const weird = us.convertQwenworkSession({ id: 's2', model: 'plain-text-model', tokens_input: 1, tokens_output: 1, time_created: 1795311356436 }, 'intl');
  assert.equal(weird.provider, 'qwenwork-qwenwork');
  assert.equal(weird.model, 'plain-text-model');
});

test('千问办公双线归属：按目录段精确匹配（.qwenwork 是 .qwenworkcn 的前缀，不能靠前缀判）', () => {
  assert.equal(us.qwenworkLineOfPath(path.join('/users/x', '.qwenworkcn', '.harness', 'flash-cli', 'qwenwork', 'qwenwork.db')), 'cn');
  assert.equal(us.qwenworkLineOfPath(path.join('/users/x', '.qwenwork', '.harness', 'flash-cli', 'qwenwork', 'qwenwork.db')), 'intl');
  assert.equal(us.qwenworkLineOfPath('C:\\Users\\x\\.qwenworkcn\\.harness\\flash-cli\\qwenwork\\qwenwork.db'), 'cn', 'Windows 反斜杠同样按段匹配');
  // 段不能命中目录名的一部分：只有整段等于 .qwenworkcn 才算国内版
  assert.equal(us.qwenworkLineOfPath(path.join('/backup', '.qwenworkcn-backup-2026', 'qwenwork.db')), 'intl');
  assert.equal(us.qwenworkLineOfPath('/tmp/whatever.db'), 'intl', '显式 QWENWORK_DB 副本无从判归属时按国际版记（保守标注，不影响量与模型）');
});

test('千问办公来源：双线目录都能发现、QWENWORK_DB 显式覆盖、缺库不误报（需要 node:sqlite）', { skip: !hasSqlite && 'node:sqlite 不可用（Node < 22.5）' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qww-paths-'));
  try {
    const mk = (line) => {
      const p = path.join(dir, line, '.harness', 'flash-cli', 'qwenwork', 'qwenwork.db');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x');
      return p;
    };
    const intl = mk('.qwenwork');
    const cn = mk('.qwenworkcn');
    const p = us.sourcePaths(dir, {}, 'win32');
    assert.deepEqual(p.qwenwork, [intl, cn], '双线库都发现，且国际版在前');
    // 显式覆盖排在前面，仍能按目录段判归属（放在 .qwenworkcn 下就是国内版）
    const explicit = path.join(dir, 'copy.db');
    fs.writeFileSync(explicit, 'x');
    assert.deepEqual(us.sourcePaths(dir, { QWENWORK_DB: explicit }, 'win32').qwenwork, [explicit, intl, cn]);
    assert.equal(us.qwenworkLineOfPath(cn), 'cn');
    // 家目录没有千问办公 → 空数组（detectSources 据此显示「本机未检测到」）
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qww-none-'));
    try { assert.deepEqual(us.sourcePaths(empty, { QWENWORK_DB: '' }, 'win32').qwenwork, []); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('千问办公来源：1 小时内仍在更新的会话暂不同步；坏库只跳这一份并提示（需要 node:sqlite）', { skip: !hasSqlite && 'node:sqlite 不可用（Node < 22.5）' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qww-test-'));
  try {
    const now = Date.now();
    const mkDb = (rel, build) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const db = new DatabaseSync(p);
      build(db);
      db.close();
      return p;
    };
    const sess = (db) => {
      db.exec('CREATE TABLE session (id TEXT, title TEXT, model TEXT, agent TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER)');
      return db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    };
    const intlDb = mkDb(path.join('.qwenwork', '.harness', 'flash-cli', 'qwenwork', 'qwenwork.db'), (db) => {
      const ins = sess(db);
      ins.run('s-intl-done', '已结束', '{"id":"flash","providerID":"openai-compatible"}', 'qwenwork', 0.01, 10, 5, 0, 0, 0, now - 5 * 3600e3, now - 3 * 3600e3);
      ins.run('s-intl-live', '进行中', '{"id":"flash","providerID":"openai-compatible"}', 'qwenwork', 0, 99, 9, 0, 0, 0, now - 2 * 3600e3, now - 60e3);
    });
    const cnDb = mkDb(path.join('.qwenworkcn', '.harness', 'flash-cli', 'qwenwork', 'qwenwork.db'), (db) => {
      sess(db).run('s-cn-done', '国内版', '{"id":"minimax-m3.1-flash","providerID":"anthropic"}', 'qwenwork', 0, 100, 20, 0, 0, 0, now - 4 * 3600e3, now - 2 * 3600e3);
    });
    const r = await us.collectSource('qwenwork', { paths: { qwenwork: [intlDb, cnDb] } });
    assert.deepEqual(r.entries.map((e) => e.meta.qwenworkSessionId).sort(), ['s-cn-done', 's-intl-done']);
    assert.equal(r.files, 2);
    assert.equal(r.entries.find((e) => e.meta.qwenworkSessionId === 's-cn-done').meta.qwenworkLine, 'cn', '双线归属按目录段落到每行');
    assert.equal(r.entries.find((e) => e.meta.qwenworkSessionId === 's-intl-done').meta.qwenworkLine, 'intl');
    assert.equal(r.entries.find((e) => e.meta.qwenworkSessionId === 's-cn-done').provider, 'qwenwork-cn-anthropic');
    assert.match(r.notes.join(' '), /暂不同步 1 个进行中的会话/, '进行中的会话先不发（同会话两行是 10R 去重拦不住的）');

    // 没有 session 表的库（客户端换版/不是预期形状）：只跳这一份并明说，不整源报错、不静默为空
    const bogus = mkDb('bogus.db', (db) => db.exec('CREATE TABLE unrelated (x INTEGER)'));
    const r2 = await us.collectSource('qwenwork', { paths: { qwenwork: [intlDb, bogus] } });
    assert.equal(r2.entries.length, 1, '坏库不影响另一份照常出账');
    assert.match(r2.notes.join(' '), /跳过 1 个千问办公账本/, '读不了的账本必须提示（否则来源静默为空，看着像没出问题）');
    // 根本不是 SQLite 的文件也不能把整源打挂
    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'not a database at all');
    const r3 = await us.collectSource('qwenwork', { paths: { qwenwork: [junk] } });
    assert.equal(r3.entries.length, 0);
    assert.match(r3.notes.join(' '), /跳过 1 个千问办公账本/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('zcode 来源：死表检测——最后记录超 7 天时 notes 提示（ZCode 0.16.9 静默失效）', async () => {
  if (!(await us.sqliteAvailable())) { console.log('skip: node:sqlite unavailable (CI Node 20)'); return; }
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-test-'));
  try {
    const dbPath = path.join(dir, 'db.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE model_usage (logical_request_id varchar, provider_id varchar, model_id varchar, agent varchar, status varchar, started_at integer, completed_at integer, duration_ms integer, input_tokens integer, output_tokens integer)');
    const old = Date.now() - 30 * 86400e3;
    db.prepare('INSERT INTO model_usage (logical_request_id, provider_id, model_id, agent, status, started_at, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?)').run('r1', 'account:plan', 'GLM-5', 'cli', 'completed', old, 10, 2);
    db.close();
    const r = await us.collectSource('zcode', { paths: { zcode: [dbPath] } });
    assert.equal(r.entries.length, 1);
    assert.ok(r.notes.some((n) => n.includes('不再向该表落库') && n.includes('30 天前')), '死表提示进 notes');
    // 新表（最近有行）不提示
    const dbPath2 = path.join(dir, 'db2.sqlite');
    const db2 = new DatabaseSync(dbPath2);
    db2.exec('CREATE TABLE model_usage (logical_request_id varchar, provider_id varchar, model_id varchar, agent varchar, status varchar, started_at integer, completed_at integer, duration_ms integer, input_tokens integer, output_tokens integer)');
    db2.prepare('INSERT INTO model_usage (logical_request_id, provider_id, model_id, agent, status, started_at, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?)').run('r1', 'account:plan', 'GLM-5', 'cli', 'completed', Date.now() - 3600e3, 10, 2);
    db2.close();
    const r2 = await us.collectSource('zcode', { paths: { zcode: [dbPath2] } });
    assert.deepEqual(r2.notes, [], '活表无提示');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
