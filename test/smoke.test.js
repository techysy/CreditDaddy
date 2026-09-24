import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-test-'));

const { dayKey, msUntilNextTick } = await import('../src/checkin.js');
const store = await import('../src/store.js');
const { importAccounts, displayNameFrom } = await import('../src/accounts.js');
const transfer = await import('../src/transfer.js');
const qoderApp = await import('../src/qoderApp.js');
const { rejectForeignRequest } = await import('../src/daemon.js');
const { extractTokens } = await import('../src/localDetect.js');
const { checkinWorkbuddyIntl } = await import('../src/workbuddyClient.js');
const { APP_VERSION } = await import('../src/constants.js');

test('dayKey 以 10:00 (UTC+8) 为签到日界，与本机时区无关', () => {
  assert.match(dayKey(new Date('2026-09-23T10:00:00Z').getTime()), /^\d{4}-\d{2}-\d{2}$/);
  // 10:00 (UTC+8) = 02:00 UTC
  assert.equal(dayKey(new Date('2026-01-05T02:00:00Z').getTime()), '2026-01-05');
  assert.equal(dayKey(new Date('2026-01-05T01:59:59Z').getTime()), '2026-01-04');
  assert.equal(dayKey(new Date('2026-01-05T23:59:59Z').getTime()), '2026-01-05');
});

test('下次 tick 在 2h~2h10m 之间', () => {
  for (let i = 0; i < 20; i++) {
    const ms = msUntilNextTick(Date.now(), () => 0.5);
    assert.ok(ms >= 2 * 3600_000 && ms <= 2 * 3600_000 + 10 * 60_000);
  }
});

test('账号存储往返 + 去重 + 脱敏', async () => {
  const accounts = [];
  const a = store.normalizeAccountInput({ name: '测试', provider: 'qoder', token: 'jt-abcdef1234567890' });
  accounts.push(a);
  await store.saveAccounts(accounts);
  const loaded = await store.loadAccounts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].token, 'jt-abcdef1234567890');

  assert.ok(store.findDuplicate(loaded, 'qoder', 'jt-abcdef1234567890'));
  assert.ok(!store.findDuplicate(loaded, 'qoder-cn', 'jt-abcdef1234567890'));

  const pub = store.publicAccount(loaded[0]);
  assert.ok(pub.tokenMasked.includes('...'));
  assert.equal(pub.token, undefined, '脱敏视图不应泄露完整 token');
  assert.equal(pub.isPat, false);
});

test('normalize 拒绝非法输入', () => {
  assert.throws(() => store.normalizeAccountInput({ provider: 'qoder', token: '' }));
  assert.throws(() => store.normalizeAccountInput({ provider: 'bogus', token: 'x' }));
});

test('PAT 识别', () => {
  const a = store.normalizeAccountInput({ provider: 'qoder-cn', token: 'pt-xyz1234567890' });
  assert.equal(store.publicAccount(a).isPat, true);
});

test('明文导出不含 id，兼容新旧字段', () => {
  const a = store.normalizeAccountInput({ provider: 'qoder', token: 'jt-tok', uid: 'u-1', email: 'a@b.c' });
  const payload = JSON.parse(JSON.stringify(transfer.exportAccounts([a])));
  assert.equal(payload.format, 'creditdaddy-accounts');
  assert.equal(payload.provider, 'qoder');
  assert.equal(payload.accounts[0].id, undefined);
  assert.equal(payload.accounts[0].token, 'jt-tok');
  assert.equal(payload.accounts[0].accessToken, 'jt-tok');
  assert.equal(payload.accounts[0].providerSpecificData.userId, 'u-1');
});

test('加密导出往返（10router-oauth-secure-v1）', () => {
  const a = store.normalizeAccountInput({ provider: 'qoder-cn', token: 'dt-secret-token-xyz', refreshToken: 'rt' });
  const blob = JSON.parse(JSON.stringify(transfer.exportAccounts([a], { password: 'pass1234' })));
  assert.equal(blob.format, '10router-oauth-secure-v1');
  assert.ok(!JSON.stringify(blob).includes('dt-secret'), '加密文件不应含明文 token');
  const parsed = transfer.parseImport(blob, { password: 'pass1234' });
  assert.equal(parsed.source, 'creditdaddy');
  assert.equal(parsed.accounts[0].token, 'dt-secret-token-xyz');
  assert.equal(parsed.accounts[0].refreshToken, 'rt');
  assert.throws(() => transfer.parseImport(blob, { password: 'nope' }), (e) => e.code === 'WRONG_PASSWORD');
  assert.throws(() => transfer.parseImport(blob, {}), (e) => e.code === 'NEED_PASSWORD');
  assert.throws(() => transfer.exportAccounts([a], { password: '123' }), (e) => e.code === 'PASSPHRASE_TOO_SHORT');
});

