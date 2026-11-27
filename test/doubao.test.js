// 豆包网页会话线测试（issue #32）——接口形状 2026-10-19/20 CDP 实测钉死。
// 干净配置目录：store 等模块按测试隔离初始化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'creditdaddy-doubao-'));

const dc = await import('../src/doubaoClient.js');

const DETAIL_SIGNED = {
  code: 0,
  data: {
    campaign_code: 'pc_incentive_task_mvp_v3',
    tasks: [
      {
        campaign_code: 'daily_signin',
        task_kind: 'daily_signin',
        task_status: 3,
        daily_checkin: {
          checked_in_today: true,
          continuous_days: 3,
          last_checkin_date: '2026-10-20',
          reward: { reward_amount: 200, reward_type: 'quota_grant' },
          reward_status: 3,
          total_days: 3,
        },
      },
      { campaign_code: 'select_work_fields', task_kind: 'chat_activity', task_status: 1 },
    ],
    progress: { total_amount: 600 },
  },
  msg: '',
};

const DETAIL_UNSIGNED = {
  ...DETAIL_SIGNED,
  data: {
    ...DETAIL_SIGNED.data,
    tasks: [
      {
        ...DETAIL_SIGNED.data.tasks[0],
        task_status: 1,
        daily_checkin: {
          checked_in_today: false,
          continuous_days: 2,
          last_checkin_date: '2026-10-19',
          reward: { reward_amount: 200, reward_type: 'quota_grant' },
          total_days: 2,
        },
      },
    ],
    progress: { total_amount: 400 },
  },
};

const CLAIM_OK = {
  code: 0,
  data: {
    checked_in: true,
    checkin_date: '2026-10-20',
    continuous_days: 3,
    idempotent: false,
    reward_amount: 200,
    reward_code: 'quota_grant',
    reward_status: 3,
    reward_type: 'quota_grant',
  },
  msg: '',
  message: '',
};

const CLAIM_IDEMPOTENT = { ...CLAIM_OK, data: { ...CLAIM_OK.data, idempotent: true } };

const CLAIM_BIZ_WARNING = {
  code: 0,
  data: {
    biz_error: {
      code: 3,
      message: '领取结果确认中，请稍后重试',
      toast_status: 'warning',
    },
    task_status: 0,
  },
  msg: '',
  message: '',
};

const CLAIM_BIZ_ALREADY = {
  code: 0,
  data: {
    biz_error: {
      code: 4,
      message: '已领取',
      toast_status: 'info',
    },
    task_status: 3,
  },
  msg: '',
  message: '',
};

const LOGIN_INVALID = { data: null, code: 710012001, msg: '登录已过期，请重新登录', message: 'login invalid' };

/** 注入 global fetch：fetchJsonRace 直连路径走 globalThis.fetch（无代理场景） */
function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

const mkRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

test('fetchDoubaoStatus：已签场景（checked_in_today=true，连续天数与总额解析）', async () => {
  let seen = null;
  const restore = stubFetch(async (url, init) => {
    seen = { url, method: init.method, body: init.body, headers: init.headers };
    return mkRes(DETAIL_SIGNED);
  });
  try {
    const st = await dc.fetchDoubaoStatus('sid=ABC');
    assert.equal(st.auth, true);
    assert.equal(st.code, 0);
    assert.equal(st.checkin.checkedIn, true);
    assert.equal(st.checkin.continuousDays, 3);
    assert.equal(st.checkin.lastDate, '2026-10-20');
    assert.equal(st.checkin.rewardAmount, 200);
    assert.equal(st.totalAmount, 600);
    assert.equal(seen.method, 'POST');
    assert.deepEqual(JSON.parse(seen.body), { campaign_group_code: 'pc_incentive_task_mvp_v3' });
    assert.equal(seen.headers.Cookie, 'sid=ABC');
  } finally { restore(); }
});

test('fetchDoubaoStatus：会话失效（code 710012001 → auth=false）', async () => {
  const restore = stubFetch(async () => mkRes(LOGIN_INVALID));
  try {
    const st = await dc.fetchDoubaoStatus('bad');
    assert.equal(st.auth, false);
    assert.equal(st.code, 710012001);
    assert.equal(st.checkin, null);
  } finally { restore(); }
});

test('checkinDoubao：未签 → landing/checkin 成功（+200 额度，连续天数 +1）', async () => {
  const calls = [];
  let claimPayload = null;
  const restore = stubFetch(async (url, init) => {
    calls.push(String(url));
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    if (url.includes('/landing/checkin')) {
      claimPayload = JSON.parse(init.body);
      return mkRes(CLAIM_OK);
    }
    throw new Error('unexpected url ' + url);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'checked-in');
    assert.equal(r.claimedAmount, 200);
    assert.match(r.message, /连续 3 天/);
    assert.equal(calls.length, 2, '先 detail 后 checkin');
    assert.deepEqual(claimPayload, { scene: 'pc_incentive_task_mvp_v3' });
  } finally { restore(); }
});

