import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOMY_AUTH_CONFIG } from '../src/loomyAuth.js';
import { detectLoomy, readCredential } from '../src/loomyLocal.js';
import { productImpl } from '../src/providers.js';
import { TENROUTER_PROVIDER_MAP } from '../src/tenrouterAccounts.js';

test('Loomy 供应商产品线与同步配置', () => {
  assert.equal(typeof productImpl('loomy'), 'object');
  assert.equal(TENROUTER_PROVIDER_MAP.loomy, 'loomy');
});

test('Loomy 统一认证配置常量存在', () => {
  assert.equal(LOOMY_AUTH_CONFIG.baseUrl, 'https://account.xfinfr.com');
  assert.equal(LOOMY_AUTH_CONFIG.appId, 'GM3LOOMY');
  assert.ok(LOOMY_AUTH_CONFIG.accessKeyId);
  assert.ok(LOOMY_AUTH_CONFIG.accessKeySecret);
});

test('Loomy 本机探测（Windows 本地环境）', () => {
  const d = detectLoomy();
  assert.equal(typeof d.clientInstalled, 'boolean');
  assert.equal(typeof d.running, 'boolean');
  assert.equal(typeof d.signedIn, 'boolean');
});

test('Loomy 注册接口与身份校验已接入（新手机号一条龙）', async () => {
  const auth = await import('../src/loomyAuth.js');
  assert.equal(typeof auth.registerLoomyByPhone, 'function');
  assert.equal(typeof auth.fetchLoomyIdentity, 'function');
  // 参数校验先行：不合法手机号在出网前就拒绝
  await assert.rejects(() => auth.registerLoomyByPhone({ phone: '12345', code: '123456' }), /手机号格式/);
  await assert.rejects(() => auth.registerLoomyByPhone({ phone: '13100000000', code: '' }), /验证码/);
});

test('Loomy 积分口径：normalizePointsBalance 映射永久/每日赠送', async () => {
  const { normalizePointsBalance } = await import('../src/loomyClient.js');
  const q = normalizePointsBalance({ data: { permanentPoints: 10500, dailyPoints: 3506, dailyLimit: 5000 } });
  assert.equal(q.unit, '积分');
  assert.equal(q.remaining, 14006);
  const names = q.parts.map((p) => p.name);
  assert.ok(names.includes('永久积分'));
  assert.ok(names.includes('每日赠送积分'));
  const daily = q.parts.find((p) => p.name === '每日赠送积分');
  assert.equal(daily.remaining, 3506);
  assert.equal(daily.used, 1494);
  assert.equal(daily.recurring, true);
  // 空数据 → empty 口径（绝不再拿模型数量冒充积分）
  const empty = normalizePointsBalance({ data: {} });
  assert.equal(empty.empty, true);
});

test('ZCode 已知活动兜底清单包含 WEEKEND BUILD', async () => {
  const { ZCODE_KNOWN_CLAIM_PLANS } = await import('../src/zcodeClient.js');
  assert.ok(Array.isArray(ZCODE_KNOWN_CLAIM_PLANS) && ZCODE_KNOWN_CLAIM_PLANS.length >= 1);
  assert.ok(ZCODE_KNOWN_CLAIM_PLANS.some((p) => p.planId === 'zcode-v3-start-plan-1030-wk'));
});

test('Loomy 账号支持切换（canSwitch）', async () => {
  const { publicAccount } = await import('../src/store.js');
  const view = publicAccount({ provider: 'loomy', token: 'x'.repeat(20), meta: { phone: '13100003656' } });
  assert.equal(view.canSwitch, true);
});
