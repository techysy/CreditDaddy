/**
 * accounts.json 静态加密（纵深防御，2026-11-19 用户立项）回归：
 * - 注入密码器后写入 = AES-256-GCM 信封（文件里搜不到 token 明文）
 * - 读回 = 原数组（往返无损）
 * - 历史明文文件兼容读（迁移无感）
 * - 无密码器进程读到密文 → 明确报错，绝不静默清空
 * - .bak 随主文件同形态（密文环境不产生第二份明文）
 * - 密码器可注销（CLI 实例语义）
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cipher-'));
process.env.CREDITDADDY_HOME = HOME;

const store = await import('../src/store.js');

const KEY = crypto.randomBytes(32);
const realCipher = { keyBytes: () => KEY };

beforeEach(() => {
  // 干净起点：删主文件与 bak，注销密码器（顺序无关用例互不污染）
  for (const f of ['accounts.json', 'accounts.json.bak']) {
    fs.rmSync(path.join(HOME, f), { force: true });
  }
  store.setAccountsCipher(null);
});

const ACC = { id: 'a1', provider: 'zcode', name: '测试', token: 'tok-secret-abcdef', meta: {} };

test('明文模式（无密码器）：现状不变——数组直写、读回一致', async () => {
  await store.saveAccounts([ACC]);
  const raw = fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8');
  assert.match(raw, /tok-secret-abcdef/, '明文模式 token 落盘可见（现状口径）');
  const list = await store.loadAccounts();
  assert.equal(list[0].token, 'tok-secret-abcdef');
});

test('注入密码器后：文件为信封形态，搜不到 token 明文，读回无损', async () => {
  store.setAccountsCipher(realCipher);
  await store.saveAccounts([ACC]);
  const raw = fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.enc, 'aes-256-gcm', '文件是信封形态');
  assert.equal(Array.isArray(parsed.rows), true);
  assert.ok(!raw.includes('tok-secret-abcdef'), '密文文件搜不到 token 明文');
  const list = await store.loadAccounts();
  assert.equal(list[0].token, 'tok-secret-abcdef', '解密往返无损');
});

test('历史明文文件兼容读：注入密码器后读旧明文 → 正常返回（首次保存时才转密文）', async () => {
  fs.writeFileSync(path.join(HOME, 'accounts.json'), JSON.stringify([ACC], null, 2));
  store.setAccountsCipher(realCipher);
  const list = await store.loadAccounts();
  assert.equal(list[0].id, 'a1', '明文老文件照常读出');
  // 下一次写才升级成信封
  await store.saveAccounts(list);
  const raw = fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8');
  assert.equal(JSON.parse(raw).enc, 'aes-256-gcm');
});

test('无密码器进程读到密文：明确报错（不静默清空、不丢数据）', async () => {
  store.setAccountsCipher(realCipher);
  await store.saveAccounts([ACC]);
  store.setAccountsCipher(null);   // 模拟 CLI/NAS 实例
  await assert.rejects(
    () => store.loadAccounts(),
    /加密形态但本进程没有解密密钥/,
    '错误信息要指路（桌面版启动 / 备份）'
  );
  // 数据还在磁盘上——报错不能伴随删除
  const raw = fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8');
  assert.equal(JSON.parse(raw).enc, 'aes-256-gcm', '密文文件原样保留');
});

test('.bak 随主文件同形态：密文环境里备份同样是密文', async () => {
  store.setAccountsCipher(realCipher);
  await store.saveAccounts([ACC]);                       // 第一次写
  await store.saveAccounts([{ ...ACC, name: '改' }]);    // 第二次写触发 .bak
  const bakRaw = fs.readFileSync(path.join(HOME, 'accounts.json.bak'), 'utf8');
  assert.equal(JSON.parse(bakRaw).enc, 'aes-256-gcm', '备份也是信封，不产生第二份明文');
  assert.ok(!bakRaw.includes('tok-secret-abcdef'));
});

test('密钥错误时解密失败：走 .bak 恢复链，仍失败才抛（GCM 认证标签守护）', async () => {
  store.setAccountsCipher(realCipher);
  await store.saveAccounts([ACC]);
  // 篡改密文一个字节 → GCM 认证失败
  const file = path.join(HOME, 'accounts.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = Buffer.from(parsed.rows[0].data, 'base64');
  data[0] ^= 0xff;
  parsed.rows[0].data = data.toString('base64');
  fs.writeFileSync(file, JSON.stringify(parsed));
  await assert.rejects(() => store.loadAccounts(), /失败/, '篡改密文必须解密失败（GCM 完整性）');
});
