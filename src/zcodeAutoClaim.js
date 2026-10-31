/**
 * ZCode 活动自动领取 — 签到调度器每轮调用。
 *
 * 策略（对齐用户手动路径，逐级尝试）：
 *   1. billing/preview 查可领活动；为空 → 无事可做（返回 null，不留痕迹）
 *   2. 先直接 claim（不带验证码：服务端未风控时可直接成功）
 *   3. 返回 3007/3001（需要验证码 / 参数被拒）且有验证码提供者 → 拉 captcha 配置，
 *      让提供者（桌面版的隐藏窗口跑阿里云验证码 SDK 静默验证）拿 captchaVerifyParam 后重试
 *   4. 没有提供者（NAS / 纯 CLI）或验证码需要人工 → 标记「需手动领取」，卡片上提示
 *   - 1003（已领取过）按成功口径处理并记忆
 * 结果写入账号 lastResult（签到日历记忆用的是 status checked-in/already，第二天照常重查 preview）
 */

import { logger } from './logger.js';
import { t } from './i18n.js';
import { fetchClaimPlans, claimPlan, fetchCaptchaConfig, ZCODE_KNOWN_CLAIM_PLANS } from './zcodeClient.js';
import { withAccounts } from './store.js';

// 额满（1005）时消费服务端 nextAt（plan.ends_at）：
// 下轮自动轮询（claimIntervalMin 分钟一触）在 nextAt 之前跳过该号,不做无谓抢。
// 进程内缓存 + 落盘 account.meta.zcodeClaimNextAt 双轨（重启保护）。
const snoozeUntil = new Map();  // accountId → ms 时间戳

function snoozeUntilMs(account) {
  const meta = Number(new Date(account?.meta?.zcodeClaimNextAt || 0)) || 0;
  const proc = snoozeUntil.get(account.id) || 0;
  return Math.max(meta, proc);
}

// 桌面版（Electron 主进程）注册的隐藏窗口验证码实现；NAS / CLI 为 null（走「需手动领取」分支）
let captchaProvider = null;
export function setZcodeCaptchaProvider(fn) { captchaProvider = typeof fn === 'function' ? fn : null; }
export function hasZcodeCaptchaProvider() { return Boolean(captchaProvider); }
export function getZcodeCaptchaProvider() { return captchaProvider; }

/** 账号被删除时清掉额满暂休缓存（daemon DELETE /api/accounts/:id 调用；落盘份随账号一起删） */
export function forgetAccount(id) { snoozeUntil.delete(id); }

const grantsText = (plan) => (plan.grants && plan.grants.length ? plan.grants.join('；') : '');

/**
 * 为单个 ZCode 账号执行一次自动领取。
 * @returns {null | { status, message, claims: Array }} null = preview 为空或查询失败（已记日志，不上卡片）
 */
