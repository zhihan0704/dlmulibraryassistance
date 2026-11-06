/**
 * 预约前置检查（Phase 7 任务四）
 *
 * 任务四的核心要求：**不得把下列四件事混成同一个状态**
 *   ① 座位空档（时间上有没有空闲）
 *   ② 预约记录状态（resvStatus 的相位）
 *   ③ 用户签到状态
 *   ④ 用户预约资格
 *
 * 本模块把它们各自放在 `dimensions` 的独立字段里，
 * 顶层只给一个汇总结论 `ready`（**恒为 false**，因为没有一项能独立证明可提交）。
 */

import {decideSeatStatus, type SeatLike, type SeatVerdict} from './seat-status';
import {classifyRecordPhase, type RecordLike} from './resv-lifecycle';
import type {Grade} from './resv-decoding';

export type CheckState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NEEDS_REVIEW';

export interface PreflightCheck {
  id: string;
  label: string;
  state: CheckState;
  grade: Grade;
  detail: string;
}

export interface PreflightDimensions {
  /** ① 座位空档：由 decideSeatStatus 给出，只谈"时间上能不能用" */
  timeWindow: {verdict: SeatVerdict; freeMinutes: number; detail: string};
  /** ② 预约记录状态：这条记录本身处在哪个相位 */
  recordStatus: {phase: string; grade: Grade; detail: string};
  /** ③ 签到状态：只看记录上有没有已签到位，不代表用户真的到了 */
  checkinStatus: {present: boolean; grade: Grade; detail: string};
  /** ④ 用户资格 */
  eligibility: {value: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN'; grade: Grade; detail: string};
}

export interface PreflightInput {
  seat: SeatLike;
  /** 用户想约的记录信息（用于记录相位判断）；没有则视为新预约 */
  existingRecord?: RecordLike | null;
  reservationDate: string;
  start: string;
  end: string;
  nowMinute: number;
  minDurationMinutes?: number | null;
  eligibility?: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN';
}

export interface PreflightResult {
  /** 恒为 false —— 本模块存在的意义就是说明"为什么还不能提交" */
  ready: false;
  checks: PreflightCheck[];
  blockers: string[];
  dimensions: PreflightDimensions;
  /** 恒为 false：不提供任何真实提交能力 */
  executesRealReservation: false;
}

export function reservationPreflight(input: PreflightInput): PreflightResult {
  const checks: PreflightCheck[] = [];
  const blockers: string[] = [];
  const eligibility = input.eligibility ?? 'UNKNOWN';

  // ① 时间维度（座位空档）
  const status = decideSeatStatus({
    seat: input.seat,
    reservationDate: input.reservationDate,
    start: input.start,
    end: input.end,
    eligibility,
    minDurationMinutes: input.minDurationMinutes ?? null,
  });

  checks.push({
    id: 'time-window',
    label: '座位时间可用性',
    state:
      status.verdict === 'CLOSED' || status.verdict === 'OCCUPIED'
        ? 'FAIL'
        : status.verdict === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : status.verdict === 'AVAILABLE'
            ? 'PASS'
            : 'UNKNOWN',
    grade: status.grade,
    detail: `判决=${status.verdict}；空闲 ${status.freeMinutes}/${status.windowMinutes} 分钟；${status.reasons[0] ?? ''}`,
  });
  if (status.verdict === 'OCCUPIED' || status.verdict === 'CLOSED') blockers.push(`座位不可用：${status.reasons[0] ?? status.verdict}`);
  if (status.verdict === 'NEEDS_REVIEW') blockers.push('座位可用性依赖未确认规则（最短时长冲突）');

  // ② 预约记录状态（独立维度）
  const recordPhase = input.existingRecord
    ? classifyRecordPhase(input.existingRecord, input.nowMinute, input.reservationDate)
    : null;
  checks.push({
    id: 'record-status',
    label: '预约记录状态',
    state: recordPhase ? (recordPhase.phase === 'UNKNOWN' ? 'UNKNOWN' : 'PASS') : 'UNKNOWN',
    grade: recordPhase?.grade ?? 'D',
    detail: recordPhase ? `${recordPhase.phase}（${recordPhase.reason}）` : '未提供已有记录，视为新建预约',
  });

  // ③ 签到状态（独立维度，且明确不推断"人是否到场"）
  const checkedIn = Boolean(
    input.existingRecord && typeof input.existingRecord.resvStatus === 'number' && (input.existingRecord.resvStatus & 64) !== 0,
  );
  checks.push({
    id: 'checkin-status',
    label: '签到状态',
    state: 'UNKNOWN',
    grade: 'C',
    detail: checkedIn
      ? '记录上含「已签到」候选位（站点字典），但该位的因果未观测，不能据此确认用户已到场'
      : '记录上不含「已签到」候选位；不能据此判定用户未签到或违约',
  });
  blockers.push('签到状态无法从只读数据确认');

  // ④ 用户资格（独立维度）
  checks.push({
    id: 'eligibility',
    label: '用户预约资格',
    state: eligibility === 'ELIGIBLE' ? 'PASS' : eligibility === 'NOT_ELIGIBLE' ? 'FAIL' : 'UNKNOWN',
    grade: 'D',
    detail:
      eligibility === 'ELIGIBLE'
        ? '调用方声明资格可用（本模块无法独立核实）'
        : eligibility === 'NOT_ELIGIBLE'
          ? '资格不可用'
          : '资格未接入：违规次数、封禁状态、每日上限均未知',
  });
  if (eligibility !== 'ELIGIBLE') blockers.push('用户资格未知，不得判定为可预约');

  return {
    ready: false,
    checks,
    blockers,
    dimensions: {
      timeWindow: {
        verdict: status.verdict,
        freeMinutes: status.freeMinutes,
        detail: `窗口 ${status.windowMinutes} 分钟，空闲 ${status.freeMinutes} 分钟`,
      },
      recordStatus: {
        phase: recordPhase?.phase ?? 'NO_RECORD',
        grade: recordPhase?.grade ?? 'D',
        detail: recordPhase?.reason ?? '无已有记录',
      },
      checkinStatus: {
        present: checkedIn,
        grade: 'C',
        detail: '仅表示记录位；不代表用户实际到场',
      },
      eligibility: {
        value: eligibility,
        grade: 'D',
        detail: eligibility === 'UNKNOWN' ? '未接入' : '由调用方声明',
      },
    },
    executesRealReservation: false,
  };
}

/**
 * 四个维度的边界说明（供测试与文档引用）。
 * 任何把这几项合并成一个状态的做法都违反任务四。
 */
export const DIMENSION_BOUNDARIES = {
  timeWindow: '座位在该时段有没有空闲 —— 由 decideSeatStatus 判定',
  recordStatus: '这条预约记录处在生命周期的哪个相位 —— 由 classifyRecordPhase 判定',
  checkinStatus: '记录上是否有已签到位 —— 候选解释，不代表本人到场',
  eligibility: '用户是否具备预约资格 —— 完全未接入',
} as const;
