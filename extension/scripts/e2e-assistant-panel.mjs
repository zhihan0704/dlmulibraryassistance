import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
await stat(join(dist, 'service-worker.js'));
const tempRoot = join(root, '.release-tests');
await mkdir(tempRoot, {recursive: true});
const profile = await mkdtemp(join(tempRoot, 'assistant-edge-'));
const origin = 'https://seats.dlmu.edu.cn';
const roomId = 987654, roomName = '预约自习室';
const roomUrl = `${origin}/#/ic/seatPredetermine/${roomId}`;
const personalUrl = `${origin}/#/ic/userinfo`;
const seats = ['SYN-01', 'SYN-02', 'SYN-03'].map((seatCode, index) => ({roomId, seatCode, devId: 9900123 + index}));
const seatKey = seat => `${seat.roomId}/${seat.devId}/${seat.seatCode}`;
const beijingDate = days => new Date(Date.now() + 8 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const firstDay = beijingDate(2), secondDay = beijingDate(3);
const knownRecord = 'TEST-RECORD-ASSISTANT-001';
const discarded = 'test-private-response-field';
const schoolRequests = [];
const passes = [];
const panelErrors = [];
let reserveStatus = 200;
let changed = false;

const fixture = `<!doctype html><meta charset="utf-8"><title>合成学校页面</title>
<main id="fixture"></main><script>
const fixture = document.getElementById('fixture');
if (location.hash === '#/ic/userinfo') {
  fixture.innerHTML = ${JSON.stringify(`<table><thead><tr><th>预约编号</th><th>预约对象</th><th>预约时间</th><th>状态</th></tr></thead><tbody><tr><td>${knownRecord}</td><td>一楼 ${roomName} ${seats[0].seatCode}</td><td>开始: ${firstDay} 19:00 结束: ${firstDay} 20:00</td><td>审核通过</td></tr></tbody></table>`)};
} else {
  fixture.innerHTML = ${JSON.stringify(`<div class="seat"><h3>${roomName}</h3><div class="seat-area">${seats.map(seat => `<div class="draggable"><em>${seat.seatCode}</em></div>`).join('')}</div></div><button id="fixture-refresh">合成页面刷新座位</button>`)};
  async function readSeats() {
    const result = await fetch('/ic-web/reserve');
    await result.json();
    document.documentElement.dataset.fixtureLoaded = result.status;
  }
  document.getElementById('fixture-refresh').onclick = readSeats;
  void readSeats();
}
</script>`;

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run',
      '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
  });
  // All HTTP(S) is fulfilled locally or aborted. No fixture is forwarded to the school.
  await context.route(/^https?:\/\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname.endsWith('.dlmu.edu.cn')) schoolRequests.push({method: request.method(), origin: url.origin, path: url.pathname});
    if (request.method() !== 'GET' || url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html; charset=utf-8', body: fixture});
    if (url.pathname !== '/ic-web/reserve') return route.fulfill({status: 404, body: ''});
    const data = seats.map((seat, index) => ({roomId, roomName, devId: seat.devId, devName: seat.seatCode,
      coordinate: `${10 + index},20`, devStatus: 0, openState: 1, openStart: '18:00', openEnd: '22:00',
      resvInfo: index === 0 ? [{startTime: changed ? '19:45' : '19:30', endTime: '20:00', resvStatus: 0, trueName: discarded}] : []}));
    return route.fulfill({status: reserveStatus, json: reserveStatus === 200 ? {data} : {message: 'synthetic expired session'}});
  });
  return context;
}

