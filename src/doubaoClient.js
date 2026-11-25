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

const DETAIL_URL = 'https://www.doubao.com/alice/ug/campaign/v3/detail/';
const CHECKIN_URL = 'https://www.doubao.com/alice/ug/campaign/item/reward/claim/';
/** 任务面板所属活动组（pc 端激励任务 v3；签到是其中的 daily_signin 任务） */
const CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3';
const CAMPAIGN_ITEM = 'daily_signin';

/**
 * 客户端指纹伪装（issue #32 用户实测反馈：纯网页 cookie 裸 UA 打活动接口吃「请求非法」，
 * 活动在服务端按客户端环境放行）。指纹 = 豆包桌面版 webview 的完整请求形状（CDP 抓包）：
 *   - UA 与 webview 同款（Chrome/147 + DoubaoWebView 标识）
 *   - URL 必带 version_code / device_platform=web / web_platform=desktop / aid 等平台参数
 *   - web_id / tea_uuid 按账号 uid 确定性派生（每号一台稳定「设备」，同 attempt 语义）
 *   - device_id 空（实测可过）
 */
const CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36';
const COMMON_PARAMS = {
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

/** 按 uid 派生稳定设备标识（每号恒定，账号间互异；纯数字 web_id 风格） */
function deviceIdsFor(uid) {
  const seed = crypto.createHash('sha256').update(`doubao-dev:${uid || 'anonymous'}`).digest();
  const webId = '76' + [...seed.subarray(0, 8)].map((b) => b % 10).join('');          // 18 位数字
  const teaUuid = [...seed.subarray(8, 16)].map((b) => (b % 10)).join('').padEnd(16, '7');
  return { web_id: webId, tea_uuid: teaUuid };
}

/** 组装带客户端指纹的接口 URL */
function apiUrl(base, uid) {
  const params = new URLSearchParams({ ...COMMON_PARAMS, ...deviceIdsFor(uid), device_id: '', region: '', sys_region: '' });
  return base + '?' + params.toString();
}

const postJson = (url, cookie, body, uid) => fetchJsonRace(url, {
  method: 'POST',
  headers: {
    Cookie: String(cookie || ''),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.doubao.com/pc/agent-explore',
    Origin: 'https://www.doubao.com',
    'User-Agent': CLIENT_UA,
    'Agw-Js-Conv': 'str',
  },
  body: JSON.stringify(body),
  timeoutMs: FETCH_TIMEOUT_MS,
});

/** 会话失效的业务码（实测：匿名 / 过期 cookie 返 code 710012001「登录已过期」） */
const LOGIN_INVALID = 710012001;

/** detail 响应里挖签到任务（tasks[].task_kind === 'daily_signin'） */
function findCheckinTask(body) {
  const tasks = body?.data?.tasks;
  if (!Array.isArray(tasks)) return null;
  return tasks.find((t) => t && t.task_kind === 'daily_signin') || null;
}

/**
 * 签到状态 + 体验额度读数（detail 接口一次拿全）。
 * @returns {{ auth: boolean, code: number|string|null, checkin: { checkedIn: boolean, continuousDays: number, lastDate: string, rewardAmount: number }|null, totalAmount: number|null }}
 */
/**
 * 签到状态 + 体验额度读数（detail 接口一次拿全）。uid 用于派生稳定设备指纹。
 * @returns {{ auth: boolean, code: number|string|null, checkin: object|null, totalAmount: number|null }}
 */
export async function fetchDoubaoStatus(cookie, uid = '') {
  const res = await postJson(apiUrl(DETAIL_URL, uid), cookie, { campaign_group_code: CAMPAIGN_GROUP }, uid);
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
 * 每日签到：先查状态，未签才 claim。返回 CreditDaddy 签到契约。
 * 服务端幂等：重复领取 code 0 + idempotent:true——归 already 不算错误。
 */
export async function checkinDoubao(account) {
  const base = { accountId: account.id, account: account.name || account.id, provider: 'doubao' };
  const cookie = account.meta?.cookieSiteSession?.cookie || account.token || account.cookie;
  if (!cookie) return { ...base, status: 'failed', message: '缺少豆包会话 cookie（请重新登录捕获）' };

  const uid = account.uid || '';
  let st;
  try {
    st = await fetchDoubaoStatus(cookie, uid);
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
    const res = await postJson(apiUrl(CHECKIN_URL, uid), cookie, {
      task_id: '',
      campaign_group_code: CAMPAIGN_GROUP,
      campaign_item_code: CAMPAIGN_ITEM,
    }, uid);
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
  if (code !== 0) return { ...base, status: 'failed', message: `${body.msg || body.message || '签到失败'}（code ${code}）` };
  const d = body.data || {};
  const bizError = d.biz_error;
  if (bizError) {
    const bizCode = String(bizError.code ?? '');
    // 官方前端逻辑：'0', '4', '6' 视为成功或已领/幂等
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
  const amount = Number(d.reward_amount) || st.checkin.rewardAmount || 200;
  const days = Number(d.continuous_days) || st.checkin.continuousDays + 1;
  return { ...base, status: 'checked-in', claimedAmount: amount, message: `签到成功，+${amount} 额度（连续 ${days} 天）` };
}
