import {decideDailyRun, getDailySchedule, isDailyPhaseWindow, nextDailyAlarms, validateDailyBookingConfig,
  type DailyPhase, type DailySchedule} from '../core/daily-booking-scheduler';
import {DlmuAdapter} from '../adapters/dlmu-adapter';
import {OFFICIAL_HOME, OFFICIAL_PERSONAL, officialSeatRoute,
  type DailySeatIdentity} from '../core/daily-observations';
import type {OfficialReservation} from '../core/product-model';
import type {RuntimeEventType} from '../core/runtime-health';
import type {SeatTarget} from '../core/seat-timeline';
import {DailyBookingRepository, type DailyResult, type DailyState} from '../storage/daily-booking-db';

const ALARM_PREFIX = 'dlmu-daily:';
const PHASES: DailyPhase[] = ['PREPARE', 'OPEN', 'VERIFY'];
const OFFICIAL_ORIGIN = new URL(OFFICIAL_HOME).origin;
const PERSONAL_HASH = new URL(OFFICIAL_PERSONAL).hash;
const SESSION_HOSTS = new Set(['id.dlmu.edu.cn', 'atrust.dlmu.edu.cn']);
type DailyStore = Pick<DailyBookingRepository, 'get' | 'configure' | 'setEnabled' | 'claim' | 'finish' |
  'reserveNavigation' | 'session' | 'markSessionLost' | 'confirmSession'>;

function parseUrl(value?: string): URL | null {
  try { return value ? new URL(value) : null; } catch { return null; }
}

function hashOf(url?: string): string | undefined { return parseUrl(url)?.hash.split('?')[0]; }
function phaseTime(schedule: DailySchedule, phase: DailyPhase): number {
  return phase === 'PREPARE' ? schedule.prepareAt : phase === 'OPEN' ? schedule.openAt : schedule.verifyAt;
}

function isOfficial(tab: chrome.tabs.Tab, hash?: string): boolean {
  const url = parseUrl(tab.url);
  const pending = parseUrl(tab.pendingUrl);
  return url?.origin === OFFICIAL_ORIGIN && (!hash || hashOf(tab.url) === hash) && !tab.incognito &&
    (!tab.pendingUrl || pending?.origin === OFFICIAL_ORIGIN && hashOf(tab.pendingUrl) === hashOf(tab.url));
}

function isLoginTab(tab: chrome.tabs.Tab, url = tab.pendingUrl ?? tab.url): boolean {
  const parsed = parseUrl(url);
  return tab.active && !tab.incognito && parsed?.protocol === 'https:' && SESSION_HOSTS.has(parsed.hostname);
}

async function getTab(id: number | undefined): Promise<chrome.tabs.Tab | null> {
  if (id === undefined) return null;
  try { return await chrome.tabs.get(id); } catch { return null; }
}

export async function readTab<T>(tab: chrome.tabs.Tab, message: object, expectedHash: string): Promise<T | null> {
  if (tab.id === undefined || tab.discarded || tab.status === 'loading' || !isOfficial(tab, expectedHash)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tab.id, message, {frameId: 0}) as Promise<T | undefined>,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000); }),
    ]);
    if (!reply) return null;
    // A tab can navigate to SSO or another route while the content-script read is in flight.
    const after = await getTab(tab.id);
    return after && !after.discarded && after.status !== 'loading' && isOfficial(after, expectedHash) ? reply : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readSeat(tab: chrome.tabs.Tab, roomName: string, seatCode: string): Promise<DailySeatIdentity | null> {
  const hash = hashOf(tab.url);
  if (!hash || !isOfficial(tab)) return null;
  const response = await readTab<{seat: DailySeatIdentity | null}>(tab, {type: 'READ_DAILY_SEAT', roomName, seatCode}, hash);
  const seat = response?.seat;
  if (!seat || seat.roomName !== roomName || seat.seatCode !== seatCode ||
      !/^\d+$/.test(seat.roomId) || !/^\d+$/.test(seat.seatId) ||
      hash !== hashOf(officialSeatRoute(seat.roomId))) return null;
  return seat;
}