test('checkinDoubao：已签 → already（不打 claim）', async () => {
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(String(url));
    return mkRes(DETAIL_SIGNED);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'already');
    assert.equal(calls.length, 1, 'detail 查完即返回');
  } finally { restore(); }
});

test('checkinDoubao：claim 返回 idempotent=true → already（服务端幂等去重）', async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes(CLAIM_IDEMPOTENT);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'already');
    assert.match(r.message, /幂等/);
  } finally { restore(); }
});

test('checkinDoubao：claim 返回 biz_error code 3 → failed 且展示业务友好文案', async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes(CLAIM_BIZ_WARNING);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'failed');
    assert.match(r.message, /领取结果确认中/);
  } finally { restore(); }
});

test('checkinDoubao：claim 返回 biz_error code 4 → already（服务端已发放）', async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes(CLAIM_BIZ_ALREADY);
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'already');
    assert.match(r.message, /已发放/);
  } finally { restore(); }
});

test('checkinDoubao：会话失效抛 auth 错误（调用方按凭据失效引导重新捕获）', async () => {
  const restore = stubFetch(async () => mkRes(LOGIN_INVALID));
  try {
    await assert.rejects(
      dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'bad' } } }),
      (e) => e.auth === true && /重新登录/.test(e.message),
    );
  } finally { restore(); }
});

test('checkinDoubao：无签到任务 → no-activity（活动未开放 / 飞书企业号）', async () => {
  const restore = stubFetch(async () => mkRes({ code: 0, data: { tasks: [{ task_kind: 'chat_activity', task_status: 1 }], progress: { total_amount: 0 } } }));
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', meta: { cookieSiteSession: { cookie: 'sid=X' } } });
    assert.equal(r.status, 'no-activity');
    assert.match(r.message, /无签到任务/);
  } finally { restore(); }
});

test('doubao 进 providers 注册表：checkin / quota 可分发', async () => {
  const { productImpl } = await import('../src/providers.js');
  const impl = productImpl('doubao');
  assert.equal(impl.label, '豆包');
  assert.equal(typeof impl.checkin, 'function');
  assert.equal(typeof impl.quota, 'function');
});

test('cookieSites 配置表的 provider 全部在 PROVIDERS 白名单（豆包收割上报被 store 校验拒的回归钉子）', async () => {
  const { COOKIE_SITES } = await import('../src/cookieSites.js');
  const { PROVIDERS } = await import('../src/constants.js');
  for (const site of COOKIE_SITES) {
    assert.ok(PROVIDERS.includes(site.provider), `站点 ${site.id} 的 provider "${site.provider}" 不在 PROVIDERS 白名单——收割上报会被 store 拒绝`);
  }
  const doubao = COOKIE_SITES.find((s) => s.id === 'doubao');
  assert.ok(doubao, 'doubao 站点必须存在');
  assert.equal(doubao.entryOnly, undefined, 'doubao 已恢复为完整产品线，不得为 entryOnly');
  assert.equal(doubao.verify, 'api', 'doubao 验证模式为 api');
});

test('doubaoClient：支持 account.token 作为会话 Cookie 兜底', async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_SIGNED);
    throw new Error('unexpected url');
  });
  try {
    const r = await dc.checkinDoubao({ id: 'db2', name: '豆包B', provider: 'doubao', token: 'sid=TOKEN_BASED' });
    assert.equal(r.status, 'already');
  } finally { restore(); }
});

test('doubaoLocal：decryptCookieValue 正确解密 v10 并剥离 32B Binding 头', async () => {
  const { decryptCookieValue } = await import('../src/doubaoLocal.js');
  const mockKey = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const plainText = 'sessionid_value_123456';
  const prefix32 = crypto.randomBytes(32);
  const payload = Buffer.concat([prefix32, Buffer.from(plainText, 'utf8')]);

  const cipher = crypto.createCipheriv('aes-256-gcm', mockKey, nonce);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  const rawEncrypted = Buffer.concat([Buffer.from('v10'), nonce, ct, tag]);

  const dec = decryptCookieValue(rawEncrypted, mockKey);
  assert.equal(dec, plainText, '解密后应正确剥离 32B 头并还原明文 Cookie');
});

test('doubaoLocal：detectDoubao 结构完整且为纯同步执行', async () => {
  const { detectDoubao } = await import('../src/doubaoLocal.js');
  const d = detectDoubao();
  assert.equal(typeof d, 'object');
  assert.equal(typeof d.exists, 'boolean');
  assert.equal(typeof d.clientInstalled, 'boolean');
  assert.equal(typeof d.running, 'boolean');
  assert.equal(typeof d.dataDir, 'string');
});

