/**
 * 座位状态判断模块（Phase 5）
 *
 * 分两层，刻意分开：
 *
 * 1) `siteSeatClass()` —— **复现网页自身的分类**（green / yellowGreen / yellow / gray）。
 *    这是对页面行为的建模，已用 5 组不同窗口（6 个样本）的现场证据逐座位验证（见 docs）。
 *    它回答的是「网页会把这个座位画成什么颜色」，不是「你能不能约」。
 *
 * 2) `decideSeatStatus()` —— **对外判决**（AVAILABLE / OCCUPIED / CLOSED / UNKNOWN / NEEDS_REVIEW）。
 *    只在证据充分时给结论；依赖未确认条件的，一律降级为 UNKNOWN / NEEDS_REVIEW。
 *
 * 硬约束：
 *  - devStatus 与 openState **不参与**任何判决（前者已被证明与可约性无关，后者样本全为 1）。
 *  - UNKNOWN 绝不自动变成 AVAILABLE。
 *  - 最短预约时长存在来源冲突（接口 30 分钟 vs 帮助页 1 小时），凡依赖它的结论
 *    默认按冲突处理 → NEEDS_REVIEW。
 */

import {freeGaps, type FreeGap, type ResvIntervalLike} from './free-time';

export type SiteSeatClass = 'green' | 'yellowGreen' | 'yellow' | 'gray';
export type SeatVerdict = 'AVAILABLE' | 'OCCUPIED' | 'CLOSED' | 'UNKNOWN' | 'NEEDS_REVIEW';
export type EvidenceGrade = 'A' | 'B' | 'C' | 'D';

export interface SeatLike {
  openStart: string | null;
  openEnd: string | null;
  resvIntervals: ResvIntervalLike[];
  devStatus?: unknown;
  openState?: unknown;
}

export interface StatusInput {
  seat: SeatLike;
  /** 用户选择的预约日期 YYYY-MM-DD */
  reservationDate: string;
  /** HH:MM */
  start: string;
  end: string;
  /** 资格：未提供视为 UNKNOWN */
  eligibility?: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN';
  /**
   * 最短预约时长（分钟）。
   * - 传 null / 不传：表示「未确认」，依赖它的判断一律 NEEDS_REVIEW
   * - 传数字：按该值判断
   */
  minDurationMinutes?: number | null;
}

