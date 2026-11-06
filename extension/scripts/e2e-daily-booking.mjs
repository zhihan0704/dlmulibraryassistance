import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, rm, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
await stat(join(dist, 'service-worker.js'));
const tempRoot = join(root, '.release-tests');
await mkdir(tempRoot, {recursive: true});
const profile = await mkdtemp(join(tempRoot, 'daily-edge-'));
const origin = 'https://seats.dlmu.edu.cn';
const roomId = 987654;
const devId = 9900123;
const seatCode = 'D1-01';
const roomName = '预约自习室';
const roomUrl = `${origin}/#/ic/seatPredetermine/${roomId}`;
const alarmPrefix = 'dlmu-daily:';
const phases = {PREPARE: '07:55:00', OPEN: '08:00:00', VERIFY: '08:01:00'};
const requests = [];
const passed = [];

const fixture = `<!doctype html><meta charset="utf-8"><title>合成座位页</title>
<main class="seat"><h3>${roomName}</h3><div class="seat-area"><div class="draggable"><em>${seatCode}</em></div></div></main>
<script>fetch('/ic-web/reserve').then(response => response.json()).then(() => { document.documentElement.dataset.fixtureLoaded = 'yes'; });</script>`;
const seatResponse = {data: [{devId, devName: seatCode, roomId, roomName, coordinate: '10,20', devStatus: 1, openState: 1, resvInfo: []}]};

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
  });
  // Every web request is intercepted before opening the fixture. No request is forwarded.
  await context.route(/^https?:\/\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname.endsWith('.dlmu.edu.cn')) requests.push({method: request.method(), origin: url.origin, path: url.pathname});
    if (request.method() !== 'GET' || url.origin !== origin) return route.abort();
    if (url.pathname === '/ic-web/reserve') return route.fulfill({json: seatResponse});
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html; charset=utf-8', body: fixture});
    return route.fulfill({status: 404, body: ''});
  });
  return context;
}

