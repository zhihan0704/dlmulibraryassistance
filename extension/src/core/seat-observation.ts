import type {LiveSnapshot} from './live-seats';
import {DEFAULT_AVAILABILITY_AGE_MS, parseInstant} from './seat-timeline';

export type SeatObservationSource = 'NETWORK' | 'DOM';
export type SeatObservationState = 'BASELINE' | 'CHANGED' | 'UNCHANGED' | 'STALE' | 'UNKNOWN' | 'SESSION_LOST' | 'SOURCE_UNAVAILABLE' | 'STOPPED';
export type SeatObservationChangeType = 'SEAT_CHANGED' | 'TIME_CHANGED' | 'RECORD_ADDED' | 'RECORD_REMOVED' | 'STATUS_CHANGED';
type InvalidState = 'UNKNOWN' | 'SESSION_LOST' | 'SOURCE_UNAVAILABLE';
interface SeatIdentity {
  key: string;
  name: string;
  roomId: number | null;
  devId: number | null;
}
export interface SeatFingerprint extends SeatIdentity {
  /** Exact canonical comparison value. Keep inside the content script. */
  canonical: string;
}
export interface SeatObservationFrame {
  source: SeatObservationSource;
  observedAt: string;
  seats: readonly SeatFingerprint[];
}
export interface DomSeatFingerprintInput {
  name: string;
  className: string;
  title: string;
  left: string;
  top: string;
  visibleTimes?: readonly string[];
}
export interface SeatObservationChange extends SeatIdentity {
  kind: 'ADDED' | 'REMOVED' | 'UPDATED';
  observedAt: string;
  /** Independent observation differences. These never encode a booking outcome. */
  changeTypes: readonly SeatObservationChangeType[];
}
export interface SeatObservationStatus {
  state: SeatObservationState;
  reason: string;
  source: SeatObservationSource | null;
  /** Capture time on this client. A retained timestamp does not imply current validity. */
  lastFreshAt: string | null;
  lastChangedAt: string | null;
  freshness: 'FRESH' | 'STALE' | 'UNKNOWN';
  accepted: boolean;
  duplicate: boolean;
  seatCount: number;
  observationCount: number;
  eventCount: number;
  /** Only changes from this call. Does not include page text, raw values, or fingerprints. */
  changes: SeatObservationChange[];
}
export interface SeatObservationMonitorOptions {
  maxAgeMs?: number;
  stopAt?: number;
  maxObservations?: number;
}

const MAX_SEATS = 2_000;
const MAX_REMEMBERED_CHANGES = 2 * MAX_SEATS;
const DEFAULT_MAX_OBSERVATIONS = 10_000;
const MAX_FIELD_LENGTH = 4_096;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function networkSeatKey(roomId: number, devId: number, name: string): string {
  return JSON.stringify([roomId, devId, name]);
}
export function domSeatKey(name: string): string {
  return name.trim();
}

function positiveId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}
function field(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) throw Error('座位观察字段格式无效');
  return value;
}
function seatName(value: unknown): string {
  const text = field(value).trim();
  if (!text || text.length > 64 || /[\u0000-\u001f\u007f]/.test(text)) throw Error('座位编号无效');
  return text;
}
function scalar(value: unknown): unknown {
  if (value === undefined) return ['missing'];
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return field(value);
  throw Error('座位观察含无法比较的原始字段');
}
function sortedUniqueSeats(rows: SeatFingerprint[]): SeatFingerprint[] {
  if (rows.length === 0 || rows.length > MAX_SEATS) throw Error('座位观察数量无效');
  const keys = new Set(rows.map(row => row.key));
  if (keys.size !== rows.length) throw Error('座位观察身份重复');
  return rows;
}

/** Compare the allowlisted response fields as observations, without interpreting status values. */
export function fingerprintNetwork(snapshot: LiveSnapshot): SeatObservationFrame {
  if (snapshot.source !== 'LIVE_RESERVE' || snapshot.apiPath !== '/ic-web/reserve' || snapshot.invalidRows !== 0 || (snapshot.invalidIntervals ?? 0) !== 0) {
    throw Error('响应来源不符或包含无效座位及时段，不能比较');
  }
  if (!Array.isArray(snapshot.seats) || snapshot.seats.length === 0 || snapshot.seats.length > MAX_SEATS) throw Error('座位观察数量无效');
  const seats = snapshot.seats.map(seat => {
    if (!positiveId(seat.roomId) || !positiveId(seat.devId)) throw Error('座位身份字段无效');
    const name = seatName(seat.name);
    const intervals = seat.resvIntervals.map(item => JSON.stringify([
      field(item.startTime), field(item.endTime), scalar(item.rawResvStatus === undefined ? item.resvStatus : item.rawResvStatus),
    ])).sort(lexical);
    return {
      key: networkSeatKey(seat.roomId, seat.devId, name), name, roomId: seat.roomId, devId: seat.devId,
      canonical: JSON.stringify([scalar(seat.openStart), scalar(seat.openEnd), scalar(seat.devStatus), scalar(seat.openState),
        scalar(seat.onlyView), seat.position ? [scalar(seat.position.x), scalar(seat.position.y)] : null, intervals]),
    };
  }).sort((a,b) => a.roomId - b.roomId || a.devId - b.devId || lexical(a.name,b.name));
  return {source: 'NETWORK', observedAt: snapshot.capturedAt, seats: sortedUniqueSeats(seats)};
}