test('导入 10router 迁移文件：只取 qoder 账号、丢弃合成邮箱', () => {
  const blob = transfer.sealTransfer({
    provider: 'qoder-cn',
    accounts: [
      { accessToken: 'dt-cn-1', email: 'qoder-cn-user-42', name: '小号', providerSpecificData: { userId: '42' }, expiresAt: 1790000000 },
      { provider: 'cursor', accessToken: 'x' },
      { refreshToken: 'only-refresh' },
    ],
  }, 'pw-10router');
  const r = transfer.parseImport(blob, { password: 'pw-10router' });
  assert.equal(r.source, '10router');
  assert.equal(r.accounts.length, 1);
  assert.equal(r.skipped, 2);
  assert.deepEqual(
    { p: r.accounts[0].provider, e: r.accounts[0].email, u: r.accounts[0].uid, n: r.accounts[0].name },
    { p: 'qoder-cn', e: null, u: '42', n: '小号' });
  assert.equal(store.normalizeAccountInput(r.accounts[0]).expiresAt, new Date(1790000000 * 1000).toISOString());
});

test('同一 uid 的新 token 视为续期而不是新增', async () => {
  await store.saveAccounts([]);
  await importAccounts([{ provider: 'qoder', token: 'dt-old', uid: 'same-user', name: '原名' }]);
  const r = await importAccounts([{ provider: 'qoder', token: 'dt-new', uid: 'same-user', name: '新名', expiresAt: '2030-01-01T00:00:00Z' }]);
  assert.deepEqual(r, { added: 0, updated: 1, skipped: 0 });
  const list = await store.loadAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].token, 'dt-new');
  assert.equal(list[0].name, '原名', '续期保留原备注名');
  assert.equal(list[0].expiresAt, '2030-01-01T00:00:00.000Z');
});

test('Qoder 客户端身份字段格式', () => {
  assert.match(qoderApp.machineOs(), /^[a-z0-9_]+_(win32|darwin|linux)$/);
  assert.equal(qoderApp.machineHostname('MX-PC'), 'MX-PC');
  assert.match(qoderApp.machineHostname('我的电脑'), /^unknown-[0-9a-f]{8}$/);
  assert.equal(qoderApp.machineHostname('x'.repeat(200)).length, 96);
  assert.match(qoderApp.machineId('qoder'), /^[0-9a-f-]{36}$/);
});

test('withAccounts 并发修改不丢数据', async () => {
  await store.saveAccounts([]);
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    store.withAccounts((list) => {
      list.push(store.normalizeAccountInput({ provider: 'qoder', token: `jt-concurrent-${i}` }));
    })));
  assert.equal((await store.loadAccounts()).length, 20);
});

test('批量导入去重并跳过非法项', async () => {
  await store.saveAccounts([]);
  const r = await importAccounts([
    { provider: 'qoder', token: 'jt-a' },
    { provider: 'qoder', token: 'jt-a' },
    { provider: 'qoder-cn', token: 'jt-a' },
    { provider: 'bogus', token: 'jt-b' },
  ]);
  assert.deepEqual(r, { added: 2, updated: 0, skipped: 2 });
});

test('displayNameFrom 选取首个非空字段', () => {
  assert.equal(displayNameFrom({ nickname: ' ', name: '小明', email: 'a@b.c' }), '小明');
  assert.equal(displayNameFrom({ email: 'a@b.c' }), 'a@b.c');
  assert.equal(displayNameFrom(null), null);
});

