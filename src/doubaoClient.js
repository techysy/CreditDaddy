/**
 * 豆包（doubao.com）网页会话 — 每日签到领体验额度（issue #32）。
 *
 *   POST https://www.doubao.com/alice/ug/campaign/v3/detail/   任务面板数据（含签到状态）
 *   POST https://www.doubao.com/alice/ug/campaign/landing/checkin  领取（+200 额度/天）
 *
 * 鉴权：纯 doubao.com 会话 cookie（网页捕获线），无 a_bogus / msToken 请求签名；
 * device_id 空可过；服务端自带幂等（重复领取返回 idempotent:true 不重复发放）。
 * 接口形状 2026-10-19/20 带调试端口实测（CDP 挂监听抓已签 + 未签两个场景）。
 *
 * 参与门槛：仅个人账号（飞书企业号被排除，活动页会提示「请切换至个人账号」）。
 * 活动页 UI 有「仅支持豆包电脑版」前端墙，但接口不吃这套——cookie 直打即通。
 */

import crypto from 'node:crypto';
import { fetchJsonRace } from './zcodeClient.js';
import { FETCH_TIMEOUT_MS } from './constants.js';
import { extractDoubaoUid, parseCookieHeader, readDoubaoDeviceInfo } from './doubaoLocal.js';

const DETAIL_URL = 'https://www.doubao.com/alice/ug/campaign/v3/detail/';
const CHECKIN_URL = 'https://www.doubao.com/alice/ug/campaign/landing/checkin';
/** 任务面板所属活动组（pc 端激励任务 v3；签到是其中的 daily_signin 任务） */
const CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3';

/**
 * 客户端指纹（issue #32 / 桌面客户端实测对照）：
 * - 当凭据来自本机桌面端或携带设备信息（meta.doubaoDevice.deviceId）时，
 *   使用真实桌面端参数（aid=582478, client_platform=pc_client, device_id, fp=verify_<deviceId>），
 *   与豆包桌面客户端 DailyCheckIn 请求完全一致。
 * - 纯网页 cookie 无 deviceId 时，回退网页参数（aid=497858, device_id 空）。
 */
const WEB_CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36';
const DEFAULT_PC_VERSION = '2.37.16';
const WEB_COMMON_PARAMS = {
  version_code: '20800',
  language: 'zh',
  device_platform: 'web',
  doubao_device_platform: 'web',
  aid: '497858',
  real_aid: '497858',
  pkg_type: 'release_version',
  pc_version: '2.32.6',
  doubao_pc_version: '5.72.66',
  samantha_web: '1',
  web_platform: 'desktop',
  'use-olympus-account': '1',
  web_tab_id: '0',
};

/** 解析账号关联的桌面设备上下文（纯内存或本地 Local State，无敏感信息） */
export function resolveDoubaoDevice(account) {
  const dev = account?.meta?.doubaoDevice;
  if (dev && (dev.deviceId || dev.pcVersion)) return dev;
  if (account?.source === 'local-app') return readDoubaoDeviceInfo();
  return null;
}

/** 按 uid 派生稳定设备标识（每号恒定，账号间互异；纯数字 web_id 风格） */
function deviceIdsFor(uid) {
  const seed = crypto.createHash('sha256').update(`doubao-dev:${uid || 'anonymous'}`).digest();
  const webId = '76' + [...seed.subarray(0, 8)].map((b) => b % 10).join('');          // 18 位数字
  const teaUuid = [...seed.subarray(8, 16)].map((b) => (b % 10)).join('').padEnd(16, '7');
  return { web_id: webId, tea_uuid: teaUuid };
}

