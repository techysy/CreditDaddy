/**
 * Trae OAuth 登录闭环的自证测试：授权 URL 拼装、回调解析（二次编码 / JWT 含 =）、
 * CSRF 绑定、换票主机白名单，以及「探测 → 回调 → 换票」的全链路——
 * 授权页侧的行为用本地回环模拟（探测请求 / 凭据回调），换票端点用本地 mock 承接。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  buildAuthorizeUrl, parseCallbackQuery, parseCallbackParams,
  resolveExchangeHost, newDeviceId, newDeviceIdentity,
  startTraeLogin, pollTraeLogin, _resetForTests,
} from '../src/traeAuth.js';

const TEST_PORT = 46123;
const identity = {
  deviceId: '2297305622694752',
  machineId: '0e802b6d-9a2e-4f12-9a7e-1c4b6f0a9e11',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nX\n-----END PUBLIC KEY-----',
  privateKeyJwk: { kty: 'EC', crv: 'P-256' },
};

test('设备身份：deviceId 是 16 位纯数字（签到风控约束），密钥对成对生成', () => {
  for (let i = 0; i < 20; i++) {
    const id = newDeviceId();
    assert.match(id, /^[1-9]\d{15}$/);
  }
  const id2 = newDeviceIdentity();
  assert.match(id2.deviceId, /^[1-9]\d{15}$/);
  assert.match(id2.machineId, /^[0-9a-f-]{36}$/);
  assert.match(id2.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.equal(id2.privateKeyJwk.kty, 'EC');
  assert.equal(id2.privateKeyJwk.crv, 'P-256');
});

test('授权 URL：外层 /login 包装 + 内层 22 参数逐项对齐真机抓包', () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const traceId = crypto.randomUUID();
  const url = buildAuthorizeUrl({ port: 3379, traceId, challenge, identity });

  assert.ok(url.startsWith('https://www.trae.cn/login?login_platform=trae&redirect_url='));
  const inner = JSON.parse('"' + new URL(url).searchParams.get('redirect_url') + '"');
  assert.ok(inner.startsWith('https://www.trae.cn/authorization?'));
  const q = new URL(inner).searchParams;
  assert.equal(q.get('login_version'), '1');
  assert.equal(q.get('auth_from'), 'trae');
  assert.equal(q.get('login_channel'), 'native_ide');
  assert.equal(q.get('auth_type'), 'local');
  assert.equal(q.get('client_id'), 'ono9krqynydwx5');
  assert.equal(q.get('redirect'), '0');
  assert.equal(q.get('login_trace_id'), traceId);
  assert.equal(q.get('auth_callback_url'), 'http://127.0.0.1:3379/authorize');
  assert.equal(q.get('machine_id'), identity.machineId);
  assert.equal(q.get('device_id'), identity.deviceId);
  assert.equal(q.get('x_device_id'), identity.deviceId);
  assert.equal(q.get('x_machine_id'), identity.machineId);
  assert.equal(q.get('x_env'), '');
  assert.equal(q.get('x_app_type'), 'stable');
  assert.equal(q.get('code_challenge'), challenge);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('channel_name'), 'common');
  // 22 参数
  assert.equal([...q.keys()].length, 22);
});

test('回调解析：路径前缀剥离、二次编码还原、值里含 = 的 JWT 不被截断、裸键按空值处理', () => {
  const jwt = 'eyJhbGciOiJub25lIn0.eyJkYXRhIjp7ImlkIjoxfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c=';
  // 真实形状：每个「值」可能被二次编码（授权页把整个回调 URL 再 encode 一层时）；
  // jwt 的 base64url 填充 = 以 %3D 形态进来，解码一次后还原
  const q = parseCallbackQuery('/authorize?a=1'
    + `&authCodeInfo=${encodeURIComponent(encodeURIComponent('{"AuthCode":"ac-1"}'))}`
    + `&t=${encodeURIComponent(jwt)}`
    + '&bare&host=http%3A%2F%2Fapi.trae.cn');
  assert.equal(q.a, '1');
  assert.deepEqual(JSON.parse(q.authCodeInfo), { AuthCode: 'ac-1' });
  assert.equal(q.t, jwt);
  assert.equal(q.bare, '');
  assert.equal(q.host, 'http://api.trae.cn');
});

test('回调参数：authCodeInfo 提取 AuthCode/ExpireAt，userInfo 取 uid/昵称，error 透传', () => {
  const p = parseCallbackParams({
    authCodeInfo: JSON.stringify({ AuthCode: 'ac-2', ExpireAt: Math.floor(Date.now() / 1000) + 600 }),
    userInfo: JSON.stringify({ UserID: '1910311587417227', ScreenName: '测试师' }),
    host: 'https://api.trae.cn',
    userRegion: 'cn',
    loginTraceID: 'tid-1',
  });
  assert.equal(p.authCode, 'ac-2');
  assert.ok(p.codeExpireAt > 0);
  assert.equal(p.uid, '1910311587417227');
  assert.equal(p.name, '测试师');
  assert.equal(p.host, 'https://api.trae.cn');
  assert.equal(p.region, 'cn');
  assert.equal(p.traceId, 'tid-1');
  assert.equal(p.error, null);

  const denied = parseCallbackParams({ error: 'user_cancel' });
  assert.equal(denied.error, 'user_cancel');
});

test('换票主机：白名单族放行、回环保留 scheme、外域回落 api.trae.cn', () => {
  assert.equal(resolveExchangeHost('https://api.trae.cn/').host, 'https://api.trae.cn');
  assert.equal(resolveExchangeHost('api.trae.com.cn').host, 'https://api.trae.com.cn');
  assert.equal(resolveExchangeHost('http://127.0.0.1:46999').host, 'http://127.0.0.1:46999');
  assert.equal(resolveExchangeHost('https://evil.example.com').host, 'https://api.trae.cn');
  assert.equal(resolveExchangeHost('https://evil.example.com').usedFallback, 'rejected');
  assert.equal(resolveExchangeHost('').usedFallback, 'missing');
});

// ── 全链路：探测 → 回调 → 换票（本地 mock 授权页 + mock 换票端点） ──

let mockExchange;
let mockCalls;

beforeEach(async () => {
  _resetForTests();
  mockCalls = [];
  mockExchange = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      mockCalls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      // 主端点成功，兜底端点返回 404 以证明不会走到
      if (req.url === '/trae/api/v3/oauth/ExchangeToken') {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ data: { id: 1910311587417227 }, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accessToken: jwt, refreshToken: 'rt-1', expiresIn: 3600 }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
      }
    });
  });
  await new Promise((resolve) => mockExchange.listen(0, '127.0.0.1', resolve));
});

afterEach(() => {
  _resetForTests();
  mockExchange.closeAllConnections?.();
  mockExchange.close();
});

function enc2(s) {
  return encodeURIComponent(encodeURIComponent(s));
}

async function fireCallback(port, query) {
  const res = await fetch(`http://127.0.0.1:${port}/authorize?${query}`);
  return { status: res.status, cors: res.headers.get('access-control-allow-origin'), text: await res.text() };
}

test('全链路：探测应答 200+CORS → 凭据回调 → 换票成功出账号', async () => {
  const mockPort = mockExchange.address().port;
  const flow = await startTraeLogin('trae', { ports: [TEST_PORT] });
  const port = TEST_PORT;
  // 回调地址在外层包装里是双重编码形态
  assert.equal(flow.url.includes(encodeURIComponent(encodeURIComponent(`http://127.0.0.1:${port}/authorize`))), true);

  // 授权 URL 里带出了本次的 login_trace_id（CSRF 绑定值）
  const inner = new URL(flow.url).searchParams.get('redirect_url');
  const traceId = new URL(inner).searchParams.get('login_trace_id');

  // ① 在线探测（无凭据）：200 + CORS，且不是终态
  const probe = await fireCallback(port, 'x=1');
  assert.equal(probe.status, 200);
  assert.equal(probe.cors, '*');
  assert.equal((await pollTraeLogin(flow.data)).status, 'pending');

  // ② 凭据回调（authCodeInfo 走二次编码，host 指向本地 mock 换票端点）
  const cb = await fireCallback(port, enc2(`authCodeInfo=${JSON.stringify({ AuthCode: 'ac-real', ExpireAt: Math.floor(Date.now() / 1000) + 600 })}`)
    + `&userInfo=${encodeURIComponent(JSON.stringify({ UserID: '1910311587417227', ScreenName: '测试师' }))}`
    + `&host=${enc2(`http://127.0.0.1:${mockPort}`)}`
    + `&userRegion=cn&loginTraceID=${traceId}`);
  assert.equal(cb.status, 200);
  assert.match(cb.text, /授权成功/);

  // ③ 轮询拿到账号；换票打的是主端点、请求体逐项对齐
  const r = await pollTraeLogin(flow.data);
  assert.equal(r.status, 'ok');
  assert.equal(r.input.provider, 'trae');
  assert.equal(r.input.uid, '1910311587417227');
  assert.equal(r.input.refreshToken, 'rt-1');
  assert.equal(r.input.source, 'browser');
  assert.match(r.input.meta.traeDevice.deviceId, /^[1-9]\d{15}$/);
  assert.equal(r.input.meta.traeDevice.machineId, mockCalls[0].body.DeviceInfo.MachineID);
  assert.equal(r.input.meta.traeDevice.privateKeyJwk.kty, 'EC');
  assert.ok(r.input.expiresAt);

  assert.equal(mockCalls.length, 1);
  const call = mockCalls[0];
  assert.equal(call.url, '/trae/api/v3/oauth/ExchangeToken');
  assert.equal(call.body.ClientID, 'ono9krqynydwx5');
  assert.equal(call.body.AuthCode, 'ac-real');
  assert.ok(call.body.CodeVerifier);
  assert.equal(call.body.DeviceInfo.DeviceID, r.input.meta.traeDevice.deviceId);
  assert.equal(call.body.DeviceInfo.PlatformCode, 'IDE_PC');
  assert.equal(call.body.DeviceInfo.DevicePublicKey, r.input.meta.traeDevice.publicKeyPem);
  assert.equal(call.body.IDEVersion, '3.4.9');
  assert.equal(call.headers['x-cloudide-token'], '');
  // 会话收摊：再次轮询按「会话不存在」终态失败
  await assert.rejects(() => pollTraeLogin(flow.data), /会话不存在/);
});

test('全链路：回调 loginTraceID 不匹配 → CSRF 拒绝', async () => {
  const mockPort = mockExchange.address().port;
  const flow = await startTraeLogin('trae', { ports: [TEST_PORT + 1] });
  await fireCallback(TEST_PORT + 1, enc2(`authCodeInfo=${JSON.stringify({ AuthCode: 'ac-x' })}`)
    + `&host=${enc2(`http://127.0.0.1:${mockPort}`)}&loginTraceID=tampered-id`);
  await assert.rejects(() => pollTraeLogin(flow.data), /loginTraceID/);
  assert.equal(mockCalls.length, 0);
});

test('全链路：拒绝回调（error=）不误判为探测，立即终态失败', async () => {
  const flow = await startTraeLogin('trae', { ports: [TEST_PORT + 2] });
  await fireCallback(TEST_PORT + 2, 'error=user_cancel&error_description=denied');
  await assert.rejects(() => pollTraeLogin(flow.data), /user_cancel|拒绝/);
});
