import {decideDailyRun, getDailySchedule, isDailyPhaseWindow, nextDailyAlarms, validateDailyBookingConfig,
  type DailyPhase, type DailySchedule} from '../core/daily-booking-scheduler';
import {matchingOfficialRecords, OFFICIAL_HOME, OFFICIAL_PERSONAL, officialSeatRoute,
  type DailySeatIdentity} from '../core/daily-observations';
import type {OfficialReservation} from '../core/product-model';
import {DailyBookingRepository, type DailyResult, type DailyState} from '../storage/daily-booking-db';

const ALARM_PREFIX = 'dlmu-daily:';
const PHASES: DailyPhase[] = ['PREPARE', 'OPEN', 'VERIFY'];
const OFFICIAL_ORIGIN = new URL(OFFICIAL_HOME).origin;
const SESSION_HOSTS = new Set(['id.dlmu.edu.cn', 'atrust.dlmu.edu.cn']);

function parseUrl(value?: string): URL | null {
  try { return value ? new URL(value) : null; } catch { return null; }
}

function isOfficial(tab: chrome.tabs.Tab, hash?: string): boolean {
  const url = parseUrl(tab.url);
  return url?.origin === OFFICIAL_ORIGIN && (!hash || url.hash.split('?')[0] === hash) && !tab.incognito;
}

async function readTab<T>(tab: chrome.tabs.Tab, message: object): Promise<T | null> {
  if (tab.id === undefined || tab.discarded) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tab.id, message, {frameId: 0}) as Promise<T | undefined>,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000); }),
    ]) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readSeat(tab: chrome.tabs.Tab, roomName: string, seatCode: string): Promise<DailySeatIdentity | null> {
  if (!isOfficial(tab)) return null;
  const response = await readTab<{seat: DailySeatIdentity | null}>(tab, {type: 'READ_DAILY_SEAT', roomName, seatCode});
  const seat = response?.seat;
  if (!seat || seat.roomName !== roomName || seat.seatCode !== seatCode ||
      !/^\d+$/.test(seat.roomId) || !/^\d+$/.test(seat.seatId) ||
      !isOfficial(tab, new URL(officialSeatRoute(seat.roomId)).hash)) return null;
  return seat;
}

async function observePersonal(tabs: chrome.tabs.Tab[], schedule: DailySchedule): Promise<number | null> {
  const tab = tabs.find(candidate => isOfficial(candidate, '#/ic/userinfo') && !candidate.discarded);
  if (!tab) return null;
  const reply = await readTab<{ok: boolean; rows: OfficialReservation[]; issues: string[]; observedAt: string}>(tab, {type: 'READ_MY_RESERVATIONS'});
  if (!reply?.ok || !Array.isArray(reply.rows) || !Array.isArray(reply.issues) || reply.issues.length) return null;
  const observedAt = Date.parse(reply.observedAt);
  if (!Number.isFinite(observedAt) || observedAt < schedule.openAt || observedAt > Date.now()) return null;
  // An absent row can be on another page, behind a date filter, or not yet loaded.
  const matches = matchingOfficialRecords(schedule.target, reply.rows);
  return matches && matches > 0 ? matches : null;
}

