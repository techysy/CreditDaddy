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
