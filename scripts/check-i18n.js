#!/usr/bin/env node
/**
 * CreditDaddy i18n 漏网检查（词典差集扫描）
 *
 * 规则：任何用户可见的中文字符串都必须作为 key 存在于 src/i18n/*.json 四份词典里——
 *   - 服务端：logger 消息模板（含/不含 args 都经 t() 渲染）、面板经 T() 渲染的状态/错误/额度标签
 *   - 面板：markup 文本节点、title/placeholder/data-i18n 属性、脚本里经 T() 的动态串
 *
 * 用法：node scripts/check-i18n.js [--full]
 *   --full  打印每条缺失的完整原文（默认截断 120 字）
 * 退出码：有缺失 = 1，全部覆盖 = 0。CI / 发版检查可挂。
 *
 * 明确豁免（不是漏网）：
 *   - bin/creditdaddy.js —— CLI 终端输出固定简中，不取经 t()，不在面板/日志 i18n 范围
 *   - 语言切换按钮「简 / 繁 / 日」——语言名永远显示母语
 *   - 产品线拉丁名（ZCode / mirasim / Trae / MiniMax …）——品牌名各语言一致，不做词条
 *   - 「本版主题：」——desktop changelog-brief 解析 CHANGELOG 用的锚点串，不是 UI 文案
 *   - 「妙手.exe」——进程名匹配的静态比对串，不展示
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL = process.argv.includes('--full');
const CJK = /[一-鿿]/;
const EXEMPT = new Set([
  '简', '繁', '日',
  '妙手.exe',        // 进程名匹配用的内部串,不展示
  '本版主题：', '本版主题:',   // desktop changelog-brief 的 CHANGELOG 解析锚点(全/半角两种冒号),不是 UI 文案
]);

const locales = ['en', 'ja', 'ko', 'zh-TW'];
const dicts = Object.fromEntries(locales.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n', l + '.json'), 'utf8'))]));
const enKeys = new Set(Object.keys(dicts.en));
let bad = 0;

// ── 1. 四份词典 key 集合一致性（加词条必须四份同步，漏一份就会在该语言回退中文） ──
for (const l of ['ja', 'ko', 'zh-TW']) {
  const ks = new Set(Object.keys(dicts[l]));
  const diff = [...enKeys].filter((k) => !ks.has(k)).concat([...ks].filter((k) => !enKeys.has(k)).map((k) => `(${l} 多出) ${k}`));
  if (diff.length) { bad++; console.log(`✗ 词典 key 集不一致 en vs ${l}（${diff.length}）:`); for (const k of diff.slice(0, 20)) console.log(`    ${JSON.stringify(k).slice(0, 100)}`); }
}

// ── 2. 注释/正则感知的 JS 字符串字面量提取 ──
function* extractLiterals(src) {
  let st = 'code', quote = '', buf = '', line = 1, startLine = 1, depth = 0, hasInterp = false, inClass = false, prevToken = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') line++;
    if (st === 'line') { if (c === '\n') st = 'code'; continue; }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; i++; } continue; }
    if (st === 'regex') {
      if (c === '\\') { i++; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c === ']') { inClass = false; continue; }
      if (c === '/' && !inClass) { st = 'code'; prevToken = '/'; continue; }
      if (c === '\n') st = 'code';   // 兜底：正则不允许裸换行
      continue;
    }
    if (st === 'str') {
      if (c === '\\') {
        // 按 JS 语义解码常见转义,使提取出的字面量 == 运行时串(与词典 key 可比)
        if (n === 'n') { buf += '\n'; i++; continue; }
        if (n === 'r') { buf += '\r'; i++; continue; }
        if (n === 't') { buf += '\t'; i++; continue; }
        if (n === '\\' || n === "'" || n === '"' || n === '`') { buf += n; i++; continue; }
        buf += c + (n || ''); i++; continue;
      }
      if (c === quote) { st = 'code'; prevToken = quote; if (!hasInterp && CJK.test(buf)) yield { text: buf, line: startLine }; continue; }
      if (quote === '`' && c === '$' && n === '{') { hasInterp = true; st = 'code'; depth = 1; i++; continue; }
      buf += c; continue;
    }
    if (c === '/' && n === '/') { st = 'line'; i++; continue; }
    if (c === '/' && n === '*') { st = 'block'; i++; continue; }
    if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) st = 'str'; }
      continue;
    }
    // / 开头：上一个 token 不是操作数结尾（标识符/数字/)/]/引号/`）→ 判定为正则字面量
    if (c === '/' && !/[A-Za-z0-9_$)\]}"'`]/.test(prevToken) && prevToken !== '/') { st = 'regex'; inClass = false; continue; }
    if (c === "'" || c === '"' || c === '`') { st = 'str'; quote = c; buf = ''; startLine = line; hasInterp = false; continue; }
    if (!/\s/.test(c)) prevToken = c;
  }
}

const missing = new Map();   // text → Set("file:line")
function addMiss(file, line, text) {
  if (EXEMPT.has(text)) return;
  if (!missing.has(text)) missing.set(text, new Set());
  missing.get(text).add(`${file}:${line}`);
}

function scanJs(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const { text, line } of extractLiterals(src)) if (!enKeys.has(text)) addMiss(rel, line, text);
}

function scanPanel(rel) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lineNo = (idx) => html.slice(0, idx).split(/\r?\n/).length;
  const mask = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '));
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const m of mask.matchAll(/>([^<>]*[一-鿿][^<>]*)</g)) {
    const t = norm(m[1]);
    if (t && !enKeys.has(t)) addMiss(rel, lineNo(m.index), t);
  }
  for (const m of mask.matchAll(/(title|placeholder|data-i18n)\s*=\s*(['"])((?:\\.|(?!\2).)*?[一-鿿](?:\\.|(?!\2).)*?)\2/gs)) {
    if (!enKeys.has(m[3])) addMiss(rel, lineNo(m.index), m[3]);
  }
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const base = lineNo(m.index);
    for (const { text, line } of extractLiterals(m[1])) if (!enKeys.has(text)) addMiss(rel, base + line - 1, text);
  }
}

for (const f of fs.readdirSync(path.join(ROOT, 'src'))) if (f.endsWith('.js')) scanJs('src/' + f);
scanPanel('src/panel.html');
scanJs('desktop/main.js');   // 桌面壳:与 daemon 共用词典(Tt 包装),同在门禁内

for (const [text, locs] of missing) {
  bad++;
  const t = FULL ? JSON.stringify(text) : JSON.stringify(text.length > 120 ? text.slice(0, 120) + '…' : text);
  console.log(`✗ ${t}\n    @ ${[...locs].slice(0, 5).join(', ')}`);
}
console.log(missing.size ? `\n词典外中文用户面字符串 ${missing.size} 条（--full 看全文）` : '✓ src 运行时与面板全部覆盖（豁免见文件头注释）');
process.exit(missing.size || bad ? 1 : 0);
