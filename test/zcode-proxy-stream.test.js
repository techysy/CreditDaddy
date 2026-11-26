import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-zproxy-'));

const zc = await import('../src/zcodeClient.js');

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