test('doubaoLocal：extractDoubaoUid 优先匹配活跃 sessionid 对应的 multi_sids 条目', async () => {
  const { extractDoubaoUid } = await import('../src/doubaoLocal.js');
  const multi = encodeURIComponent('111111:sid_old|222222:sid_other|333333:sid_active|444444:sid_extra');
  assert.equal(
    extractDoubaoUid(`multi_sids=${multi}; sessionid=sid_active; sid_tt=sid_active; uid_tt=999999`),
    '333333',
    '多账号共存时应按 sessionid 精确匹配活跃 UID 而非盲取第 1 条'
  );
  assert.equal(
    extractDoubaoUid(`multi_sids=${multi}; uid_tt=999999`),
    '111111',
    '无 sessionid 时回退 multi_sids 首项'
  );
  assert.equal(extractDoubaoUid('uid_tt=999999'), '999999', '无 multi_sids 时回退 uid_tt');
});

test('checkinDoubao：携带桌面设备上下文时使用 582478/pc_client 参数与 csrf 头', async () => {
  const seen = [];
  const restore = stubFetch(async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    if (url.includes('/landing/checkin')) return mkRes(CLAIM_OK);
    throw new Error('unexpected url ' + url);
  });
  try {
    const r = await dc.checkinDoubao({
      id: 'db_pc',
      name: '豆包 (工作)',
      provider: 'doubao',
      uid: '333333',
      meta: {
        doubaoDevice: { deviceId: '3581551264702008', installId: '1998259083587290', pcVersion: '2.37.16' },
        cookieSiteSession: { cookie: 'sessionid=sid_active; passport_csrf_token=csrf_abc' },
      },
    });
    assert.equal(r.status, 'checked-in');
    assert.equal(seen.length, 2);
    for (const req of seen) {
      const u = new URL(req.url);
      assert.equal(u.searchParams.get('aid'), '582478');
      assert.equal(u.searchParams.get('client_platform'), 'pc_client');
      assert.equal(u.searchParams.get('device_id'), '3581551264702008');
      assert.equal(u.searchParams.get('fp'), 'verify_3581551264702008');
      assert.equal(u.searchParams.get('iid'), '1998259083587290');
      assert.equal(req.headers['x-tt-passport-csrf-token'], 'csrf_abc');
      assert.match(req.headers['User-Agent'], /SamanthaDoubao\/2\.37\.16/);
    }
  } finally { restore(); }
});

test('checkinDoubao：服务端返回 710010702 / checked_in=false → failed 且提示明确', async () => {
  let restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes({ data: null, code: 710010702, msg: '系统错误', message: 'system error' });
  });
  try {
    const r1 = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', token: 'sid=X' }, { localFallback: false });
    assert.equal(r1.status, 'failed');
    assert.match(r1.message, /710010702/);
  } finally { restore(); }

  restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes({ code: 0, data: { checked_in: false }, msg: '' });
  });
  try {
    const r2 = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', token: 'sid=X' });
    assert.equal(r2.status, 'failed');
    assert.match(r2.message, /未确认签到完成/);
  } finally { restore(); }
});

test('checkinDoubao：服务端返回 710010702 时自动通过本机客户端自动化突破签到', async () => {
  const { _setCdpForTests } = await import('../src/doubaoLocal.js');
  let restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes({ data: null, code: 710010702, msg: '系统错误', message: 'system error' });
  });
  _setCdpForTests(async () => ({
    status: 'checked-in',
    claimedAmount: 200,
    message: '通过豆包客户端完成签到，+200 额度',
  }));
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', token: 'sid=X' });
    assert.equal(r.status, 'checked-in');
    assert.equal(r.claimedAmount, 200);
    assert.match(r.message, /通过豆包客户端完成签到/);
  } finally {
    restore();
    _setCdpForTests(null);
  }
});

test('checkinDoubao：服务端返回 710010702 且客户端正运行时提示友好的手动/退出指引', async () => {
  const { _setCdpForTests } = await import('../src/doubaoLocal.js');
  let restore = stubFetch(async (url) => {
    if (url.includes('/detail/')) return mkRes(DETAIL_UNSIGNED);
    return mkRes({ data: null, code: 710010702, msg: '系统错误', message: 'system error' });
  });
  _setCdpForTests(async () => ({
    status: 'unsupported',
    reason: 'running_without_cdp',
  }));
  try {
    const r = await dc.checkinDoubao({ id: 'db1', name: '豆包A', provider: 'doubao', token: 'sid=X' });
    assert.equal(r.status, 'failed');
    assert.match(r.message, /客户端正在运行/);
  } finally {
    restore();
    _setCdpForTests(null);
  }
});
