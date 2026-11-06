import {DEFAULT_AVAILABILITY_AGE_MS, inspectSeatTimeline, validSeatTarget, type InspectionContext, type SeatTimelineObservation, type SessionState, type VerifiedSeatTimeline} from './seat-timeline';

export type WatchState = 'OBSERVED_CHANGE' | 'UNCHANGED' | 'STALE' | 'UNKNOWN' | 'SESSION_LOST' | 'STOPPED';
export interface WatchResult {
  state: WatchState;
  reason: string;
  observedAt: string | null;
  eventCount: number;
}
export interface AvailabilityEvent {
  kind: 'BASELINE' | 'AVAILABILITY_CHANGED';
  observedAt: string;
  source: VerifiedSeatTimeline['source'];
  verificationRef: string;
}
export interface AvailabilityWatcherOptions extends Omit<InspectionContext, 'now' | 'session'> {
  startedAt: number;
  stopAt: number;
  maxObservations: number;
}
const MAX_WATCH_MS = 30 * 60_000;
const MAX_OBSERVATIONS = 1_000;

/** Receives observations from its caller. This finite watcher owns neither timers nor requests. */
export class AvailabilityWatcher {
  private readonly options: AvailabilityWatcherOptions;
  private last: VerifiedSeatTimeline | null = null;
  private lastFingerprint: string | null = null;
  private changes: AvailabilityEvent[] = [];
  private count = 0;
  private stopped = false;

  constructor(options: AvailabilityWatcherOptions) {
    if (!validSeatTarget(options.target) || !Number.isFinite(options.startedAt) || !Number.isFinite(options.stopAt) ||
        options.stopAt <= options.startedAt || options.stopAt - options.startedAt > MAX_WATCH_MS ||
        !Number.isInteger(options.maxObservations) || options.maxObservations < 1 || options.maxObservations > MAX_OBSERVATIONS) {
      throw Error('监测必须绑定有效座位、有限期限及观察次数');
    }
    this.options = {...options, target: {...options.target}};
  }
  private result(state: WatchState, reason: string): WatchResult {
    return {state, reason, observedAt: this.last?.observedAt ?? null, eventCount: this.changes.length};
  }
  private stopIfFinished(now: number): boolean {
    if (now >= this.options.stopAt || this.count >= this.options.maxObservations) this.stopped = true;
    return this.stopped;
  }
  observe(observation: SeatTimelineObservation, now: number, session: SessionState): WatchResult {
    if (this.stopIfFinished(now)) return this.result('STOPPED', '监测期限或次数已结束');
    if (!Number.isFinite(now) || now < this.options.startedAt) return this.result('UNKNOWN', '当前时间无效');
    this.count++;
    const inspected = inspectSeatTimeline(observation, {...this.options, now, session});
    if (inspected.state !== 'VERIFIED') return this.result(inspected.state, inspected.reason);
    const {timeline} = inspected;
    if (timeline.observedMs < this.options.startedAt) return this.result('UNKNOWN', '观察来自监测开始前');
    if (this.last && timeline.observedMs <= this.last.observedMs) return this.result('UNKNOWN', '没有新的有序观察');
    const fingerprint = JSON.stringify([timeline.coverage, timeline.segments]);
    const unchanged = fingerprint === this.lastFingerprint;
    const kind = this.last ? 'AVAILABILITY_CHANGED' : 'BASELINE';
    this.last = timeline;
    this.lastFingerprint = fingerprint;
    if (unchanged) return this.result('UNCHANGED', '新的已核验观察与上一条内容相同');
    this.changes.push({kind, observedAt: timeline.observedAt, source: timeline.source, verificationRef: timeline.verificationRef});
    return this.result('OBSERVED_CHANGE', kind === 'BASELINE' ? '已收到首条有效观察' : '座位时间线发生变化');
  }
  status(now: number, session: SessionState): WatchResult {
    if (this.stopIfFinished(now)) return this.result('STOPPED', '监测期限或次数已结束');
    if (this.options.mode === 'LIVE' && session === 'LOST') return this.result('SESSION_LOST', '会话失效');
    if (!Number.isFinite(now) || !this.last || now < this.last.observedMs) return this.result('UNKNOWN', '没有新的有效观察');
    if (now - this.last.observedMs > (this.options.maxAgeMs ?? DEFAULT_AVAILABILITY_AGE_MS)) return this.result('STALE', '最近观察已过期');
    return this.result('UNKNOWN', '没有新的观察，不能判断是否变化');
  }
  stop(): void {this.stopped = true}
  events(): AvailabilityEvent[] {return this.changes.map(event => ({...event}))}
}
