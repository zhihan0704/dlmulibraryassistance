import {
  alignedAtOrAfter, inspectBookingEvidence, type BookingRuleEvidence, type EligibilityEvidence,
} from './dynamic-booking-policy';
import {findFreeIntervals} from './free-interval-engine';
import type {LiveSnapshot} from './live-seats';
import {
  covers, observeUnverifiedLiveSeat, parseInstant, parseTimeRange, sameSeat, validSeatTarget,
  type InspectionContext, type MillisecondRange, type ObservationSource, type SeatTarget,
  type SeatTimelineObservation, type TimeRange,
} from './seat-timeline';

const MINUTE_MS = 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS;
const MAX_BACKUP_SEATS = 32;

export interface BookingPreferences {
  /** Date of the preferred start in Beijing. The requested end may be the following day. */
  date: string;
  primarySeat: SeatTarget;
  backupSeats: SeatTarget[];
  preferred: TimeRange;
  allowedWindow: TimeRange;
  minDurationMinutes: number;
  preferLonger: boolean;
  allowTimeAdjustment: boolean;
  allowBackupSeats: boolean;
  allowShorter: boolean;
}
export interface SeatDecisionEvidence {
  target: SeatTarget;
  observation: SeatTimelineObservation | null;
  rules: BookingRuleEvidence;
  eligibility: EligibilityEvidence;
}
export interface IntelligentBookingInput extends Omit<InspectionContext, 'target'> {
  preferences: BookingPreferences;
  evidence: readonly SeatDecisionEvidence[];
}
export interface BookingCandidate extends TimeRange {
  target: SeatTarget;
  durationMinutes: number;
  continuousMinutes: number;
  seatPriority: number;
  exactTime: boolean;
  shortened: boolean;
  observedAt: string;
  source: ObservationSource;
  state: 'READY';
  ruleStatus: 'VERIFIED';
  reasons: string[];
}
export interface BookingReview {
  target: SeatTarget;
  reason: string;
  state: 'NEEDS_REVIEW';
}
export interface IntelligentBookingResult {
  state: 'READY' | 'NEEDS_REVIEW' | 'NO_MATCH';
  reason: string;
  mode: InspectionContext['mode'];
  candidates: BookingCandidate[];
  reviews: BookingReview[];
  executesRealReservation: false;
}

function beijingTime(instant: number): string {
  return new Date(instant + BEIJING_OFFSET_MS).toISOString().replace(/Z$/, '+08:00');
}
function projectedSeat(value: unknown): SeatTarget {
  const seat = value as SeatTarget | null;
  if (!validSeatTarget(seat) || /[\u0000-\u001f\u007f]/.test(seat.seatCode)) throw Error('座位身份不完整');
  return {roomId: seat.roomId, devId: seat.devId, seatCode: seat.seatCode};
}
function projectedRange(value: unknown): TimeRange {
  const parsed = parseTimeRange(value as TimeRange | null);
  if (!parsed) throw Error('请输入包含完整日期和时区的有效时段');
  const range = {startAt: beijingTime(parsed.start), endAt: beijingTime(parsed.end)};
  if (!parseTimeRange(range)) throw Error('北京时间超出支持范围');
  return range;
}
function requiredFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw Error('预约偏好开关必须明确选择');
  return value;
}

/** Validate the input and copy only preference fields allowed in local storage and exports. */
export function validateBookingPreferences(input: unknown): BookingPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('预约偏好无效');
  const prefs = input as Record<string, unknown>;
  const primarySeat = projectedSeat(prefs.primarySeat);
  if (!Array.isArray(prefs.backupSeats) || prefs.backupSeats.length > MAX_BACKUP_SEATS) throw Error('备用座位列表无效');
  const backupSeats = prefs.backupSeats.map(projectedSeat);
  const allSeats = [primarySeat, ...backupSeats];
  if (allSeats.some((seat, i) => allSeats.slice(0, i).some(prior => sameSeat(seat, prior)))) throw Error('首选和备用座位不得重复');
  const preferred = projectedRange(prefs.preferred);
  const allowedWindow = projectedRange(prefs.allowedWindow);
  if (prefs.date !== preferred.startAt.slice(0, 10)) throw Error('首选日期必须与北京时间的首选开始日期一致');
  const requested = parseTimeRange(preferred)!;
  if (!covers(parseTimeRange(allowedWindow)!, requested)) throw Error('允许范围必须覆盖首选时段');
  const minDurationMinutes = prefs.minDurationMinutes;
  const requestedMinutes = (requested.end - requested.start) / MINUTE_MS;
  if (typeof minDurationMinutes !== 'number' || !Number.isInteger(minDurationMinutes) || minDurationMinutes <= 0 ||
      !Number.isInteger(requestedMinutes) || minDurationMinutes > requestedMinutes) throw Error('最短时长必须是正整数分钟且不超过首选时长');
  return {
    date: preferred.startAt.slice(0, 10), primarySeat, backupSeats, preferred, allowedWindow, minDurationMinutes,
    preferLonger: requiredFlag(prefs.preferLonger), allowTimeAdjustment: requiredFlag(prefs.allowTimeAdjustment),
    allowBackupSeats: requiredFlag(prefs.allowBackupSeats), allowShorter: requiredFlag(prefs.allowShorter),
  };
}

