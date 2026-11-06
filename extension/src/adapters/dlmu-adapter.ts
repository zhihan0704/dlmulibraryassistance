import type {LibraryAdapter} from './library-adapter';
import {parseSeatSnapshot} from '../content/seat-reader';
import {isTarget} from '../content/page-detector';
import {parsePersonalRecords} from '../content/personal-records';
import {normalizeReservePayload} from '../core/live-seats';
import {matchingOfficialRecords, readDailySeat} from '../core/daily-observations';

export type DlmuPage =
  | {kind: 'SEATS'; route: string; roomId: string}
  | {kind: 'PERSONAL' | 'OFFICIAL' | 'SSO' | 'OTHER'; route: string};

const SEAT_ROUTE = /^#\/ic\/seatPredetermine\/([1-9]\d{0,14})$/;
const SEAT_CODE = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;

export class DlmuAdapter implements LibraryAdapter {
  constructor(private readonly snapshot?: unknown) {}

  static identifyPage(href: string): DlmuPage {
    let url: URL;
    try { url = new URL(href); } catch { return {kind: 'OTHER', route: ''}; }
    if (url.protocol === 'https:' && ['id.dlmu.edu.cn', 'atrust.dlmu.edu.cn'].includes(url.hostname)) return {kind: 'SSO', route: ''};
    if (!isTarget(href)) return {kind: 'OTHER', route: ''};
    const route = url.hash.split('?')[0];
    const room = SEAT_ROUTE.exec(route);
    if (room) return {kind: 'SEATS', route, roomId: room[1]};
    if (route === '#/ic/userinfo') return {kind: 'PERSONAL', route};
    return {kind: 'OFFICIAL', route: ''};
  }

  static parseSeatResponse(body: string, at: string, page: DlmuPage) {
    if (page.kind !== 'SEATS') throw Error('当前未识别学校座位页');
    const snapshot = normalizeReservePayload(JSON.parse(body), at);
    if (snapshot.invalidRows || snapshot.invalidIntervals) throw Error('响应包含无法核对的座位或时段');
    if (snapshot.seats.some(seat => String(seat.roomId) !== page.roomId || !SEAT_CODE.test(seat.name))) {
      throw Error('响应中的区域或座位编号与当前页面不匹配');
    }
    return snapshot;
  }

  static readSeatPage(document: Document, page: DlmuPage) {
    if (page.kind !== 'SEATS') throw Error('当前未识别学校座位页');
    const roomTitle = document.querySelector('.seat h3')?.textContent?.trim() ?? '';
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.seat-area .draggable'));
    if (!roomTitle || roomTitle.length > 64 || !nodes.length || nodes.length > 2000) throw Error('座位区域尚未就绪或页面结构异常');
    const rows = nodes.map(node => ({
      name: node.querySelector('em')?.textContent?.trim() ?? '',
      className: node.className,
      title: node.getAttribute('title') ?? '',
      left: node.style.left,
      top: node.style.top,
      visibleTimes: (node.textContent ?? '').match(/\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g) ?? [],
    }));
    if (rows.some(row => !SEAT_CODE.test(row.name) || row.name.length > 32) || new Set(rows.map(row => row.name)).size !== rows.length) {
      throw Error('页面包含缺失或重复的座位编号');
    }
    return {roomTitle, rows};
  }

  static readPersonal = parsePersonalRecords;
  static matchSeat = readDailySeat;
  static matchReservation = matchingOfficialRecords;

  async detectPage() { return typeof location !== 'undefined' && isTarget(location.href); }
  async getCurrentRoom() {
    if (this.snapshot) return parseSeatSnapshot(this.snapshot).seats[0].roomId;
    const page = DlmuAdapter.identifyPage(typeof location !== 'undefined' ? location.href : '');
    return page.kind === 'SEATS' ? page.roomId : null;
  }
  /** Historical evidence has its own explicit input. Live readers never fall back to it. */
  async getSeats() { return this.snapshot ? parseSeatSnapshot(this.snapshot).seats : []; }
  async getSeatStatus() { return 'UNKNOWN'; }
  async getReservationRules() { return 'NEEDS_REVIEW' as const; }
  async getMyReservations(): Promise<{seatId: string}[]> {
    throw Error('个人预约只在当前官方个人页中读取');
  }
}
