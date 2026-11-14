/**
 * DuMate 百度搭子扫码登录 —— 纯 HTTP 重实现百度 Passport（tangram）二维码流程，无头无浏览器。
 * 协议与 10Router open-sse/shared/dumate/qr.js + session.js 同源（c50d22a6，已在线上 10R 实测可用）：
 *
 *   1. GET passport.baidu.com/v2/api/getqrcode?tpl=bceplat&gid=<guid>&callback=<jsonp>
 *        → { sign, imgurl }
 *   2. GET /v2/api/qrcode?sign=..&lp=pc&qrloginfrom=pc → 二维码 PNG（守护进程侧取回转 data URI，
 *      面板无需直连 passport.baidu.com）
 *   3. GET /channel/unicast?channel_id=<sign>&tpl=bceplat（30s 长轮询）
 *        errno==1                        → 继续等
 *        errno==0 && channel_v.status==1 → 已扫码待确认
 *        errno==0 && channel_v.status==0 → 已确认 → 第 4 步
 *        errno==50000                    → 风控拦截
 *   4. GET /v3/login/main/qrbdusslogin?bduss=<channel_v.v>&u=<enc(channel_v.u)>…
 *        → errInfo.no==0，Set-Cookie 落 Passport cookies（BDUSS/STOKEN/PTOKEN/UBI/BAIDUID）
 *   5. 跟随 data.u 跳转链进入 console.bce.baidu.com → bce-sessionid；缺失时回落
 *      quickLogin 快捷登录链（登录页「快捷登录」按钮的同款 wap 链）。
 *   6. 保留 bce-sessionid + Passport cookies，串成凭据头（与 10R dumate 渠道 apiKey 同形）。
 *
 * qrbdusslogin 的坑（逆向 SDK 得出，照抄 10R 口径）：
 *   - `u` 在线上只编码一次（SDK 先 decodeURIComponent(channel_v.u) 再由 jsonp 层编码一次），
 *     双重编码会被百度回 errInfo.no=200；
 *   - channel_v.u 可为空——SDK 回落到页面配置的回跳地址，这里用 DuMate 控制台 URL；
 *   - apiver/tt/lang/maskId/fileId 是 SDK 自动补的参数，缺了同样 no=200；
 *   - 响应是 JSONP 包着一个单引号键的 JS 对象字面量——严格 JSON.parse 会挂，字段提取带正则兜底。
 *
 * 状态机：starting | waiting | scanned | confirming | authorized | success | expired | cancelled | error
 * `authorized` = 凭据已在会话里，由 daemon 路由负责入库 + 校验后置 success。
 * 凭据只在本机会话内流转，日志绝不落 Cookie / token 值。
 */

import { randomBytes } from 'node:crypto';
import { FETCH_TIMEOUT_MS } from './constants.js';

export const DUMATE_QR_CONSOLE_URL = 'https://console.bce.baidu.com/dumate/channel';
export const DUMATE_QR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const QR_TTL_MS = 10 * 60_000;    // 百度二维码有效期约 10 分钟
const SESSION_KEEP_MS = 15 * 60_000;

const PASSPORT_NAMES = ['BDUSS', 'BDUSS_BFESS', 'STOKEN', 'PTOKEN', 'UBI', 'UBI_BFESS', 'BAIDUID', 'BAIDUID_BFESS', 'PASSID'];
const PASSPORT_HOST_ONLY = new Set(['STOKEN', 'PTOKEN', 'UBI', 'UBI_BFESS', 'PASSID']);