function configuredSeats(prefs: BookingPreferences): SeatTarget[] {
  return prefs.allowBackupSeats ? [prefs.primarySeat, ...prefs.backupSeats] : [prefs.primarySeat];
}

/** Current raw observations carry no verified coverage, rule or qualification. */
export function readOnlyBookingEvidence(snapshot: LiveSnapshot | null, preferences: BookingPreferences): SeatDecisionEvidence[] {
  const prefs = validateBookingPreferences(preferences);
  const valid = snapshot?.source === 'LIVE_RESERVE' && snapshot.apiPath === '/ic-web/reserve' &&
    snapshot.invalidRows === 0 && (snapshot.invalidIntervals ?? 0) === 0;
  return configuredSeats(prefs).map(target => ({
    target,
    observation: valid && snapshot ? observeUnverifiedLiveSeat(snapshot, target) : null,
    rules: {kind: 'UNKNOWN'},
    eligibility: {kind: 'UNKNOWN'},
  }));
}

/** Choose the closest aligned start with a stable earlier-start tie break. */
function nearestStart(first: number, latest: number, preferred: number, anchor: number, step: number): number {
  const afterLatest = alignedAtOrAfter(latest, anchor, step);
  const last = afterLatest > latest ? afterLatest - step : afterLatest;
  const afterPreferred = alignedAtOrAfter(preferred, anchor, step);
  const beforePreferred = afterPreferred - step;
  const closest = afterPreferred - preferred < preferred - beforePreferred ? afterPreferred : beforePreferred;
  return Math.max(first, Math.min(last, closest));
}

interface GapPlan {
  first: number;
  lastEnd: number;
  preferred: MillisecondRange;
  minimum: number;
  maximum: number;
  anchor: number;
  step: number;
  canMove: boolean;
}
function windowsForGap(plan: GapPlan): MillisecondRange[] {
  const {first, lastEnd, preferred, minimum, maximum, anchor, step, canMove} = plan;
  const longest = Math.floor(Math.min(maximum, lastEnd - first) / MINUTE_MS) * MINUTE_MS;
  if (longest < minimum) return [];
  const windows = new Map<number, MillisecondRange>();
  const preferredDuration = preferred.end - preferred.start;
  const preferredAligned = alignedAtOrAfter(preferred.start, anchor, step) === preferred.start;
  if (preferredAligned && preferred.start >= first && preferred.end <= lastEnd && preferredDuration >= minimum && preferredDuration <= longest) {
    windows.set(preferred.start, preferred);
  }
  const bestDurationStart = canMove ? nearestStart(first, lastEnd - longest, preferred.start, anchor, step) : first;
  windows.set(bestDurationStart, {start: bestDurationStart, end: bestDurationStart + longest});
  const near = canMove ? nearestStart(first, lastEnd - minimum, preferred.start, anchor, step) : first;
  const nearDuration = Math.floor(Math.min(maximum, lastEnd - near) / MINUTE_MS) * MINUTE_MS;
  const atNear = windows.get(near);
  if (nearDuration >= minimum && (!atNear || nearDuration > atNear.end - atNear.start)) windows.set(near, {start: near, end: near + nearDuration});
  return [...windows.values()];
}

function candidateReasons(candidate: BookingCandidate, prefs: BookingPreferences, preferred: MillisecondRange): string[] {
  const reasons = [candidate.seatPriority === 0 ? '首选座位' : `用户指定的第 ${candidate.seatPriority} 个备用座位`];
  reasons.push(candidate.exactTime ? '完全匹配首选时段' : '位于用户允许的调整范围内');
  if (candidate.shortened) reasons.push(`按你的偏好缩短 ${Math.round((preferred.end - preferred.start) / MINUTE_MS) - candidate.durationMinutes} 分钟，满足已核验最短时长`);
  else if (!candidate.exactTime) reasons.push('保留原计划时长');
  reasons.push(`有效范围内连续空档 ${candidate.continuousMinutes} 分钟`);
  reasons.push(prefs.preferLonger ? '同座位同等匹配时，优先保留更长时长' : '同座位同等匹配时，优先接近首选开始时间');
  reasons.push('当前数据、规则和预约资格均覆盖候选时段，可供人工核对');
  return reasons;
}

