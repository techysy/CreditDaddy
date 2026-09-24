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

const us = await import('../src/usageSync.js');
const tr = await import('../src/tenrouter.js');
const hasSqlite = await us.sqliteAvailable();
after(() => fs.rmSync(root, { recursive: true, force: true }));

function mockFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const r = await handler(String(url), init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status || 200 });
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
    return { body: { imported: body.usageHistory.length, skipped: 0 } };
  });
  try {
    const r1 = await tr.runUsageSync();
    assert.match(m.calls[0].url, /\/api\/settings\/database\/import-usage$/);
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-abcdefghijklmnop');
    assert.deepEqual(posted[0].map((e) => e.meta.mirasimCallId), ['a', 'b']);   // c 经 10Router 中转，d 无 token
    assert.match(r1.summary, /新增 2 行/);

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
