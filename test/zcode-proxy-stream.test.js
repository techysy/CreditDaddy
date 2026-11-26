import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-proxy-'));
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[k];

const zc = await import('../src/zcodeClient.js');

// issue #72：代理链路上游掐断连接 → fetchViaProxy 的裸 PassThrough / tlsSocket 发出无人接管的
// 'error' → Node 按未捕获异常直接掀翻守护进程（47860 停摆，10Router 的 zcode/trae/minimax-free
// 通道全变 ECONNREFUSED，最长 19 小时无人拉起）。
// 这里跑的是**真实** fetchViaProxy（不经 _setViaProxyForTests mock），用本机假代理把连接掐断，
// 脱离外网确定性复现。崩溃发生在进程级：一旦没兜住，整个文件判负——这就是回归闸。

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

/** 假代理：响应头与首块确认落进 socket 后再掐断（= 上游把连接切断）——
 *  write 回调里 destroy 保证客户端已收到响应头，时序与线上崩溃一致：
 *  fetchViaProxy 已 resolve、调用方还没开始读 body，断连就来了 */
function halfOpenProxy() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    res.write('{"partial":', () => req.socket.destroy());
  });
}

/** 假代理：CONNECT 回 200 后立刻断链——TLS 握手期失败（2026-10-05 线上崩的是这条） */
function deadTunnelProxy() {
  const srv = http.createServer();
  srv.on('connect', (req, clientSocket) => {
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    clientSocket.destroy();
  });
  return srv;
}

/** 假代理：CONNECT 后把隧道接到本机源站（正路用）。fetchViaProxy 的 https 分支固定连
 *  hostname:443，这里忽略它请求的端口、一律转给指定本机端口——假代理本就只管隧道 */
function forwardingProxy(targetPort) {
  const srv = http.createServer();
  srv.on('connect', (req, clientSocket, head) => {
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    const up = net.connect(targetPort, '127.0.0.1', () => {
      up.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => up.destroy());
      if (head && head.length) up.write(head);
      clientSocket.pipe(up); up.pipe(clientSocket);
    });
  });
  return srv;
}

/** 本地自签证书（openssl 现生成，不落盘到仓库；无 openssl 时调用方跳过该用例） */
function selfSigned() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-test-cert-'));
    const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', crt,
      '-days', '2', '-nodes', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
      { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  } catch { return null; }
}

/** 断言进程仍然健康：再发一发真实请求，能通就说明没被带走 */
async function assertDaemonAlive() {
  const alive = http.createServer((req, res) => res.end('alive'));
  const port = await listen(alive);
  zc.setProxyUrl(`http://127.0.0.1:${port}`);
  try {
    const r = await zc.fetchJsonRace('http://api.creditdaddy-test.invalid/after-crash', { preferProxy: true, timeoutMs: 3000 });
    assert.equal(await r.text(), 'alive', '断连之后守护进程应照常服务');
  } finally { zc.setProxyUrl(''); alive.close(); }
}

test('代理流式响应被掐断：进程不得退出，body 读取照常报错（issue #72 PassThrough）', async () => {
  const proxy = halfOpenProxy();
  const port = await listen(proxy);
  zc.setProxyUrl(`http://127.0.0.1:${port}`);
  try {
    const res = await zc.fetchJsonRace('http://api.creditdaddy-test.invalid/x', { preferProxy: true, timeoutMs: 3000 });
    // 留出窗口：destroy(err) 的 'error' 在下一 tick 发出，此刻读侧还没挂上监听——线上崩溃正是这个时序
    await new Promise((r) => setTimeout(r, 120));
    await assert.rejects(() => res.text(), /连接中断|aborted|ECONNRESET|socket/i, '错误仍应抛给调用方，只是不再升级成进程异常');
  } finally { zc.setProxyUrl(''); proxy.close(); }
  await assertDaemonAlive();
});

test('代理 CONNECT 隧道建好后 TLS 握手失败：进程不得退出（issue #72 TLSSocket）', async () => {
  const proxy = deadTunnelProxy();
  const port = await listen(proxy);
  zc.setProxyUrl(`http://127.0.0.1:${port}`);
  try {
    // 代理与直连两条路都会失败（.invalid 解析不了），聚合后抛出——重点是别把进程带走
    await assert.rejects(() => zc.fetchJsonRace('https://api.creditdaddy-test.invalid/x', { preferProxy: true, timeoutMs: 4000 }));
    await new Promise((r) => setTimeout(r, 120));
  } finally { zc.setProxyUrl(''); proxy.close(); }
  await assertDaemonAlive();
});

test('代理响应正常收尾不受影响：完整 body 原样读出', async () => {
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"code":0}');
  });
  const port = await listen(proxy);
  zc.setProxyUrl(`http://127.0.0.1:${port}`);
  try {
    const res = await zc.fetchJsonRace('http://api.creditdaddy-test.invalid/ok', { preferProxy: true, timeoutMs: 3000 });
    assert.deepEqual(await res.json(), { code: 0 });
  } finally { zc.setProxyUrl(''); proxy.close(); }
});

// 握手改成 await 之后，必须确认「隧道 + TLS 成功」这条正路仍然通（上面只覆盖失败路径）
test('代理 CONNECT 隧道 + TLS 握手成功：await 改动不影响正常请求', async (t) => {
  const cert = selfSigned();
  if (!cert) { t.skip('本机无 openssl，跳过 TLS 正路用例'); return; }
  const origin = https.createServer(cert, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"code":42}');
  });
  const originPort = await listen(origin);
  const proxy = forwardingProxy(originPort);
  const proxyPort = await listen(proxy);
  // 自签证书只为跑通隧道 + TLS 成功路径，不验证身份：临时关掉校验，用完立刻恢复
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  zc.setProxyUrl(`http://127.0.0.1:${proxyPort}`);
  try {
    // 域名不必可解析：隧道由代理建，本机不做 DNS（loopback 地址会被 proxyBypass 挡掉，走不到代理）
    const res = await zc.fetchJsonRace('https://cd-tunnel.test/quota', { preferProxy: true, timeoutMs: 4000 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { code: 42 }, '隧道内响应应完整读出');
  } finally {
    zc.setProxyUrl('');
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    proxy.close(); origin.close();
  }
});