test('本机模式拒绝 DNS 重绑定与跨站请求', () => {
  const bind = '127.0.0.1';
  assert.equal(rejectForeignRequest({ host: '127.0.0.1:47860' }, bind), null);
  assert.equal(rejectForeignRequest({ host: 'localhost:47860', origin: 'http://localhost:47860' }, bind), null);
  assert.equal(rejectForeignRequest({ host: '[::1]:47860' }, bind), null);
  assert.ok(rejectForeignRequest({ host: 'evil.example.com' }, bind), '陌生 Host 应被拒绝');
  assert.ok(rejectForeignRequest({ host: '127.0.0.1:47860', origin: 'https://evil.example.com' }, bind), '跨站 Origin 应被拒绝');
  // NAS 模式（0.0.0.0）允许任意 Host（靠访问密钥保护），但仍拒绝跨站
  assert.equal(rejectForeignRequest({ host: '192.168.1.10:47860' }, '0.0.0.0'), null);
  assert.ok(rejectForeignRequest({ host: '192.168.1.10:47860', origin: 'http://evil.lan' }, '0.0.0.0'));
});

test('extractTokens 提取并去重 dt-/pt- token', () => {
  const text = 'a dt-AAAAAAAAAAAAAAAAAAAA b pt-BBBBBBBBBBBBBBBBBBBB dt-AAAAAAAAAAAAAAAAAAAA dt-short';
  assert.deepEqual(extractTokens(text).sort(), ['dt-AAAAAAAAAAAAAAAAAAAA', 'pt-BBBBBBBBBBBBBBBBBBBB']);
});

test('APP_VERSION 与 package.json 一致', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});

// ── WorkBuddy ──
const wbClient = await import('../src/workbuddyClient.js');
const wbLocal = await import('../src/workbuddyLocal.js');
const { normalizeQoderQuota } = await import('../src/providers.js');

const fakeJwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

test('WorkBuddy token 按签发方识别国内版 / 国际版', () => {
  const cn = wbClient.inspectToken(fakeJwt({ iss: 'https://www.codebuddy.cn/auth/realms/copilot', sub: 'u-cn', exp: 1790000000 }));
  assert.equal(cn.provider, 'workbuddy');
  assert.equal(cn.uid, 'u-cn');
  assert.equal(cn.host, 'www.codebuddy.cn');
  assert.equal(wbClient.inspectToken(fakeJwt({ iss: 'https://www.workbuddy.cn/auth/realms/copilot' })).provider, 'workbuddy');
  assert.equal(wbClient.inspectToken(fakeJwt({ iss: 'https://www.codebuddy.ai/auth/realms/x' })).provider, 'workbuddy-intl');
  assert.equal(wbClient.inspectToken('dt-not-a-jwt').provider, null);
  assert.equal(wbClient.apiHost({ provider: 'workbuddy', token: fakeJwt({ iss: 'https://copilot.tencent.com/auth' }), meta: {} }), 'www.codebuddy.cn');
});

test('WorkBuddy 会话文件 → 账号记录（保留会话以便切换）', () => {
  const token = fakeJwt({ iss: 'https://www.workbuddy.cn/auth/realms/copilot', sub: 'u-1', exp: 1790000000 });
  const rec = wbLocal.sessionToAccount({
    account: { uid: 'u-1', nickname: '小明', phoneNumber: '13800001234', enterpriseId: '' },
    auth: { accessToken: token, refreshToken: 'r-1', expiresAt: 1790000000000, domain: 'www.workbuddy.cn', tokenType: 'Bearer' },
    accounts: [{ uid: 'u-1' }],
  }, 'test');
  assert.equal(rec.provider, 'workbuddy');
  assert.equal(rec.name, '小明');
  assert.equal(rec.refreshToken, 'r-1');
  assert.equal(rec.meta.domain, 'www.workbuddy.cn');
  assert.equal(rec.meta.session.auth.accessToken, undefined, '会话副本里不重复存 token');
  assert.equal(rec.meta.session.auth.tokenType, 'Bearer');
  const pub = store.publicAccount(store.normalizeAccountInput(rec));
  assert.equal(pub.product, 'workbuddy');
  assert.equal(pub.phone, '138****1234');
  assert.equal(pub.canSwitch, true);
  assert.equal(JSON.stringify(pub).includes('r-1'), false, '脱敏视图不含 refreshToken');
});

test('Qoder 配额归一化为统一积分结构', () => {
  const q = normalizeQoderQuota({
    userQuota: { total: 0, used: 0, remaining: 0 },
    addOnQuota: { total: 200, used: 100, remaining: 100 },
    isQuotaExceeded: false, expiresAt: 253402214400000,
  });
  assert.deepEqual({ t: q.total, u: q.used, r: q.remaining, n: q.parts.length }, { t: 200, u: 100, r: 100, n: 1 });
  assert.equal(q.parts[0].expiresAt, null, '“永不过期”哨兵值不当作到期时间');
});

