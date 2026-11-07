import {validateBookingPreferences, type BookingPreferences} from '../core/intelligent-booking';
import {parseInstant, type SeatTarget} from '../core/seat-timeline';
import {normalizeRuntimeEvent, normalizeRuntimeSnapshot, shanghaiTimestamp, type RuntimeEvent, type RuntimeSnapshot} from '../core/runtime-health';

export const ASSISTANT_PLAN_LIMIT = 100;
export const RUNTIME_EVENT_LIMIT = 500;
export const RUNTIME_RETENTION_MS = 30 * 86_400_000;
const CREDENTIAL_LABEL = /cookie|token|password|authorization|bearer|sessionid|账号|密码|凭据|学号/i;

export type PlanVerification = 'PENDING' | 'VERIFIED' | 'NEEDS_REVIEW';
export interface AssistantPlanInput {
  id: string;
  preferences: BookingPreferences;
  priority: 1 | 2 | 3;
  reminderAt: string | null;
  floorName?: string;
  roomName?: string;
}

export interface AssistantPlan extends AssistantPlanInput {
  revision: string;
  verification: PlanVerification;
  observedAt?: string;
}

export interface RuntimeEventFilter {
  date?: string;
  seat?: SeatTarget | string;
  task?: string;
  limit?: number;
}

export interface AssistantBackupPayload {
  preferences: BookingPreferences | null;
  plans: AssistantPlanInput[];
  notificationsEnabled: boolean;
}

export interface AssistantBackup {
  schemaVersion: 1;
  kind: 'DLMU_ASSISTANT_CONFIG';
  exportedAt: string;
  payload: AssistantBackupPayload;
  sha256: string;
}

export function objectValue(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(error);
  return value as Record<string, unknown>;
}

export function beijingTimestamp(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || !Number.isFinite(new Date(epoch).getTime())) throw Error('时间无效');
  return shanghaiTimestamp(epoch);
}

function zonedTime(value: unknown): string {
  const instant = parseInstant(value);
  if (instant === null) throw Error('需要含完整日期和时区的时间');
  return beijingTimestamp(instant);
}

export function validatePlanId(value: unknown): string {
  if (typeof value !== 'string' || !/^plan:\d{4}-\d{2}-\d{2}$/.test(value) || parseInstant(`${value.slice(5)}T00:00:00+08:00`) === null) {
    throw Error('计划日期无效');
  }
  return value;
}

function seatLabel(value: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,31}$/u.test(value) || CREDENTIAL_LABEL.test(value)) throw Error('座位编号包含无效内容');
  return value;
}

function projectSeat(seat: SeatTarget): SeatTarget {
  return {roomId: seat.roomId, devId: seat.devId, seatCode: seatLabel(seat.seatCode)};
}

export function normalizePreferences(value: unknown): BookingPreferences {
  const input = validateBookingPreferences(value);
  return {
    date: input.date, primarySeat: projectSeat(input.primarySeat), backupSeats: input.backupSeats.map(projectSeat),
    preferred: input.preferred, allowedWindow: input.allowedWindow,
    minDurationMinutes: input.minDurationMinutes, preferLonger: input.preferLonger, allowTimeAdjustment: input.allowTimeAdjustment,
    allowBackupSeats: input.allowBackupSeats, allowShorter: input.allowShorter,
  };
}

function optionalLocation(value: unknown, floor: boolean): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const pattern = floor ? /^(?:第)?(?:[一二三四五六七八九十零两]+|[0-9]{1,2})楼$/ : /^[\p{L}\p{N}][\p{L}\p{N} ()（）·_-]{0,47}$/u;
  if (typeof value !== 'string' || !pattern.test(value) || CREDENTIAL_LABEL.test(value)) throw Error('楼层或区域名称无效');
  return value;
}

/** Plans are user configuration. Imported verification, raw text, and arbitrary IDs are ignored. */
export function normalizePlanInput(value: unknown): AssistantPlanInput {
  const input = objectValue(value, '计划配置无效');
  const preferences = normalizePreferences(input.preferences);
  const id = validatePlanId(`plan:${preferences.date}`);
  if (input.id !== undefined && input.id !== id) throw Error('计划编号与日期不一致');
  const priority = input.priority ?? 2;
  if (priority !== 1 && priority !== 2 && priority !== 3) throw Error('预约优先级无效');
  const reminderAt = input.reminderAt === null || input.reminderAt === undefined ? null : zonedTime(input.reminderAt);
  if (reminderAt && Date.parse(reminderAt) >= Date.parse(preferences.preferred.endAt)) throw Error('提醒须早于预约时段结束');
  const floorName = optionalLocation(input.floorName, true), roomName = optionalLocation(input.roomName, false);
  return {id, preferences, priority, reminderAt, ...(floorName ? {floorName} : {}), ...(roomName ? {roomName} : {})};
}

export function normalizeHealthSnapshot(value: unknown, now = Date.now()): RuntimeSnapshot {
  const snapshot = normalizeRuntimeSnapshot(value);
  if (Date.parse(snapshot.capturedAt) > now) throw Error('健康摘要观察时间晚于当前时刻');
  return snapshot;
}

export function normalizeStoredEvent(value: unknown): RuntimeEvent {
  const event = normalizeRuntimeEvent(value);
  const taskDate = event.relatedTask?.startsWith('plan:') ? event.relatedTask.slice(5) : null;
  return {
    ...event,
    relatedSeat: event.relatedSeat && !CREDENTIAL_LABEL.test(event.relatedSeat.seatCode) ? event.relatedSeat : null,
    relatedTask: taskDate && parseInstant(`${taskDate}T00:00:00+08:00`) === null ? null : event.relatedTask,
  };
}

export function normalizeBackupPayload(value: unknown): AssistantBackupPayload {
  const input = objectValue(value, '配置备份内容无效');
  if (Object.keys(input).some(key => !['preferences', 'plans', 'notificationsEnabled'].includes(key)) ||
      !Array.isArray(input.plans) || input.plans.length > ASSISTANT_PLAN_LIMIT || typeof input.notificationsEnabled !== 'boolean') {
    throw Error('配置备份字段无效');
  }
  const plans = input.plans.map(normalizePlanInput);
  if (new Set(plans.map(plan => plan.id)).size !== plans.length) throw Error('配置备份含重复日期');
  return {preferences: input.preferences === null ? null : normalizePreferences(input.preferences), plans, notificationsEnabled: input.notificationsEnabled};
}
