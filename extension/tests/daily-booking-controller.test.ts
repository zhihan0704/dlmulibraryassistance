import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {installDailyBookingController} from '../src/background/daily-booking-controller';
import {getDailySchedule, type DailyBookingConfig} from '../src/core/daily-booking-scheduler';
import type {DailySessionGate, DailyState} from '../src/storage/daily-booking-db';

const origin = 'https://seats.dlmu.edu.cn';
const panelUrl = 'chrome-extension://fixture/src/sidepanel/index.html';
const roomUrl = `${origin}/#/ic/seatPredetermine/987654`;
const personalUrl = `${origin}/#/ic/userinfo`;
const config: DailyBookingConfig = {
  enabled: true, mode: 'ASSISTED',
  target: {floorName: '一楼', roomName: '合成区域', seatCode: 'D1-01', roomId: '987654', seatId: '9900123', startTime: '17:30', endTime: '21:15', dayOffset: 1},
};
const initialTime = Date.parse('2026-11-06T08:00:10+08:00');
const schedule = getDailySchedule(config, initialTime);

function event<Args extends unknown[]>() {
  const listeners: Array<(...args: Args) => unknown> = [];
  return {
    addListener(callback: (...args: Args) => unknown) { listeners.push(callback); },
    emit(...args: Args) { return listeners.map(callback => callback(...args)); },
  };
}

function fixtureTab(id: number, url: string, active = false): chrome.tabs.Tab {
  return {id, url, active, windowId: 1, index: id, pinned: false, highlighted: false, incognito: false, selected: active, discarded: false, frozen: false, autoDiscardable: true, status: 'complete', groupId: -1};
}

function harness(t: TestContext, configured = true) {
  let time = initialTime;
  let revision = 0;
  let state: DailyState | undefined = configured ? {id: 'daily-fixed-seat', revision: 'initial', config, result: null} : undefined;
  let gate: DailySessionGate | undefined;
  let response: (id: number, message: {type: string}) => unknown = () => null;
  const tabs = new Map<number, chrome.tabs.Tab>();
  const alarmEvent = event<[chrome.alarms.Alarm]>();
  const startup = event<[]>();
  const install = event<[]>();
  const tabEvent = event<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>();
  const messages = event<[object, chrome.runtime.MessageSender, (value?: unknown) => void]>();
  const alarms = new Map<string, chrome.alarms.Alarm>();
  const reads: string[] = [], notices: string[] = [], navigations: string[] = [];
  const reminderKeys = new Set<string>();
  let claims = 0;
  const repository: Parameters<typeof installDailyBookingController>[0] = {
    async get() { return state && structuredClone({...state, session: gate}); },
    async configure(value) { return state = {id: 'daily-fixed-seat', revision: String(++revision), config: value, result: null}; },
    async setEnabled(value) { if (state) state = {...state, config: {...state.config, enabled: value}}; },
    async claim() { claims += 1; return 'synthetic-lease'; },
    async reserveNavigation() { return true; },
    async finish(_revision, key, _token, result, _now, allowReminder) {
      const reminder = allowReminder && !reminderKeys.has(key);
      if (reminder) reminderKeys.add(key);
      if (state) state = {...state, result};
      return {saved: true, reminder};
    },
    async session() { return gate && {...gate}; },
    async markSessionLost(now) {
      if (gate && gate.verifiedAt === undefined) return false;
      gate = {lostAt: now};
      return true;
    },
    async confirmSession(lostAt, observedAt) {
      if (gate?.lostAt !== lostAt || observedAt <= lostAt) return false;
      gate = {...gate, verifiedAt: observedAt};
      return true;
    },
  };
  const chromeFixture = {
    runtime: {id: 'fixture', getURL: () => panelUrl, onMessage: messages, onStartup: startup, onInstalled: install, sendMessage: async () => {}},
    alarms: {
      onAlarm: alarmEvent,
      async getAll() { return [...alarms.values()]; },
      async create(name: string, value: {when: number}) { alarms.set(name, {name, scheduledTime: value.when}); },
      async clear(name: string) { return alarms.delete(name); },
    },
    tabs: {
      onUpdated: tabEvent,
      async query(filter: {active?: boolean}) { return [...tabs.values()].filter(tab => !filter.active || tab.active); },
      async get(id: number) { const tab = tabs.get(id); if (!tab) throw Error('tab gone'); return {...tab}; },
      async sendMessage(id: number, message: {type: string}) { reads.push(message.type); return response(id, message); },
      async create(value: {url: string}) { navigations.push(value.url); },
    },
    notifications: {create(id: string, _options: unknown, callback: () => void) { notices.push(id); callback(); }},
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {configurable: true, value: chromeFixture});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); });
  installDailyBookingController(repository, () => time);
  const send = (message: object, sender: chrome.runtime.MessageSender = {id: 'fixture', url: panelUrl}): Promise<any> =>
    new Promise(resolve => { if (!messages.emit(message, sender, resolve).includes(true)) resolve(undefined); });
  return {
    tabs, alarms, reads, notices, navigations, send,
    openAlarm: () => alarmEvent.emit({name: `dlmu-daily:OPEN:${schedule.day}`, scheduledTime: schedule.openAt}),
    staleAlarm: () => alarmEvent.emit({name: `dlmu-daily:OPEN:${schedule.day}`, scheduledTime: schedule.openAt - 60_000}),
    startup: () => startup.emit(),
    flush: () => send({type: 'DAILY_GET'}),
    claims: () => claims,
    setTime(now: number) { time = now; },
    respond(read: typeof response) { response = read; },
  };
}

