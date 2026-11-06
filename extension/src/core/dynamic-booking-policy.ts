import {findFreeIntervals} from './free-interval-engine';
import {covers, DEFAULT_AVAILABILITY_AGE_MS, inspectSeatTimeline, parseInstant, parseTimeRange, sameSeat, type InspectionContext, type SeatTarget, type SeatTimelineObservation, type TimeRange} from './seat-timeline';

export type VerifiedPolicySource = 'OFFICIAL_RULES' | 'OFFICIAL_ELIGIBILITY' | 'MOCK';
interface TimedEvidence {
  evidenceRef: string;
  observedAt: string;
  appliesTo: TimeRange;
}
export type BookingRuleEvidence = {kind: 'UNKNOWN' | 'CONFLICT'} | (TimedEvidence & {
  kind: 'VERIFIED';
  source: 'OFFICIAL_RULES' | 'MOCK';
  roomId: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  startStepMinutes: number;
  stepAnchorAt: string;
});
export type EligibilityEvidence = {kind: 'UNKNOWN'} | (TimedEvidence & {
  kind: 'VERIFIED';
  source: 'OFFICIAL_ELIGIBILITY' | 'MOCK';
  target: SeatTarget;
  eligible: boolean;
});
export interface DynamicBookingInput extends InspectionContext {
  preferred: TimeRange;
  dynamicTime: {enabled: false} | {enabled: true; window: TimeRange};
  observation: SeatTimelineObservation | null;
  rules: BookingRuleEvidence;
  eligibility: EligibilityEvidence;
}
export interface BookingSuggestion {
  target: SeatTarget;
  startAt: string;
  endAt: string;
  mode: 'PREFERRED' | 'DYNAMIC_TIME';
  observedAt: string;
}
export interface DynamicBookingResult {
  state: 'SUGGESTED' | 'NO_MATCH' | 'UNKNOWN' | 'STALE' | 'SESSION_LOST' | 'NEEDS_REVIEW' | 'INELIGIBLE';
  reason: string;
  suggestion: BookingSuggestion | null;
  executesRealReservation: false;
}
const MINUTE_MS = 60_000;
const no = (state: DynamicBookingResult['state'], reason: string): DynamicBookingResult => ({state, reason, suggestion: null, executesRealReservation: false});
function freshEvidence(evidence: TimedEvidence, context: InspectionContext): boolean {
  const observed = parseInstant(evidence.observedAt);
  return typeof evidence.evidenceRef === 'string' && evidence.evidenceRef.trim().length > 0 &&
    observed !== null && observed <= context.now && context.now - observed <= (context.maxAgeMs ?? DEFAULT_AVAILABILITY_AGE_MS);
}
function alignedAtOrAfter(instant: number, anchor: number, step: number): number {
  return anchor + Math.ceil((instant - anchor) / step) * step;
}

/** A recommendation only. No action, request, fallback seat, or guessed availability. */
export function evaluateDynamicBooking(input: DynamicBookingInput): DynamicBookingResult {
  const preferred = parseTimeRange(input.preferred);
  const allowedWindow = input.dynamicTime.enabled ? input.dynamicTime.window : input.preferred;
  const window = parseTimeRange(allowedWindow);
  if (!preferred || !window || !covers(window, preferred)) return no('UNKNOWN', '预约时段或允许的调整范围无效');
  const inspected = inspectSeatTimeline(input.observation, input);
  if (inspected.state !== 'VERIFIED') return no(inspected.state, inspected.reason);
  const rules = input.rules;
  if (rules.kind === 'CONFLICT') return no('NEEDS_REVIEW', '预约规则存在未解决冲突');
  if (rules.kind !== 'VERIFIED' || rules.roomId !== input.target.roomId ||
      rules.source !== (input.mode === 'MOCK' ? 'MOCK' : 'OFFICIAL_RULES') || !freshEvidence(rules, input)) {
    return no('UNKNOWN', '预约规则来源、时效或范围未确认');
  }
  const ruleWindow = parseTimeRange(rules.appliesTo);
  const anchor = parseInstant(rules.stepAnchorAt);
  if (!ruleWindow || !covers(ruleWindow, window) || anchor === null ||
      ![rules.minDurationMinutes, rules.maxDurationMinutes, rules.startStepMinutes].every(v => Number.isSafeInteger(v) && v > 0 && v <= 1440) ||
      rules.minDurationMinutes > rules.maxDurationMinutes) {
    return no('UNKNOWN', '规则没有覆盖完整时段或缺少可核验的时长及对齐参数');
  }
  const eligibility = input.eligibility;
  if (eligibility.kind !== 'VERIFIED' || !sameSeat(eligibility.target, input.target) ||
      eligibility.source !== (input.mode === 'MOCK' ? 'MOCK' : 'OFFICIAL_ELIGIBILITY') || !freshEvidence(eligibility, input)) {
    return no('UNKNOWN', '本座位预约资格尚未确认');
  }
  const eligibilityWindow = parseTimeRange(eligibility.appliesTo);
  if (!eligibilityWindow || !covers(eligibilityWindow, window) || typeof eligibility.eligible !== 'boolean') return no('UNKNOWN', '资格证据不覆盖整个时段');
  if (!eligibility.eligible) return no('INELIGIBLE', '已核验证据显示不具备预约资格');
  const duration = preferred.end - preferred.start;
  if (duration % MINUTE_MS !== 0 || duration < rules.minDurationMinutes * MINUTE_MS || duration > rules.maxDurationMinutes * MINUTE_MS) {
    return no('NO_MATCH', '原请求时长不符合已核验规则，不自动缩短或延长');
  }
  const free = findFreeIntervals(inspected.timeline, allowedWindow);
  if (free.state === 'UNKNOWN') return no('UNKNOWN', free.reason);
  const step = rules.startStepMinutes * MINUTE_MS;
  const suggested = (start: number, mode: BookingSuggestion['mode']): DynamicBookingResult => ({
    state: 'SUGGESTED', reason: '已核验证据支持该座位时间建议',
    suggestion: {target: {...input.target}, startAt: new Date(start).toISOString(), endAt: new Date(start + duration).toISOString(), mode, observedAt: inspected.timeline.observedAt},
    executesRealReservation: false,
  });
  if (preferred.start >= input.now && alignedAtOrAfter(preferred.start, anchor, step) === preferred.start &&
      free.intervals.some(interval => covers(interval, preferred))) return suggested(preferred.start, 'PREFERRED');
  if (!input.dynamicTime.enabled) return no('NO_MATCH', '原时段不可用，未开启时间调整');
  for (const interval of free.intervals) {
    const start = alignedAtOrAfter(Math.max(interval.start, input.now), anchor, step);
    if (start + duration <= interval.end) return suggested(start, 'DYNAMIC_TIME');
  }
  return no('NO_MATCH', '同一座位在允许范围内没有符合原时长的空档');
}
