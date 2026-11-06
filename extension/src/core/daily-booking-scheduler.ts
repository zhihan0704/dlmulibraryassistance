/** Shanghai civil time for the current daily booking workflow (UTC+08:00). */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const MAX_EVIDENCE_AGE_MS = MINUTE_MS;

export type DailyPhase = 'PREPARE' | 'OPEN' | 'VERIFY';
export type DailyBookingMode = 'ASSISTED' | 'MOCK';

export interface DailySeatTemplate {
  floorName: string;
  roomName: string;
  seatCode: string;
  roomId: string;
  seatId: string;
  startTime: string;
  endTime: string;
  dayOffset: 1;
}

export interface DailyBookingConfig {
  enabled: boolean;
  mode: DailyBookingMode;
  target: DailySeatTemplate;
}

export interface BookingTargetIdentity {
  date: string;
  roomId: string;
  seatId: string;
  startAt: string | number;
  endAt: string | number;
}

export interface BookingTarget extends BookingTargetIdentity {
  floorName: string;
  roomName: string;
  seatCode: string;
  startAt: string;
  endAt: string;
}

export interface DailySchedule {
  day: string;
  prepareAt: number;
  openAt: number;
  verifyAt: number;
  target: BookingTarget;
  duplicateKey: string;
}

export interface DailyAlarm {
  phase: DailyPhase;
  when: number;
  schedule: DailySchedule;
}

export interface DailyPreflightEvidence {
  observedAt: number;
  duplicateKey: string;
  auth: 'VERIFIED' | 'UNKNOWN' | 'LOGIN_REQUIRED';
  rules: 'VERIFIED' | 'UNRESOLVED';
  seat: 'VERIFIED' | 'MISMATCH' | 'UNKNOWN';
  /** Count of verified active records matching the complete target. Null means unverified. */
  exactMatchCount: number | null;
}

export interface DailyRunCheckpoint {
  duplicateKey: string;
  state: 'NOT_ATTEMPTED' | 'ATTEMPTED' | 'UNCERTAIN' | 'SUCCEEDED' | 'DUPLICATE';
}

export type DailyRunAction = 'PREPARE' | 'ASSIST' | 'SUBMIT_MOCK' | 'OBSERVE' | 'STOP';
export type DailyRunReason =
  | 'DISABLED'
  | 'STALE_SCHEDULE'
  | 'OUTSIDE_WINDOW'
  | 'PREPARATION_WINDOW'
  | 'VERIFICATION_WINDOW'
  | 'EXACT_DUPLICATE'
  | 'ALREADY_ATTEMPTED'
  | 'ASSISTED_ONLY'
  | 'EVIDENCE_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'RULES_UNVERIFIED'
  | 'SEAT_UNVERIFIED'
  | 'MOCK_PREFLIGHT_PASSED';

export interface DailyRunInput {
  config: DailyBookingConfig;
  schedule: DailySchedule;
  nowMs: number;
  phase: DailyPhase;
  evidence?: DailyPreflightEvidence | null;
  previous?: DailyRunCheckpoint | null;
}

export interface DailyRunDecision {
  action: DailyRunAction;
  reason: DailyRunReason;
  duplicateKey: string;
}

const PHASES: DailyPhase[] = ['PREPARE', 'OPEN', 'VERIFY'];
const AT_MINUTE: Record<DailyPhase, number> = {PREPARE: 7 * 60 + 55, OPEN: 8 * 60, VERIFY: 8 * 60 + 1};
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('预约区域或座位标识无效');
  }
  return value.trim();
}

function validClock(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) throw new Error('调度时钟无效');
}