const bare = (d) => String(d || '').replace(/^\./, '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logPage = () => encodeURIComponent(`traceId:pc_loginv5_${Math.floor(Date.now() / 1000)},logPage:loginv5`);
const guid = () => [7, 4, 4, 4, 12].map((n) => randomBytes(8).toString('hex').toUpperCase().slice(0, n)).join('-');
const unjsonp = (t) => { const m = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(t); return JSON.parse(m ? m[1] : t); };
const jsoNo = (t) => { const m = /"no"\s*:\s*"?\s*(-?\d+)/.exec(t); return m ? +m[1] : null; };
const jsoU = (t) => { const m = /"u"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t); return m ? m[1].replace(/\\\//g, '/').replace(/\\\\/g, '\\') : null; };

/** 域感知 cookie 罐（够用即可：name/value/domain，header(host) 按域过滤） */
export class Jar {
  constructor() { this.cookies = []; }
  add(name, value, domain) {
    if (!name) return;
    this.cookies = this.cookies.filter((c) => !(c.name === name && bare(c.domain) === bare(domain)));
    this.cookies.push({ name, value: String(value ?? ''), domain: domain || '' });
  }
  addSetCookie(list, host) {
    for (const raw of list || []) {
      const first = String(raw).split(';')[0];
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      const dm = /domain=([^;]+)/i.exec(String(raw));
      this.add(name, value, dm ? dm[1].trim() : host);
    }
  }
  header(host) {
    const h = bare(host);
    return this.cookies
      .filter((c) => { const d = bare(c.domain); return !d || h === d || h.endsWith('.' + d); })
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }
  has(name) { return this.cookies.some((c) => c.name === name && c.value); }
  all() { return this.cookies.slice(); }
}

/** 只留控制台会话 + Passport 集（照抄 10R keepCookie 口径） */
export function keepCookie(c) {
  if (c.name === 'bce-sessionid') return true;
  if (/^bce/i.test(c.name)) return false;
  const d = bare(c.domain);
  return d === 'baidu.com' || d === 'passport.baidu.com';
}

async function fetchGet(url, jar, timeoutMs, s) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  if (s) s.ctl = ctl;
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctl.signal,
      headers: {
        'User-Agent': DUMATE_QR_UA,
        Accept: '*/*',
        Referer: 'https://login.bce.baidu.com/',
        ...(jar ? { Cookie: jar.header(new URL(url).hostname) } : {}),
      },
    });
    if (jar) jar.addSetCookie(res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')], new URL(url).hostname);
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    if (s && s.cancelled) return { status: 0, headers: new Headers(), body: Buffer.alloc(0) };
    throw e;
  } finally { clearTimeout(timer); }
}

/* ---------------- 快捷登录链（bce-sessionid 缺失时的兜底，可独立复用） ---------------- */

const reauthError = (msg) => Object.assign(new Error(msg), { reauth: true });
const b64urlJson = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 校验 Passport 并取账号名：{ username, portraitUrl } 或 null */
export async function qrPortrait(pp) {
  const jar = new Jar();
  for (const c of pp) jar.add(c.name, c.value, c.domain || '.baidu.com');
  const r = await fetchGet('https://login.bce.baidu.com/passport-portrait', jar, 20_000);
  try {
    const j = JSON.parse(r.body.toString('utf8'));
    if (j && j.success && j.result && j.result.username) return j.result;
  } catch { /* 非 JSON = 未登录 */ }
  return null;
}

/**
 * 用 Passport cookies（必须含 BDUSS/BDUSS_BFSS）换全套控制台会话。
 * @returns {{ cookies: Array<{name,value,domain}>, account: string }}
 */
export async function qrQuickLogin(pp) {
  if (!pp.some((c) => c.name === 'BDUSS' || c.name === 'BDUSS_BFESS')) {
    throw reauthError('no Baidu passport cookie (BDUSS) — cannot log in');
  }
  const jar = new Jar();
  for (const c of pp) jar.add(c.name, c.value, c.domain || '.baidu.com');
  // 登录页 JS 在出示「快捷登录」前写入的标记 cookie，缺了会被弹回登录页
  for (const [n, v] of [
    ['bce-login-type', 'PASSPORT'],
    ['bce-login-type-detail', 'SHARED_PASSPORT'],
    ['bce-fe-load-type', 'self'],
    ['x-bce-login-redirect-url', DUMATE_QR_CONSOLE_URL],
    ['x-bce-login-redirect-url-console', DUMATE_QR_CONSOLE_URL],
  ]) jar.add(n, v, '.bce.baidu.com');

  const pf = await qrPortrait(pp).catch(() => null);
  if (!pf) throw reauthError('Baidu passport session rejected (BDUSS not accepted) — re-login required');

  let url = 'https://login.bce.baidu.com/postlogin/passport/wap'
    + '?activate=true&passportShared=true&redirect=' + DUMATE_QR_CONSOLE_URL
    + '&ocpcContext=' + b64urlJson({ portraitUrl: pf.portraitUrl || '', username: pf.username });

  for (let hop = 0; hop < 10; hop++) {
    const r = await fetchGet(url, jar, 20_000);
    const loc = r.headers.get('location');
    if (!loc) {
      const onConsole = /^https:\/\/console\.bce\.baidu\.com\//.test(url);
      const hasSess = jar.has('bce-sessionid');
      if (onConsole && r.status === 200 && hasSess) return { cookies: jar.all(), account: pf.username };
      break;
    }
    url = new URL(loc, url).href;
  }
  if (!jar.has('bce-sessionid')) {
    throw reauthError('quick-login did not establish a console session (passport rejected or risk check) — re-login required');
  }
  throw new Error('quick-login redirect chain never reached the console: ' + url.slice(0, 120));
}

