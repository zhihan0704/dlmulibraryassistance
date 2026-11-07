import {DlmuAdapter} from '../adapters/dlmu-adapter';
import {OFFICIAL_PERSONAL, officialSeatRoute} from '../core/daily-observations';
import {nextDailyAlarms} from '../core/daily-booking-scheduler';
import {rankBookingCandidates, readOnlyBookingEvidence, type BookingPreferences} from '../core/intelligent-booking';
import {createRuntimeEvent, evaluateRuntimeHealth, normalizeRuntimeSnapshot, safeRuntimeSeat, shanghaiTimestamp,
  type RuntimeEventType, type RuntimeHealthEvidence, type RuntimeSource} from '../core/runtime-health';
import {parseInstant, sameSeat, type SeatTarget} from '../core/seat-timeline';
import type {LiveReply} from '../shared/live-monitor';
import {AssistantRepository, type AssistantPlan} from '../storage/assistant-repository';
import type {DailyBookingRepository} from '../storage/daily-booking-db';
import {readPersonal, readSeat, readTab} from './daily-booking-controller';

const OFFICIAL_ORIGIN = new URL(OFFICIAL_PERSONAL).origin;
const PLAN_ALARM = 'dlmu-assistant-plan-reminder';
const REMINDER_WINDOW = 120_000;
const CHANGE_TYPES = new Set<RuntimeEventType>(['SEAT_CHANGED', 'TIME_CHANGED', 'RECORD_ADDED', 'RECORD_REMOVED', 'STATUS_CHANGED']);
const NOTIFY_TYPES = new Set<RuntimeEventType>(['SESSION_LOST', 'DATA_STALE', 'TASK_FAILED', 'RESERVATION_VERIFIED', 'RESERVATION_UNVERIFIED', 'CANDIDATE_FOUND']);

