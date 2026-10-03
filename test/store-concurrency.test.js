/**
 * store.js 的串行化读改写回归测试。
 *
 * accounts.json 早就有 withAccounts 串行队列，state.json / settings.json 原来没有：
 * 多个写入方各自「读 → 改几个键 → 整份写回」，并发时后写的会拿旧快照把别人的键抹掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'creditdaddy-conc-'));

const { withState, withSettings, saveSettings, loadSettings, saveState, loadState } =
  await import('../src/store.js');

test('withState：签到轮写 qoderDailyDone 时不会抹掉网关写的 zcodeGatewayExhausted', async () => {
  await saveState({ qoderDailyDone: {}, deviceClaim: null, zcodeGatewayExhausted: {} });

  // 签到轮开头读到快照（checkin.js:233），随后是一整轮网络请求
  const tickSnapshot = await loadState();
  // 期间网关在数据面打上「额度耗尽」标记
  await withState((st) => {
    st.zcodeGatewayExhausted = { ...(st.zcodeGatewayExhausted || {}), acc1: '2026-10-03T10:00:00Z' };
  });
  // 签到轮收尾：拿开头那份快照落盘
  await withState((fresh) => {
    fresh.qoderDailyDone = { a1: '2026-10-03' };
    fresh.deviceClaim = null;
  });

  const final = await loadState();
  assert.deepEqual(final.qoderDailyDone, { a1: '2026-10-03' });
  assert.equal(final.zcodeGatewayExhausted?.acc1, '2026-10-03T10:00:00Z', '网关的打标必须活下来');
  // 快照确实来自打标之前——否则这个用例证明不了它测的是丢更新
  assert.equal(tickSnapshot.zcodeGatewayExhausted?.acc1, undefined);
});

test('withState：并发写入互不覆盖', async () => {
  await saveState({});
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => withState((st) => { st['k' + i] = i; }))
  );
  const final = await loadState();
  const lost = Array.from({ length: 40 }, (_, i) => i).filter((i) => final['k' + i] !== i);
  assert.deepEqual(lost, [], `${lost.length} 个并发写入被覆盖`);
});

test('withState：回调抛错不卡死队列，后续写入照常', async () => {
  await assert.rejects(
    withState(() => { throw new Error('boom'); }),
    /boom/
  );
  await withState((st) => { st.afterFailure = true; });
  assert.equal((await loadState()).afterFailure, true);
});

test('saveSettings：并发合并不丢更新', async () => {
  await saveSettings({ base: 0 });
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => saveSettings({ ['k' + i]: i }))
  );
  const s = await loadSettings();
  assert.equal(s.base, 0, '先写的补丁不能被后写的冲掉');
  const lost = Array.from({ length: 40 }, (_, i) => i).filter((i) => s['k' + i] !== i);
  assert.deepEqual(lost, [], `${lost.length} 个并发设置写入被覆盖`);
});

test('withSettings：Qoder 网页会话暂存区与 addAccount 的取用互不冲突', async () => {
  // 桌面壳连着发两个网页会话，addAccount 同时在取用暂存项
  const uids = ['uid-a', 'uid-b', 'uid-c'];
  await Promise.all([
    withSettings((s) => {
      s.pendingQoderWebSessions = {
        ...(s.pendingQoderWebSessions || {}),
        [uids[0]]: { kind: 'qoder', cookie: 'c0' },
      };
    }),
    withSettings((s) => {
      s.pendingQoderWebSessions = {
        ...(s.pendingQoderWebSessions || {}),
        [uids[1]]: { kind: 'qoder', cookie: 'c1' },
      };
    }),
    withSettings((s) => {
      s.pendingQoderWebSessions = {
        ...(s.pendingQoderWebSessions || {}),
        [uids[2]]: { kind: 'qoder-cn', cookie: 'c2' },
      };
    }),
  ]);
  assert.deepEqual(Object.keys((await loadSettings()).pendingQoderWebSessions).sort(), [...uids].sort());

  // 取走 uid-a，剩下的两个必须还在
  const taken = await withSettings((s) => {
    const p = s.pendingQoderWebSessions || {};
    const found = p[uids[0]];
    delete p[uids[0]];
    return found;
  });
  assert.equal(taken.cookie, 'c0');
  assert.deepEqual(Object.keys((await loadSettings()).pendingQoderWebSessions).sort(), [uids[1], uids[2]].sort());
});