export interface StatusResult {
  verdict: SeatVerdict;
  grade: EvidenceGrade;
  windowMinutes: number;
  freeMinutes: number;
  longestGapMinutes: number;
  gaps: FreeGap[];
  reasons: string[];
  /** 该判决是否依赖「最短时长」这一存在冲突的参数 */
  dependsOnMinDuration: boolean;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function toMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

/** 只保留「所选日期」的预约区间（接口返回的是含日期的完整时间戳） */
export function intervalsOnDate(seat: SeatLike, date: string): ResvIntervalLike[] {
  return seat.resvIntervals.filter((i) => typeof i.startTime === 'string' && i.startTime.slice(0, 10) === date);
}

/**
 * 复现网页自身的座位分类。
 *
 * 规则（由 5 组现场证据（6 个样本）反推并逐座位验证，阈值 30 分钟唯一可行）：
 *  - gray      : 不在开放时段内 / 窗口非法
 *  - green     : 整个窗口都空闲（窗口内无任何预约）
 *  - yellowGreen: 不是整窗空闲，但窗口内存在 ≥ minDuration 的连续空档
 *  - yellow    : 不是整窗空闲，且没有任何 ≥ minDuration 的连续空档
 */
export function siteSeatClass(
  seat: SeatLike,
  date: string,
  start: string,
  end: string,
  minDurationMinutes = 30,
): SiteSeatClass {
  if (!DATE.test(date) || !CLOCK.test(start) || !CLOCK.test(end)) return 'gray';
  if (!seat.openStart || !seat.openEnd) return 'gray';
  const ws = toMinutes(start);
  const we = toMinutes(end);
  const openS = toMinutes(seat.openStart);
  const openE = toMinutes(seat.openEnd);
  if (we <= ws) return 'gray';
  if (ws < openS || we > openE) return 'gray';

  const gaps = freeGaps({...seat, resvIntervals: intervalsOnDate(seat, date)}, ws);
  const clipped = gaps
    .map((g) => ({start: Math.max(toMinutes(g.start), ws), end: Math.min(toMinutes(g.end), we)}))
    .filter((g) => g.end > g.start);
  const freeTotal = clipped.reduce((s, g) => s + (g.end - g.start), 0);

  if (freeTotal >= we - ws) return 'green';
  if (clipped.some((g) => g.end - g.start >= minDurationMinutes)) return 'yellowGreen';
  return 'yellow';
}

/**
 * 对外判决。
 *
 * 证据分级：
 *  - CLOSED   : B（窗口完全落在开放时段外，直接可判）
 *  - OCCUPIED : B（窗口内空闲时间 = 0，无论最短时长是 30 还是 60 都约不了）
 *  - AVAILABLE: 仅当「整窗空闲 + 资格已确认 + 最短时长无冲突」同时成立；现实中几乎不会触发
 *  - NEEDS_REVIEW: 结论依赖最短时长（存在 30 vs 60 的来源冲突）
 *  - UNKNOWN  : 其余一切情况（默认）
 */
export function decideSeatStatus(input: StatusInput): StatusResult {
  const {seat, reservationDate, start, end} = input;
  const reasons: string[] = [];
  const min = input.minDurationMinutes ?? null;
  const eligibility = input.eligibility ?? 'UNKNOWN';

  const pick = (verdict: SeatVerdict, grade: EvidenceGrade, extra: Partial<StatusResult> = {}): StatusResult => ({
    verdict,
    grade,
    windowMinutes: 0,
    freeMinutes: 0,
    longestGapMinutes: 0,
    gaps: [],
    reasons,
    dependsOnMinDuration: false,
    ...extra,
  });

  // 1. 输入校验
  if (!DATE.test(reservationDate) || !CLOCK.test(start) || !CLOCK.test(end)) {
    reasons.push('日期或时间格式无效');
    return pick('UNKNOWN', 'D');
  }
  const ws = toMinutes(start);
  const we = toMinutes(end);
  /** 结束时间不晚于开始时间 → 视为跨日窗口（例如 23:00–01:00） */
  const crossesDay = we <= ws;
  const windowMinutes = crossesDay ? 1440 - ws + we : we - ws;
  if (crossesDay) reasons.push('跨日窗口（结束时间不晚于开始时间）');

  // 2. 与开放时段的关系：分三种，不能一概而论
  //    - 完全在外  → CLOSED（确定）
  //    - 部分越界  → NEEDS_REVIEW（系统是否允许/截断未验证，不得直接判 CLOSED）
  //    - 完全在内  → 继续按空闲情况判断
  if (!seat.openStart || !seat.openEnd) {
    reasons.push('缺少开放时段（openTimes），无法判断是否闭馆');
    return pick('UNKNOWN', 'D', {windowMinutes});
  }
  const openS = toMinutes(seat.openStart);
  const openE = toMinutes(seat.openEnd);

  const overlap = (aStart: number, aEnd: number): number =>
    Math.max(0, Math.min(aEnd, openE) - Math.max(aStart, openS));
  const insideMinutes = crossesDay ? overlap(ws, 1440) + overlap(0, we) : overlap(ws, we);

  if (insideMinutes === 0) {
    reasons.push(`所选时段完全在开放时间 ${seat.openStart}–${seat.openEnd} 之外`);
    return pick('CLOSED', 'B', {windowMinutes});
  }
  if (insideMinutes < windowMinutes) {
    reasons.push(
      `所选时段仅 ${insideMinutes}/${windowMinutes} 分钟落在开放时间 ${seat.openStart}–${seat.openEnd} 内；` +
        '页面是否允许部分越界的时段、或是否会自动截断，尚未验证',
    );
    return pick('NEEDS_REVIEW', 'D', {windowMinutes});
  }
  // 走到这里说明窗口完整落在开放时段内
  // 3. 窗口内的空闲
  const gaps = freeGaps({...seat, resvIntervals: intervalsOnDate(seat, reservationDate)}, ws);
  const clipped = gaps
    .map((g) => ({start: Math.max(toMinutes(g.start), ws), end: Math.min(toMinutes(g.end), we)}))
    .filter((g) => g.end > g.start);
  const freeMinutes = clipped.reduce((s, g) => s + (g.end - g.start), 0);
  const longestGapMinutes = clipped.reduce((m, g) => Math.max(m, g.end - g.start), 0);
  const gapList = clipped.map((g) => ({
    start: `${String(Math.floor(g.start / 60)).padStart(2, '0')}:${String(g.start % 60).padStart(2, '0')}`,
    end: `${String(Math.floor(g.end / 60)).padStart(2, '0')}:${String(g.end % 60).padStart(2, '0')}`,
    minutes: g.end - g.start,
  }));

  // 4. 整窗被占 —— 与最短时长无关，可直接判定
  if (freeMinutes === 0) {
    reasons.push('所选时段完全被预约记录覆盖，无任何空闲');
    return pick('OCCUPIED', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList});
  }