function sender(tab: chrome.tabs.Tab, frameId = 0): chrome.runtime.MessageSender {
  return {id: 'fixture', url: tab.url, tab, frameId, documentLifecycle: 'active'};
}

test('worker activation restores future alarms and rejects an outdated alarm', async t => {
  const h = harness(t);
  await h.flush();
  assert.equal(h.claims(), 0);
  assert.equal(h.alarms.size, 3);
  assert.ok([...h.alarms.values()].every(alarm => alarm.scheduledTime > initialTime));
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.notices, []);
  h.staleAlarm();
  await h.flush();
  assert.equal(h.claims(), 0);
});

test('browser startup during the prepare window can still check the seat, with no opening reminder', async t => {
  const h = harness(t);
  const room = fixtureTab(1, roomUrl, true);
  h.tabs.set(room.id!, room);
  h.setTime(schedule.prepareAt + 10_000);
  h.respond(() => ({seat: {roomId: '987654', seatId: '9900123', roomName: '合成区域', seatCode: 'D1-01'}}));
  h.startup();
  const restored = await h.flush();
  assert.equal(restored.state.result.phase, 'PREPARE');
  assert.deepEqual(h.reads, ['READ_DAILY_SEAT']);
  assert.deepEqual(h.notices, []);
  assert.ok([...h.alarms.values()].every(alarm => alarm.scheduledTime > schedule.prepareAt + 10_000));
});

test('duplicate alarm reads cannot emit a reminder without its persisted one-shot reservation', async t => {
  const h = harness(t);
  h.openAlarm();
  h.openAlarm();
  const result = await h.flush();
  assert.equal(h.claims(), 2);
  assert.equal(result.state.result.pending, true);
  assert.deepEqual(h.notices, [`dlmu-daily-${schedule.day}`]);
  assert.deepEqual(h.navigations, []);
});

test('session loss persists without a configured task, and clean new personal evidence is required to resume', async t => {
  const h = harness(t, false);
  const room = fixtureTab(1, roomUrl, true);
  const personal = fixtureTab(2, personalUrl);
  h.tabs.set(room.id!, room);
  h.tabs.set(personal.id!, personal);
  assert.equal(await h.send({type: 'DAILY_SESSION_LOST'}, sender(room, 1)), undefined);
  assert.deepEqual(await h.send({type: 'DAILY_SESSION_STATUS'}, sender(room)), {ok: true, lost: false, verified: false});
  assert.deepEqual(await h.send({type: 'DAILY_SESSION_LOST'}, sender(room)), {ok: true, lost: true, verified: false});
  const fields = {type: 'DAILY_BIND', roomName: '合成区域', floorName: '一楼', seatCode: 'D1-01', startTime: '17:30', endTime: '21:15'};
  const blocked = await h.send(fields);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /重新打开学校个人预约页/);
  assert.deepEqual(h.reads.splice(0), ['DAILY_SESSION_UPDATED', 'DAILY_SESSION_UPDATED']);
  h.setTime(initialTime + 1_000);
  const observedAt = new Date(initialTime + 1_000).toISOString();
  h.respond(() => ({ok: true, route: '#/ic/userinfo', rows: [], issues: [], observedAt}));
  await h.send({type: 'PRODUCT_IMPORT_OFFICIAL'}, sender(personal));
  await h.flush();
  assert.equal((await h.send({type: 'DAILY_SESSION_STATUS'}, sender(room))).lost, true);
  h.respond(() => ({ok: true, route: '#/ic/userinfo', rows: [{id: 'fixture-row', source: 'OFFICIAL_VISIBLE_DOM', observedAt}], issues: [], observedAt}));
  await h.send({type: 'PRODUCT_IMPORT_OFFICIAL'}, sender(personal));
  await h.flush();
  assert.deepEqual(await h.send({type: 'DAILY_SESSION_STATUS'}, sender(room)), {ok: true, lost: false, verified: true, verifiedAt: Date.parse(observedAt)});
  assert.deepEqual(h.reads, ['READ_MY_RESERVATIONS', 'READ_MY_RESERVATIONS', 'DAILY_SESSION_UPDATED', 'DAILY_SESSION_UPDATED']);
  assert.equal((await h.flush()).state, undefined);
});

test('a seat reply is discarded if the tab leaves its original route before it resolves', async t => {
  const h = harness(t, false);
  const tab = fixtureTab(1, roomUrl, true);
  h.tabs.set(tab.id!, tab);
  h.respond(() => {
    h.tabs.set(tab.id!, {...tab, pendingUrl: 'https://id.dlmu.edu.cn/login'});
    return {seat: {roomId: '987654', seatId: '9900123', seatCode: 'D1-01', roomName: '合成区域'}};
  });
  const result = await h.send({type: 'DAILY_BIND', roomName: '合成区域', floorName: '一楼', seatCode: 'D1-01', startTime: '17:30', endTime: '21:15'});
  assert.equal(result.ok, false);
  assert.match(result.error, /核对区域和编号/);
  assert.equal((await h.flush()).state, undefined);
});
