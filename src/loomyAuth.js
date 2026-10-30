/**
 * 讯飞 Loomy 独立登录授权模拟器（无需安装客户端，支持纯手机号验证码两步直登）。
 *
 * 逆向自讯飞 Loomy 生产客户端（account.xfinfr.com HMAC-SHA1 签名体系）：
 *   - AppId: GM3LOOMY
 *   - AccessKeyId: 2thryby66wxi53sk
 *   - AccessKeySecret: zsak6eadrbawz683wf5r3m2snrwj868r
 *   - BaseUrl: https://account.xfinfr.com
 *
 * 流程：
 *   1. sendLoomySms(phone)                -> POST /login/phone/sendMsgCode (获取 msgid)
 *   2. loginLoomyBySms({ phone, code, msgid }) -> POST /login/phone/checkCode   (换取 14 天 session token)
 *   3. registerLoomyByPhone({ phone, code })   -> POST /register/phone/submit    (新手机号注册；与登录共用同一条验证码)
 *   4. fetchLoomyIdentity(session)             -> POST /userinfo/query/baseInfo   (会话校验 / 昵称)
 */

import crypto from 'node:crypto';

export const LOOMY_AUTH_CONFIG = {
  baseUrl: 'https://account.xfinfr.com',
  accessKeyId: '2thryby66wxi53sk',
  accessKeySecret: 'zsak6eadrbawz683wf5r3m2snrwj868r',
  appId: 'GM3LOOMY',
};

function contentMD5(body) {
  if (!body) return '';
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const hash = crypto.createHash('md5').update(bodyStr, 'utf8').digest();
  return hash.toString('base64');
}

function escapePathSegment(segment) {
  return encodeURIComponent(segment)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildEscapedPath(path) {
  let cleanPath = path.startsWith('/') ? path : '/' + path;
  if (cleanPath.length > 1 && cleanPath.endsWith('/')) {
    cleanPath = cleanPath.slice(0, -1);
  }
  return cleanPath.split('/').map((seg) => (seg ? escapePathSegment(seg) : '')).join('/');
}

function generateSignature({ method, path, queryParams = {}, body = '', contentType = 'application/json', date, nonce, accessKeySecret }) {
  const escapedPath = buildEscapedPath(path);
  const md5 = contentMD5(body);
  const parts = [
    method.toUpperCase(),
    escapedPath,
    '', // escapedQuery
    md5,
    contentType,
    date,
    nonce,
    '', // signedHeaders
    ''  // canonicalizedHeaders
  ];
  const stringToSign = parts.join('\n');
  const hmac = crypto.createHmac('sha1', accessKeySecret);
  hmac.update(stringToSign, 'utf8');
  return hmac.digest('base64');
}

function generateRequestHeaders({ method, path, body = '', contentType = 'application/json' }) {
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();
  const signature = generateSignature({
    method,
    path,
    body,
    contentType,
    date,
    nonce,
    accessKeySecret: LOOMY_AUTH_CONFIG.accessKeySecret,
  });

  const authorization = `account ${LOOMY_AUTH_CONFIG.accessKeyId}:${signature}`;
  const md5 = contentMD5(body);

  const headers = {
    Authorization: authorization,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
    Accept: 'application/json',
  };
  if (md5) headers['Content-MD5'] = md5;
  return headers;
}

function makeBase() {
  return {
    appid: LOOMY_AUTH_CONFIG.appId,
    modelid: 'Web',
    version: '1.0.0',
    devid: 'web',
    ua: 'Loomy|Desktop|Electron|Windows',
    traceid: crypto.randomUUID().replace(/-/g, ''),
  };
}

async function requestLoomy(path, body) {
  const bodyString = JSON.stringify(body);
  const headers = generateRequestHeaders({
    method: 'POST',
    path,
    body: bodyString,
  });

  const url = `${LOOMY_AUTH_CONFIG.baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyString,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`讯飞认证接口 HTTP ${res.status}: ${text}`);
  }

  const json = await res.json().catch(() => ({}));
  if (json.code && json.code !== '000000') {
    const err = new Error(json.desc || json.message || `业务错误 (${json.code})`);
    err.code = json.code;
    // 100002 / 020002 与客户端 AUTH_ERROR_CODES 同口径：登录态无效
    if (json.code === '100002' || json.code === '020002') err.auth = true;
    throw err;
  }

  return json.data;
}

/** 发送手机验证码 */
export async function sendLoomySms(phone) {
  const cleanPhone = String(phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(cleanPhone)) {
    throw new Error('手机号格式不正确');
  }

  const data = await requestLoomy('/login/phone/sendMsgCode', {
    base: makeBase(),
    param: {
      ccode: '86',
      phone: cleanPhone,
      expire: 300,
    },
  });

  if (!data?.msgid) {
    throw new Error('讯飞接口未返回 msgid');
  }

  return { success: true, msgid: data.msgid };
}

/** 提交手机验证码换取 Session */
export async function loginLoomyBySms({ phone, code, msgid }) {
  const cleanPhone = String(phone || '').trim();
  const cleanCode = String(code || '').trim();
  const cleanMsgid = String(msgid || '').trim();

  if (!cleanPhone || !cleanCode || !cleanMsgid) {
    throw new Error('手机号、验证码和 msgid 均为必填项');
  }

  const data = await requestLoomy('/login/phone/checkCode', {
    base: makeBase(),
    param: {
      ccode: '86',
      phone: cleanPhone,
      mcode: cleanCode,
      msgid: cleanMsgid,
      expire: 14 * 24 * 3600, // 14 天有效
    },
  });

  if (!data?.session) {
    throw new Error('登录未返回 session 凭据');
  }

  return {
    session: data.session,
    userid: data.userid || data.uid,
    phone: cleanPhone,
  };
}

/**
 * 新手机号注册（与登录共用同一条短信验证码，param 不带 msgid）。
 * 渲染层 registerByPhone 同款：phone + code（可选 password，这里不设密码）。
 */
export async function registerLoomyByPhone({ phone, code }) {
  const cleanPhone = String(phone || '').trim();
  const cleanCode = String(code || '').trim();
  if (!/^1[3-9]\d{9}$/.test(cleanPhone)) throw new Error('手机号格式不正确');
  if (!cleanCode) throw new Error('验证码不能为空');

  const data = await requestLoomy('/register/phone/submit', {
    base: makeBase(),
    param: { phone: cleanPhone, code: cleanCode },
  });

  // 注册成功即视为已登录（服务端语义同客户端：注册后可直接 checkCode 换 session）
  return { success: true, ...data };
}

/** 会话校验 / 资料查询：POST /userinfo/query/baseInfo { param: { session } } */
export async function fetchLoomyIdentity(session) {
  const cleanSession = String(session || '').trim();
  if (!cleanSession) throw new Error('缺少 session');

  const data = await requestLoomy('/userinfo/query/baseInfo', {
    base: makeBase(),
    param: { session: cleanSession },
  });

  return {
    userid: String(data?.userid || ''),
    phone: String(data?.phone || ''),
    nickname: String(data?.nickname || '').trim() || null,
  };
}
