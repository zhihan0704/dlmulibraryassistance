import type {LiveRoomSummary, LiveSnapshot} from '../core/live-seats';
import type {SeatObservationChange, SeatObservationStatus} from '../core/seat-observation';

export const LIVE_CHANNEL = 'lsa:reserve-response';
export const WANT_CHANNEL = 'lsa:want-buffer';
export const READY_CHANNEL = 'lsa:reserve-observer-ready';
export const LIVE_MAX_AGE_MS = 120_000;

export interface DomSummary {
  at: string;
  route: string;
  roomTitle: string;
  count: number;
  classCounts: Record<string, number>;
  withFreeIntervals: number;
}

export interface LiveReply {
  ok: true;
  route: string;
  live: {snapshot: LiveSnapshot; summary: {total: number; withResv: number; withoutResv: number; invalidRows: number; rooms: LiveRoomSummary[]}} | null;
  liveError: string | null;
  domError: string | null;
  hookSeen: boolean;
  transports: ('XHR' | 'FETCH')[];
  capturedCount: number;
  capturedBy: {XHR: number; FETCH: number};
  lastCapturedAt: string | null;
  session: 'UNKNOWN' | 'REVERIFIED' | 'SESSION_LOST';
  domRunning: boolean;
  dom: DomSummary | null;
  eventMonitor: {network: SeatObservationStatus; dom: SeatObservationStatus; events: number};
  selected: {network: SeatObservationChange | null; dom: SeatObservationChange | null};
}