async function openPanel(context) {
  const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension:')) ??
    await context.waitForEvent('serviceworker', {predicate: item => item.url().startsWith('chrome-extension:'), timeout: 15000});
  const panel = await context.newPage();
  panel.on('pageerror', error => panelErrors.push(error.message));
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidepanel/index.html`, {waitUntil: 'domcontentloaded'});
  await panel.locator('[data-preferences]').waitFor();
  return panel;
}

async function workerCall(panel, type, data = {}) {
  const reply = await panel.evaluate(message => chrome.runtime.sendMessage(message), {type: 'ASSISTANT_' + type, ...data});
  assert.equal(reply?.ok, true, reply?.error);
  return reply.data;
}

async function downloadJson(panel, selector) {
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.locator(selector).click()]);
  assert.equal(await download.failure(), null);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

async function submit(panel, value, expected) {
  await panel.locator('[data-preferences]').evaluate((form, submitter) => form.requestSubmit(form.querySelector(`button[value=${submitter}]`)), value);
  await panel.waitForFunction(text => document.querySelector('[data-assistant-feedback]').textContent === text, expected, {timeout: 10000});
}

async function fillTime(panel, date, start, end) {
  for (const [name, time] of Object.entries({start, end, from: '18:00', to: '22:00'})) {
    await panel.locator(`[data-preferences] [name=${name}]`).fill(`${date}T${time}`);
  }
}

let context;
try {
  context = await launch();
  const seatTab = await context.newPage();
  await seatTab.goto(roomUrl, {waitUntil: 'domcontentloaded'});
  await seatTab.locator('html[data-fixture-loaded="200"]').waitFor();
  let panel = await openPanel(context);
  await seatTab.bringToFront();
  const primarySelector = '[data-preferences] [name=primary]';
  await panel.waitForFunction(key => [...document.querySelector('[name=primary]').options].some(option => option.value === key), seatKey(seats[0]), {timeout: 15000});
  await panel.locator(primarySelector).selectOption(seatKey(seats[0]));
  for (const seat of seats.slice(1)) {
    await panel.locator('[data-preferences] [name=backup]').selectOption(seatKey(seat));
    await panel.locator('[data-add-seat]').click();
  }
  await panel.locator('[data-backups] li').nth(1).getByRole('button', {name: '上移'}).click();
  for (const option of ['adjust', 'fallback', 'shorten']) await panel.locator(`[data-preferences] [name=${option}]`).check();
  await panel.locator('[data-preferences] [name=minimum]').fill('30');
  await fillTime(panel, firstDay, '19:00', '20:00');
  await submit(panel, 'preferences', '已保存预约偏好。');
  const preferences = (await workerCall(panel, 'STATE')).preferences;
  assert.deepEqual(preferences.primarySeat, seats[0]);
  assert.deepEqual(preferences.backupSeats, [seats[2], seats[1]]);
  assert.equal(preferences.allowBackupSeats, true);
  assert.equal(preferences.allowShorter, true);
  await panel.locator('[data-analysis]').getByText(/待核验/).first().waitFor();
  assert.equal(await panel.locator('[data-analysis] article').count(), 0);
  passes.push('从合成座位页选择座位，保存偏好与备用顺序。空 resvInfo 和原始状态 0 维持待核验');

  await panel.locator('[data-preferences] details summary').click();
  await panel.locator('[data-preferences] [name=floor]').fill('一楼');
  await panel.locator('[data-preferences] [name=room]').fill(roomName);
  await panel.locator('[data-preferences] [name=priority]').selectOption('1');
  await panel.locator('[data-preferences] [name=reminder]').fill(`${firstDay}T18:30`);
  await submit(panel, 'plan', '已保存本机日期计划。');
  await fillTime(panel, secondDay, '20:00', '21:00');
  await panel.locator('[data-preferences] [name=priority]').selectOption('3');
  await panel.locator('[data-preferences] [name=reminder]').fill(`${secondDay}T18:30`);
  await submit(panel, 'plan', '已保存本机日期计划。');
  const firstPlan = panel.locator('[data-plans] article').filter({hasText: firstDay});
  const secondPlan = panel.locator('[data-plans] article').filter({hasText: secondDay});
  await firstPlan.waitFor();
  await secondPlan.waitFor();
  const plans = (await workerCall(panel, 'STATE')).plans;
  assert.deepEqual(plans.map(plan => [plan.preferences.date, plan.priority, plan.verification]), [[firstDay, 1, 'PENDING'], [secondDay, 3, 'PENDING']]);
  assert.equal(plans[0].preferences.preferred.startAt.slice(0, 16), `${firstDay}T19:00`);
  assert.equal(plans[1].preferences.preferred.startAt.slice(0, 16), `${secondDay}T20:00`);
  const alarms = await panel.evaluate(() => chrome.alarms.get('dlmu-assistant-plan-reminder'));
  assert.equal(alarms?.scheduledTime, Date.parse(`${firstDay}T18:30:00+08:00`));
  assert.equal(alarms.periodInMinutes, undefined);
  passes.push('两日计划、各自时段和优先级独立保存，注册最早的单次提醒');

  const personal = await context.newPage();
  await personal.goto(personalUrl, {waitUntil: 'load'});
  await personal.locator('tbody tr').waitFor();
  await seatTab.bringToFront();
  await firstPlan.getByRole('button', {name: '核对学校预约'}).click();
  await firstPlan.getByText(/官方个人页已核验/).waitFor();
  await secondPlan.getByRole('button', {name: '核对学校预约'}).click();
  await secondPlan.getByText(/未取得唯一匹配/).waitFor();
  passes.push('合成个人预约唯一匹配通过，只核对匹配日期，其他日期仍待核对');
  await personal.close();

  changed = true;
  await seatTab.locator('#fixture-refresh').click();
  await panel.locator('[data-log-seat]').fill(seats[0].seatCode);
  await panel.locator('[data-query]').click();
  await panel.waitForFunction(async seat => {
    const reply = await chrome.runtime.sendMessage({type: 'ASSISTANT_EVENTS', filter: {seat}});
    return reply?.ok && reply.data.some(event => event.eventType === 'TIME_CHANGED');
  }, seats[0].seatCode, {timeout: 10000, polling: 100});
  await seatTab.locator('#fixture-refresh').click();
  await panel.waitForFunction(async () => {
    const reply = await chrome.runtime.sendMessage({type: 'ASSISTANT_EVENTS'});
    return reply?.ok && reply.data.filter(event => event.eventType === 'DATA_CAPTURED' && event.source === 'NETWORK').length >= 3;
  }, null, {timeout: 10000, polling: 100});
  const logs = await downloadJson(panel, '[data-export-events]');
  assert.equal(logs.filter(event => event.eventType === 'TIME_CHANGED').length, 1);
  assert.ok(logs.every(event => event.relatedSeat?.seatCode === seats[0].seatCode && event.timestamp.endsWith('+08:00')));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${knownRecord}|${discarded}`));
  await panel.locator('#assistant-logs details summary').click();
  const backup = await downloadJson(panel, '[data-export-config]');
  assert.equal(backup.kind, 'DLMU_ASSISTANT_CONFIG');
  assert.equal(backup.sha256, createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex'));
  assert.equal(backup.payload.plans.length, 2);
  assert.ok(backup.payload.plans.every(plan => !Object.hasOwn(plan, 'verification')));
  assert.doesNotMatch(JSON.stringify(backup), new RegExp(`${knownRecord}|${discarded}`));
  passes.push('同一座位时段变化只记一次，筛选日志和配置备份可下载，导出不含预约编号或响应身份字段');

  reserveStatus = 401;
  await seatTab.bringToFront();
  await seatTab.locator('#fixture-refresh').click();
  await seatTab.locator('html[data-fixture-loaded="401"]').waitFor();
  await panel.locator('[data-health][data-state="SESSION_LOST"]').waitFor();
  const paused = await workerCall(panel, 'STATE');
  assert.equal(paused.health.session, 'SESSION_LOST');
  assert.equal(paused.seats.length, 0);
  assert.equal(paused.analysis.state, 'NEEDS_REVIEW');
  assert.equal(paused.plans.length, 2);
  passes.push('合成 401 触发等待人工登录，拒用旧座位数据，保留两日计划');

  await context.close();
  context = await launch();
  panel = await openPanel(context);
  await panel.locator('[data-plans] article').filter({hasText: secondDay}).waitFor();
  const restored = await workerCall(panel, 'STATE');
  assert.deepEqual(restored.preferences, preferences);
  assert.equal(restored.plans.length, 2);
  assert.equal(restored.analysis.state, 'NEEDS_REVIEW');
  assert.equal(restored.health.session, 'SESSION_LOST');
  assert.deepEqual(panelErrors, []);
  assert.ok(schoolRequests.filter(request => request.path === '/ic-web/reserve').length >= 4);
  assert.ok(schoolRequests.every(request => request.method === 'GET' && request.origin === origin && ['/', '/ic-web/reserve', '/favicon.ico'].includes(request.path)));
  passes.push('隔离 Edge 配置重启后恢复计划，等待新证据。学校 URL 全部本地拦截且只产生合成 GET');
  console.log(passes.join('\n'));
} finally {
  await context?.close().catch(() => {});
  const resolvedRoot = await realpath(tempRoot);
  const resolvedProfile = await realpath(profile);
  const child = relative(resolvedRoot, resolvedProfile);
  if (child.startsWith('assistant-edge-') && !child.includes('..') && !child.includes(sep) && !isAbsolute(child)) {
    await rm(resolvedProfile, {recursive: true, force: true});
  }
}
