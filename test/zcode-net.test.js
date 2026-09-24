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