/** 组装带客户端指纹的接口 URL */
function apiUrl(base, uid, device = null) {
  const derived = deviceIdsFor(uid);
  if (device?.deviceId) {
    const pcVer = device.pcVersion || DEFAULT_PC_VERSION;
    const params = new URLSearchParams({
      version_code: '20800',
      language: 'zh',
      device_platform: 'web',
      doubao_device_platform: 'desktop',
      aid: '582478',
      os: 'windows',
      real_aid: '582478',
      pkg_type: 'release_version',
      device_id: device.deviceId,
      pc_version: pcVer,
      doubao_pc_version: pcVer,
      web_id: derived.web_id,
      tea_uuid: device.deviceId,
      region: 'CN',
      sys_region: 'CN',
      samantha_web: '1',
      web_platform: 'desktop',
      'use-olympus-account': '1',
      runtime: 'web',
      runtime_version: '3.47.0',
      client_platform: 'pc_client',
      channel: 'win',
      fp: `verify_${device.deviceId}`,
      ...(device.installId ? { iid: device.installId } : {}),
    });
    return base + '?' + params.toString();
  }
  const params = new URLSearchParams({ ...WEB_COMMON_PARAMS, ...derived, device_id: '', region: '', sys_region: '' });
  return base + '?' + params.toString();
}