async function openPanel(context) {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 15000});
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidepanel/index.html`, {waitUntil: 'domcontentloaded'});
  await panel.locator('[data-daily-summary]').waitFor();
  return panel;
}

function readState(panel) {
  return panel.evaluate(() => chrome.runtime.sendMessage({type: 'DAILY_GET'}));
}

async function submitForm(panel, official, code) {
  const form = panel.locator('[data-daily-form]');
  await form.locator('[name="seatCode"]').fill(code);
  await official.bringToFront();
  // The Side Panel document is hosted in a tab in this harness. Keep the fixture tab active.
  await form.evaluate(node => node.requestSubmit());
}

async function dailyAlarms(panel) {
  return panel.evaluate(async prefix => (await chrome.alarms.getAll()).filter(alarm => alarm.name.startsWith(prefix)), alarmPrefix);
}

async function assertAlarmSchedule(panel, enabledAt) {
  await panel.waitForFunction(async prefix => (await chrome.alarms.getAll()).filter(alarm => alarm.name.startsWith(prefix)).length === 3, alarmPrefix, {polling: 100});
  const alarms = await dailyAlarms(panel);
  assert.deepEqual(alarms.map(alarm => alarm.name.split(':')[1]).sort(), Object.keys(phases).sort());
  for (const alarm of alarms) {
    const [, phase, day] = alarm.name.split(':');
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(alarm.scheduledTime, Date.parse(`${day}T${phases[phase]}+08:00`));
    assert.ok(alarm.scheduledTime > enabledAt);
    assert.equal(alarm.periodInMinutes, undefined);
  }
  const open = alarms.find(alarm => alarm.name.startsWith(`${alarmPrefix}OPEN:`));
  const day = open.name.split(':')[2];
  const targetDate = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const reply = await readState(panel);
  assert.equal(reply.next.target.date, targetDate);
  assert.equal(reply.next.target.startAt, `${targetDate}T17:30:00+08:00`);
  assert.equal(reply.next.target.endAt, `${targetDate}T21:15:00+08:00`);
  return alarms;
}

let context;
try {
  context = await launch();
  const official = await context.newPage();
  await official.goto(roomUrl, {waitUntil: 'domcontentloaded'});
  await official.locator('html[data-fixture-loaded="yes"]').waitFor();
  let panel = await openPanel(context);
  await panel.waitForFunction(async ({roomName, seatCode, devId}) => {
    try {
      const [tab] = await chrome.tabs.query({url: 'https://seats.dlmu.edu.cn/*'});
      const result = await chrome.tabs.sendMessage(tab.id, {type: 'READ_DAILY_SEAT', roomName, seatCode});
      return result?.seat?.seatId === String(devId);
    } catch { return false; }
  }, {roomName, seatCode, devId}, {timeout: 15000, polling: 100});
  passed.push('Edge 内容脚本从合成 GET 响应与座位 DOM 取得一致的区域和座位标识');

  const form = panel.locator('[data-daily-form]');
  await form.locator('[name="startTime"]').fill('17:30');
  await form.locator('[name="endTime"]').fill('21:15');
  await submitForm(panel, official, 'D1-02');
  await panel.waitForFunction(() => document.querySelector('[data-daily-error]').textContent.includes('核对区域和编号'), null, {polling: 100});
  assert.equal((await readState(panel)).state, undefined);
  passed.push('表单填写的座位与合成学校页面不匹配时拒绝绑定');

  await submitForm(panel, official, seatCode);
  await panel.waitForFunction(code => document.querySelector('[data-daily-summary]').textContent.includes(code), seatCode, {polling: 100});
  const bound = (await readState(panel)).state;
  assert.equal(bound.config.mode, 'ASSISTED');
  assert.equal(bound.config.enabled, false);
  assert.deepEqual(bound.config.target, {floorName: '一楼', roomName, seatCode, roomId: String(roomId), seatId: String(devId), startTime: '17:30', endTime: '21:15', dayOffset: 1});
  passed.push('侧边栏保存精确楼层、区域、座位及使用时段，并保持辅助模式');

  await panel.bringToFront();
  const enabledAt = Date.now();
  await panel.locator('[data-daily-toggle]').click();
  await assertAlarmSchedule(panel, enabledAt);
  passed.push('启用后登记三个北京时间单次闹钟，下次预约使用日期为闹钟日期的次日');

  // Clear the test profile's alarm registrations, then prove startup rebuilds them from persisted config.
  await panel.evaluate(async prefix => {
    for (const alarm of await chrome.alarms.getAll()) if (alarm.name.startsWith(prefix)) await chrome.alarms.clear(alarm.name);
  }, alarmPrefix);
  assert.equal((await dailyAlarms(panel)).length, 0);
  await context.close();
  const restartedAt = Date.now();
  context = await launch();
  panel = await openPanel(context);
  await panel.waitForFunction(() => document.querySelector('[data-daily-toggle]').textContent === '暂停每日提醒', null, {polling: 100});
  const restored = (await readState(panel)).state;
  assert.deepEqual(restored.config, {...bound.config, enabled: true});
  await assertAlarmSchedule(panel, restartedAt);
  passed.push('同一 Edge 测试配置重启后恢复绑定，并重建已经清除的闹钟');

  await panel.locator('[data-daily-toggle]').click();
  await panel.waitForFunction(() => document.querySelector('[data-daily-toggle]').textContent === '启用每日提醒', null, {polling: 100});
  assert.equal((await readState(panel)).state.config.enabled, false);
  assert.equal((await dailyAlarms(panel)).length, 0);
  passed.push('暂停后配置保留，三个每日闹钟全部清除');
  assert.ok(requests.some(request => request.path === '/ic-web/reserve'));
  assert.ok(requests.every(request => request.method === 'GET' && request.origin === origin));
  passed.push('全部学校请求在本地拦截，流程没有发出非 GET 请求');
  console.log(passed.join('\n'));
} finally {
  await context?.close().catch(() => {});
  const resolvedRoot = await realpath(tempRoot);
  const resolvedProfile = await realpath(profile);
  const child = relative(resolvedRoot, resolvedProfile);
  if (child.startsWith('daily-edge-') && !child.includes('..') && !isAbsolute(child)) {
    await rm(resolvedProfile, {recursive: true, force: true});
  }
}
