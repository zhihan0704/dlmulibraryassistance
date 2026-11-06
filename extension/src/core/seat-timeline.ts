import type {LiveSnapshot} from './live-seats';

export interface SeatTarget {
  roomId: number;
  devId: number;
  seatCode: string;
}
export interface TimeRange {startAt: string; endAt: string}
export interface MillisecondRange {start: number; end: number}
export type ObservationSource = 'MOCK' | 'LIVE_RESERVE' | 'OFFICIAL_VISIBLE' | 'HISTORICAL';
export type ObservationMode = 'MOCK' | 'LIVE';
export type SessionState = 'CONFIRMED' | 'LOST' | 'UNKNOWN';
export type SeatIntervalState = 'FREE' | 'OCCUPIED' | 'UNKNOWN';
export interface SeatTimelineSegment extends TimeRange {state: SeatIntervalState}
interface ObservationIdentity {
  target: SeatTarget;
  source: ObservationSource;
  observedAt: string;
}
export interface UnverifiedSeatTimeline extends ObservationIdentity {
  completeness: 'UNVERIFIED';
  reason: string;
}
/** A trusted adapter may assert completeness only after verifying the scope and status semantics. */
export interface CompleteSeatTimeline extends ObservationIdentity {
  completeness: 'COMPLETE';
  verificationRef: string;
  coverage: TimeRange;
  segments: readonly SeatTimelineSegment[];
}
export type SeatTimelineObservation = UnverifiedSeatTimeline | CompleteSeatTimeline;
export interface VerifiedSeatTimeline {
  target: SeatTarget;
  source: ObservationSource;
  observedAt: string;
  observedMs: number;
  verificationRef: string;
  coverage: MillisecondRange;
  segments: readonly (MillisecondRange & {state: SeatIntervalState})[];
}
export type TimelineInspection =
  | {state: 'VERIFIED'; timeline: VerifiedSeatTimeline}
  | {state: 'UNKNOWN' | 'STALE' | 'SESSION_LOST'; reason: string};
export interface InspectionContext {
  target: SeatTarget;
  mode: ObservationMode;
  session: SessionState;
  now: number;
  maxAgeMs?: number;
}
export const DEFAULT_AVAILABILITY_AGE_MS = 120_000;
const MAX_SEGMENTS = 10_000;

