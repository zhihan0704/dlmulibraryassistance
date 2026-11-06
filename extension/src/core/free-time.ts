/**
 * 空闲时段推算（纯函数）
 *
 * 依据：图书馆网页自身的 `getFreeArray()` 逻辑（`chunk-8395d758`）：
 *  1. 过滤掉 `(128 & resvStatus) > 0` 的记录（位 128 置位表示「不计入占用」）；
 *  2. 按开始时间排序后合并相邻/重叠区间；
 *  3. 在 [起点, 闭馆时间] 内取补集，即为空闲区间；
 *  4. 查询当天时，起点为「当前时间 + 1 分钟」。
 *
 * 验证：用 2026-11-02 12:47 的真站采集（`research/live/2026-11-02/capture-1247.json`）
 * 推算「从现在起是否还有空闲」，得到 120 有 / 32 无，与网页自己渲染的
 * `withFreeIntervals = 120` **完全一致**。
 *
 * 注意：本函数产出的是**空闲时间区间**这一客观事实，
 * **不是**「该座位可预约」这一判断。可用性还取决于规则、资格与状态位语义，
 * 均仍为 UNKNOWN。
 */

export interface ResvIntervalLike {
  startTime: string;
  endTime: string;
  resvStatus: number | null;
}

export interface FreeGap {
  start: string;
  end: string;
  minutes: number;
}

export interface SeatLike {
  openStart: string | null;
  openEnd: string | null;
  resvIntervals: ResvIntervalLike[];
}

/** 位 128：网页据此把记录排除在占用之外；含义本身未确认，此处只复现行为 */
const IGNORE_BIT = 128;
/** 前端逻辑：当天查询从「现在 + 1 分钟」起算 */
export const NOW_OFFSET_MINUTES = 1;

function clockMinutes(value: string): number {
  // 兼容 "HH:MM" 与 "YYYY-MM-DD HH:MM:SS"
  const hhmm = value.length > 5 ? value.slice(11, 16) : value;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function formatClock(total: number): string {
  const m = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 合并后的占用区间（分钟内，左闭右开） */
export function mergeOccupied(intervals: ResvIntervalLike[]): Array<{start: number; end: number}> {
  const items = intervals
    .filter((i) => i.resvStatus === null || (i.resvStatus & IGNORE_BIT) === 0)
    .map((i) => ({start: clockMinutes(i.startTime), end: clockMinutes(i.endTime)}))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);

  const merged: Array<{start: number; end: number}> = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({...item});
  }
  return merged;
}

/**
 * 计算 [fromMinute, openEnd] 内的空闲区间。
 * openStart/openEnd 缺失时返回空数组（无法推算，不猜）。
 */
export function freeGaps(seat: SeatLike, fromMinute: number): FreeGap[] {
  if (!seat.openStart || !seat.openEnd) return [];
  const openStart = clockMinutes(seat.openStart);
  const openEnd = clockMinutes(seat.openEnd);
  const begin = Math.max(fromMinute, openStart);
  if (begin >= openEnd) return [];

  const raw: Array<{start: number; end: number}> = [];
  let cursor = begin;
  for (const occupied of mergeOccupied(seat.resvIntervals)) {
    if (occupied.end <= cursor) continue;
    if (occupied.start > cursor) {
      raw.push({start: cursor, end: Math.min(occupied.start, openEnd)});
    }
    cursor = Math.max(cursor, occupied.end);
    if (cursor >= openEnd) break;
  }
  if (cursor < openEnd) raw.push({start: cursor, end: openEnd});

  return raw
    .filter((g) => g.end > g.start)
    .map((g) => ({start: formatClock(g.start), end: formatClock(g.end), minutes: g.end - g.start}));
}

export function totalFreeMinutes(seat: SeatLike, fromMinute: number): number {
  return freeGaps(seat, fromMinute).reduce((sum, g) => sum + g.minutes, 0);
}

/** 采集时刻（ISO）→ 北京时间当日分钟数 */
export function beijingMinuteOfDay(iso: string): number {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return Number.NaN;
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.getUTCHours() * 60 + bj.getUTCMinutes();
}