/* ---------------- 会话表与后台流程 ---------------- */

const sessions = new Map();
let seq = 0;

function gc() {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.doneAt && now - s.doneAt > SESSION_KEEP_MS) sessions.delete(k);
}

export function finishQr(s, status, error) {
  if (s.doneAt && s.status !== 'authorized') return;
  s.status = status;
  if (error) s.error = error;
  s.doneAt = Date.now();
}

export function pubQr(s) {
  const o = { sid: s.id, status: s.status };
  if (s.qr && ['waiting', 'scanned', 'confirming'].includes(s.status)) { o.qr = s.qr; o.expiresAt = s.expiresAt; }
  if (s.error) o.error = s.error;
  if (s.account) o.account = s.account;
  return o;
}

export function getQrSession(sid) { gc(); return sessions.get(String(sid || '')) || null; }

/** 开新扫码会话；同一实例上未完成的旧会话先取消 */
export function startQrSession() {
  gc();
  for (const s of sessions.values()) if (!s.doneAt) { s.cancelled = true; try { s.ctl?.abort(); } catch { /* noop */ } }
  const s = { id: 'dmqr-' + (++seq) + '-' + randomBytes(4).toString('hex'), status: 'starting', cancelled: false, doneAt: 0 };
  sessions.set(s.id, s);
  runQr(s).catch(() => finishQr(s, 'error', 'QR flow crashed'));
  return s;
}

export function cancelQrSession(sid) {
  const s = getQrSession(sid);
  if (!s || s.doneAt) return false;
  s.cancelled = true;
  try { s.ctl?.abort(); } catch { /* noop */ }
  finishQr(s, 'cancelled');
  return true;
}