/** Rank only fully supported suggestions. READY denotes a time suggestion for manual review. */
export function rankBookingCandidates(input: IntelligentBookingInput): IntelligentBookingResult {
  const result: IntelligentBookingResult = {
    state: 'NEEDS_REVIEW', reason: '预约偏好或观察范围未核验', mode: input.mode,
    candidates: [], reviews: [], executesRealReservation: false,
  };
  if ((input.mode !== 'LIVE' && input.mode !== 'MOCK') || !Array.isArray(input.evidence)) return result;
  let prefs: BookingPreferences;
  try { prefs = validateBookingPreferences(input.preferences); } catch { return result; }
  const preferred = parseTimeRange(prefs.preferred)!;
  const allowedRange = prefs.allowTimeAdjustment ? prefs.allowedWindow : prefs.preferred;
  const window = parseTimeRange(allowedRange)!;
  const requested = preferred.end - preferred.start;
  for (const [seatPriority, target] of configuredSeats(prefs).entries()) {
    const matches = input.evidence.filter(evidence => sameSeat(target, evidence.target));
    if (matches.length !== 1) {
      result.reviews.push({target, state: 'NEEDS_REVIEW', reason: matches.length === 0 ? '尚未取得该座位的观察证据' : '该座位的观察来源无法唯一匹配'});
      continue;
    }
    const {observation, rules, eligibility} = matches[0];
    const checked = inspectBookingEvidence({...input, target, observation, rules, eligibility}, window);
    if (checked.state !== 'VERIFIED') {
      if (checked.state !== 'INELIGIBLE') result.reviews.push({target, state: 'NEEDS_REVIEW', reason: checked.reason});
      continue;
    }
    const gaps = findFreeIntervals(checked.timeline, allowedRange);
    if (gaps.state !== 'KNOWN') {
      result.reviews.push({target, state: 'NEEDS_REVIEW', reason: gaps.reason});
      continue;
    }
    const policyMin = Math.max(prefs.minDurationMinutes, checked.rules.minDurationMinutes) * MINUTE_MS;
    const minimum = prefs.allowShorter ? policyMin : Math.max(requested, policyMin);
    const maximum = Math.min(requested, checked.rules.maxDurationMinutes * MINUTE_MS);
    if (minimum > maximum) continue;
    const step = checked.rules.startStepMinutes * MINUTE_MS;
    for (const gap of gaps.intervals) {
      const effectiveStart = Math.max(gap.start, input.now);
      const first = prefs.allowTimeAdjustment ? alignedAtOrAfter(effectiveStart, checked.anchor, step) : preferred.start;
      if (first < effectiveStart || alignedAtOrAfter(first, checked.anchor, step) !== first) continue;
      for (const time of windowsForGap({first, lastEnd: gap.end, preferred, minimum, maximum, anchor: checked.anchor, step, canMove: prefs.allowTimeAdjustment})) {
        const candidate: BookingCandidate = {
          target, startAt: beijingTime(time.start), endAt: beijingTime(time.end),
          durationMinutes: (time.end - time.start) / MINUTE_MS,
          continuousMinutes: Math.floor((gap.end - effectiveStart) / MINUTE_MS), seatPriority,
          exactTime: time.start === preferred.start && time.end === preferred.end,
          shortened: time.end - time.start < requested, observedAt: beijingTime(checked.timeline.observedMs),
          source: checked.timeline.source, state: 'READY', ruleStatus: 'VERIFIED', reasons: [],
        };
        candidate.reasons = candidateReasons(candidate, prefs, preferred);
        result.candidates.push(candidate);
      }
    }
  }
  result.candidates.sort((a, b) => {
    const startA = parseInstant(a.startAt)!, startB = parseInstant(b.startAt)!;
    const priority = a.seatPriority - b.seatPriority || Number(b.exactTime) - Number(a.exactTime);
    const duration = b.durationMinutes - a.durationMinutes;
    const distance = Math.abs(startA - preferred.start) - Math.abs(startB - preferred.start);
    const continuous = b.continuousMinutes - a.continuousMinutes;
    return priority || (prefs.preferLonger ? duration || continuous || distance : distance || duration || continuous) || startA - startB;
  });
  if (result.candidates.length > 0) {
    result.state = 'READY';
    result.reason = '已有完整证据支持的时间建议，等待本人核对';
    if (result.reviews.some(review => sameSeat(review.target, prefs.primarySeat))) {
      for (const candidate of result.candidates) candidate.reasons.push('首选座位的证据待核验，此项仅是备选建议');
    }
  } else if (result.reviews.length > 0) {
    result.reason = '证据不足，暂不提供可执行的建议';
  } else {
    result.state = 'NO_MATCH';
    result.reason = '已核验的座位没有符合当前时段、时长和资格偏好的结果';
  }
  return result;
}
