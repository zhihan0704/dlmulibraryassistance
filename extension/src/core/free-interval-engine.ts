import {covers, parseTimeRange, type MillisecondRange, type TimeRange, type VerifiedSeatTimeline} from './seat-timeline';

export type FreeIntervalResult =
  | {state: 'KNOWN'; intervals: MillisecondRange[]}
  | {state: 'UNKNOWN'; reason: string};

/** Return free intervals only inside a fully covered, known analysis window. Intervals are [start, end). */
export function findFreeIntervals(timeline: VerifiedSeatTimeline, window: TimeRange): FreeIntervalResult {
  const range = parseTimeRange(window);
  if (!range || !covers(timeline.coverage, range)) return {state: 'UNKNOWN', reason: '座位数据未覆盖整个请求时段'};
  const intervals: MillisecondRange[] = [];
  let cursor = range.start;
  for (const segment of timeline.segments) {
    const start = Math.max(segment.start, range.start), end = Math.min(segment.end, range.end);
    if (start >= end) continue;
    if (segment.state === 'UNKNOWN' || start !== cursor) return {state: 'UNKNOWN', reason: '请求范围内有未知状态或缺口'};
    cursor = end;
    if (segment.state !== 'FREE') continue;
    const previous = intervals.at(-1);
    if (previous?.end === start) previous.end = end;
    else intervals.push({start, end});
  }
  if (cursor !== range.end) return {state: 'UNKNOWN', reason: '请求范围内有时间缺口'};
  return {state: 'KNOWN', intervals};
}
