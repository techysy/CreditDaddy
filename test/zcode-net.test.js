import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-znet-'));

const zc = await import('../src/zcodeClient.js');

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

beforeEach(() => {
  for (const k of PROXY_ENV) delete process.env[k];
  zc.setProxyFirst(false);
  zc._setViaProxyForTests(null);
});

/** mock 直连（global fetch）与代理（_setViaProxyForTests），记录调用顺序 */
function stubFetch(log, { directFail = false, proxyFail = false } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    log.push('direct');
    if (directFail) throw new Error('直连被重置');
    return new Response('{"code":0}');
  };
  zc._setViaProxyForTests(async () => {
    log.push('proxy');
    if (proxyFail) throw new Error('代理拒绝');
    return new Response('{"code":0}');
  });
  return () => { globalThis.fetch = realFetch; zc._setViaProxyForTests(null); };
}

test('proxyFirst / setProxyFirst：默认 false，落盘后可读回', () => {
  assert.equal(zc.proxyFirst(), false);
  zc.setProxyFirst(true);
  assert.equal(zc.proxyFirst(), true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.CREDITDADDY_HOME, 'zcode-net.json'), 'utf8'));
  assert.equal(onDisk.proxyFirst, true);
  zc.setProxyFirst(false);
});

test('自动轮询领取开关：默认关，开启后落盘', () => {
  assert.equal(zc.autoClaimEnabled(), false);
  zc.setAutoClaimEnabled(true);
  assert.equal(zc.autoClaimEnabled(), true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.CREDITDADDY_HOME, 'zcode-net.json'), 'utf8'));
  assert.equal(onDisk.autoClaim, true);
  assert.equal(onDisk.autoClaimUntil, null, '普通开启不带时限');
  zc.setAutoClaimEnabled(false);
  assert.equal(zc.autoClaimEnabled(), false);
});

test('enableAutoClaimFor：限时开启，到期自动失效；手动关闭清掉时限', () => {
  assert.equal(zc.autoClaimEnabled(), false);
  zc.enableAutoClaimFor(60 * 60 * 1000);
  assert.equal(zc.autoClaimEnabled(), true);
  assert.ok(zc.autoClaimUntil() > Date.now() + 55 * 60 * 1000, '时限应在 ~1 小时后');
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.CREDITDADDY_HOME, 'zcode-net.json'), 'utf8'));
  assert.equal(onDisk.autoClaim, true);
  assert.ok(onDisk.autoClaimUntil > Date.now(), '到期时间落盘（重启后仍生效）');

  zc.setAutoClaimEnabled(false);
  assert.equal(zc.autoClaimEnabled(), false);
  assert.equal(zc.autoClaimUntil(), null);
  const off = JSON.parse(fs.readFileSync(path.join(process.env.CREDITDADDY_HOME, 'zcode-net.json'), 'utf8'));
  assert.equal(off.autoClaimUntil, null);
});

test('enableAutoClaimFor：非法时长拒绝', () => {
  assert.throws(() => zc.enableAutoClaimFor(0));
  assert.throws(() => zc.enableAutoClaimFor(-1000));
  assert.throws(() => zc.enableAutoClaimFor('x'));
});

test('setProxyUrl：设置 / 读取 / 清除；非法地址拒绝', () => {
  assert.equal(zc.proxyUrl(), null);
  zc.setProxyUrl('http://127.0.0.1:7890');
  assert.equal(zc.proxyUrl(), 'http://127.0.0.1:7890');
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.CREDITDADDY_HOME, 'zcode-net.json'), 'utf8'));
  assert.equal(onDisk.proxyUrl, 'http://127.0.0.1:7890');
  assert.throws(() => zc.setProxyUrl('socks5://127.0.0.1:1080'), /http:\/\/.*代理/);
  zc.setProxyUrl('');
  assert.equal(zc.proxyUrl(), null);
  zc.setProxyUrl(null);
  assert.equal(zc.proxyUrl(), null);
});

test('fetchJsonRace：面板配置的代理优先级高于环境变量', async () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  zc.setProxyUrl('http://127.0.0.1:7890');
  const log = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { log.push('direct'); return new Response('{"code":0}'); };
  let usedProxyUrl = null;
  zc._setViaProxyForTests(async (url) => { log.push('proxy'); usedProxyUrl = url; return new Response('{"code":0}'); });
  try {
    await zc.fetchJsonRace('https://zcode.z.ai/api/v1/test');
    assert.deepEqual(log, ['direct'], '直连成功时不触碰代理');
  } finally { globalThis.fetch = realFetch; zc._setViaProxyForTests(null); zc.setProxyUrl(''); }
});

test('fetchJsonRace：无代理环境只尝试直连', async () => {
  const log = [];
  const restore = stubFetch(log);
  try {
    const res = await zc.fetchJsonRace('https://zcode.z.ai/api/v1/test');
    assert.equal(res.status, 200);
    assert.deepEqual(log, ['direct']);
  } finally { restore(); }
});