function normalizedText(value: string): string {
  return field(value).trim().replace(/\s+/g, ' ');
}
function normalizedPosition(value: string): string {
  const text = normalizedText(value);
  const numeric = /^([+-]?(?:\d+\.?\d*|\.\d+))(%|px)?$/.exec(text);
  return numeric && Number.isFinite(Number(numeric[1])) ? String(Number(numeric[1])) + (numeric[2] ?? '') : text;
}

/** DOM seats are scoped to the current route by the caller. Raw title stays inside the fingerprint. */
export function fingerprintDom(rows: readonly DomSeatFingerprintInput[], observedAt: string): SeatObservationFrame {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_SEATS) throw Error('DOM 座位观察数量无效');
  const seats = rows.map((row: DomSeatFingerprintInput) => {
    const name = seatName(row.name);
    const classes = [...new Set(field(row.className).split(/\s+/).filter(Boolean))].sort(lexical);
    const visibleTimes = [...new Set((row.visibleTimes ?? []).map(normalizedText).filter(Boolean))].sort(lexical);
    return {
      key: domSeatKey(name), name, roomId: null, devId: null,
      canonical: JSON.stringify([classes, normalizedText(row.title), normalizedPosition(row.left), normalizedPosition(row.top), visibleTimes]),
    };
  }).sort((a,b) => lexical(a.name,b.name));
  return {source: 'DOM', observedAt, seats: sortedUniqueSeats(seats)};
}

type NetworkParts = [
  openStart: unknown, openEnd: unknown, devStatus: unknown, openState: unknown,
  onlyView: unknown, position: unknown, intervals: string[],
];
type DomParts = [
  classes: string[], title: string, left: string, top: string, visibleTimes: string[],
];

interface IntervalGroup {
  count: number;
  statuses: Map<string, number>;
}

function groupByIntervalTime(intervals: readonly string[]): Map<string, IntervalGroup> {
  const groups = new Map<string, IntervalGroup>();
  for (const interval of intervals) {
    const [start, end, status] = JSON.parse(interval) as [string, string, unknown];
    const time = JSON.stringify([start, end]);
    const statusKey = JSON.stringify(status);
    let group = groups.get(time);
    if (!group) {
      group = {count: 0, statuses: new Map()};
      groups.set(time, group);
    }
    group.count++;
    group.statuses.set(statusKey, (group.statuses.get(statusKey) ?? 0) + 1);
  }
  return groups;
}

function countIdenticalStatuses(before: IntervalGroup, after: IntervalGroup): number {
  let equal = 0;
  for (const [status, count] of before.statuses) {
    equal += Math.min(count, after.statuses.get(status) ?? 0);
  }
  return equal;
}

function compareNetworkParts(before: NetworkParts, after: NetworkParts): SeatObservationChangeType[] {
  const changes: SeatObservationChangeType[] = [];
  const openingChanged = JSON.stringify(before.slice(0, 2)) !== JSON.stringify(after.slice(0, 2));
  const seatStatusChanged = JSON.stringify(before.slice(2, 5)) !== JSON.stringify(after.slice(2, 5));
  if (JSON.stringify(before[5]) !== JSON.stringify(after[5])) changes.push('SEAT_CHANGED');

  const oldIntervals = groupByIntervalTime(before[6]);
  const newIntervals = groupByIntervalTime(after[6]);
  let added = false;
  let removed = false;
  let intervalStatusChanged = false;
  for (const [time, current] of newIntervals) {
    const previous = oldIntervals.get(time);
    if (!previous) {
      added = true;
      continue;
    }
    if (current.count > previous.count) added = true;
    if (current.count < previous.count) removed = true;
    if (countIdenticalStatuses(previous, current) < Math.min(previous.count, current.count)) {
      intervalStatusChanged = true;
    }
  }
  if ([...oldIntervals.keys()].some(time => !newIntervals.has(time))) removed = true;

  // Without reservation identity, changed time pairs are observed additions/removals.
  // A replacement changes the time set, without identifying a rescheduled booking.
  if (openingChanged || added && removed) changes.push('TIME_CHANGED');
  if (added) changes.push('RECORD_ADDED');
  if (removed) changes.push('RECORD_REMOVED');
  if (seatStatusChanged || intervalStatusChanged) changes.push('STATUS_CHANGED');
  return changes;
}

