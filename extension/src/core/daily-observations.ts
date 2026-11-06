import type {LiveSnapshot} from './live-seats';
import type {OfficialReservation} from './product-model';
import type {BookingTarget} from './daily-booking-scheduler';

export const OFFICIAL_HOME = 'https://seats.dlmu.edu.cn/#/ic/home';
export const OFFICIAL_PERSONAL = 'https://seats.dlmu.edu.cn/#/ic/userinfo';
const SEAT_PATH = /^#\/ic\/seatPredetermine\/(\d+)$/;
const ACTIVE_STATUSES = new Set(['审核通过', '已预约', '预约成功', '已签到', '签到成功', '使用中（已签到）']);

export interface DailySeatIdentity {
  roomId: string;
  seatId: string;
  roomName: string;
  seatCode: string;
  observedAt: number;
}

export function readDailySeat(
  snapshot: LiveSnapshot | null, route: string, title: string, displayedCodes: readonly string[],
  roomName: string, seatCode: string, now: number,
): DailySeatIdentity | null {
  const roomId = SEAT_PATH.exec(route)?.[1];
  if (!roomId || !snapshot || snapshot.apiPath !== '/ic-web/reserve' || snapshot.invalidRows !== 0) return null;
  const observedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > 120_000) return null;
  if (title.trim() !== roomName || displayedCodes.filter(code => code === seatCode).length !== 1) return null;
  const matches = snapshot.seats.filter(seat => String(seat.roomId) === roomId && seat.roomName === roomName && seat.name === seatCode);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].devId) || matches[0].devId <= 0) return null;
  return {roomId, seatId: String(matches[0].devId), roomName, seatCode, observedAt};
}

export function officialSeatRoute(roomId: string): string {
  if (!/^\d+$/.test(roomId)) throw Error('请重新核对学校页面中的区域');
  return `https://seats.dlmu.edu.cn/#/ic/seatPredetermine/${roomId}`;
}

export function matchingOfficialRecords(target: BookingTarget, rows: readonly OfficialReservation[]): number | null {
  const matches = rows.filter(row => row.source === 'OFFICIAL_VISIBLE_DOM' && row.date === target.date &&
    row.floorName === target.floorName && row.roomName === target.roomName && row.seatCode === target.seatCode &&
    Date.parse(row.startAt) === Date.parse(target.startAt) && Date.parse(row.endAt) === Date.parse(target.endAt));
  if (matches.some(row => !row.cancelled && !ACTIVE_STATUSES.has(row.displayStatus))) return null;
  return matches.filter(row => !row.cancelled).length;
}
