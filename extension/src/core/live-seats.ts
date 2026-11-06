/**
 * 实时座位数据：规范化与校验（纯函数，可在 Node 下测试）
 *
 * 数据来源：图书馆网页**自己**发出的 GET /ic-web/reserve 响应，
 * 由 MAIN world 的被动旁路（reserve-hook.ts）捕获后传入。
 *
 * 安全约束：
 * 1. 本模块不发起任何网络请求，也不构造请求参数。
 * 2. resvInfo 中含有他人姓名/账号字段（title、trueName、logonName），
 *    本模块**只提取时间段与 resvStatus**，其余字段就地丢弃，
 *    避免他人隐私数据进入扩展、进入日志或进入界面。
 * 3. 不推断座位可用性：status 恒为 'UNKNOWN'（见 §状态映射）。
 */

export interface LiveResvInterval {
  startTime: string;
  endTime: string;
  resvStatus: number | null;
  /** Unknown scalar forms are for comparison only. Historical numeric decoders stay isolated. */
  rawResvStatus?: string | boolean;
}

export interface LiveSeat {
  devId: number;
  name: string;
  roomId: number;
  roomName: string;
  position: { x: number; y: number } | null;
  /** 原样保留，不解释语义（红线：devStatus=0 不等于空闲） */
  devStatus: unknown;
  /** 原样保留；该字段在日期分组上的语义与座位上不同，不得互用 */
  openState: unknown;
  openStart: string | null;
  openEnd: string | null;
  onlyView: boolean | null;
  resvIntervals: LiveResvInterval[];
  status: 'UNKNOWN';
}

export interface LiveRoomSummary {
  roomId: number;
  roomName: string;
  count: number;
}

export interface LiveSnapshot {
  source: 'LIVE_RESERVE';
  apiPath: string;
  /** 扩展收到该响应的本机时刻（ISO）。页面响应中未发现服务端时间戳字段。 */
  capturedAt: string;
  seats: LiveSeat[];
  /** 被跳过的畸形行数，用于诚实展示而不是静默丢弃 */
  invalidRows: number;
  invalidIntervals?: number;
  rooms: LiveRoomSummary[];
}

const MAX_SEATS = 2000;
const MAX_NAME = 32;

/** 容忍 "x,y" 百分比坐标；不合规返回 null（实时数据里位置是可选信息） */
export function readPosition(value: unknown): { x: number; y: number } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2) return null;
  const nums = parts.map((p) => Number(p.trim()));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return null;
  return { x: nums[0], y: nums[1] };
}

function readText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 仅保留时间与状态码，丢弃 title/trueName/logonName 等身份字段 */
function readIntervals(value: unknown): {intervals: LiveResvInterval[]; invalid: number} {
  if (!Array.isArray(value)) return {intervals: [], invalid: value == null ? 0 : 1};
  const out: LiveResvInterval[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const startTime = readText(item.startTime, 32);
    const endTime = readText(item.endTime, 32);
    if (!startTime || !endTime) continue;
    const rawStatus = item.resvStatus;
    const resvStatus = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : null;
    const interval: LiveResvInterval = {startTime, endTime, resvStatus};
    if (typeof rawStatus === 'boolean' || typeof rawStatus === 'string' && rawStatus.length <= 32) interval.rawResvStatus = rawStatus;
    out.push(interval);
  }
  return {intervals: out, invalid: value.length - out.length};
}

function looksLikeSeat(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.devId === 'number' && Number.isSafeInteger(item.devId) && item.devId > 0;
}

/**
 * 在响应体中定位座位数组。
 * 不假设信封结构（可能是 {code,data} 也可能直接是数组），
 * 只认「元素带合法 devId 的对象数组」，避免猜错结构。
 */
export function findSeatArray(input: unknown): unknown[] | null {
  if (Array.isArray(input)) {
    return input.some(looksLikeSeat) ? input : null;
  }
  if (!input || typeof input !== 'object') return null;
  const root = input as Record<string, unknown>;
  if (Array.isArray(root.data)) {
    return root.data.some(looksLikeSeat) ? root.data : null;
  }
  if (root.data && typeof root.data === 'object') {
    const nested = root.data as Record<string, unknown>;
    if (Array.isArray(nested.data)) {
      return nested.data.some(looksLikeSeat) ? nested.data : null;
    }
  }
  return null;
}

/**
 * 把 /ic-web/reserve 响应规范化为 LiveSnapshot。
 * 结构性错误一律抛错（让上层显示「读取失败」，而不是展示半截数据）。
 */
export function normalizeReservePayload(
  input: unknown,
  capturedAt: string,
  apiPath = '/ic-web/reserve',
): LiveSnapshot {
  const rows = findSeatArray(input);
  if (!rows) throw new Error('响应中未找到座位数组');
  if (rows.length === 0) throw new Error('座位数组为空');
  if (rows.length > MAX_SEATS) throw new Error('座位数量异常，已拒绝');

  const seats: LiveSeat[] = [];
  const seen = new Set<number>();
  let invalidRows = 0;
  let invalidIntervals = 0;

  for (const row of rows) {
    if (!looksLikeSeat(row)) {
      invalidRows += 1;
      continue;
    }
    const item = row as Record<string, unknown>;
    const name = readText(item.devName, MAX_NAME);
    if (!name) {
      invalidRows += 1;
      continue;
    }
    const devId = item.devId as number;
    if (seen.has(devId)) {
      invalidRows += 1;
      continue;
    }
    seen.add(devId);
    const reservation = readIntervals(item.resvInfo);
    invalidIntervals += reservation.invalid;
    seats.push({
      devId,
      name,
      roomId: typeof item.roomId === 'number' ? item.roomId : 0,
      roomName: readText(item.roomName, 64) ?? '',
      position: readPosition(item.coordinate),
      devStatus: item.devStatus,
      openState: item.openState,
      openStart: readText(item.openStart, 16),
      openEnd: readText(item.openEnd, 16),
      onlyView: readBool(item.onlyView),
      resvIntervals: reservation.intervals,
      status: 'UNKNOWN',
    });
  }

  if (seats.length === 0) throw new Error('没有可用的座位记录');

  const roomMap = new Map<number, LiveRoomSummary>();
  for (const seat of seats) {
    const entry = roomMap.get(seat.roomId) ?? { roomId: seat.roomId, roomName: seat.roomName, count: 0 };
    entry.count += 1;
    if (!entry.roomName && seat.roomName) entry.roomName = seat.roomName;
    roomMap.set(seat.roomId, entry);
  }

  return {
    source: 'LIVE_RESERVE',
    apiPath,
    capturedAt,
    seats,
    invalidRows,
    ...(invalidIntervals ? {invalidIntervals} : {}),
    rooms: Array.from(roomMap.values()),
  };
}

/** 界面用摘要：不解释状态语义，只陈述可数的客观事实 */
export function summarizeSnapshot(snapshot: LiveSnapshot) {
  const withResv = snapshot.seats.filter((s) => s.resvIntervals.length > 0).length;
  return {
    total: snapshot.seats.length,
    withResv,
    withoutResv: snapshot.seats.length - withResv,
    invalidRows: snapshot.invalidRows,
    rooms: snapshot.rooms,
  };
}
