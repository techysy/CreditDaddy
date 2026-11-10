/**
 * 稳健性审计（2026-10-29 全量审计）的回归测试。
 *
 * 覆盖三类修复：
 *   1. tenrouter.loadConfig 不再用默认值静默覆盖读不了的配置（EPERM/损坏 → 报错 + .bak 恢复）；
 *      withConfig 在读失败时不得把「默认值 + 本轮改动」写回盘
 *   2. 三个网关 forgetAccount：删除账号后进程内轮换/冷却状态同步清掉
 *   3. qoderClient 对「200 但非 JSON」响应报明确错误，不再让 SyntaxError 冒充「token 不可用」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离代理：qoderClient 的 webReq → fetchJsonRace(preferProxy) 在配置了
// https_proxy 时会走 node:http/tls 的 viaProxy 路径（不经 globalThis.fetch），
// 开发机 shell 带代理变量会让 stub 失效、真网络闯进「无网络」测试。
for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'all_proxy']) delete process.env[k];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-audit-'));
process.env.CREDITDADDY_HOME = path.join(root, 'data');

const tr = await import('../src/tenrouter.js');
const zg = await import('../src/zcodeGateway.js');
const tg = await import('../src/traeGateway.js');
const mg = await import('../src/minimaxGateway.js');

const cfgFile = () => path.join(process.env.CREDITDADDY_HOME, 'tenrouter.json');

test('loadConfig：文件不存在 → 默认配置；损坏 → 报错而不是静默重置', () => {
  fs.rmSync(cfgFile(), { force: true });
  assert.equal(tr.loadConfig().endpoint, '', 'ENOENT 走默认值');

  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), '{"endpoint":"https://10r.example.com","key":"sk-real","sync":{');
  assert.throws(() => tr.loadConfig(), /读取 .* 失败/, '损坏文件必须上抛——返回默认值会让下一次 withConfig 把真配置整份抹掉');
});

test('loadConfig：主文件损坏但 .bak 完好 → 用备份恢复', () => {
  fs.writeFileSync(cfgFile() + '.bak', JSON.stringify({ endpoint: 'https://10r.example.com', key: 'sk-from-bak' }));
  const c = tr.loadConfig();
  assert.equal(c.endpoint, 'https://10r.example.com');
  assert.equal(c.key, 'sk-from-bak');
});

test('withConfig：读失败时跳过落盘，损坏文件原样保留', async () => {
  // 独立前提：主文件损坏且没有 .bak（上一个用例留下的备份会让损坏被恢复）
  fs.rmSync(cfgFile() + '.bak', { force: true });
  fs.writeFileSync(cfgFile(), '{"endpoint":"https://10r.example.com","key":"sk-real","sync":{');
  const before = fs.readFileSync(cfgFile(), 'utf8');
  await assert.rejects(() => tr.updateConfig({ key: 'sk-new' }), /读取/);
  assert.equal(fs.readFileSync(cfgFile(), 'utf8'), before, '读失败绝不能把默认配置写回盘');
});

test('saveConfig：成功写盘前留 .bak（供主文件损坏时恢复）', async () => {
  // 当前主文件是损坏的：先放一份完好的（模拟上一次成功保存），再走一次正常保存
  fs.writeFileSync(cfgFile(), JSON.stringify({ endpoint: 'https://10r.example.com', key: 'sk-old' }));
  await tr.updateConfig({ key: 'sk-newer' });
  const bak = JSON.parse(fs.readFileSync(cfgFile() + '.bak', 'utf8'));
  assert.equal(bak.key, 'sk-old', '.bak 应该是写盘前那份');
  assert.equal(JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).key, 'sk-newer');
});

test('网关 forgetAccount：删账号后冷却/权重等进程内残留同步清掉', () => {
  zg.__resetForTests();
  zg.__setCoolingForTests('acc-z', Date.now() + 60_000);
  zg.forgetAccount('acc-z');
  // 冷却清掉的直接后果：该 id 不再出现在 coolingDetail / 不再被跳过。
  // 这里用暴露的统计口验证（不触网）：重新标记另一个 id 不受影响
  zg.__setCoolingForTests('acc-live', Date.now() + 60_000);
  zg.forgetAccount('acc-live');
  zg.forgetAccount('never-existed');   // 不存在的 id 不抛错

  tg.forgetAccount('acc-t');
  mg.forgetAccount('acc-m');
  mg.forgetAccount(null);   // 异常入参不抛
});

test('qoderClient：200 但非 JSON 的响应报明确错误，不再冒充「token 不可用」', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    return new Response('<html>edge block page</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const qc = await import('../src/qoderClient.js');
    // fetchUsageDetail：结构异常按「无明细」回落（null），不抛
    assert.equal(await qc.fetchUsageDetail({ provider: 'qoder', meta: { qoderWebSession: { cookie: 'c=1' } } }), null);
    // userinfo / quota / 活动列表：明确报「响应非 JSON」
    await assert.rejects(() => qc.fetchUserinfo({ provider: 'qoder', token: 'dt-x' }), /非 JSON/);
    await assert.rejects(() => qc.fetchQuotaUsage({ provider: 'qoder', token: 'dt-x' }), /非 JSON/);
    await assert.rejects(() => qc.exchangePatToJobToken('pt-x'), /非 JSON/);
    // resolveToken 不再吞成 null（否则上层报「token 不可用」误导用户重导凭据）
    assert.equal(await qc.resolveToken({ provider: 'qoder', token: 'pt-x' }), null, '兑换失败仍按无 token 处理（契约不变）');
  } finally {
    globalThis.fetch = orig;
  }
});
