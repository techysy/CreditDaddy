/**
 * QoderDaddy 常量 — Qoder 官方 OpenAPI 端点。
 *
 * 端点与请求头结构来自社区逆向成果（10router 项目实测可用）：
 *   openapi.qoder.sh      国际版：活动/签到、userinfo、配额、PAT 兑换
 *   openapi.qoder.com.cn  国内版：同上
 *
 * ⚠️ 非官方接口，Qoder 调整服务端时可能失效。
 */

import { readFileSync } from 'node:fs';

export const OPENAPI_BASE = 'https://openapi.qoder.sh';
export const CN_OPENAPI_BASE = 'https://openapi.qoder.com.cn';

export const LOGIN_URL = 'https://qoder.com/device/selectAccounts';
export const CN_LOGIN_URL = 'https://qoder.cn/device/selectAccounts';

// 活动（签到）列表与领取
export const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns?clientType=10';
export const CAMPAIGN_CLAIM_PATH = (id) => `/sash/api/v1/me/campaigns/${encodeURIComponent(id)}/claim`;

// 账号信息与配额
export const USERINFO_PATH = '/api/v1/userinfo';
export const QUOTA_USAGE_PATH = '/api/v2/quota/usage';

// PAT (pt-...) → 短期 job token (jt-...) 兑换（普通 JSON POST，无需 COSY 签名）
export const JOB_TOKEN_EXCHANGE_PATH = '/api/v1/jobToken/exchange';

export const PROVIDERS = ['qoder', 'qoder-cn'];
export const PROVIDER_LABEL = { qoder: 'Qoder 国际版', 'qoder-cn': 'Qoder 国内版' };

/** 签到请求头（源自 10router qoderCheckin.js，clientType=10 与官方客户端一致） */
export function buildQoderHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'Cosy-Version': '0.3.3',
    'Cosy-MachineOS':
      process.platform === 'win32' ? 'windows'
        : process.platform === 'darwin' ? 'macos' : 'linux',
    'User-Agent': 'Qoder',
    Accept: 'application/json',
  };
}

/** PAT 兑换请求头（源自 10router qoderModels.js，模拟官方 qodercli） */
export function buildExchangeHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'qodercli/1.0.0',
    'Cosy-Version': '1.0.0',
    'Cosy-ClientType': '5',
  };
}

export const FETCH_TIMEOUT_MS = 15000;

// 版本号以 package.json 为唯一来源（桌面版 / fpk 打包时都会一并拷入 package.json）
export const APP_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