export async function readPersonal(tab: chrome.tabs.Tab, now: () => number, notBefore: number): Promise<{rows: OfficialReservation[]; observedAt: number} | null> {
  const reply = await readTab<{ok: boolean; rows: OfficialReservation[]; issues: string[]; observedAt: string; route: string}>(
    tab, {type: 'READ_MY_RESERVATIONS'}, PERSONAL_HASH,
  );
  if (!reply?.ok || reply.route?.split('?')[0] !== PERSONAL_HASH || !Array.isArray(reply.rows) ||
      !Array.isArray(reply.issues) || reply.issues.length) return null;
  const observedAt = Date.parse(reply.observedAt);
  const checkedAt = now();
  if (!Number.isFinite(observedAt) || observedAt < notBefore || observedAt > checkedAt || checkedAt - observedAt > 60_000 ||
      reply.rows.some(row => row?.source !== 'OFFICIAL_VISIBLE_DOM' || !row.id || row.observedAt !== reply.observedAt)) return null;
  return {rows: reply.rows, observedAt};
}

async function inspect(state: DailyState, schedule: DailySchedule, phase: DailyPhase, tabs: chrome.tabs.Tab[],
  now: () => number, navigate: (url: string, windowId?: number) => Promise<void>, canRead: () => Promise<boolean>): Promise<DailyResult & {verified?: boolean}> {
  const result = (message: string, pending = false, verified = false) =>
    ({phase, day: schedule.day, targetDate: schedule.target.date, at: now(), message, pending, verified});
  if (state.session && state.session.verifiedAt === undefined || !await canRead()) {
    return result('等待人工登录及个人预约复核。请完成认证后打开学校个人预约页。', true);
  }
  const {roomId, roomName, seatId, seatCode} = state.config.target;
  if (phase !== 'PREPARE') {
    const personal = tabs.find(tab => isOfficial(tab, PERSONAL_HASH) && !tab.discarded);
    const sample = personal && await readPersonal(personal, now, schedule.openAt);
    // An absent row may be filtered, paginated or not loaded. Absence is not proof of no booking.
    const count = sample && DlmuAdapter.matchReservation(schedule.target, sample.rows);
    if (count === 1) return result('官方个人预约页显示同一日期、区域、座位和时段已有有效预约。', false, true);
    if (count && count > 1) return result('官方个人预约页出现多条匹配记录，请人工核对。');
  }
  const roomUrl = officialSeatRoute(roomId);
  const roomTab = tabs.find(tab => isOfficial(tab, hashOf(roomUrl)) && !tab.discarded);
  if (phase === 'VERIFY') {
    const official = roomTab ?? tabs.find(tab => isOfficial(tab));
    if (official && !tabs.some(tab => isOfficial(tab, PERSONAL_HASH))) await navigate(OFFICIAL_PERSONAL, official.windowId);
    return result('尚未在个人预约页核验到匹配记录。请打开官方个人预约，并核对日期与筛选条件。', true);
  }
  if (!roomTab && phase === 'PREPARE') {
    const official = tabs.find(tab => isOfficial(tab));
    if (official) await navigate(roomUrl, official.windowId);
  }
  const seat = roomTab && await canRead() ? await readSeat(roomTab, roomName, seatCode) : null;
  if (!seat) return result('等待学校座位页提供最新的匹配座位。请检查登录并打开所选区域。', true);
  if (seat.seatId !== seatId) return result('学校页面的座位标识已变化。请在侧边栏重新核对并保存。');
  if (phase === 'PREPARE') return result('已从学校页面核对固定座位。请在开放时查看官方规则与可预约状态。');
  return result('已到预约提醒时间。生产提交条件仍需核实，请在学校网页核对并确认预约。');
}

type DailyReport = (eventType: RuntimeEventType, at: number, dedupKey?: string, seat?: SeatTarget) => void;