export function installAssistantController(daily: DailyBookingRepository) {
  const repository = new AssistantRepository();
  let recovering = true;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }
  const changed = () => void chrome.runtime.sendMessage({type: 'ASSISTANT_UPDATED'}).catch(() => {});

  async function record(eventType: RuntimeEventType, source: RuntimeSource, at: number, dedupKey?: string,
    seat?: SeatTarget | null, task?: string, remind = false) {
    const event = createRuntimeEvent({eventType, timestamp: at, source, relatedSeat: seat, relatedTask: task});
    if (!await repository.appendEvent(event, dedupKey)) return;
    if (remind || NOTIFY_TYPES.has(eventType)) {
      const key = dedupKey ?? `event:${event.eventId}`;
      if (await repository.claimNotification(key, Date.now())) {
        try {
          await chrome.notifications.create(event.eventId, {type: 'basic', title: '海大图书馆助手',
            message: event.description, iconUrl: 'icons/icon128.png'});
          await repository.appendEvent(createRuntimeEvent({eventType: 'NOTIFICATION_SENT', timestamp: Date.now(), source: 'WORKER', relatedSeat: seat, relatedTask: task}));
        } catch { /* The underlying event remains available in the panel. */ }
      }
    }
  }

  async function readCurrent(tabId?: number) {
    const tab = Number.isSafeInteger(tabId) ? await chrome.tabs.get(tabId!).catch(() => undefined)
      : (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0];
    const page = DlmuAdapter.identifyPage(tab?.url ?? '');
    const live = tab && (page.kind === 'SEATS' || page.kind === 'PERSONAL')
      ? await readTab<LiveReply>(tab, {type: 'GET_LIVE'}, page.route) : null;
    return {page, live};
  }

  function decision(preferences: BookingPreferences, live: LiveReply | null, lost = false) {
    const observed = live && !live.liveError && !live.networkError && live.eventMonitor.network.freshness !== 'UNKNOWN';
    const evidence = readOnlyBookingEvidence(observed ? live.live?.snapshot ?? null : null, preferences);
    return rankBookingCandidates({preferences, evidence, mode: 'LIVE', now: Date.now(),
      session: lost || live?.session === 'SESSION_LOST' ? 'LOST' : live?.session === 'REVERIFIED' ? 'CONFIRMED' : 'UNKNOWN'});
  }

  async function reportCandidates(preferences: BookingPreferences, live: LiveReply | null, relatedTask?: string) {
    const gate = await daily.session();
    const result = decision(preferences, live, !!gate && gate.verifiedAt === undefined);
    const first = result.candidates[0];
    if (result.state === 'READY' && first) {
      await record('CANDIDATE_FOUND', 'PLANNER', Date.now(),
        `candidate:${first.target.roomId}:${first.target.devId}:${first.startAt}:${first.endAt}`, first.target, relatedTask);
    }
    return result;
  }

  async function state(tabId?: number, date?: string) {
    const [{page, live}, db, alarmList] = await Promise.all([
      readCurrent(tabId),
      Promise.all([repository.getPreferences(), repository.listPlans(), repository.getHealth(), repository.listEvents({limit: 100}),
        repository.getNotificationsEnabled(), daily.get(), daily.session()]).catch(() => null),
      chrome.alarms.getAll().catch(() => null),
    ]);
    const [preferences, plans, lastGood, events, notifications, dailyState, session] = db ?? [null, [], null, [], false, undefined, undefined] as const;
    const lost = !!session && session.verifiedAt === undefined;
    const enabled = dailyState?.config.enabled === true;
    const now = Date.now();
    const expected = dailyState && enabled ? nextDailyAlarms(dailyState.config, now).map(item =>
      ({name: `dlmu-daily:${item.phase}:${item.schedule.day}`, when: item.when})) : [];
    const nextPlan = Math.min(...plans.map(plan => parseInstant(plan.reminderAt) ?? 0).filter(at => at > now));
    if (Number.isFinite(nextPlan)) expected.push({name: PLAN_ALARM, when: nextPlan});
    const alarms = alarmList === null ? 'ERROR' : !expected.length ? 'NONE' : expected.every(item =>
      alarmList.some(alarm => alarm.name === item.name && alarm.scheduledTime === item.when)) ? 'SCHEDULED' : 'MISSING';
    const dataState = (freshness?: string) => freshness === 'FRESH' ? 'FRESH' : freshness === 'STALE' ? 'STALE' : 'WAITING';
    const health: RuntimeHealthEvidence = {
      browser: 'CONNECTED', extension: 'CONNECTED', worker: recovering ? 'RECOVERING' : 'READY', content: live ? 'CONNECTED' : 'DISCONNECTED',
      page: page.kind, session: lost ? 'SESSION_LOST' : live?.session ?? 'UNKNOWN',
      network: live?.networkError ? 'ERROR' : dataState(live?.eventMonitor.network.freshness),
      dom: live?.domError ? 'ERROR' : dataState(live?.eventMonitor.dom.freshness), parseError: !!live?.liveError && !live.networkError,
      indexedDB: db ? 'READY' : 'ERROR', alarms, task: dailyState ? enabled ? 'ENABLED' : 'PAUSED' : 'NONE',
      lastResponse: live?.eventMonitor.network.lastFreshAt ?? null, lastDom: live?.eventMonitor.dom.lastFreshAt ?? null,
      lastParsed: live?.eventMonitor.network.lastFreshAt ?? null,
      lastTask: [dailyState?.result ? shanghaiTimestamp(dailyState.result.at) : '',
        events.find(event => event.eventType === 'TASK_STARTED')?.timestamp ?? ''].sort().at(-1) || null,
      lastGood, lastError: events.find(event => event.severity !== 'INFO') ?? null,
    };
    const plan = plans.find(plan => plan.preferences.date === date);
    const selected = plan?.preferences ?? preferences;
    const seats = !lost && live?.session !== 'SESSION_LOST' && !live?.liveError && !live?.networkError && live?.eventMonitor.network.freshness === 'FRESH'
      ? live.live?.snapshot.seats.map(seat => ({roomId: seat.roomId, devId: seat.devId, seatCode: seat.name, roomName: seat.roomName})) ?? [] : [];
    return {health: evaluateRuntimeHealth(health), preferences, plans, notifications, seats,
      dailyTarget: dailyState?.config.target ?? null, analysis: selected ? decision(selected, live, lost) : null};
  }

  async function observe(message: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
    const page = DlmuAdapter.identifyPage(sender.url ?? '');
    if (page.kind !== 'SEATS' || page.route !== message.route || (message.source !== 'NETWORK' && message.source !== 'DOM')) return;
    const at = parseInstant(message.at);
    if (at === null || at > Date.now() || Date.now() - at > 10 * 60_000) return;
    const type = message.eventType;
    if (type !== 'DATA_CAPTURED' && type !== 'PARSER_ERROR' && type !== 'NETWORK_ERROR' && type !== 'DATA_STALE') return;
    const key = `${type}:${message.source}:${page.roomId}:${at}`;
    if (type !== 'DATA_CAPTURED') {
      await record(type, message.source, type === 'DATA_STALE' ? Date.now() : at, key);
      changed();
      return;
    }
    const snapshot = normalizeRuntimeSnapshot({capturedAt: message.at, route: page.route, seatCount: message.seatCount, source: message.source});
    const gate = await daily.session();
    if (gate && (!gate.verifiedAt || at < gate.verifiedAt)) return;
    await repository.saveHealth(snapshot);
    await record('PAGE_ENTERED', 'BROWSER', at, `page:${sender.tab?.id}:${sender.documentId ?? 'current'}:${page.roomId}`);
    await record(type, message.source, at, key);
    const changes = Array.isArray(message.changes) ? message.changes.slice(0, 2000) : [];
    if (changes.length) {
      const [prefs, plans] = await Promise.all([repository.getPreferences(), repository.listPlans()]);
      const watched = [...(prefs ? [prefs] : []), ...plans.map(plan => plan.preferences)];
      const impacted = new Set<BookingPreferences>();
      const emitted = new Set<string>();
      for (const change of changes) {
        if (!change || typeof change !== 'object' || !Array.isArray(change.changeTypes)) continue;
        const rawSeat = safeRuntimeSeat({roomId: change.roomId, devId: change.devId, seatCode: change.name});
        const seat = rawSeat && String(rawSeat.roomId) === page.roomId ? rawSeat : null;
        const matchesSeat = (target: SeatTarget) => sameSeat(target, seat) || (message.source === 'DOM' &&
          String(target.roomId) === page.roomId && target.seatCode === change.name);
        const matches = watched.filter(pref => matchesSeat(pref.primarySeat) || pref.allowBackupSeats && pref.backupSeats.some(matchesSeat));
        const primary = matches.map(pref => pref.primarySeat).find(matchesSeat);
        const tracked = primary ?? matches.flatMap(pref => pref.backupSeats).find(matchesSeat);
        for (const preference of matches) impacted.add(preference);
        for (const eventType of change.changeTypes.slice(0, 5)) {
          if (!CHANGE_TYPES.has(eventType)) continue;
          const eventKey = `${key}:${eventType}:${tracked?.devId ?? 'group'}`;
          if (emitted.has(eventKey)) continue;
          emitted.add(eventKey);
          await record(eventType, message.source, at, eventKey, tracked ?? seat, undefined, Boolean(primary && eventType === 'TIME_CHANGED' && message.source === 'NETWORK'));
        }
      }
      if (impacted.size && message.source === 'NETWORK' && sender.tab) {
        const latest = await readTab<LiveReply>(sender.tab, {type: 'GET_LIVE'}, page.route);
        for (const preference of impacted) await reportCandidates(preference, latest, `plan:${preference.date}`);
      }
    }
    changed();
  }

  async function verifyPlan(plan: AssistantPlan) {
    const gate = await daily.session();
    if (gate && !gate.verifiedAt) throw Error('请人工登录并完成个人预约页复核');
    const tabs = await chrome.tabs.query({url: OFFICIAL_ORIGIN + '/*'});
    const personal = tabs.find(tab => DlmuAdapter.identifyPage(tab.url ?? '').kind === 'PERSONAL');
    const target = plan.preferences.primarySeat;
    const seatTab = tabs.find(tab => tab.url?.split('?')[0] === officialSeatRoute(String(target.roomId)));
    const seat = seatTab && plan.roomName ? await readSeat(seatTab, plan.roomName, target.seatCode) : null;
    const sample = personal && await readPersonal(personal, Date.now, gate?.verifiedAt ?? 0);
    const verified = Boolean(sample && seat?.seatId === String(target.devId) && seat.roomId === String(target.roomId) && plan.floorName && plan.roomName &&
      DlmuAdapter.matchReservation({date: plan.preferences.date, floorName: plan.floorName, roomName: plan.roomName,
        seatCode: target.seatCode, seatId: String(target.devId), roomId: String(target.roomId),
        ...plan.preferences.preferred}, sample.rows) === 1);
    const currentGate = await daily.session();
    if (currentGate?.lostAt !== gate?.lostAt || currentGate?.verifiedAt !== gate?.verifiedAt) throw Error('认证状态发生变化，请重新核对');
    const observedAt = Date.now();
    if (!await repository.setPlanVerification(plan.id, plan.revision, verified ? 'VERIFIED' : 'NEEDS_REVIEW', shanghaiTimestamp(observedAt))) {
      throw Error('计划已变更，请重新核对');
    }
    await record(verified ? 'RESERVATION_VERIFIED' : 'RESERVATION_UNVERIFIED', 'TASK', observedAt,
      `verify:${plan.id}:${plan.revision}:${verified}`, target, plan.id);
  }

  async function reminders() {
    const now = Date.now();
    let next = Infinity;
    const plans = await repository.listPlans();
    for (const plan of plans.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
      const at = parseInstant(plan.reminderAt);
      if (at === null) continue;
      if (at > now) next = Math.min(next, at);
      else if (now - at <= REMINDER_WINDOW) await record('TASK_STARTED', 'TASK', now, `reminder:${plan.id}:${at}`,
        plan.preferences.primarySeat, plan.id, true);
    }
    if (Number.isFinite(next)) await chrome.alarms.create(PLAN_ALARM, {when: next});
    else await chrome.alarms.clear(PLAN_ALARM);
    changed();
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string' || !message.type.startsWith('ASSISTANT_')) return;
    if (message.type === 'ASSISTANT_OBSERVATION') {
      if (sender.frameId === 0 && sender.tab && !sender.tab.incognito && (!sender.documentLifecycle || sender.documentLifecycle === 'active')) {
        void serial(() => observe(message, sender)).catch(() => {});
      }
      return;
    }
    if (sender.url !== chrome.runtime.getURL('src/sidepanel/index.html')) return;
    const perform = async () => {
      switch (message.type) {
        case 'ASSISTANT_STATE': return state(message.tabId, message.date);
        case 'ASSISTANT_SAVE_PREFERENCES': return repository.savePreferences(message.preferences);
        case 'ASSISTANT_SAVE_PLAN': {
          const plan = await repository.savePlan(message.plan);
          await reminders();
          return plan;
        }
        case 'ASSISTANT_REMOVE_PLAN': {
          const removed = await repository.removePlan(message.id);
          await reminders();
          return removed;
        }
        case 'ASSISTANT_VERIFY_PLAN': {
          const plan = (await repository.listPlans()).find(item => item.id === message.id);
          if (!plan) throw Error('未找到该日期的计划');
          await verifyPlan(plan);
          return true;
        }
        case 'ASSISTANT_EVENTS': return repository.listEvents(message.filter);
        case 'ASSISTANT_EXPORT_EVENTS': return repository.exportEvents(message.filter);
        case 'ASSISTANT_CLEAR_EVENTS': return repository.clearEvents();
        case 'ASSISTANT_EXPORT_CONFIG': return repository.exportConfig();
        case 'ASSISTANT_RESTORE_CONFIG': await repository.restoreConfig(message.backup); await reminders(); return true;
        case 'ASSISTANT_CLEAR_DATA': await repository.clearAssistantData(); await reminders(); return true;
        case 'ASSISTANT_NOTIFICATIONS': return repository.setNotificationsEnabled(message.enabled);
        default: throw Error('不支持的操作');
      }
    };
    const operation = message.type === 'ASSISTANT_STATE' ? perform() : serial(perform);
    void operation.then(data => reply({ok: true, data}), () => reply({ok: false, error: '操作未完成，请检查输入、学校页面或本地数据库后重试'}));
    return true;
  });
  chrome.runtime.onStartup.addListener(() => {
    void serial(async () => { await record('BROWSER_STARTED', 'BROWSER', Date.now()); await reminders(); }).catch(() => {});
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === PLAN_ALARM) void serial(reminders).catch(() => {}); });
  void serial(async () => {
    try { await record('EXTENSION_INITIALIZED', 'WORKER', Date.now()); await reminders(); }
    finally { recovering = false; changed(); }
  }).catch(() => {});

  return (eventType: RuntimeEventType, at: number, key?: string, seat?: SeatTarget) => {
    void serial(async () => { await record(eventType, 'TASK', at, key, seat, 'daily-fixed-seat'); changed(); }).catch(() => {});
  };
}