function titleTimes(title: string): string[] {
  return (title.match(/\b(?:\d{4}-\d{2}-\d{2}[ T])?(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g) ?? [])
    .sort(lexical);
}

function compareDomParts(before: DomParts, after: DomParts): SeatObservationChangeType[] {
  const changes: SeatObservationChangeType[] = [];
  if (JSON.stringify(before.slice(0, 4)) !== JSON.stringify(after.slice(0, 4))) changes.push('SEAT_CHANGED');
  if (JSON.stringify(before[4]) !== JSON.stringify(after[4])
    || JSON.stringify(titleTimes(before[1])) !== JSON.stringify(titleTimes(after[1]))) {
    changes.push('TIME_CHANGED');
  }
  // DOM presentation alone cannot establish record membership or reservation status.
  return changes;
}

function compareFingerprints(source: SeatObservationSource, before: SeatFingerprint, after: SeatFingerprint): SeatObservationChangeType[] {
  return source === 'NETWORK'
    ? compareNetworkParts(JSON.parse(before.canonical) as NetworkParts, JSON.parse(after.canonical) as NetworkParts)
    : compareDomParts(JSON.parse(before.canonical) as DomParts, JSON.parse(after.canonical) as DomParts);
}

function makeChange(
  seat: SeatIdentity,
  kind: SeatObservationChange['kind'],
  observedAt: string,
  changeTypes: readonly SeatObservationChangeType[] = ['SEAT_CHANGED'],
): SeatObservationChange {
  const {key, name, roomId, devId} = seat;
  return {key, name, roomId, devId, kind, observedAt, changeTypes};
}

function copyChange(change: SeatObservationChange): SeatObservationChange {
  return {...change, changeTypes: [...change.changeTypes]};
}

/** In-memory comparison and freshness for one channel and one page scope. Owns no timer or request. */
export class SeatObservationMonitor {
  private readonly maxAgeMs: number;
  private readonly stopAt: number | undefined;
  private readonly maxObservations: number;
  private latest: {source: SeatObservationSource; at: string; ms: number; seats: Map<string, SeatFingerprint>} | null = null;
  private state: SeatObservationState = 'SOURCE_UNAVAILABLE';
  private reason = '等待当前页面数据';
  private lastChangedAt: string | null = null;
  private changesBySeat = new Map<string, SeatObservationChange>();
  private observationCount = 0;
  private eventCount = 0;
  private sessionLostAt: number | null = null;
  private stopped = false;

  constructor(options: SeatObservationMonitorOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_AVAILABILITY_AGE_MS;
    this.stopAt = options.stopAt;
    this.maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0 ||
        (this.stopAt !== undefined && !Number.isFinite(this.stopAt)) ||
        !Number.isSafeInteger(this.maxObservations) || this.maxObservations <= 0) {
      throw Error('观察期限或次数配置无效');
    }
  }

  private atLimit(now: number): boolean {
    if (this.observationCount >= this.maxObservations || (this.stopAt !== undefined && now >= this.stopAt)) this.stopped = true;
    return this.stopped;
  }

  private result(now: number, accepted = false, duplicate = false, changes: SeatObservationChange[] = []): SeatObservationStatus {
    const stale = this.latest !== null && now - this.latest.ms > this.maxAgeMs;
    const validState = this.state === 'BASELINE' || this.state === 'CHANGED' || this.state === 'UNCHANGED';
    const validClock = Number.isFinite(now) && (!this.latest || now >= this.latest.ms);
    const state = this.stopped ? 'STOPPED' : validState && !validClock ? 'UNKNOWN' : validState && stale ? 'STALE' : this.state;
    const reason = state === 'STOPPED' ? '监测已停止或达到上限' : state === 'STALE' ? '最近观察已过期' : !validClock && validState ? '观察时钟无效' : this.reason;
    return {
      state, reason, source: this.latest?.source ?? null, lastFreshAt: this.latest?.at ?? null, lastChangedAt: this.lastChangedAt,
      freshness: stale ? 'STALE' : validState && validClock && !this.stopped && this.latest ? 'FRESH' : 'UNKNOWN',
      accepted, duplicate, seatCount: this.latest?.seats.size ?? 0, observationCount: this.observationCount, eventCount: this.eventCount,
      changes: changes.map(copyChange),
    };
  }

  observe(frame: SeatObservationFrame, now = Date.now()): SeatObservationStatus {
    if (this.atLimit(now)) return this.result(now);
    const ms = parseInstant(frame.observedAt);
    if (ms === null || !Number.isFinite(now) || ms > now || (frame.source !== 'NETWORK' && frame.source !== 'DOM')) {
      return this.invalidate('UNKNOWN', '观察来源或时间无效', now);
    }
    if (this.sessionLostAt !== null && ms <= this.sessionLostAt) return this.result(now, false, true);
    if (now - ms > this.maxAgeMs) {
      if (this.state !== 'SESSION_LOST' && (!this.latest || now - this.latest.ms > this.maxAgeMs)) {
        this.state = 'STALE';
        this.reason = '到达的观察已过期';
      }
      return this.result(now);
    }
    if (this.latest && frame.source !== this.latest.source) return this.invalidate('UNKNOWN', '观察通道发生变化', now);
    if (this.latest && ms < this.latest.ms) return this.result(now, false, true);
    if (!Array.isArray(frame.seats) || !frame.seats.length || frame.seats.length > MAX_SEATS) {
      return this.invalidate('SOURCE_UNAVAILABLE', '当前没有有效座位数据', now);
    }
    const seats = new Map<string, SeatFingerprint>();
    for (const seat of frame.seats) {
      if (!seat || !seat.key || typeof seat.canonical !== 'string' || seats.has(seat.key)) return this.invalidate('UNKNOWN', '座位观察无效或身份重复', now);
      seats.set(seat.key, {...seat});
    }
    if (this.latest && ms === this.latest.ms) {
      const same = seats.size === this.latest.seats.size && [...seats].every(([key, seat]) => this.latest?.seats.get(key)?.canonical === seat.canonical);
      return same ? this.result(now, false, true) : this.invalidate('UNKNOWN', '同一捕获时刻出现不一致的座位数据', now);
    }
    const baseline = !this.latest || this.sessionLostAt !== null;
    const changes: SeatObservationChange[] = [];
    if (!baseline && this.latest) {
      for (const [key, seat] of seats) {
        const old = this.latest.seats.get(key);
        if (!old) changes.push(makeChange(seat, 'ADDED', frame.observedAt));
        else if (old.canonical !== seat.canonical) {
          let types: SeatObservationChangeType[];
          try {
            types = compareFingerprints(frame.source, old, seat);
          } catch {
            return this.invalidate('UNKNOWN', '座位观察字段无法比较', now);
          }
          if (types.length) changes.push(makeChange(seat, 'UPDATED', frame.observedAt, types));
        }
      }
      for (const [key, seat] of this.latest.seats) if (!seats.has(key)) changes.push(makeChange(seat, 'REMOVED', frame.observedAt));
    }
    this.latest = {source: frame.source, at: frame.observedAt, ms, seats};
    this.sessionLostAt = null;
    this.observationCount++;
    this.state = baseline ? 'BASELINE' : changes.length ? 'CHANGED' : 'UNCHANGED';
    this.reason = baseline ? '取得有效观察基线' : changes.length ? '座位观察字段发生变化' : '新观察与上一条内容相同';
    if (baseline) return this.result(now, true);
    if (changes.length) {
      this.lastChangedAt = frame.observedAt;
      this.eventCount++;
      for (const change of changes) {
        this.changesBySeat.delete(change.key);
        this.changesBySeat.set(change.key, change);
      }
      while (this.changesBySeat.size > MAX_REMEMBERED_CHANGES) {
        const oldest = this.changesBySeat.keys().next().value;
        if (oldest === undefined) break;
        this.changesBySeat.delete(oldest);
      }
    }
    return this.result(now, true, false, changes);
  }

  status(now = Date.now()): SeatObservationStatus {
    this.atLimit(now);
    return this.result(now);
  }
  invalidate(state: InvalidState, reason?: string, now = Date.now()): SeatObservationStatus {
    if (this.atLimit(now)) return this.result(now);
    if (state !== 'SESSION_LOST' && this.sessionLostAt !== null) return this.result(now);
    if (state === 'SESSION_LOST' && Number.isFinite(now)) this.sessionLostAt = now;
    this.state = state;
    this.reason = reason ?? (state === 'SESSION_LOST' ? '会话失效，等待人工登录' : state === 'SOURCE_UNAVAILABLE' ? '等待当前页面数据' : '数据待核验');
    return this.result(now);
  }
  lastChangeFor(key: string): SeatObservationChange | null {
    const change = this.changesBySeat.get(key);
    return change ? copyChange(change) : null;
  }
  stop(): void {this.stopped = true}
  reset(): void {
    this.latest = null;
    this.state = 'SOURCE_UNAVAILABLE';
    this.reason = '等待当前页面数据';
    this.lastChangedAt = null;
    this.changesBySeat.clear();
    this.observationCount = 0;
    this.eventCount = 0;
    this.sessionLostAt = null;
    this.stopped = false;
  }
}