const postJson = (url, cookie, body, device = null) => {
  const cookieMap = parseCookieHeader(cookie);
  const csrfToken = cookieMap.passport_csrf_token || cookieMap.passport_csrf_token_default || '';
  const ua = device?.deviceId
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/${device.pcVersion || DEFAULT_PC_VERSION}`
    : WEB_CLIENT_UA;
  return fetchJsonRace(url, {
    method: 'POST',
    headers: {
      Cookie: String(cookie || ''),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.doubao.com/pc/agent-explore',
      Origin: 'https://www.doubao.com',
      'User-Agent': ua,
      'Agw-Js-Conv': 'str',
      ...(csrfToken ? { 'x-tt-passport-csrf-token': csrfToken } : {}),
    },
    body: JSON.stringify(body),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
};

/** 会话失效的业务码（实测：匿名 / 过期 cookie 返 code 710012001「登录已过期」） */
const LOGIN_INVALID = 710012001;

/** detail 响应里挖签到任务（tasks[].task_kind === 'daily_signin'） */
function findCheckinTask(body) {
  const tasks = body?.data?.tasks;
  if (!Array.isArray(tasks)) return null;
  return tasks.find((t) => t && t.task_kind === 'daily_signin') || null;
}

const RISK_BLOCKED_CODE = 710010702;

/**
 * 签到状态 + 体验额度读数（detail 接口一次拿全）。uid 用于派生稳定设备指纹。
 * @returns {{ auth: boolean, code: number|string|null, checkin: { checkedIn: boolean, continuousDays: number, lastDate: string, rewardAmount: number }|null, totalAmount: number|null }}
 */
export async function fetchDoubaoStatus(cookie, uid = '', device = null) {
  const res = await postJson(apiUrl(DETAIL_URL, uid, device), cookie, { campaign_group_code: CAMPAIGN_GROUP }, device);
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { /* 非 JSON */ }
  if (!body || typeof body !== 'object') return { auth: false, code: `HTTP ${res.status}`, checkin: null, totalAmount: null };
  const code = Number(body.code);
  if (code === LOGIN_INVALID) return { auth: false, code, checkin: null, totalAmount: null };
  const task = findCheckinTask(body);
  const c = task?.daily_checkin || {};
  return {
    auth: true,
    code,
    checkin: task ? {
      checkedIn: c.checked_in_today === true,
      continuousDays: Number(c.continuous_days) || 0,
      lastDate: typeof c.last_checkin_date === 'string' ? c.last_checkin_date : null,
      rewardAmount: Number(c.reward?.reward_amount) || 0,
    } : null,
    totalAmount: Number(body.data?.progress?.total_amount) || 0,
  };
}

/**
 * 每日签到：先查状态，未签才调用 landing/checkin（官方桌面端 & 网页端唯一签到入口）。
 * 注意：item/reward/claim/ 在 daily_signin 场景会持续返回 biz_error.code 3「领取结果确认中」。
 * 服务端幂等：重复领取返回 code 0 + idempotent:true——归 already 不算错误。
 */
export async function checkinDoubao(account, options = {}) {
  const base = { accountId: account.id, account: account.name || account.id, provider: 'doubao' };
  const cookie = account.meta?.cookieSiteSession?.cookie || account.token || account.cookie;
  if (!cookie) return { ...base, status: 'failed', message: '缺少豆包会话 cookie（请重新登录捕获）' };

  const uid = extractDoubaoUid(cookie) || account.uid || '';
  const device = resolveDoubaoDevice(account);
  let st;
  try {
    st = await fetchDoubaoStatus(cookie, uid, device);
  } catch (e) {
    return { ...base, status: 'failed', message: e?.message || '网络错误' };
  }
  if (!st.auth) {
    const e = new Error('豆包会话已失效，请重新登录捕获');
    e.auth = true;
    throw e;
  }
  if (st.checkin?.checkedIn) {
    return { ...base, status: 'already', message: '今天已签到', uid: null };
  }
  if (!st.checkin) {
    // 活动下线 / 飞书企业号被排除等场景：detail 里没有签到任务
    return { ...base, status: 'no-activity', message: '当前账号无签到任务（活动可能未开放，或飞书企业账号不支持参与）' };
  }

  let body = null;
  try {
    const res = await postJson(apiUrl(CHECKIN_URL, uid, device), cookie, { scene: CAMPAIGN_GROUP }, device);
    const text = await res.text();
    body = JSON.parse(text);
  } catch (e) {
    return { ...base, status: 'failed', message: e?.message || '网络错误' };
  }
  if (!body || typeof body !== 'object') return { ...base, status: 'failed', message: '签到接口返回无法解析' };
  const code = Number(body.code);
  if (code === LOGIN_INVALID) {
    const e = new Error('豆包会话已失效，请重新登录捕获');
    e.auth = true;
    throw e;
  }
  if (code === RISK_BLOCKED_CODE) {
    if (options?.localFallback !== false && process.platform === 'win32') {
      try {
        const { checkinDoubaoViaLocalClient, detectDoubao } = await import('./doubaoLocal.js');
        const det = detectDoubao();
        if (det.clientInstalled) {
          const localRes = await checkinDoubaoViaLocalClient(options);
          if (localRes?.status === 'checked-in' || localRes?.status === 'already') {
            return { ...base, ...localRes };
          }
          if (localRes?.reason === 'running_without_cdp') {
            return {
              ...base,
              status: 'failed',
              message: '豆包风控拦截（code 710010702）：客户端正在运行，请在豆包窗口中点击「立即签到」；或退出客户端后由 CreditDaddy 自动调起完成签到',
            };
          }
        }
      } catch {}
    }
    return { ...base, status: 'failed', message: '豆包风控拦截（code 710010702），请打开豆包客户端完成今日签到' };
  }
  if (code !== 0) return { ...base, status: 'failed', message: `${body.msg || body.message || '签到失败'}（code ${code}）` };
  const d = body.data || {};
  const bizError = d.biz_error;
  if (bizError) {
    const bizCode = String(bizError.code ?? '');
    if (bizCode === '4' || d.idempotent === true) {
      return { ...base, status: 'already', message: '今天已签到（服务端已发放）' };
    }
    if (!['0', '6'].includes(bizCode)) {
      return {
        ...base,
        status: 'failed',
        message: bizError.message ? `豆包：${bizError.message}` : `领取未成功（code ${bizCode}）`,
      };
    }
  }

  if (d.idempotent === true) return { ...base, status: 'already', message: '今天已签到（服务端幂等去重）' };
  if (d.checked_in === false) {
    return { ...base, status: 'failed', message: body.msg || '豆包未确认签到完成，请稍后重试' };
  }
  const amount = Number(d.reward_amount) || st.checkin.rewardAmount || 200;
  const days = Number(d.continuous_days) || st.checkin.continuousDays + 1;
  return { ...base, status: 'checked-in', claimedAmount: amount, message: `签到成功，+${amount} 额度（连续 ${days} 天）` };
}