export function validateDailyBookingConfig(input: unknown): DailyBookingConfig {
  if (!input || typeof input !== 'object') throw new Error('调度配置无效');
  const config = input as Partial<DailyBookingConfig>;
  if (typeof config.enabled !== 'boolean' || (config.mode !== 'ASSISTED' && config.mode !== 'MOCK')) throw new Error('调度模式无效');
  const target = config.target;
  if (!target || target.dayOffset !== 1) throw new Error('只支持预约次日的固定座位');
  if (typeof target.startTime !== 'string' || typeof target.endTime !== 'string' || !TIME.test(target.startTime) || !TIME.test(target.endTime) || target.startTime >= target.endTime) {
    throw new Error('开始和结束时间必须是同日递增的北京时间');
  }
  return {
    enabled: config.enabled,
    mode: config.mode,
    target: {
      floorName: label(target.floorName), roomName: label(target.roomName), seatCode: label(target.seatCode),
      roomId: label(target.roomId), seatId: label(target.seatId), startTime: target.startTime, endTime: target.endTime, dayOffset: 1,
    },
  };
}

function shanghaiMidnight(nowMs: number): number {
  validClock(nowMs);
  return Math.floor((nowMs + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

function shanghaiDate(instant: number): string {
  return new Date(instant + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shanghaiWallInstant(value: string | number): number {
  if (typeof value === 'number') { validClock(value); return value; }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) throw new Error('预约时间缺少完整日期和时刻');
  const [, date, minute, second = '00', fraction = '', zone = '+08:00'] = match;
  if (!TIME.test(minute) || Number(second) > 59) throw new Error('预约时刻无效');
  const wall = `${date}T${minute}:${second}`;
  const wallAsUtc = Date.parse(`${wall}Z`);
  if (!Number.isFinite(wallAsUtc) || new Date(wallAsUtc).toISOString().slice(0, 19) !== wall) throw new Error('预约日期无效');
  const instant = Date.parse(`${wall}${fraction}${zone}`);
  validClock(instant);
  return instant;
}

export function bookingTargetKey(target: BookingTargetIdentity): string {
  const start = shanghaiWallInstant(target.startAt);
  const end = shanghaiWallInstant(target.endAt);
  if (!DATE.test(target.date) || shanghaiDate(start) !== target.date || end <= start) throw new Error('预约日期和时段不匹配');
  return JSON.stringify([target.date, label(target.roomId), label(target.seatId), start, end]);
}

export function sameBookingTarget(left: BookingTargetIdentity, right: BookingTargetIdentity): boolean {
  try { return bookingTargetKey(left) === bookingTargetKey(right); }
  catch { return false; }
}

/** Visible rows only count after the caller has established active status and record identity. */
export interface VerifiedVisibleBooking {
  date: string;
  floorName: string;
  roomName: string;
  seatCode: string;
  startAt: string | number;
  endAt: string | number;
  active: boolean;
  verified: boolean;
}

export function countVerifiedTargetMatches(target: BookingTarget, rows: VerifiedVisibleBooking[]): number {
  return rows.filter(row => row.active === true && row.verified === true &&
    row.floorName.trim() === target.floorName && row.roomName.trim() === target.roomName && row.seatCode.trim() === target.seatCode &&
    sameBookingTarget(target, {...row, roomId: target.roomId, seatId: target.seatId})).length;
}

export function getDailySchedule(input: DailyBookingConfig, nowMs = Date.now()): DailySchedule {
  const config = validateDailyBookingConfig(input);
  const midnight = shanghaiMidnight(nowMs);
  const day = shanghaiDate(midnight);
  const date = shanghaiDate(midnight + DAY_MS);
  const {floorName, roomName, seatCode, roomId, seatId, startTime, endTime} = config.target;
  const target: BookingTarget = {
    date, floorName, roomName, seatCode, roomId, seatId,
    startAt: `${date}T${startTime}:00+08:00`, endAt: `${date}T${endTime}:00+08:00`,
  };
  return {
    day,
    prepareAt: midnight + AT_MINUTE.PREPARE * MINUTE_MS,
    openAt: midnight + AT_MINUTE.OPEN * MINUTE_MS,
    verifyAt: midnight + AT_MINUTE.VERIFY * MINUTE_MS,
    target,
    duplicateKey: bookingTargetKey(target),
  };
}

function phaseStart(schedule: DailySchedule, phase: DailyPhase): number {
  if (phase === 'PREPARE') return schedule.prepareAt;
  if (phase === 'OPEN') return schedule.openAt;
  return schedule.verifyAt;
}

/** Plan only future occurrences. A restart never fills in a missed opening or preparation. */
export function nextDailyAlarms(config: DailyBookingConfig, nowMs = Date.now()): DailyAlarm[] {
  if (!config.enabled) return [];
  const today = getDailySchedule(config, nowMs);
  const tomorrow = getDailySchedule(config, nowMs + DAY_MS);
  return PHASES.map(phase => {
    const schedule = phaseStart(today, phase) > nowMs ? today : tomorrow;
    return {phase, when: phaseStart(schedule, phase), schedule};
  }).sort((left, right) => left.when - right.when);
}

export function isDailyPhaseWindow(schedule: DailySchedule, phase: DailyPhase, nowMs: number): boolean {
  if (!PHASES.includes(phase) || !Number.isSafeInteger(nowMs)) return false;
  const end = phase === 'PREPARE' ? schedule.openAt : phase === 'OPEN' ? schedule.verifyAt : schedule.verifyAt + MINUTE_MS;
  return nowMs >= phaseStart(schedule, phase) && nowMs < end;
}

function isFreshTargetEvidence(input: DailyRunInput): boolean {
  const {evidence, nowMs, schedule} = input;
  return !!evidence && evidence.duplicateKey === schedule.duplicateKey && Number.isSafeInteger(evidence.observedAt) &&
    evidence.observedAt <= nowMs && evidence.observedAt >= nowMs - MAX_EVIDENCE_AGE_MS;
}

/** Pure decision only. The worker must persist ATTEMPTED before executing its mock adapter. */
export function decideDailyRun(input: DailyRunInput): DailyRunDecision {
  const {config, schedule, nowMs, phase, evidence, previous} = input;
  const decide = (action: DailyRunAction, reason: DailyRunReason): DailyRunDecision => ({action, reason, duplicateKey: schedule.duplicateKey});
  if (!config.enabled) return decide('STOP', 'DISABLED');
  let current: DailySchedule;
  try { current = getDailySchedule(config, nowMs); }
  catch { return decide('STOP', 'STALE_SCHEDULE'); }
  if (schedule.day !== current.day || schedule.duplicateKey !== current.duplicateKey ||
      schedule.prepareAt !== current.prepareAt || schedule.openAt !== current.openAt || schedule.verifyAt !== current.verifyAt ||
      schedule.target.floorName !== current.target.floorName || schedule.target.roomName !== current.target.roomName ||
      schedule.target.seatCode !== current.target.seatCode ||
      !sameBookingTarget(schedule.target, current.target)) return decide('STOP', 'STALE_SCHEDULE');
  if (!isDailyPhaseWindow(current, phase, nowMs)) return decide('STOP', 'OUTSIDE_WINDOW');
  if (phase === 'PREPARE') return decide('PREPARE', 'PREPARATION_WINDOW');
  if (phase === 'VERIFY') return decide('OBSERVE', 'VERIFICATION_WINDOW');
  if (previous?.duplicateKey === schedule.duplicateKey && previous.state !== 'NOT_ATTEMPTED') return decide('STOP', 'ALREADY_ATTEMPTED');
  const fresh = isFreshTargetEvidence(input);
  if (fresh && evidence?.auth === 'VERIFIED' && typeof evidence.exactMatchCount === 'number' && Number.isSafeInteger(evidence.exactMatchCount) && evidence.exactMatchCount > 0) {
    return decide('STOP', 'EXACT_DUPLICATE');
  }
  // No production action exists. An unresolved assisted slot remains useful as a reminder.
  if (config.mode === 'ASSISTED') return decide('ASSIST', 'ASSISTED_ONLY');
  if (!fresh || !evidence || evidence.exactMatchCount !== 0) return decide('STOP', 'EVIDENCE_UNAVAILABLE');
  if (evidence.auth !== 'VERIFIED') return decide('STOP', 'AUTH_REQUIRED');
  if (evidence.rules !== 'VERIFIED') return decide('STOP', 'RULES_UNVERIFIED');
  if (evidence.seat !== 'VERIFIED') return decide('STOP', 'SEAT_UNVERIFIED');
  return decide('SUBMIT_MOCK', 'MOCK_PREFLIGHT_PASSED');
}

export interface DailyMockAdapter {
  /** Atomically claim this target and persist ATTEMPTED before any simulated write. */
  claimAttempt(checkpoint: DailyRunCheckpoint): Promise<boolean>;
  saveCheckpoint(checkpoint: DailyRunCheckpoint): Promise<void>;
  submitMock(target: BookingTarget, signal: AbortSignal): Promise<void>;
  now(): number;
}

export interface DailyMockResult {
  decision: DailyRunDecision;
  checkpoint: DailyRunCheckpoint | null;
  result: 'SKIPPED' | 'CLAIM_HELD' | 'AWAITING_VERIFICATION' | 'UNCERTAIN' | 'VERIFIED';
}

/** Injectable simulation runner. Its only submission dependency is the caller's mock adapter. */
export async function executeDailyMock(input: DailyRunInput, adapter: DailyMockAdapter, timeoutMs = 3000): Promise<DailyMockResult> {
  const decision = decideDailyRun(input);
  const {schedule, previous, evidence} = input;
  const prior = previous?.duplicateKey === schedule.duplicateKey ? previous : null;
  if (input.config.mode !== 'MOCK') return {decision, checkpoint: prior, result: 'SKIPPED'};
  if (decision.action === 'OBSERVE' && (prior?.state === 'ATTEMPTED' || prior?.state === 'UNCERTAIN') &&
      evidence?.auth === 'VERIFIED' && evidence.exactMatchCount === 1 && isFreshTargetEvidence(input)) {
    const checkpoint: DailyRunCheckpoint = {duplicateKey: schedule.duplicateKey, state: 'SUCCEEDED'};
    await adapter.saveCheckpoint(checkpoint);
    return {decision, checkpoint, result: 'VERIFIED'};
  }
  if (decision.action !== 'SUBMIT_MOCK') return {decision, checkpoint: prior, result: 'SKIPPED'};
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('模拟提交时限无效');

  const checkpoint: DailyRunCheckpoint = {duplicateKey: schedule.duplicateKey, state: 'ATTEMPTED'};
  if (!await adapter.claimAttempt(checkpoint)) return {decision, checkpoint: prior, result: 'CLAIM_HELD'};
  const nowMs = adapter.now();
  const recheck = decideDailyRun({...input, nowMs});
  if (recheck.action !== 'SUBMIT_MOCK') return {decision: recheck, checkpoint, result: 'SKIPPED'};

  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('模拟提交结果未明确')); abort.abort(); }, Math.min(timeoutMs, schedule.verifyAt - nowMs));
    });
    await Promise.race([Promise.resolve().then(() => adapter.submitMock(schedule.target, abort.signal)), timeout]);
    const completedAt = adapter.now();
    if (completedAt >= schedule.verifyAt || completedAt - nowMs >= timeoutMs || completedAt < nowMs) throw new Error('模拟提交完成时间超出有效窗口');
    return {decision, checkpoint, result: 'AWAITING_VERIFICATION'};
  } catch {
    const uncertain: DailyRunCheckpoint = {duplicateKey: schedule.duplicateKey, state: 'UNCERTAIN'};
    await adapter.saveCheckpoint(uncertain);
    return {decision, checkpoint: uncertain, result: 'UNCERTAIN'};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