async function runQr(s) {
  const jar = new Jar();
  const GID = guid(), CB = 'tangram_guid_' + Date.now(), LP = logPage();
  try {
    // 1) 取码
    const r1 = await fetchGet(
      `https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=${GID}&callback=${CB}&apiver=v3&tt=${Date.now()}&tpl=bceplat&logPage=${LP}&_=${Date.now()}`,
      jar, 20_000, s);
    if (s.cancelled) return;
    let j1 = null; try { j1 = unjsonp(r1.body.toString('utf8')); } catch { /* 下面统一处理 */ }
    if (!j1 || +j1.errno !== 0 || !j1.sign) throw new Error('QR generation failed: errno=' + (j1 ? j1.errno : r1.status));
    const sign = j1.sign;

    // 2) 二维码图片（守护进程侧取回 → data URI）
    const imgUrl = 'https://' + String(j1.imgurl || 'passport.baidu.com/v2/api/qrcode?sign=' + sign).replace(/^https?:\/\//, '')
      + `&lp=pc&qrloginfrom=pc&logPage=${LP}`;
    const r2 = await fetchGet(imgUrl, jar, 20_000, s);
    if (s.cancelled) return;
    if (r2.status !== 200 || !/image/.test(String(r2.headers.get('content-type') || ''))) {
      throw new Error('QR image fetch failed: HTTP ' + r2.status);
    }
    s.qr = 'data:image/png;base64,' + r2.body.toString('base64');
    s.expiresAt = Date.now() + QR_TTL_MS;
    s.status = 'waiting';

    // 3) unicast 长轮询，直到确认 / 过期 / 取消
    let cv = null, errs = 0;
    while (!s.cancelled) {
      if (Date.now() > s.expiresAt) { finishQr(s, 'expired'); return; }
      let d = null;
      try {
        const r3 = await fetchGet(
          `https://passport.baidu.com/channel/unicast?channel_id=${sign}&gid=${GID}&tpl=bceplat&_sdkFrom=1&callback=${CB}&apiver=v3&tt=${Date.now()}&_=${Date.now()}`,
          jar, 40_000, s);
        if (s.cancelled) return;
        d = unjsonp(r3.body.toString('utf8'));
        errs = 0;
      } catch (e) {
        if (s.cancelled) return;
        if (++errs >= 5) throw new Error('scan-status polling failed: ' + e.message);
        await sleep(2000); continue;
      }
      if (+d.errno === 50000) throw new Error('Baidu risk control blocked this QR login — retry later or use local import');
      let cvo = null; try { cvo = typeof d.channel_v === 'string' ? JSON.parse(d.channel_v) : d.channel_v; } catch { /* 继续轮询 */ }
      if (cvo && +cvo.status === 0) { cv = cvo; break; }
      if (cvo && +cvo.status === 1 && s.status === 'waiting') s.status = 'scanned';
    }
    if (s.cancelled || !cv || !cv.v) {
      if (!s.cancelled) finishQr(s, 'error', 'login confirmed but no ticket was returned');
      return;
    }
    s.status = 'confirming';

    // 4) qrbdusslogin——落 Passport cookies；cv.u 为空回落控制台 URL（与 SDK 缺省同口径）
    const r4 = await fetchGet(
      `https://passport.baidu.com/v3/login/main/qrbdusslogin?v=${Date.now()}`
      + `&bduss=${encodeURIComponent(cv.v)}&u=${encodeURIComponent(cv.u || DUMATE_QR_CONSOLE_URL)}`
      + `&loginVersion=v5&qrcode=1&tpl=bceplat&maskId=&fileId=&lang=&apiver=v3&tt=${Date.now()}&callback=${CB}&_=${Date.now()}`,
      jar, 20_000, s);
    if (s.cancelled) return;
    const body4 = r4.body.toString('utf8');
    let j4 = null; try { j4 = unjsonp(body4); } catch { /* 对象字面量 body——正则兜底 */ }
    const no = j4 && j4.errInfo ? +j4.errInfo.no : jsoNo(body4);
    if (no !== 0) throw new Error('login confirm failed: errInfo.no=' + (no == null ? r4.status : no));
    const ret = (j4 && j4.data && j4.data.u) || jsoU(body4) || cv.u;

    // 5) 跟随回跳链进控制台
    if (ret) {
      let url = ret;
      for (let hop = 0; hop < 10; hop++) {
        const rr = await fetchGet(url, jar, 20_000, s);
        if (s.cancelled) return;
        const loc = rr.headers.get('location');
        if (!loc) break;
        url = new URL(loc, url).href;
      }
    }

    // 6) bce-sessionid 缺失 → 快捷登录链兜底
    if (!jar.has('bce-sessionid')) {
      const pp = jar.all().filter((c) => PASSPORT_NAMES.includes(c.name));
      if (pp.some((c) => c.name === 'BDUSS' || c.name === 'BDUSS_BFESS')) {
        const out = await qrQuickLogin(pp);
        for (const c of out.cookies) jar.add(c.name, c.value, c.domain);
        s.account = out.account || s.account;
      }
    }
    const kept = jar.all().filter(keepCookie);
    if (!kept.some((c) => c.name === 'bce-sessionid' && c.value)) {
      throw new Error('QR login succeeded but no console session was established (missing bce-sessionid)');
    }
    if (!kept.some((c) => c.name === 'BDUSS' || c.name === 'BDUSS_BFESS')) {
      // 没有 Passport cookie 只影响后续静默续期，不阻断本次登录
    }
    s.credCookies = kept;
    s.status = 'authorized';
  } catch (e) {
    if (!s.cancelled) finishQr(s, 'error', String(e && e.message || e).split('\n')[0].slice(0, 200));
  } finally {
    if (s.cancelled && !s.doneAt) finishQr(s, 'cancelled');
    s.ctl = null;
  }
}

/** 凭据头（daemon 路由在 authorized 后取用入库） */
export function credHeaderOf(s) {
  return (s?.credCookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}
