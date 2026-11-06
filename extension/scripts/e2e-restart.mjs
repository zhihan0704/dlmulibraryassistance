#!/usr/bin/env node
/**
 * 端到端验证：浏览器重启后，本地任务是否恢复、Service Worker 是否重建。
 *
 * 做法：用同一个持久化 profile 启动两次 Edge。
 * 第一次通过侧边栏 UI 创建一个「模拟任务」，然后完全关闭浏览器；
 * 第二次重新启动，检查任务仍在、Service Worker 重新注册。
 *
 * 不访问真实站点，不创建任何真实预约。只操作本地模拟任务。
 *
 * 用法：node scripts/e2e-restart.mjs
 * 退出码：0 通过；1 失败。
 */
import {chromium} from 'playwright-core';
import {mkdtemp, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({name, pass, detail});
  console.log(`${pass ? '  ✔' : '  ✘'} ${name}${detail ? ' — ' + detail : ''}`);
};

const base = await mkdtemp(join(tmpdir(), 'lsa-restart-'));
const profile = join(base, 'profile');
await mkdir(profile, {recursive: true});

async function launch() {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
  });
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker', {timeout: 20000}).catch(() => null);
  return {ctx, worker};
}

async function panelPage(ctx, worker) {
  const extId = new URL(worker.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(500);
  return page;
}

// 明天的固定时刻，保证任务在测试期间不会到期执行
const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
const pad = (n) => String(n).padStart(2, '0');
const ymd = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
const whenValue = `${ymd}T09:00`;

let created = null;
let first;
try {
  first = await launch();
  check('第一次启动：Service Worker 注册', Boolean(first.worker), first.worker?.url() ?? '未捕获');

  const page = await panelPage(first.ctx, first.worker);
  check('第一次启动：侧边栏可打开', (await page.title()).includes('海大图书馆预约助手'));

  await page.locator('.legacy-tools > summary').click();
  await page.fill('#date', ymd);
  await page.fill('#start', '09:00');
  await page.fill('#end', '10:00');
  await page.fill('#when', whenValue);
  await page.locator('form .primary').click();
  await page.waitForTimeout(900);

  const taskText = await page.locator('#tasks').innerText();
  check('第一次启动：任务创建成功', taskText.includes('模拟预约'), taskText.split('\n')[0]);
  const errText = await page.locator('#error').innerText().catch(() => '');
  check('第一次启动：无表单错误', errText.trim() === '', errText.trim());

  created = taskText.split('\n').find((l) => l.includes('模拟预约')) ?? null;
} catch (e) {
  check('第一次启动流程未抛异常', false, e.message);
} finally {
  if (first) await first.ctx.close().catch(() => {});
}

// 完全关闭后再启动，模拟「浏览器重启」
let second;
try {
  second = await launch();
  check('第二次启动：Service Worker 重建', Boolean(second.worker), second.worker?.url() ?? '未捕获');

  const page = await panelPage(second.ctx, second.worker);
  await page.locator('.legacy-tools > summary').click();
  await page.waitForTimeout(600);
  const taskText = await page.locator('#tasks').innerText();
  check('重启后任务仍存在', taskText.includes('模拟预约'), taskText.split('\n')[0] ?? '(空)');
  check('重启后任务内容一致', created ? taskText.includes(created) : false, created ?? '(无基线)');

  const stored = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const tasks = all['lsa.tasks.v1'] ?? [];
    return {count: tasks.length, statuses: tasks.map((t) => t.status)};
  });
  check('存储中任务数 = 1', stored.count === 1, JSON.stringify(stored));
  check('任务状态为 WAITING（未误执行）', stored.statuses?.[0] === 'WAITING', JSON.stringify(stored.statuses));
} catch (e) {
  check('第二次启动流程未抛异常', false, e.message);
} finally {
  if (second) await second.ctx.close().catch(() => {});
  await rm(base, {recursive: true, force: true}).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length - failed.length}/${results.length} 项通过 ====`);
if (failed.length) {
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
  process.exit(1);
}
