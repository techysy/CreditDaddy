import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-zproxy-'));
// 开发机 shell 里常带 HTTPS_PROXY：不清掉会让「没配代理」的用例绕道真实代理，结果随机器漂移
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[k];

const zc = await import('../src/zcodeClient.js');

/** 本机起一个监听，返回端口 */
function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

/** 在一段易崩的代码外面套一个未捕获异常收集器：Node 默认把无人接管的 'error' 直接 throw
 *  掀翻进程，装了收集器它就落到数组里 —— 断言数组为空即「进程没被带走」 */
async function assertNoUncaught(fn) {
  const seen = [];
  const onUncaught = (e) => seen.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 120));   // 'error' 在下一 tick 才发出
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(seen.map((e) => e?.message || String(e)), [], '不得出现未捕获异常（守护进程会被带走）');
}

/** 假代理：CONNECT 回 200 后立刻掐断隧道 —— TLS 握手期失败（issue #72 记的 2026-10-05 崩的是这一处） */
function deadTunnelProxy() {
  const srv = http.createServer();
  srv.on('connect', (req, client) => {
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    setTimeout(() => client.destroy(), 5);
  });
  return srv;
}

/** 假代理：CONNECT 后把隧道转给本机源站（正路用）。fetchViaProxy 的 https 分支固定连
 *  hostname:443，这里忽略它请求的端口、一律转给指定本机端口——假代理本就只管隧道 */
function forwardingProxy(targetPort) {
  const srv = http.createServer();
  srv.on('connect', (req, client, head) => {
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    const up = net.connect(targetPort, '127.0.0.1', () => {
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
      if (head?.length) up.write(head);
      client.pipe(up); up.pipe(client);
    });
  });
  return srv;
}

/** 自签证书（openssl 现生成，不落盘进仓库；无 openssl 时调用方跳过该用例） */
function selfSigned() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-test-cert-'));
    const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', crt,
      '-days', '2', '-nodes', '-subj', '/CN=cd-tunnel.test', '-addext', 'subjectAltName=DNS:cd-tunnel.test'],
      { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  } catch { return null; }
}

// #72：代理上游在 body 中途掐断连接时，只应让这一次响应失败，不能把守护进程带走。
// 此前 fetchViaProxy 的 PassThrough 没挂 'error' 监听，调用方还没开始读 body 时
// pass.destroy(err) 就会抛 Unhandled 'error' event，进程直接退出。
test('fetchViaProxy：上游中途断开只让这次响应失败，不抛未处理的 error', async () => {
  // 一个「代理」：http 目标走绝对 URI 转发，这里直接回响应头，写一半 body 后掐断
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"code":0,');
    setTimeout(() => res.socket.destroy(), 20);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    zc.setProxyUrl(`http://127.0.0.1:${server.address().port}`);
    zc.setProxyFirst(true);
    // 目标不能是 loopback（loopback 不走代理）；域名只经代理转发，不会被本机解析
    const res = await zc.fetchJsonRace('http://upstream.example/api', { timeoutMs: 5000 });
    assert.equal(res.status, 200);
    // 断开发生在调用方读 body 之前：此时 PassThrough 上没有任何消费者
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(uncaught, [], '断开不应变成未捕获异常');
    await assert.rejects(res.text());
  } finally {
    process.off('uncaughtException', onUncaught);
    zc.setProxyFirst(false);
    zc.setProxyUrl(null);
    await new Promise((r) => server.close(r));
  }
});

// issue #72 同一函数里的另一处同类隐患：tls.connect() 之后、交给 https.request 之前，
// tlsSocket 自己没有 'error' 监听（报告者把 2026-10-05 那次崩溃归到这里）。
// 说明：Node 22 上这条时序里握手错误会被 req 接走，摘掉源码那行监听本用例仍为绿 —— 它锁的是
// 「握手失败只能让这次请求失败、绝不能升级成进程异常」这条口径，一旦有人把 tls.connect 改成
// await 握手 / 换实现重新打开窗口（那正是当年崩的形态），这里就会变红。
test('fetchViaProxy：CONNECT 后 TLS 握手失败不抛未处理的 error，且按请求错误尽快收尾', async () => {
  const proxy = deadTunnelProxy();
  const port = await listen(proxy);
  zc.setProxyUrl(`http://127.0.0.1:${port}`);
  zc.setProxyFirst(true);
  const t0 = Date.now();
  try {
    await assertNoUncaught(async () => {
      // cd-tunnel.test 是保留域：本机不解析（直连那条必失败），隧道由假代理建
      await assert.rejects(
        zc.fetchJsonRace('https://cd-tunnel.test/quota', { timeoutMs: 15000 }),
        '握手失败应作为普通请求错误抛给调用方',
      );
    });
    // 必须尽快了结，不能吊满 15s 墙钟（Node 自己会报「disconnected before secure TLS」）
    assert.ok(Date.now() - t0 < 8000, `握手失败应尽快抛出，不该吊满墙钟（实际耗时 ${Date.now() - t0}ms）`);
  } finally {
    zc.setProxyFirst(false);
    zc.setProxyUrl(null);
    await new Promise((r) => proxy.close(r));
  }
});

// 兜底不能把正路堵死：隧道 + TLS 握手成功时，请求必须照常拿到完整响应
test('fetchViaProxy：CONNECT 隧道内 TLS 握手成功，响应照旧完整读出', async (t) => {
  const cert = selfSigned();
  if (!cert) { t.skip('本机无 openssl，跳过 TLS 正路用例'); return; }
  const origin = https.createServer(cert, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"code":42}');
  });
  const originPort = await listen(origin);
  const proxy = forwardingProxy(originPort);
  const proxyPort = await listen(proxy);
  // 自签证书只为跑通「隧道 + TLS 成功」这条正路，不验证身份：临时关掉校验，用完立刻恢复
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  zc.setProxyUrl(`http://127.0.0.1:${proxyPort}`);
  zc.setProxyFirst(true);
  try {
    await assertNoUncaught(async () => {
      const res = await zc.fetchJsonRace('https://cd-tunnel.test/quota', { timeoutMs: 8000 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { code: 42 }, '隧道内响应应完整读出');
    });
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    zc.setProxyFirst(false);
    zc.setProxyUrl(null);
    await new Promise((r) => { proxy.close(); origin.close(); r(); });
  }
});

// 证书校验不能被兜底顺手关掉：自签证书必须仍然报错，而不是悄悄放行
test('fetchViaProxy：隧道内证书不可信仍按握手失败报错（不得放宽校验）', async (t) => {
  const cert = selfSigned();
  if (!cert) { t.skip('本机无 openssl，跳过证书负路用例'); return; }
  const origin = https.createServer(cert, (req, res) => res.end('{}'));
  const originPort = await listen(origin);
  const proxy = forwardingProxy(originPort);
  const proxyPort = await listen(proxy);
  zc.setProxyUrl(`http://127.0.0.1:${proxyPort}`);
  zc.setProxyFirst(true);
  try {
    await assertNoUncaught(async () => {
      await assert.rejects(
        zc.fetchJsonRace('https://cd-tunnel.test/quota', { timeoutMs: 8000 }),
        /self-signed|self signed|certificate|altname|CA cert|fetch failed|unable to verify/i,
        '自签证书应被拒绝',
      );
    });
  } finally {
    zc.setProxyFirst(false);
    zc.setProxyUrl(null);
    await new Promise((r) => { proxy.close(); origin.close(); r(); });
  }
});