test('导入：10router codebuddy-* 映射为 WorkBuddy，兼容更名前的 QoderDaddy 导出', () => {
  const blob = transfer.sealTransfer({ provider: 'codebuddy-cn', accounts: [{ accessToken: 'eyJ.a.b', name: 'cb' }] }, 'pw-10r');
  const r = transfer.parseImport(blob, { password: 'pw-10r' });
  assert.equal(r.accounts[0].provider, 'workbuddy');
  const legacy = transfer.parseImport({ format: 'qoderdaddy-accounts', accounts: [{ provider: 'qoder', token: 'dt-legacy' }] });
  assert.equal(legacy.source, 'creditdaddy');
  assert.equal(legacy.accounts[0].token, 'dt-legacy');
  const legacySealed = transfer.sealTransfer({ format: 'qoderdaddy-accounts', accounts: [{ provider: 'qoder', token: 'dt-x' }] }, 'pw-old');
  assert.equal(transfer.parseImport(legacySealed, { password: 'pw-old' }).source, 'creditdaddy');
});

test('切换 WorkBuddy 账号：写入当前会话并清除登出标记', async () => {
  const fake = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-'));
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME };
  process.env.LOCALAPPDATA = fake;
  process.env.XDG_DATA_HOME = fake;
  try {
    const dir = wbLocal.workbuddyAuthDir();
    if (process.platform === 'darwin') return; // macOS 路径固定在 ~/Library，跳过
    await fs.mkdir(dir, { recursive: true });
    const tokA = fakeJwt({ iss: 'https://www.codebuddy.cn/auth/realms/copilot', sub: 'A', exp: 1890000000 });
    const tokB = fakeJwt({ iss: 'https://www.codebuddy.cn/auth/realms/copilot', sub: 'B', exp: 1890000000 });
    const cur = path.join(dir, 'workbuddy-desktop.info');
    await fs.writeFile(cur, JSON.stringify({ account: { uid: 'A', nickname: 'A' }, auth: { accessToken: tokA, refreshToken: 'rA', domain: 'www.codebuddy.cn' }, accounts: [] }));
    await fs.writeFile(path.join(dir, 'workbuddy-desktop.2026-08-01T00-00-00-000Z.1.x.info'),
      JSON.stringify({ account: { uid: 'B', nickname: 'B' }, auth: { accessToken: tokB, refreshToken: 'rB', domain: 'www.codebuddy.cn' }, accounts: [] }));
    const found = wbLocal.readWorkbuddySessions();
    assert.deepEqual(found.accounts.map((a) => [a.uid, a.current]), [['A', true], ['B', false]]);
    assert.equal(wbLocal.currentWorkbuddyUid(), 'A');

    await fs.writeFile(cur + '.logged-out', 'x');
    const target = store.normalizeAccountInput(found.accounts[1]);
    const r = wbLocal.writeWorkbuddySession(target);
    assert.equal(r.previousUid, 'A');
    const written = JSON.parse(await fs.readFile(cur, 'utf8'));
    assert.equal(written.account.uid, 'B');
    assert.equal(written.auth.accessToken, tokB);
    assert.equal(written.auth.refreshToken, 'rB');
    await assert.rejects(fs.access(cur + '.logged-out'), '登出标记应被清除');
    assert.equal(wbLocal.currentWorkbuddyUid(), 'B');
  } finally {
    Object.assign(process.env, saved);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  }
});

// ── ZCode ──
const zc = await import('../src/zcrypto.js');
const zcodeClient = await import('../src/zcodeClient.js');
const nodeCrypto = await import('node:crypto');

