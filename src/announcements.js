/**
 * 在线公告 Feed 服务（对齐 10Router /api/announcements）：
 *   - 10 分钟内存 TTL 缓存；
 *   - 默认请求先返回当前缓存，过期时非阻塞后台刷新；
 *   - 传 ?check=1 时同步阻塞刷新后返回；
 *   - 按顺序从 GitHub raw → fastly.jsdelivr → cdn.jsdelivr → Gitee raw 拉取，
 *     全部失败时兜底返回随包根目录 announcements.json（始终返回合法结构）。
 */

import { readFileSync } from 'node:fs';

export const ANNOUNCEMENTS_CACHE_TTL_MS = 10 * 60 * 1000;
export const ANNOUNCEMENTS_FETCH_TIMEOUT_MS = 6000;

export const ANNOUNCEMENTS_CANDIDATE_URLS = [
  'https://raw.githubusercontent.com/techysy/CreditDaddy/refs/heads/main/announcements.json',
  'https://fastly.jsdelivr.net/gh/techysy/CreditDaddy@main/announcements.json',
  'https://cdn.jsdelivr.net/gh/techysy/CreditDaddy@main/announcements.json',
  'https://gitee.com/techysy/CreditDaddy/raw/main/announcements.json',
];

function loadBundledAnnouncements() {
  try {
    const raw = JSON.parse(readFileSync(new URL('../announcements.json', import.meta.url), 'utf8'));
    return normalizeFeed(raw) || { items: [] };
  } catch {
    return { items: [] };
  }
}

const BUNDLED_ANNOUNCEMENTS = loadBundledAnnouncements();

export function normalizeFeed(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    ...data,
    items,
  };
}

export function createAnnouncementsService({
  bundledFeed = BUNDLED_ANNOUNCEMENTS,
  candidateUrls = ANNOUNCEMENTS_CANDIDATE_URLS,
  ttlMs = ANNOUNCEMENTS_CACHE_TTL_MS,
  timeoutMs = ANNOUNCEMENTS_FETCH_TIMEOUT_MS,
  fetchImpl = (...args) => globalThis.fetch(...args),
  nowFn = () => Date.now(),
} = {}) {
  const safeFallback = normalizeFeed(bundledFeed) || { items: [] };
  const memoryCache = {
    feed: safeFallback,
    fetchedAt: 0,
  };
  let inFlightPromise = null;

  async function fetchRemoteFeed() {
    if (inFlightPromise) return inFlightPromise;
    inFlightPromise = (async () => {
      const urls = (Array.isArray(candidateUrls) ? candidateUrls : []).filter(Boolean);
      for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!res || !res.ok) continue;
          const json = await res.json();
          const norm = normalizeFeed(json);
          if (norm && norm.items.length > 0) {
            memoryCache.feed = norm;
            memoryCache.fetchedAt = nowFn();
            return { ok: true, source: url, feed: memoryCache.feed };
          }
        } catch {
          // 单个源超时 / 网络错误 / 非法 JSON → 顺延下一个镜像源
        } finally {
          clearTimeout(timer);
        }
      }
      return { ok: false, source: 'bundled', feed: memoryCache.feed || safeFallback };
    })().finally(() => {
      inFlightPromise = null;
    });
    return inFlightPromise;
  }

  async function getAnnouncements({ check = false } = {}) {
    const isStale = memoryCache.fetchedAt === 0 || (nowFn() - memoryCache.fetchedAt > ttlMs);
    if (check) {
      await fetchRemoteFeed();
    } else if (isStale) {
      // 非阻塞后台刷新：先立即返回当前缓存 / 随包兜底数据
      fetchRemoteFeed().catch(() => {});
    }
    return memoryCache.feed || safeFallback;
  }

  function getState() {
    return {
      feed: memoryCache.feed,
      fetchedAt: memoryCache.fetchedAt,
      inFlight: Boolean(inFlightPromise),
    };
  }

  return {
    getAnnouncements,
    fetchRemoteFeed,
    getState,
  };
}

const defaultService = createAnnouncementsService();

export function getAnnouncements(opts) {
  return defaultService.getAnnouncements(opts);
}

export function getBundledAnnouncements() {
  return BUNDLED_ANNOUNCEMENTS;
}
