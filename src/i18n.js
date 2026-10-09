/** 轻量国际化:以中文原文为 key,缺翻译时回退中文。字典位于 src/i18n/<locale>.json。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n');
const cache = new Map();

export function normalizeLocale(v) {
  const s = String(v || '').trim();
  return LOCALES.includes(s) ? s : 'zh-CN';
}

function dictFor(locale) {
  if (locale === 'zh-CN') return {};
  if (!cache.has(locale)) {
    try {
      cache.set(locale, JSON.parse(fs.readFileSync(path.join(DIR, `${locale}.json`), 'utf8')));
    } catch {
      cache.set(locale, {});
    }
  }
  return cache.get(locale);
}

export async function loadDict(locale) {
  return dictFor(normalizeLocale(locale));
}

let current = 'zh-CN';

export function setLocale(v) {
  current = normalizeLocale(v);
}

export function getLocale() {
  return current;
}

/** t('已连接 {n} 个账号', { n: 2 }) → 按当前语言取译文,再替换 {占位符} */
export function t(text, vars) {
  const s = dictFor(current)[text] ?? text;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