async function inspect(state: DailyState, schedule: DailySchedule, phase: DailyPhase, openPage: boolean): Promise<DailyResult> {
  const result = (message: string, pending = false): DailyResult =>
    ({phase, day: schedule.day, targetDate: schedule.target.date, at: Date.now(), message, pending});
  const tabs = await chrome.tabs.query({});
  if (tabs.some(tab => SESSION_HOSTS.has(parseUrl(tab.url)?.hostname ?? '') && tab.active)) {
    return result('等待人工登录。请在学校网页完成认证，扩展会在本次时间窗口内重新检查。', true);
  }
  const {roomId, roomName, seatId, seatCode} = state.config.target;
  if (phase !== 'PREPARE') {
    const count = await observePersonal(tabs, schedule);
    if (count === 1) return result('官方个人预约页显示同一日期、区域、座位和时段已有有效预约。');
    if (count !== null) return result('官方个人预约页出现多条匹配记录，请人工核对。');
  }
  const roomUrl = officialSeatRoute(roomId);
  const roomTab = tabs.find(tab => isOfficial(tab, new URL(roomUrl).hash) && !tab.discarded);
  if (phase === 'VERIFY') {
    const official = roomTab ?? tabs.find(tab => isOfficial(tab));
    if (openPage && official && !tabs.some(tab => isOfficial(tab, '#/ic/userinfo')) &&
        isDailyPhaseWindow(schedule, phase, Date.now())) {
      await chrome.tabs.create({url: OFFICIAL_PERSONAL, active: false, windowId: official.windowId});
    }
    return result('尚未在个人预约页核验到匹配记录。请打开官方个人预约，并核对日期与筛选条件。', true);
  }
  if (!roomTab && phase === 'PREPARE' && openPage && isDailyPhaseWindow(schedule, phase, Date.now())) {
    const official = tabs.find(tab => isOfficial(tab));
    if (official) await chrome.tabs.create({url: roomUrl, active: false, windowId: official.windowId});
  }
  const seat = roomTab ? await readSeat(roomTab, roomName, seatCode) : null;
  if (!seat) return result('等待学校座位页提供最新的匹配座位。请检查登录并打开所选区域。', true);
  if (seat.seatId !== seatId) return result('学校页面的座位标识已变化。请在侧边栏重新核对并保存。');
  if (phase === 'PREPARE') return result('已从学校页面核对固定座位。请在开放时查看官方规则与可预约状态。');
  return result('已到预约提醒时间。生产提交条件仍需核实，请在学校网页核对并确认预约。');
}