  // 5. 整窗空闲 —— 时间维度上无阻碍
  if (freeMinutes === windowMinutes) {
    if (eligibility === 'NOT_ELIGIBLE') {
      reasons.push('整窗空闲，但资格为不可预约');
      return pick('OCCUPIED', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList});
    }
    if (eligibility !== 'ELIGIBLE') {
      reasons.push('整窗空闲，但预约资格未确认');
      return pick('UNKNOWN', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList});
    }
    if (min === null) {
      reasons.push('整窗空闲且资格已确认，但最短预约时长存在来源冲突（30 分钟 vs 1 小时）');
      return pick('NEEDS_REVIEW', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList, dependsOnMinDuration: true});
    }
    if (windowMinutes >= min) {
      reasons.push('整窗空闲、资格已确认、时长满足下限');
      return pick('AVAILABLE', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList});
    }
    reasons.push(`整窗空闲但时长为 ${windowMinutes} 分钟，低于最短 ${min} 分钟`);
    return pick('OCCUPIED', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList, dependsOnMinDuration: true});
  }

  // 6. 部分空闲 —— 结论取决于「最短时长」这一冲突参数
  if (min === null) {
    reasons.push(
      `窗口内仅部分空闲（共 ${freeMinutes} 分钟，最长连续 ${longestGapMinutes} 分钟）；` +
        '能否预约取决于最短时长，而该规则存在来源冲突（接口 30 分钟 vs 帮助页 1 小时）',
    );
    return pick('NEEDS_REVIEW', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList, dependsOnMinDuration: true});
  }

  if (longestGapMinutes >= min) {
    if (eligibility === 'ELIGIBLE') {
      reasons.push(`窗口内有 ${longestGapMinutes} 分钟连续空档，满足最短 ${min} 分钟，且资格已确认`);
      return pick('AVAILABLE', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList, dependsOnMinDuration: true});
    }
    reasons.push(
      `窗口内有 ${longestGapMinutes} 分钟连续空档（满足最短 ${min} 分钟），但预约资格未确认`,
    );
    return pick('UNKNOWN', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList, dependsOnMinDuration: true});
  }

  reasons.push(`窗口内最长连续空档仅 ${longestGapMinutes} 分钟，低于最短 ${min} 分钟`);
  return pick('OCCUPIED', 'B', {windowMinutes, freeMinutes, longestGapMinutes, gaps: gapList, dependsOnMinDuration: true});
}

/**
 * devStatus / openState 的处置说明（供调用方与测试引用）。
 * 这两个字段**不参与**判决，只原样保留供研究。
 */
export const UNUSED_FIELDS_NOTE = {
  devStatus: '实测两次均为 0 且与空闲情况不一致，不参与判决（红线）',
  openState: '实测全部为 1，无区分度，语义未确认，不参与判决',
} as const;