export async function zcodeAutoClaim(account) {
  const label = account.name || account.uid || account.id;
  {
    const until = snoozeUntilMs(account);
    if (until && until > Date.now()) {
        logger.debug('ZCODE-CLAIM', '{label} 名额已领完,跳过直到 {until}(服务端计划结束点)', { label, until: new Date(until).toISOString() });
      return null;
    }
  }
  let plans;
  try {
    plans = (await fetchClaimPlans(account)).plans;
  } catch (e) {
        logger.debug('ZCODE-CLAIM', '{label} 活动查询失败:{err}', { label, err: e.message });
    return null;
  }
  if (!plans.length) {
    // preview 为空 ≠ 无事可做：服务端偶尔把活动从列表里藏起来（2026-10-30 WEEKEND BUILD
    // 实测 preview 返回空但 claim 按 planId 直接可领）。把已知清单合成伪 plan 走同一条
    // 领取链路：1001/1002（不存在/已结束）在 catch 里静默跳过，不进卡片。
    plans = ZCODE_KNOWN_CLAIM_PLANS.map((k) => ({ planId: k.planId, name: k.name || k.planId, description: '', priority: 0, grants: [], known: true }));
  }

  const claims = [];
  let anySuccess = false;
  let needManual = false;

  let snoozeAt = 0;
  for (const plan of plans) {
    const planName = plan.name || plan.planId;
    // 第 2 步：先试不带验证码
    try {
      const r = await claimPlan(account, plan.planId, {});
      // startsAt 是「到账时间」：活动权益常带 effective_at（如当天 23:00），
      // 领到了但余额里还没有——不把这个时间带出去，面板只能显示冷冰冰的
      // 「待生效」，用户以为没领上。
      claims.push({ plan: planName, via: 'direct', ok: true, startsAt: r?.startsAt || null });
      anySuccess = true;
            logger.info('ZCODE-CLAIM', '{label} 已领取「{plan}」(免验证码){grants}', { label, plan: planName, grants: grantsText(plan) ? ':' + grantsText(plan) : '' });
      continue;
    } catch (e) {
      if (e.code === 1003) {
        claims.push({ plan: planName, ok: true, already: true });
                logger.info('ZCODE-CLAIM', '{label}「{plan}」已领取过', { label, plan: planName });
        continue;
      }
      if (e.code === 1005 && e.nextAt) {
        snoozeAt = Math.max(snoozeAt, Number(new Date(e.nextAt)) || 0);
      }
      if (e.code !== 3007 && e.code !== 3001) {
        // 1001/1002 = 已知清单兜底里的活动不存在/已结束：静默跳过（不进卡片、不算失败）。
        // 只对 known 兜底项生效——preview 列表里的真实活动若返回 1002 仍要如实记失败
        if ((e.code === 1001 || e.code === 1002) && plan.known === true) continue;
        claims.push({ plan: planName, ok: false, message: e.message });
                logger.warn('ZCODE-CLAIM', '{label} 领取「{plan}」失败:{err}', { label, plan: planName, err: e.message });
        continue;
      }
    }
    // 第 3 步：需要验证码
    if (!captchaProvider) {
      needManual = true;
      claims.push({ plan: planName, ok: false, needManual: true });
            logger.info('ZCODE-CLAIM', '{label}「{plan}」需要验证码,本环境无法自动通过,请在面板手动领取', { label, plan: planName });
      continue;
    }
    try {
      const cfg = await fetchCaptchaConfig();
      if (!cfg.enabled || !cfg.sceneId) throw new Error('验证码配置不可用');
      const { captchaParam, region } = await captchaProvider(cfg);
      const r2 = await claimPlan(account, plan.planId, { captchaParam, region });
      claims.push({ plan: planName, via: 'captcha', ok: true, startsAt: r2?.startsAt || null });
      anySuccess = true;
            logger.info('ZCODE-CLAIM', '{label} 已领取「{plan}」(静默验证码){grants}', { label, plan: planName, grants: grantsText(plan) ? ':' + grantsText(plan) : '' });
    } catch (e2) {
      if (e2.code === 1005 && e2.nextAt) {
        snoozeAt = Math.max(snoozeAt, Number(new Date(e2.nextAt)) || 0);
      }
      needManual = true;
      claims.push({ plan: planName, ok: false, needManual: true, message: e2.message });
            logger.warn('ZCODE-CLAIM', '{label}「{plan}」验证码未完成:{err}(可在面板手动领取)', { label, plan: planName, err: e2.message });
    }
  }
  // 1005 名额已满 → 按服务端 ends_at 将本账号挂进跳过窗口，下一轮自动轮询在该时间点前不再空打
  if (snoozeAt > 0) {
    snoozeUntil.set(account.id, snoozeAt);
    try {
      await withAccounts((list) => {
        const cur = list.find((a) => a.id === account.id);
        if (cur) {
          cur.meta = cur.meta && typeof cur.meta === 'object' && !Array.isArray(cur.meta) ? cur.meta : {};
          cur.meta.zcodeClaimNextAt = new Date(snoozeAt).toISOString();
        }
      });
    } catch {}
  }

  // 已知清单全部不可领（1001/1002 静默跳过）时 claims 为空：无事发生，不留痕迹
  if (!claims.length) return null;
  const names = claims.filter((c) => c.ok && !c.already).map((c) => c.plan);
  const status = names.length ? 'checked-in'
    : claims.every((c) => c.already) ? 'already'
    : 'failed';
  // 到账时间：新领的活动若带 effective_at（当天稍晚才进余额），把时间写进消息——
  // 否则面板只显示「待生效」，用户无法判断是没领上还是要等。
  const fmtAt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return sameDay ? hm : `${d.getMonth() + 1}-${p2(d.getDate())} ${hm}`;
  };
  const starts = claims.filter((c) => c.ok && c.startsAt && new Date(c.startsAt).getTime() > Date.now());
  const startsText = starts.length ? `（${fmtAt(starts[0].startsAt)} 到账）` : '';
  const message = status === 'checked-in'
    ? `已领取：${names.join('、')}${claims.some((c) => c.via === 'captcha') ? '（静默验证码）' : ''}${startsText}`
    : status === 'already' ? '活动均已领取过'
    : needManual ? `有 ${claims.filter((c) => c.needManual).length} 个活动需要验证码，请在面板手动领取`
    : `领取失败：${claims.filter((c) => !c.ok).map((c) => c.message).filter(Boolean)[0] || '未知错误'}`;
  return { status, message, claims };
}