export function installDailyBookingController(repository: DailyStore = new DailyBookingRepository(), now: () => number = Date.now,
  report: DailyReport = () => {}): void {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  const notify = () => void chrome.runtime.sendMessage({type: 'DAILY_UPDATED'}).catch(() => {});
  async function notifySession(): Promise<void> {
    notify();
    const tabs = await chrome.tabs.query({url: OFFICIAL_ORIGIN + '/*'});
    for (const tab of tabs) {
      if (tab.id !== undefined && isOfficial(tab) && !tab.discarded) {
        void chrome.tabs.sendMessage(tab.id, {type: 'DAILY_SESSION_UPDATED'}, {frameId: 0}).catch(() => {});
      }
    }
  }
  async function markLost(): Promise<void> {
    if (await repository.markSessionLost(now())) {
      report('SESSION_LOST', now());
      await notifySession();
    }
  }

  async function reconcile(): Promise<void> {
    const state = await repository.get();
    const next = state?.config.mode === 'ASSISTED' ? nextDailyAlarms(state.config, now()) : [];
    const desired = new Map(next.map(alarm => [ALARM_PREFIX + alarm.phase + ':' + alarm.schedule.day, alarm.when]));
    for (const alarm of await chrome.alarms.getAll()) {
      if (!alarm.name.startsWith(ALARM_PREFIX)) continue;
      if (desired.get(alarm.name) === alarm.scheduledTime) desired.delete(alarm.name);
      else await chrome.alarms.clear(alarm.name);
    }
    for (const [name, when] of desired) await chrome.alarms.create(name, {when});
  }

  async function run(phase: DailyPhase, intendedDay: string, scheduledTime?: number): Promise<void> {
    let state = await repository.get();
    if (!state?.config.enabled || state.config.mode !== 'ASSISTED') return;
    const schedule = getDailySchedule(state.config, now());
    if (schedule.day !== intendedDay || scheduledTime !== undefined && scheduledTime !== phaseTime(schedule, phase)) return;
    if (decideDailyRun({config: state.config, schedule, phase, nowMs: now()}).action === 'STOP') return;
    const tabs = await chrome.tabs.query({});
    if (tabs.some(tab => isLoginTab(tab))) {
      await markLost();
      const current = await repository.get();
      if (!current?.config.enabled || current.config.mode !== 'ASSISTED' ||
          getDailySchedule(current.config, now()).duplicateKey !== schedule.duplicateKey) return;
      state = current;
    }
    if (!isDailyPhaseWindow(schedule, phase, now())) return;
    const {revision} = state;
    const key = `${schedule.day}|${state.id}|${schedule.duplicateKey}|${phase}`;
    const token = await repository.claim(revision, key, now());
    if (!token) return;
    const seat = {roomId: Number(state.config.target.roomId), devId: Number(state.config.target.seatId), seatCode: state.config.target.seatCode};
    report('TASK_STARTED', now(), `start:${key}`, seat);
    const navigate = async (url: string, windowId?: number) => {
      if (scheduledTime === undefined || !isDailyPhaseWindow(schedule, phase, now())) return;
      if (!await repository.reserveNavigation(revision, key, token, now()) || !isDailyPhaseWindow(schedule, phase, now())) return;
      await chrome.tabs.create({url, active: false, windowId});
    };
    const canRead = async () => {
      const current = await repository.get();
      return current?.revision === revision && current.config.enabled &&
        (!current.session || current.session.verifiedAt !== undefined);
    };
    let result: DailyResult & {verified?: boolean};
    try { result = await inspect(state, schedule, phase, tabs, now, navigate, canRead); }
    catch {
      report('TASK_FAILED', now(), `failure:${key}`, seat);
      result = {phase, day: schedule.day, targetDate: schedule.target.date, at: now(), message: '读取学校页面失败，预约结果待人工核对。', pending: true};
    }
    if (!isDailyPhaseWindow(schedule, phase, now())) return;
    const finished = await repository.finish(revision, key, token, result, now(), scheduledTime !== undefined && phase === 'OPEN');
    if (finished.reminder) {
      chrome.notifications.create('dlmu-daily-' + schedule.day, {type: 'basic', iconUrl: 'icons/icon128.png',
        title: `次日预约提醒 · ${schedule.target.date}`, message: result.message}, () => { void chrome.runtime.lastError; });
    }
    if (finished.saved) {
      if (result.verified) report('RESERVATION_VERIFIED', result.at, `verified:${key}`, seat);
      else if (phase === 'VERIFY') report('RESERVATION_UNVERIFIED', result.at, `unverified:${key}`, seat);
      notify();
    }
  }

  async function resumeSession(tabId: number): Promise<void> {
    const gate = await repository.session();
    if (!gate || gate.verifiedAt !== undefined) return;
    const tab = await getTab(tabId);
    if (!tab || !isOfficial(tab, PERSONAL_HASH)) return;
    const active = await chrome.tabs.query({active: true});
    if (active.some(candidate => isLoginTab(candidate))) return;
    const sample = await readPersonal(tab, now, gate.lostAt + 1);
    // A clean nonempty table supplies affirmative post-login evidence. A skeleton table does not.
    if (sample?.rows.length && await repository.confirmSession(gate.lostAt, sample.observedAt)) {
      report('SESSION_RECOVERED', sample.observedAt);
      await notifySession();
    }
  }

  let queuedObservation = false;
  let personalCandidate: number | undefined;
  const changedRoutes = new Set<string>();
  function observe(tab: chrome.tabs.Tab, personalReady: boolean): void {
    const hash = hashOf(tab.url);
    if (!hash || !isOfficial(tab) || (hash !== PERSONAL_HASH && !/^#\/ic\/seatPredetermine\/\d+$/.test(hash))) return;
    changedRoutes.add(hash);
    if (personalReady && hash === PERSONAL_HASH) personalCandidate = tab.id;
    if (queuedObservation) return;
    queuedObservation = true;
    void serial(async () => {
      queuedObservation = false;
      const candidate = personalCandidate;
      personalCandidate = undefined;
      const routes = new Set(changedRoutes);
      changedRoutes.clear();
      if (candidate !== undefined) await resumeSession(candidate);
      const state = await repository.get();
      if (!state?.config.enabled || state.config.mode !== 'ASSISTED' || !state.result?.pending ||
          state.session && state.session.verifiedAt === undefined) return;
      const schedule = getDailySchedule(state.config, now());
      const {phase, day} = state.result;
      const seatHash = hashOf(officialSeatRoute(state.config.target.roomId));
      if (day === schedule.day && isDailyPhaseWindow(schedule, phase, now()) &&
          (routes.has(PERSONAL_HASH) || seatHash && routes.has(seatHash))) await run(phase, day);
    }).catch(() => {});
  }

  function restore(): void { void serial(reconcile).catch(() => {}); }
  function onBrowserStartup(): void {
    void serial(async () => {
      try {
        const state = await repository.get();
        if (!state?.config.enabled || state.config.mode !== 'ASSISTED') return;
        const current = now();
        const schedule = getDailySchedule(state.config, current);
        const phase = PHASES.find(item => isDailyPhaseWindow(schedule, item, current));
        // A 07:55 Windows launch can start Edge seconds after the alarm timestamp.
        if (phase) await run(phase, schedule.day, phaseTime(schedule, phase));
      } finally { await reconcile(); }
    }).catch(() => {});
  }
  chrome.alarms.onAlarm.addListener(alarm => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const [, phase, day, extra] = alarm.name.split(':');
    if (!PHASES.includes(phase as DailyPhase) || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || extra !== undefined) return;
    void serial(async () => {
      try { await run(phase as DailyPhase, day, alarm.scheduledTime); } finally { await reconcile(); }
    }).catch(() => {});
  });
  chrome.runtime.onStartup.addListener(onBrowserStartup);
  chrome.runtime.onInstalled.addListener(restore);
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (change.url && isLoginTab(tab, change.url)) { void markLost().catch(() => {}); return; }
    if (change.url || change.status === 'complete') observe(tab, change.status === 'complete');
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return;
    if (sender.frameId === 0 && sender.tab && !sender.tab.incognito && parseUrl(sender.url)?.origin === OFFICIAL_ORIGIN &&
        (!sender.documentLifecycle || sender.documentLifecycle === 'active')) {
      if (message.type === 'DAILY_SESSION_STATUS' || message.type === 'DAILY_SESSION_LOST') {
        const read = async () => {
          if (message.type === 'DAILY_SESSION_LOST') await markLost();
          const session = await repository.session();
          return {ok: true, lost: !!session && session.verifiedAt === undefined, verified: session?.verifiedAt !== undefined,
            ...(session?.verifiedAt !== undefined ? {verifiedAt: session.verifiedAt} : {})};
        };
        void read().then(reply, () => reply({ok: false, lost: true, verified: false}));
        return true;
      }
      if (['LIVE_UPDATE', 'PRODUCT_IMPORT_OFFICIAL'].includes(message.type)) {
        observe(sender.tab, message.type === 'PRODUCT_IMPORT_OFFICIAL' && hashOf(sender.url) === PERSONAL_HASH);
        return;
      }
    }
    if (!['DAILY_GET', 'DAILY_BIND', 'DAILY_TOGGLE', 'DAILY_OPEN'].includes(message.type) ||
        sender.url !== chrome.runtime.getURL('src/sidepanel/index.html')) return;
    void serial(async () => {
      if (message.type === 'DAILY_BIND') {
        const {roomName, seatCode, floorName, startTime, endTime} = message;
        if (typeof roomName !== 'string' || typeof seatCode !== 'string' || roomName.length > 64 || seatCode.length > 32) throw Error('区域或座位编号无效');
        const session = await repository.session();
        if (session && session.verifiedAt === undefined) throw Error('请完成登录并重新打开学校个人预约页，再核对座位。');
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        const seat = tab ? await readSeat(tab, roomName, seatCode) : null;
        if (!seat) throw Error('请在当前 Edge 窗口打开对应区域座位页，等待最新座位数据，再核对区域和编号。');
        await repository.configure(validateDailyBookingConfig({enabled: false, mode: 'ASSISTED',
          target: {floorName, roomName, seatCode, startTime, endTime, roomId: seat.roomId, seatId: seat.seatId, dayOffset: 1}}));
      }
      if (message.type === 'DAILY_TOGGLE') {
        const previous = await repository.get();
        if (typeof message.enabled !== 'boolean' || !previous) throw Error('请先核对并保存固定座位');
        await repository.setEnabled(message.enabled);
        if (previous.config.enabled !== message.enabled) report(message.enabled ? 'TASK_RESUMED' : 'TASK_PAUSED', now());
      }
      const state = await repository.get();
      if (message.type === 'DAILY_OPEN') {
        const url = message.personal ? OFFICIAL_PERSONAL : state ? officialSeatRoute(state.config.target.roomId) : OFFICIAL_HOME;
        const tabs = await chrome.tabs.query({url: OFFICIAL_ORIGIN + '/*', currentWindow: true});
        const tab = tabs.find(candidate => isOfficial(candidate, hashOf(url)));
        if (tab?.id !== undefined) await chrome.tabs.update(tab.id, {active: true});
        else await chrome.tabs.create({url});
      }
      if (message.type !== 'DAILY_GET') { await reconcile(); notify(); }
      const next = state ? nextDailyAlarms({...state.config, enabled: true}, now()).find(alarm => alarm.phase === 'OPEN')?.schedule : null;
      return {ok: true, state, next, session: await repository.session()};
    }).then(reply, error => reply({ok: false, error: error instanceof Error ? error.message : '每日预约助手操作失败'}));
    return true;
  });
  restore();
}