test('fetchJsonRace：默认直连优先，直连失败回退代理', async () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  const log = [];
  const restore = stubFetch(log, { directFail: true });
  try {
    const res = await zc.fetchJsonRace('https://zcode.z.ai/api/v1/zcode-plan/billing/preview');
    assert.equal(res.status, 200);
    assert.deepEqual(log, ['direct', 'proxy'], '先直连、失败后走代理');
  } finally { restore(); }
});

test('fetchJsonRace：代理优先时代理先行，代理失败回退直连', async () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  zc.setProxyFirst(true);
  const log = [];
  const restore = stubFetch(log, { proxyFail: true });
  try {
    const res = await zc.fetchJsonRace('https://zcode.z.ai/api/v1/zcode-plan/billing/preview');
    assert.equal(res.status, 200);
    assert.deepEqual(log, ['proxy', 'direct'], '先代理、失败后回直连');
  } finally { restore(); }
});

test('fetchJsonRace：connectMs 两段式超时——连接段挂死快速失败换下一条路', async () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  const log = [];
  const realFetch = globalThis.fetch;
  // 直连黑洞：永不返回响应头，直到 signal abort。
  // 挂一个 ref'd 定时器保活事件循环——AbortSignal.timeout 的定时器是 unref 的，
  // 真实 fetch 靠 socket 句柄保活，mock 没有句柄，不补的话事件循环会提前排空。
  globalThis.fetch = async (url, init) => {
    log.push('direct');
    await new Promise((_, rej) => {
      const keepAlive = setInterval(() => {}, 1000);
      init.signal.addEventListener('abort', () => { clearInterval(keepAlive); rej(new Error('aborted')); }, { once: true });
    });
    throw new Error('unreachable');
  };
  zc._setViaProxyForTests(async () => { log.push('proxy'); return new Response('{"code":0}'); });
  try {
    const t0 = Date.now();
    const res = await zc.fetchJsonRace('https://zcode.z.ai/api/v1/x', { connectMs: 100, timeoutMs: 5000 });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 2000, `应在 connectMs(100ms) 附近失败换路，而不是吊满 timeoutMs：${Date.now() - t0}ms`);
    assert.deepEqual(log, ['direct', 'proxy'], '直连连接段超时后应走代理兜底');
  } finally { globalThis.fetch = realFetch; zc._setViaProxyForTests(null); }
});

test('fetchJsonRace：connectMs 只限连接段——响应头到达后 body 可以慢慢流', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    // 响应头立即返回，body 在 300ms 后才吐完（远超 connectMs=50）——
    // 若连接段限时没有在响应头到达时解除，这个流会被 connectSignal abort 掐断
    const stream = new ReadableStream({
      start(c) { setTimeout(() => { c.enqueue(Buffer.from('{"code":0}')); c.close(); }, 300); },
    });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: stream, signal: init.signal };
  };
  try {
    const res = await zc.fetchJsonRace('https://zcode.z.ai/api/v1/x', { connectMs: 50, timeoutMs: 5000 });
    assert.equal(res.status, 200, '响应头到达即算连接成功');
    // 真正消费流：300ms 后才结束，期间 connectSignal 已触发但不应影响 body
    const chunks = [];
    for await (const chunk of res.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), '{"code":0}', 'body 应在 connectMs 之后仍完整流出');
  } finally { globalThis.fetch = realFetch; }
});

test('fetchJsonRace：不传 connectMs 时退回单段 timeoutMs（旧行为）', async () => {
  const realFetch = globalThis.fetch;
  let capturedSignal = null;
  globalThis.fetch = async (url, init) => { capturedSignal = init.signal; return new Response('{"code":0}'); };
  try {
    await zc.fetchJsonRace('https://zcode.z.ai/api/v1/x', { timeoutMs: 3000 });
    assert.ok(capturedSignal, '应挂上超时 signal');
    assert.equal(capturedSignal.aborted, false);
  } finally { globalThis.fetch = realFetch; }
});

test('fetchJsonRace：NO_PROXY 命中与 loopback 不走代理；都失败时抛出最后错误', async () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  process.env.NO_PROXY = 'zcode.z.ai';
  const log = [];
  const restore = stubFetch(log, { directFail: true, proxyFail: true });
  try {
    await assert.rejects(zc.fetchJsonRace('https://zcode.z.ai/x'), /直连被重置/);
    assert.deepEqual(log, ['direct'], 'NO_PROXY 内的域名不尝试代理');

    log.length = 0;
    await assert.rejects(zc.fetchJsonRace('http://127.0.0.1:20128/api'), /直连被重置/);
    assert.deepEqual(log, ['direct'], 'loopback 不尝试代理');
  } finally { restore(); }
});
