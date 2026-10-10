/**
 * logger 结构化归档（JSONL 副行）回归：
 * - 每条日志双写人类可读 .log 与结构化 .jsonl（key+args 原样落盘）
 * - readArchiveJsonl 按当前语言重渲染——历史上写入的行也能切语言（本项目 i18n 设计目标）
 * - closeArchiveStream 同时 gzip 两份，原始文件截断为 0（不删除，见 logger.js 注释）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-logger-test-'));
process.env.CREDITDADDY_HOME = HOME;

const i18n = await import('../src/i18n.js');
const { logger, getLogs, readArchiveJsonl, closeArchiveStream } = await import('../src/logger.js');

const today = () => new Date().toISOString().slice(0, 10);
const jf = () => path.join(HOME, 'logs', `daemon-${today()}.jsonl`);
const lf = () => path.join(HOME, 'logs', `daemon-${today()}.log`);

test('写入：log 与 jsonl 双写，jsonl 保留 key+args', async () => {
  logger.info('TEST', '{label} 领取成功 +{amount} Credits', { label: '[WorkBuddy 国内版] 1698', amount: 100 });
  await new Promise((r) => setTimeout(r, 300)); // 写流是异步的，等 flush 完成再断言文件

  assert.ok(fs.existsSync(lf()), '人类可读 .log 应存在');
  assert.ok(fs.existsSync(jf()), '结构化 .jsonl 应存在');
  const logLine = fs.readFileSync(lf(), 'utf8').trim();
  assert.match(logLine, /\[TEST\] \[WorkBuddy 国内版\] 1698 领取成功 \+100 Credits/);
  const row = JSON.parse(fs.readFileSync(jf(), 'utf8').trim().split('\n').at(-1));
  assert.equal(row.key, '{label} 领取成功 +{amount} Credits');
  assert.deepEqual(row.args, { label: '[WorkBuddy 国内版] 1698', amount: 100 });
  assert.equal(row.msg, '[WorkBuddy 国内版] 1698 领取成功 +100 Credits');
});

test('readArchiveJsonl：历史上写入的行按当前语言重渲染', async () => {
  i18n.setLocale('en');
  const rows = readArchiveJsonl();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].msg, '[WorkBuddy China] 1698 claimed +100 Credits');

  i18n.setLocale('ja');
  const rows2 = readArchiveJsonl();
  assert.equal(rows2[0].msg, '[WorkBuddy 中国版] 1698 受け取り成功 +100 Credits');
  i18n.setLocale('zh-CN');
});

test('closeArchiveStream：双文件 gzip + 原文件截断为 0', async () => {
  logger.info('TEST', 'close-test');
  await closeArchiveStream();
  assert.ok(fs.existsSync(lf() + '.gz'), '.log.gz 应生成');
  assert.ok(fs.existsSync(jf() + '.gz'), '.jsonl.gz 应生成');
  assert.equal(fs.statSync(lf()).size, 0, '.log 原文件应被截断而不是删除');
  assert.equal(fs.statSync(jf()).size, 0, '.jsonl 原文件应被截断而不是删除');

  // 截断后仍应能从 .jsonl.gz 读到历史
  const rows = readArchiveJsonl();
  assert.equal(rows.length, 2);
});
