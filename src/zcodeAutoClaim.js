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
import { fetchClaimPlans, claimPlan, fetchCaptchaConfig } from './zcodeClient.js';

// 桌面版（Electron 主进程）注册的隐藏窗口验证码实现；NAS / CLI 为 null（走「需手动领取」分支）
let captchaProvider = null;
export function setZcodeCaptchaProvider(fn) { captchaProvider = typeof fn === 'function' ? fn : null; }
export function hasZcodeCaptchaProvider() { return Boolean(captchaProvider); }

const grantsText = (plan) => (plan.grants && plan.grants.length ? plan.grants.join('；') : '');

/**
 * 为单个 ZCode 账号执行一次自动领取。
 * @returns {null | { status, message, claims: Array }} null = preview 为空或查询失败（已记日志，不上卡片）
 */
export async function zcodeAutoClaim(account) {
  const label = account.name || account.uid || account.id;
  let plans;
  try {
    plans = (await fetchClaimPlans(account)).plans;
  } catch (e) {
    logger.debug('ZCODE-CLAIM', `${label} 活动查询失败：${e.message}`);
    return null;
  }
  if (!plans.length) return null;

  const claims = [];
  let anySuccess = false;
  let needManual = false;

  for (const plan of plans) {
    const planName = plan.name || plan.planId;
    // 第 2 步：先试不带验证码
    try {
      const r = await claimPlan(account, plan.planId, {});
      claims.push({ plan: planName, via: 'direct', ok: true });
      anySuccess = true;
      logger.info('ZCODE-CLAIM', `${label} 已领取「${planName}」（免验证码）${grantsText(plan) ? '：' + grantsText(plan) : ''}`);
      continue;
    } catch (e) {
      if (e.code === 1003) {
        claims.push({ plan: planName, ok: true, already: true });
        logger.info('ZCODE-CLAIM', `${label}「${planName}」已领取过`);
        continue;
      }
      if (e.code !== 3007 && e.code !== 3001) {
        claims.push({ plan: planName, ok: false, message: e.message });
        logger.warn('ZCODE-CLAIM', `${label} 领取「${planName}」失败：${e.message}`);
        continue;
      }
    }
    // 第 3 步：需要验证码
    if (!captchaProvider) {
      needManual = true;
      claims.push({ plan: planName, ok: false, needManual: true });
      logger.info('ZCODE-CLAIM', `${label}「${planName}」需要验证码，本环境无法自动通过，请在面板手动领取`);
      continue;
    }
    try {
      const cfg = await fetchCaptchaConfig();
      if (!cfg.enabled || !cfg.sceneId) throw new Error('验证码配置不可用');
      const { captchaParam, region } = await captchaProvider(cfg);
      await claimPlan(account, plan.planId, { captchaParam, region });
      claims.push({ plan: planName, via: 'captcha', ok: true });
      anySuccess = true;
      logger.info('ZCODE-CLAIM', `${label} 已领取「${planName}」（静默验证码）${grantsText(plan) ? '：' + grantsText(plan) : ''}`);
    } catch (e2) {
      needManual = true;
      claims.push({ plan: planName, ok: false, needManual: true, message: e2.message });
      logger.warn('ZCODE-CLAIM', `${label}「${planName}」验证码未完成：${e2.message}（可在面板手动领取）`);
    }
  }

  const names = claims.filter((c) => c.ok && !c.already).map((c) => c.plan);
  const status = names.length ? 'checked-in'
    : claims.every((c) => c.already) ? 'already'
    : 'failed';
  const message = status === 'checked-in'
    ? `已领取：${names.join('、')}${claims.some((c) => c.via === 'captcha') ? '（静默验证码）' : ''}`
    : status === 'already' ? '活动均已领取过'
    : needManual ? `有 ${claims.filter((c) => c.needManual).length} 个活动需要验证码，请在面板手动领取`
    : `领取失败：${claims.filter((c) => !c.ok).map((c) => c.message).filter(Boolean)[0] || '未知错误'}`;
  return { status, message, claims };
}