export function installDailyBookingController(): void {
  const repository = new DailyBookingRepository();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  const notify = () => void chrome.runtime.sendMessage({type: 'DAILY_UPDATED'}).catch(() => {});

  async function reconcile(): Promise<void> {
    const state = await repository.get();
    const next = state?.config.mode === 'ASSISTED' ? nextDailyAlarms(state.config, Date.now()) : [];
    const desired = new Map(next.map(alarm => [ALARM_PREFIX + alarm.phase + ':' + alarm.schedule.day, alarm.when]));
    for (const alarm of await chrome.alarms.getAll()) {
      if (!alarm.name.startsWith(ALARM_PREFIX)) continue;
      if (desired.get(alarm.name) === alarm.scheduledTime) desired.delete(alarm.name);
      else await chrome.alarms.clear(alarm.name);
    }
    for (const [name, when] of desired) await chrome.alarms.create(name, {when});
  }

  async function run(phase: DailyPhase, intendedDay?: string, openPage = true): Promise<void> {
    const state = await repository.get();
    if (!state?.config.enabled || state.config.mode !== 'ASSISTED') return;
    const now = Date.now();
    const schedule = getDailySchedule(state.config, now);
    if (intendedDay && schedule.day !== intendedDay) return;
    const decision = decideDailyRun({config: state.config, schedule, phase, nowMs: now});
    if (decision.action === 'STOP' || decision.action === 'SUBMIT_MOCK') return;
    const key = `${schedule.day}|${state.id}|${schedule.duplicateKey}|${phase}`;
    const token = await repository.claim(state.revision, key, now);
    if (!token) return;
    let result: DailyResult;
    try {
      result = await inspect(state, schedule, phase, openPage);
    } catch {
      result = {phase, day: schedule.day, targetDate: schedule.target.date, at: Date.now(), message: '读取学校页面失败，预约结果待人工核对。', pending: true};
    }
    await repository.finish(state.revision, key, token, result, result.pending ? Date.now() + 3000 : schedule.verifyAt + 60_000);
    if (phase === 'OPEN' && openPage) {
      chrome.notifications.create('dlmu-daily-' + schedule.day, {type: 'basic', iconUrl: 'icons/icon128.png',
        title: `次日预约提醒 · ${schedule.target.date}`, message: result.message}, () => { void chrome.runtime.lastError; });
    }
    notify();
  }

  async function current(openPage: boolean): Promise<void> {
    const state = await repository.get();
    if (!state?.config.enabled || state.config.mode !== 'ASSISTED') return;
    const now = Date.now();
    const schedule = getDailySchedule(state.config, now);
    const phase = PHASES.find(value => isDailyPhaseWindow(schedule, value, now));
    if (phase && (openPage || state.result?.day === schedule.day && state.result.phase === phase && state.result.pending)) {
      await run(phase, schedule.day, openPage);
    }
  }

  function restore(): void {
    void serial(async () => { await current(true); await reconcile(); }).catch(() => {});
  }
  chrome.alarms.onAlarm.addListener(alarm => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const [, phase, day] = alarm.name.split(':');
    if (!PHASES.includes(phase as DailyPhase)) return;
    void serial(async () => {
      try { await run(phase as DailyPhase, day); } finally { await reconcile(); }
    }).catch(() => {});
  });
  chrome.runtime.onStartup.addListener(restore);
  chrome.runtime.onInstalled.addListener(restore);
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if ((change.url || change.status === 'complete') && isOfficial(tab)) void serial(() => current(false)).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return;
    if (sender.frameId === 0 && parseUrl(sender.url)?.origin === OFFICIAL_ORIGIN &&
        ['LIVE_UPDATE', 'PRODUCT_IMPORT_OFFICIAL'].includes(message.type)) {
      void serial(() => current(false)).catch(() => {});
      return;
    }
    if (!['DAILY_GET', 'DAILY_BIND', 'DAILY_TOGGLE', 'DAILY_OPEN'].includes(message.type) ||
        sender.url !== chrome.runtime.getURL('src/sidepanel/index.html')) return;
    void serial(async () => {
      if (message.type === 'DAILY_BIND') {
        const {roomName, seatCode, floorName, startTime, endTime} = message;
        if (typeof roomName !== 'string' || typeof seatCode !== 'string' || roomName.length > 64 || seatCode.length > 32) throw Error('区域或座位编号无效');
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        const seat = tab ? await readSeat(tab, roomName, seatCode) : null;
        if (!seat) throw Error('请在当前 Edge 窗口打开对应区域座位页，等待最新座位数据，再核对区域和编号。');
        await repository.configure(validateDailyBookingConfig({enabled: false, mode: 'ASSISTED',
          target: {floorName, roomName, seatCode, startTime, endTime, roomId: seat.roomId, seatId: seat.seatId, dayOffset: 1}}));
      }
      if (message.type === 'DAILY_TOGGLE') {
        if (typeof message.enabled !== 'boolean' || !(await repository.get())) throw Error('请先核对并保存固定座位');
        await repository.setEnabled(message.enabled);
        if (message.enabled) await current(true);
      }
      const state = await repository.get();
      if (message.type === 'DAILY_OPEN') {
        const url = message.personal ? OFFICIAL_PERSONAL : state ? officialSeatRoute(state.config.target.roomId) : OFFICIAL_HOME;
        const tabs = await chrome.tabs.query({url: OFFICIAL_ORIGIN + '/*', currentWindow: true});
        const tab = tabs.find(candidate => isOfficial(candidate, new URL(url).hash));
        if (tab?.id !== undefined) await chrome.tabs.update(tab.id, {active: true});
        else await chrome.tabs.create({url});
      }
      if (message.type !== 'DAILY_GET') { await reconcile(); notify(); }
      const now = Date.now();
      const next = state ? nextDailyAlarms({...state.config, enabled: true}, now).find(alarm => alarm.phase === 'OPEN')?.schedule : null;
      return {ok: true, state, next};
    }).then(reply, error => reply({ok: false, error: error instanceof Error ? error.message : '每日预约助手操作失败'}));
    return true;
  });
  restore();
}