/** 与 ZCode 客户端相同格式的加密（测试用）：enc:v1:<nonce>.<tag>.<ct>，base64url，AES-256-GCM(key=SHA256(secret)) */
function zEncrypt(plain, secret) {
  const key = nodeCrypto.createHash('sha256').update(secret).digest();
  const nonce = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${nonce.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

test('ZCode enc:v1 解密与身份提取', () => {
  const secret = 'zcode-credential-fallback:win32:C:\Users\t:t';
  const creds = {
    'oauth:active_provider': zEncrypt('bigmodel', secret),
    'oauth:bigmodel:user_info': zEncrypt(JSON.stringify({ id: 42, username: 'alice', displayName: '爱丽丝' }), secret),
    'oauth:bigmodel:access_token': zEncrypt('eyJ.x.y', secret),
    zcodejwttoken: zEncrypt('jwt-value-longer-than-twenty-chars', secret),
  };
  assert.equal(zc.decryptWithSecret(creds['oauth:active_provider'], secret), 'bigmodel');
  assert.throws(() => zc.decryptWithSecret(creds['oauth:active_provider'], 'wrong-secret'));
  assert.equal(zc.safeDecrypt('plain-text', secret), 'plain-text');
  assert.equal(zc.safeDecrypt(creds.zcodejwttoken, 'wrong'), null);
  const id = zc.identityWithSecret(creds, secret);
  assert.deepEqual({ p: id.provider, u: id.userId, n: zc.identityLabel(id) }, { p: 'bigmodel', u: '42', n: '爱丽丝' });
  assert.equal(zc.isLoggedIn(creds), true);
  assert.equal(zc.isLoggedIn({ zcodejwttoken: '  ' }), false);
  assert.equal(zc.defaultSecret('/home/u', { platform: 'linux', username: 'u' }).startsWith('zcode-credential-fallback:linux:/home/u:u')
    || Boolean(process.env.ZCODE_CREDENTIAL_SECRET), true);
});

test('ZCode 规范化哈希：与键序无关，忽略设备相关键', () => {
  const a = { b: '2', a: '1', 'web-remote-control:x': 'dev-1' };
  const b = { a: '1', b: '2', 'web-remote-control:x': 'dev-2' };
  assert.equal(zc.canonicalHash(a), zc.canonicalHash(b));
  assert.notEqual(zc.canonicalHash(a), zc.canonicalHash({ a: '1', b: '3' }));
});

test('ZCode 冷切换：写回凭据 / 配置 / 每账号独立设备 ID', async () => {
  const fake = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-home-'));
  const saved = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = fake;
  try {
    const zl = await import('../src/zcodeLocal.js');
    const v2 = path.join(fake, '.zcode', 'v2');
    await fs.mkdir(v2, { recursive: true });
    await fs.writeFile(path.join(v2, 'credentials.json'), JSON.stringify({ zcodejwttoken: 'jwt-A-xxxxxxxxxxxxxxxxxxxxxxxx' }));
    await fs.writeFile(path.join(v2, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'mid-A', lastDailyActiveDate: '2026-09-24' }));
    const live = zl.liveToAccount();
    assert.equal(live.provider, 'zcode');
    assert.equal(live.meta.deviceMid, 'mid-A', '导入时沿用本机当前设备 ID');

    const target = store.normalizeAccountInput({
      provider: 'zcode', token: 'zcode-creds:B', uid: 'B',
      meta: { credentials: { zcodejwttoken: 'jwt-B-xxxxxxxxxxxxxxxxxxxxxxxx' }, config: { provider: {} } },
    });
    const r = zl.switchTo(target, { force: true });
    assert.equal(r.switched, true);
    const written = JSON.parse(await fs.readFile(path.join(v2, 'credentials.json'), 'utf8'));
    assert.equal(written.zcodejwttoken, 'jwt-B-xxxxxxxxxxxxxxxxxxxxxxxx');
    const tele = JSON.parse(await fs.readFile(path.join(v2, 'telemetry-state.json'), 'utf8'));
    assert.equal(tele.deviceMid, target.meta.deviceMid, '写入目标账号的虚拟设备 ID');
    assert.notEqual(tele.deviceMid, 'mid-A');
    assert.equal(tele.lastDailyActiveDate, '2026-09-24', '保留 telemetry 其他字段');
    assert.equal(zl.switchTo(target, { force: true }).alreadyActive, true);
  } finally {
    if (saved === undefined) delete process.env.ZCODE_HOME; else process.env.ZCODE_HOME = saved;
  }
});

test('ZCode 额度解析：BigModel 窗口额度 / Z.ai 余额 / 无套餐', () => {
  const q = zcodeClient.normalizeQuotaLimit({
    code: 200, success: true,
    data: { level: 'lite', limits: [
      { type: 'TOKENS_LIMIT', usage: 120, currentValue: 20, remaining: 100, nextResetTime: 1790000000000 },
      { type: 'TIME_LIMIT', usage: 300, currentValue: 60, remaining: 240 },
    ] },
  }, { code: 200, success: true, data: [{ status: 'VALID', productName: 'GLM Coding Lite' }] });
  assert.deepEqual({ r: q.remaining, t: q.total, u: q.unit, plan: q.plan, n: q.parts.length }, { r: 240, t: 300, u: '分钟', plan: 'GLM Coding Lite', n: 2 });
  assert.equal(q.parts[0].unit, '次');
  const b = zcodeClient.normalizeBalance({ code: 0, data: { plans: [], balances: [] } });
  assert.equal(b.empty, true);
});

test('过期时间：数字字符串（秒 / 毫秒）也能解析', () => {
  assert.equal(store.normalizeExpiry('1790000000'), new Date(1790000000 * 1000).toISOString());
  assert.equal(store.normalizeExpiry('1790000000000'), new Date(1790000000000).toISOString());
  assert.equal(store.normalizeExpiry('garbage'), null);
});

test('导出范围：按 provider 或按产品整体筛选', () => {
  const accs = [
    { id: 'a', provider: 'qoder', token: 'dt-a' },
    { id: 'b', provider: 'qoder-cn', token: 'dt-b' },
    { id: 'c', provider: 'workbuddy', token: 'eyJc' },
    { id: 'd', provider: 'workbuddy-intl', token: 'eyJd' },
    { id: 'e', provider: 'zcode', token: 'z-e' },
  ];
  const ids = (o) => transfer.buildExportPayload(accs, o).accounts.map((x) => x.provider);
  assert.deepEqual(ids({ product: 'workbuddy' }), ['workbuddy', 'workbuddy-intl']);
  assert.deepEqual(ids({ product: 'qoder' }), ['qoder', 'qoder-cn']);
  assert.deepEqual(ids({ provider: 'workbuddy-intl' }), ['workbuddy-intl']);
  assert.equal(ids({}).length, 5);
});

// ── 浏览器登录（WorkBuddy / ZCode）：用假 fetch 走完整流程 ──
function mockFetch(routes) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) {
      if (re.test(String(url))) {
        const r = fn(String(url), init);
        return new Response(JSON.stringify(r.body), { status: r.status || 200 });
      }
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('ZCode enc:v1 加密与解密互逆', () => {
  const v = zc.encryptWithSecret('你好 token', 'sec');
  assert.ok(v.startsWith('enc:v1:'));
  assert.equal(zc.decryptWithSecret(v, 'sec'), '你好 token');
  assert.throws(() => zc.decryptWithSecret(v, 'other'));
});

test('ZCode 浏览器登录：init → pending → ready，凭据按客户端格式加密入账号', async () => {
  const za = await import('../src/zcodeAuth.js');
  let polls = 0;
  const m = mockFetch([
    [/oauth\/cli\/init$/, () => ({ body: { code: 0, data: { flow_id: 'f1', authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=s', expires_at: Math.floor(Date.now() / 1000) + 600, poll_interval_sec: 2 } } })],
    [/oauth\/cli\/poll\/f1$/, () => (++polls < 2
      ? { body: { code: 0, data: { status: 'pending' } } }
      : { body: { code: 0, data: { status: 'ready', token: 'zjwt', user: { user_id: 42, name: '小明', email: 'm@x.com' }, bigmodel: { access_token: 'bm-at', refresh_token: 'bm-rt' } } } })],
  ]);
  try {
    const s = await za.startZcodeLogin('zcode-bigmodel');
    assert.equal(s.data.provider, 'bigmodel');
    assert.match(m.calls[0].init.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
    assert.equal((await za.pollZcodeLogin(s.data)).status, 'pending');
    const r = await za.pollZcodeLogin(s.data);
    assert.equal(r.status, 'ok');
    assert.equal(m.calls[2].init.headers.Authorization, m.calls[0].init.headers.Authorization);   // 轮询用同一 poll token
    const { input } = r;
    assert.equal(input.provider, 'zcode');
    assert.equal(input.uid, '42');
    assert.equal(input.token, 'zcode-creds:42');
    assert.equal(input.name, '小明');
    assert.ok(!('deviceMid' in input.meta) && !('config' in input.meta));
    const secret = zc.defaultSecret((await import('../src/zcodeLocal.js')).zcodePaths().home);
    const c = input.meta.credentials;
    assert.ok(zc.isLoggedIn(c));
    assert.equal(zc.safeDecrypt(c['oauth:active_provider'], secret), 'bigmodel');
    assert.equal(zc.safeDecrypt(c['oauth:bigmodel:access_token'], secret), 'bm-at');
    assert.equal(zc.safeDecrypt(c['oauth:bigmodel:refresh_token'], secret), 'bm-rt');
    assert.equal(zc.safeDecrypt(c.zcodejwttoken, secret), 'zjwt');
    assert.equal(zc.identityWithSecret(c, secret).userId, '42');
  } finally { m.restore(); }
});

test('ZCode 浏览器登录：Z.ai 换业务 token；授权失败终止', async () => {
  const za = await import('../src/zcodeAuth.js');
  const m = mockFetch([
    [/poll\/ok$/, () => ({ body: { code: 0, data: { status: 'ready', token: 'j', user: { user_id: 'u1' }, zai: { access_token: 'oauth-at' } } } })],
    [/poll\/bad$/, () => ({ body: { code: 0, data: { status: 'failed' } } })],
    [/api\.z\.ai\/api\/auth\/z\/login$/, (_u, init) => ({ body: { code: 0, success: true, data: { access_token: 'biz-' + JSON.parse(init.body).token } } })],
  ]);
  try {
    const secret = zc.defaultSecret((await import('../src/zcodeLocal.js')).zcodePaths().home);
    const r = await za.pollZcodeLogin({ provider: 'zai', flowId: 'ok', pollToken: 't' });
    assert.equal(zc.safeDecrypt(r.input.meta.credentials['oauth:zai:access_token'], secret), 'biz-oauth-at');
    await assert.rejects(za.pollZcodeLogin({ provider: 'bigmodel', flowId: 'bad', pollToken: 't' }), /授权失败/);
  } finally { m.restore(); }
});

test('WorkBuddy 浏览器登录：state → 等 token → 等账号 → 组装成可切换的客户端会话', async () => {
  const wa = await import('../src/workbuddyAuth.js');
  const token = fakeJwt({ iss: 'https://www.codebuddy.cn/auth/realms/copilot', sub: 'uid-1', exp: Math.floor(Date.now() / 1000) + 86400 });
  let tokenPolls = 0, accountPolls = 0;
  const m = mockFetch([
    [/auth\/state\?platform=WorkBuddy$/, () => ({ body: { code: 0, data: { state: 'st', authUrl: 'https://www.codebuddy.cn/login?platform=WorkBuddy&state=st' } } })],
    [/auth\/token\?state=st$/, () => (++tokenPolls < 2 ? { body: { code: 11217, msg: 'retry' } } : { body: { code: 0, data: { accessToken: token, refreshToken: 'rt', expiresIn: 3600, refreshExpiresIn: 7200, tokenType: 'Bearer' } } })],
    [/login\/account\?state=st$/, () => (++accountPolls < 2 ? { body: { code: 12151 } } : { body: { code: 0, data: { uid: 'uid-1', nickname: '阿强', type: 'personal' } } })],
    [/plugin\/accounts$/, () => ({ body: { code: 0, data: { accounts: [{ uid: 'uid-1', nickname: '阿强', pluginEnabled: true, phoneNumber: '13800000000' }, { uid: 'ent', pluginEnabled: false }] } } })],
  ]);
  try {
    const s = await wa.startWorkbuddyLogin('workbuddy');
    assert.equal(s.data.host, 'www.codebuddy.cn');
    assert.equal((await wa.pollWorkbuddyLogin(s.data)).status, 'pending');   // token 未就绪
    assert.equal((await wa.pollWorkbuddyLogin(s.data)).status, 'pending');   // token 就绪，账号未就绪
    const r = await wa.pollWorkbuddyLogin(s.data);
    assert.equal(r.status, 'ok');
    const { input } = r;
    assert.equal(input.provider, 'workbuddy');
    assert.equal(input.token, token);
    assert.equal(input.refreshToken, 'rt');
    assert.equal(input.uid, 'uid-1');
    assert.equal(input.name, '阿强');
    assert.equal(input.source, 'browser');
    assert.equal(input.meta.domain, 'www.codebuddy.cn');
    assert.equal(input.meta.session.account.phoneNumber, '13800000000');   // 用账号列表补齐
    assert.deepEqual(input.meta.session.accounts.map((a) => a.uid), ['uid-1']);
    assert.equal(input.meta.session.allAccounts.length, 2);
    assert.ok(!('accessToken' in input.meta.session.auth) && !('refreshToken' in input.meta.session.auth));
  } finally { m.restore(); }
});

// ── Qoder 设备身份组件：从 qodercli 包里提取 UMID ──
function fakeElf(machine, len = 64) {
  const b = Buffer.alloc(len, 7);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(b, 0);
  b.writeUInt16LE(machine, 18);
  return b;
}
function tarOf(files) {
  const blocks = [];
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('设备身份组件：tar 取文件 / 按架构挑 ELF / npm integrity 校验', async () => {
  const um = await import('../src/qoderUmid.js');
  const x64 = fakeElf(62), arm = fakeElf(183);
  const js = `var a="z/rt/gwAAAA",b="${arm.toString('base64')}",c="${x64.toString('base64')}",d="TVqQAAMAAAAEAAAA";`;
  assert.deepEqual(um.extractElf(js, 62), x64);
  assert.deepEqual(um.extractElf(js, 183), arm);
  assert.equal(um.extractElf(js, 40), null);

  const tar = tarOf([['package/package.json', Buffer.from('{}')], ['package/bundle/qodercli.js', Buffer.from(js)]]);
  assert.equal(um.tarEntry(tar, 'package/bundle/qodercli.js').toString(), js);
  assert.equal(um.tarEntry(tar, 'package/nope.js'), null);

  const integrity = 'sha512-' + nodeCrypto.createHash('sha512').update(tar).digest('base64');
  assert.ok(um.checkIntegrity(tar, integrity));
  assert.ok(!um.checkIntegrity(Buffer.concat([tar, Buffer.from('x')]), integrity));
  assert.ok(!um.checkIntegrity(tar, 'sha1-abc'));

  assert.ok(um.umidSupported('linux', 'x64') && um.umidSupported('linux', 'arm64'));
  assert.ok(!um.umidSupported('win32', 'x64') && !um.umidSupported('linux', 'ia32'));
});

test('账号续期：换上新 token 时清掉旧 token 留下的失败结果与校验错误', async () => {
  await store.withAccounts((list) => {
    list.push({
      id: 'renew-1', provider: 'workbuddy', name: '续期测试', token: 'old-token', uid: 'renew-uid', createdAt: new Date().toISOString(),
      verified: false, verifyError: 'HTTP 401',
      lastResult: { at: new Date().toISOString(), status: 'failed', message: '登录已失效，请在 WorkBuddy 客户端重新登录该账号后，到「添加账号 → 本机导入」同步' },
    });
    list.push({
      id: 'renew-2', provider: 'workbuddy', name: '已签到', token: 'tok-2', uid: 'renew-uid-2', createdAt: new Date().toISOString(),
      lastResult: { at: new Date().toISOString(), status: 'checked-in', amount: 5 },
    });
  });
  const r = await importAccounts([
    { provider: 'workbuddy', token: 'new-token', uid: 'renew-uid' },
    { provider: 'workbuddy', token: 'tok-2b', uid: 'renew-uid-2' },
  ]);
  assert.equal(r.updated, 2);
  const list = await store.loadAccounts();
  const a = list.find((x) => x.id === 'renew-1');
  assert.equal(a.token, 'new-token');
  assert.equal(a.lastResult, null);
  assert.equal(a.verifyError, undefined);
  assert.equal(list.find((x) => x.id === 'renew-2').lastResult.status, 'checked-in');   // 成功结果保留
});

test('WorkBuddy 国际版活跃领取：2xx → checked-in；429 → no-activity；5xx → failed', async () => {
  const realFetch = globalThis.fetch;
  const mk = (status, body = '') => {
    globalThis.fetch = async () => new Response(body, { status });
  };
  const account = { id: 'wbi-1', provider: 'workbuddy-intl', name: '国际版A', token: 'tok', uid: 'u1' };
  try {
    mk(200, 'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n');
    const ok = await checkinWorkbuddyIntl(account, {});
    assert.equal(ok.status, 'checked-in');
    assert.equal(ok.claimedAmount, 0);

    mk(429, '{"error":{"data":{"code":14018,"msg":"Credits exhausted"}}}');
    const exhausted = await checkinWorkbuddyIntl(account, {});
    assert.equal(exhausted.status, 'no-activity');
    assert.match(exhausted.message, /额度已耗尽/);

    mk(500, 'oops');
    const bad = await checkinWorkbuddyIntl(account, {});
    assert.equal(bad.status, 'failed');
  } finally { globalThis.fetch = realFetch; }
});
