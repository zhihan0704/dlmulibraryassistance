import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = join(root, '.release-tests');
const origin = 'https://assistant-storage-fixture.invalid';
const bundle = await build({
  stdin: {
    resolveDir: root,
    contents: `export {AssistantRepository} from './src/storage/assistant-repository';
      export {DailyBookingRepository} from './src/storage/daily-booking-db';
      export {createRuntimeEvent} from './src/core/runtime-health';`,
  },
  bundle: true,
  format: 'iife',
  globalName: 'StorageFixture',
  write: false,
});
await mkdir(tempRoot, {recursive: true});
const profile = await mkdtemp(join(tempRoot, 'assistant-storage-'));

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-first-run'],
  });
  await context.route(/^https?:\/\//, route => new URL(route.request().url()).origin === origin
    ? route.fulfill({contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>合成本地存储测试</title>'})
    : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  await page.addScriptTag({content: bundle.outputFiles[0].text});
  const assertions = await page.evaluate(async () => {
    const {AssistantRepository, DailyBookingRepository, createRuntimeEvent} = StorageFixture;
    const databaseName = 'dlmu-daily-booking-v2-fixture';
    const now = Date.now();
    const checks = [];
    function check(condition, message) { if (!condition) throw Error(message); checks.push(message); }
    async function rejects(operation) { try { await operation(); return false; } catch { return true; } }
    function idbRequest(value) { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
    const config = {enabled: true, mode: 'ASSISTED', target: {floorName: '一楼', roomName: '合成区域', seatCode: 'D1-01', roomId: '12', seatId: '34', startTime: '17:30', endTime: '21:15', dayOffset: 1}};
    const result = {phase: 'OPEN', day: '2026-11-06', targetDate: '2026-11-07', at: now - 1000, message: '合成旧任务结果'};
    const oldState = {id: 'daily-fixed-seat', revision: 'fixture-v1', config, result};
    const claimKey = '2026-11-06|fixture|OPEN';
    const oldClaim = {id: claimKey, token: 'fixture-lease', until: now - 1};
    async function seedV1(name) {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const state = open.result.createObjectStore('state', {keyPath: 'id'});
        state.add(oldState);
        state.add({id: 'daily-session', lostAt: now - 5000});
        open.result.createObjectStore('claims', {keyPath: 'id'}).add(oldClaim);
      };
      return idbRequest(open);
    }

    (await seedV1(databaseName)).close();
    const daily = new DailyBookingRepository(databaseName);
    const assistant = new AssistantRepository(databaseName);
    const upgraded = await daily.get();
    const db = await idbRequest(indexedDB.open(databaseName));
    const migratedClaim = await idbRequest(db.transaction('claims').objectStore('claims').get(claimKey));
    check(db.version === 2 && ['state', 'claims', 'assistant-settings', 'assistant-plans', 'runtime-health', 'runtime-events', 'runtime-dedup'].every(name => db.objectStoreNames.contains(name)), '真实 IndexedDB v1 → v2 只增加存储');
    db.close();
    check(JSON.stringify(upgraded.config) === JSON.stringify(config) && JSON.stringify(upgraded.result) === JSON.stringify(result) && upgraded.session.lostAt === now - 5000 && JSON.stringify(migratedClaim) === JSON.stringify(oldClaim), '保留 2.1 固定座位、历史结果、认证门控和领取记录');
    check(await assistant.getPreferences() === null && !await assistant.getNotificationsEnabled(), '新偏好保持未设置，新通知默认关闭');
    await daily.confirmSession(now - 5000, now - 1000);
    const revision = (await daily.get()).revision;
    const claim = await daily.claim(revision, claimKey, now);
    const replay = await daily.finish(revision, claimKey, claim, result, now, true);
    check(replay.saved && !replay.reminder, '迁移前不确定的旧提醒不会重复发送');

    const seat = {roomId: 12, devId: 34, seatCode: 'D1-01'};
    function preferences(date) {
      const preferred = {startAt: `${date}T17:30:00+08:00`, endAt: `${date}T21:15:00+08:00`};
      return {date, primarySeat: seat, backupSeats: [], preferred, allowedWindow: preferred, minDurationMinutes: 60,
        preferLonger: true, allowTimeAdjustment: false, allowBackupSeats: false, allowShorter: false};
    }
    const first = await assistant.savePlan({preferences: preferences('2026-11-07'), verification: 'VERIFIED', roomName: '合成区域', floorName: '一楼'});
    await assistant.savePlan({preferences: preferences('2026-11-08'), priority: 1});
    await assistant.savePreferences({...preferences('2026-11-07'), Cookie: 'fixture-credential'});
    check(first.verification === 'PENDING' && (await assistant.listPlans()).map(plan => plan.id).join(',') === 'plan:2026-11-07,plan:2026-11-08', '多日期任务互不覆盖，用户输入不能标记已核验');
    check(await assistant.setPlanVerification(first.id, first.revision, 'VERIFIED', new Date(now).toISOString()), '当前计划版本接受可信本地核验');
    const edited = await assistant.savePlan({preferences: preferences('2026-11-07'), priority: 3});
    check(edited.verification === 'PENDING' && !await assistant.setPlanVerification(first.id, first.revision, 'VERIFIED', new Date(now).toISOString()), '计划编辑重置核验并拒绝旧版本回写');

    const backup = await assistant.exportConfig();
    check(!/fixture-credential|verification|observedAt|revision/.test(JSON.stringify(backup)), '配置导出仅含偏好、计划设置和提醒开关');
    const restored = new AssistantRepository(databaseName + '-restore');
    check(await rejects(() => restored.restoreConfig({...backup, sha256: '0'.repeat(64)})) && (await restored.listPlans()).length === 0, '损坏备份拒绝且不会部分写入');
    await restored.restoreConfig(backup);
    check((await restored.listPlans()).length === 2 && (await restored.getPreferences()).primarySeat.seatCode === 'D1-01', '完整性校验后恢复不同日期计划和偏好');

    const event = () => createRuntimeEvent({eventType: 'TIME_CHANGED', timestamp: now, source: 'NETWORK', relatedSeat: seat, relatedTask: 'plan:2026-11-07'});
    const inserted = await Promise.all([assistant.appendEvent({...event(), description: 'Bearer fixture-secret', Cookie: 'fixture-header'}, 'time:fixture'), assistant.appendEvent(event(), 'time:fixture')]);
    const events = await assistant.listEvents({date: event().timestamp.slice(0, 10), seat, task: 'plan:2026-11-07'});
    check(inserted.filter(Boolean).length === 1 && events.length === 1 && !/Bearer|fixture-secret|fixture-header/.test(JSON.stringify(await assistant.exportEvents())), '并发事件原子去重，按北京时间、座位和任务筛选并过滤原始字段');
    const oldEvent = createRuntimeEvent({eventType: 'TIME_CHANGED', timestamp: now - 31 * 86_400_000, source: 'NETWORK'});
    check(!await assistant.appendEvent(oldEvent) && (await assistant.listEvents()).length === 1, '拒绝超出保留期限的历史日志');
    check(!await assistant.claimNotification('fixture-notification', now), '默认不领取通知');
    await assistant.setNotificationsEnabled(true);
    const notifications = await Promise.all([assistant.claimNotification('fixture-notification', now), assistant.claimNotification('fixture-notification', now)]);
    await assistant.clearEvents();
    check(notifications.filter(Boolean).length === 1 && !await assistant.claimNotification('fixture-notification', now) && (await assistant.listEvents()).length === 0, '并发通知仅领取一次，清理日志后仍保持去重');

    const snapshot = {capturedAt: new Date(now).toISOString(), route: '#/ic/seatPredetermine/12', seatCount: 152, source: 'NETWORK'};
    await assistant.saveHealth({...snapshot, token: 'fixture-token'});
    check(!await assistant.saveHealth({...snapshot, capturedAt: new Date(now - 2000).toISOString(), seatCount: 1}) && (await assistant.getHealth()).seatCount === 152 && !JSON.stringify(await assistant.getHealth()).includes('fixture-token'), '仅保留最新有效健康摘要，旧观察和原始字段无法覆盖');

    const blockedName = databaseName + '-blocked';
    const old = await seedV1(blockedName);
    const blocked = new AssistantRepository(blockedName);
    check(await rejects(() => blocked.getPreferences()) && old.version === 1 && (await idbRequest(old.transaction('state').objectStore('state').get('daily-fixed-seat'))).revision === 'fixture-v1', '版本升级受旧连接阻塞时保留原库');
    old.close();
    check(await blocked.getPreferences() === null && (await new DailyBookingRepository(blockedName).get()).config.target.seatCode === 'D1-01', '关闭旧连接后可重试迁移');

    await assistant.clearAssistantData();
    check((await assistant.listPlans()).length === 0 && (await daily.get()).config.target.seatCode === 'D1-01', '清除 2.2 数据不删除每日旧任务');
    return checks;
  });
  console.log(assertions.join('\n'));
  console.log(`通过 ${assertions.length} 项合成 IndexedDB 断言`);
} finally {
  await context?.close().catch(() => {});
  const [base, disposable] = await Promise.all([realpath(tempRoot), realpath(profile)]);
  const child = relative(base, disposable);
  if (child.startsWith('assistant-storage-') && !child.includes('..') && !isAbsolute(child)) await rm(disposable, {recursive: true, force: true});
}