/** Absolute instants only. Offsetless server strings need a separately verified date/time contract. */
export function parseInstant(input: unknown): number | null {
  if (typeof input !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!parts) return null;
  const [, ys, ms, ds, hs, mins, ss, zone] = parts;
  const year = Number(ys), month = Number(ms), day = Number(ds);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (Number(hs) > 23 || Number(mins) > 59 || Number(ss) > 59) return null;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3)), offsetMinute = Number(zone.slice(4));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const instant = Date.parse(input);
  return Number.isFinite(instant) ? instant : null;
}
export function parseTimeRange(range: TimeRange | null | undefined): MillisecondRange | null {
  if (!range) return null;
  const start = parseInstant(range.startAt), end = parseInstant(range.endAt);
  return start !== null && end !== null && start < end ? {start, end} : null;
}
export function validSeatTarget(target: SeatTarget | null | undefined): target is SeatTarget {
  return !!target && Number.isSafeInteger(target.roomId) && target.roomId > 0 &&
    Number.isSafeInteger(target.devId) && target.devId > 0 && typeof target.seatCode === 'string' &&
    target.seatCode.trim() === target.seatCode && target.seatCode.length > 0 && target.seatCode.length <= 64;
}
export function sameSeat(a: SeatTarget | null | undefined, b: SeatTarget | null | undefined): boolean {
  return validSeatTarget(a) && validSeatTarget(b) && a.roomId === b.roomId && a.devId === b.devId && a.seatCode === b.seatCode;
}
export function covers(outer: MillisecondRange, inner: MillisecondRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}
export function allowedObservationSource(source: ObservationSource, mode: ObservationMode): boolean {
  return mode === 'MOCK' ? source === 'MOCK' : source === 'LIVE_RESERVE' || source === 'OFFICIAL_VISIBLE';
}
function validVerificationRef(ref: unknown): boolean {
  return typeof ref === 'string' && ref.length <= 200 && ref.trim().length > 0;
}
export function inspectSeatTimeline(input: SeatTimelineObservation | null | undefined, context: InspectionContext): TimelineInspection {
  if (context.mode === 'LIVE' && context.session === 'LOST') return {state: 'SESSION_LOST', reason: '会话失效'};
  if (context.mode === 'LIVE' && context.session !== 'CONFIRMED') return {state: 'UNKNOWN', reason: '当前会话未确认'};
  if (!input || !sameSeat(input.target, context.target) || !allowedObservationSource(input.source, context.mode)) {
    return {state: 'UNKNOWN', reason: '目标座位或证据来源不匹配'};
  }
  const observedMs = parseInstant(input.observedAt);
  const maxAgeMs = context.maxAgeMs ?? DEFAULT_AVAILABILITY_AGE_MS;
  if (observedMs === null || !Number.isFinite(context.now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || observedMs > context.now) {
    return {state: 'UNKNOWN', reason: '观察时间或数据时效配置无效'};
  }
  if (context.now - observedMs > maxAgeMs) return {state: 'STALE', reason: '座位观察已过期'};
  if (input.completeness !== 'COMPLETE' || !validVerificationRef(input.verificationRef)) {
    return {state: 'UNKNOWN', reason: '时间覆盖或座位状态语义未经核验'};
  }
  const coverage = parseTimeRange(input.coverage);
  if (!coverage || !Array.isArray(input.segments) || input.segments.length === 0 || input.segments.length > MAX_SEGMENTS) {
    return {state: 'UNKNOWN', reason: '时间覆盖数据不完整'};
  }
  const segments: (MillisecondRange & {state: SeatIntervalState})[] = [];
  for (const segment of input.segments) {
    const range = parseTimeRange(segment);
    if (!range || !covers(coverage, range) || !['FREE', 'OCCUPIED', 'UNKNOWN'].includes(segment.state)) {
      return {state: 'UNKNOWN', reason: '时段范围或状态无效'};
    }
    segments.push({...range, state: segment.state});
  }
  segments.sort((a, b) => a.start - b.start);
  let cursor = coverage.start;
  const canonical: typeof segments = [];
  for (const segment of segments) {
    if (segment.start !== cursor) return {state: 'UNKNOWN', reason: '座位时段存在缺口或重叠'};
    cursor = segment.end;
    const previous = canonical.at(-1);
    if (previous?.state === segment.state) previous.end = segment.end;
    else canonical.push(segment);
  }
  if (cursor !== coverage.end) return {state: 'UNKNOWN', reason: '座位时段没有覆盖所声明的范围'};
  return {state: 'VERIFIED', timeline: {
    target: {...input.target}, source: input.source, observedAt: input.observedAt, observedMs,
    verificationRef: input.verificationRef, coverage, segments: canonical,
  }};
}

/**
 * Phase 1 reserve capture has no verified coverage, raw status interpretation, or availability proof.
 * Keep only the matching identity and receipt time. Empty resvInfo is not an empty booking timeline.
 */
export function observeUnverifiedLiveSeat(snapshot: LiveSnapshot, target: SeatTarget): UnverifiedSeatTimeline | null {
  if (snapshot.source !== 'LIVE_RESERVE' || parseInstant(snapshot.capturedAt) === null || !validSeatTarget(target)) return null;
  const matching = snapshot.seats.filter(seat => sameSeat(target, {roomId: seat.roomId, devId: seat.devId, seatCode: seat.name}));
  if (matching.length !== 1) return null;
  return {target: {...target}, source: 'LIVE_RESERVE', observedAt: snapshot.capturedAt, completeness: 'UNVERIFIED', reason: '原始响应不证明完整时间覆盖或状态语义'};
}
