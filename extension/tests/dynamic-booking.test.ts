import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AvailabilityWatcher} from '../src/core/availability-watcher';
import {evaluateDynamicBooking, type DynamicBookingInput} from '../src/core/dynamic-booking-policy';
import {findFreeIntervals} from '../src/core/free-interval-engine';
import {normalizeReservePayload} from '../src/core/live-seats';
import {inspectSeatTimeline, observeUnverifiedLiveSeat, parseInstant, type CompleteSeatTimeline, type TimeRange} from '../src/core/seat-timeline';

const target = {roomId: 10, devId: 1, seatCode: 'MOCK-01'};
const instant = (time: string) => '2026-11-06T' + time + ':00+08:00';
const range = (start: string, end: string): TimeRange => ({startAt: instant(start), endAt: instant(end)});
const now = Date.parse(instant('08:00'));
const observedAt = new Date(now).toISOString();
const coverage = range('09:00', '12:00');
const preferred = range('09:00', '10:00');
const clear: CompleteSeatTimeline = {target, source: 'MOCK', observedAt, completeness: 'COMPLETE', verificationRef: 'synthetic-complete', coverage, segments: [{...coverage, state: 'FREE'}]};
const occupied: CompleteSeatTimeline = {...clear, segments: [{...range('09:00', '10:30'), state: 'OCCUPIED'}, {...range('10:30', '12:00'), state: 'FREE'}]};
const base: DynamicBookingInput = {
  target, mode: 'MOCK', session: 'UNKNOWN', now, preferred, dynamicTime: {enabled: false}, observation: clear,
  rules: {kind: 'VERIFIED', source: 'MOCK', evidenceRef: 'synthetic-rules', observedAt, appliesTo: coverage, roomId: target.roomId, minDurationMinutes: 30, maxDurationMinutes: 120, startStepMinutes: 15, stepAnchorAt: coverage.startAt},
  eligibility: {kind: 'VERIFIED', source: 'MOCK', evidenceRef: 'synthetic-eligibility', observedAt, appliesTo: coverage, target, eligible: true},
};
const flexible = {enabled: true, window: coverage} as const;

test('verified exact preference stays on the same seat and is only a recommendation', () => {
  const result = evaluateDynamicBooking({...base, dynamicTime: flexible});
  assert.equal(result.state, 'SUGGESTED');
  assert.equal(result.suggestion?.mode, 'PREFERRED');
  assert.deepEqual(result.suggestion?.target, target);
  assert.equal(result.suggestion?.startAt, new Date(preferred.startAt).toISOString());
  assert.equal(result.executesRealReservation, false);
});

test('occupied preference only moves time after opt-in, preserving seat and duration', () => {
  assert.equal(evaluateDynamicBooking({...base, observation: occupied}).state, 'NO_MATCH');
  const result = evaluateDynamicBooking({...base, observation: occupied, dynamicTime: flexible});
  assert.equal(result.suggestion?.mode, 'DYNAMIC_TIME');
  assert.deepEqual(result.suggestion?.target, target);
  assert.equal(result.suggestion?.startAt, new Date(instant('10:30')).toISOString());
  assert.equal(result.suggestion?.endAt, new Date(instant('11:30')).toISOString());
});

test('opt-in bounds and grid alignment constrain candidate windows', () => {
  const unaligned: CompleteSeatTimeline = {...clear, segments: [{...range('09:00','10:07'), state:'OCCUPIED'}, {...range('10:07','12:00'), state:'FREE'}]};
  const bounded = evaluateDynamicBooking({...base, observation: unaligned, dynamicTime: {enabled: true, window: range('09:00','11:14')}});
  assert.equal(bounded.state, 'NO_MATCH');
  assert.equal(evaluateDynamicBooking({...base, observation: unaligned, dynamicTime: flexible}).suggestion?.startAt, new Date(instant('10:15')).toISOString());
  assert.equal(evaluateDynamicBooking({...base, dynamicTime: {enabled: true, window: range('09:30','12:00')}}).state, 'UNKNOWN');
});

test('nonmatching seat, room, or seat-code cannot become an alternative', () => {
  for (const alternate of [{...target, devId: 2}, {...target, roomId: 11}, {...target, seatCode: 'MOCK-02'}]) {
    const result = evaluateDynamicBooking({...base, observation: {...clear, target: alternate}, dynamicTime: flexible});
    assert.equal(result.state, 'UNKNOWN');
    assert.equal(result.suggestion, null);
  }
});

test('unknown slots and uncovered bounds do not produce a candidate', () => {
  const uncertain: CompleteSeatTimeline = {...clear, segments: [{...range('09:00','10:00'), state:'UNKNOWN'}, {...range('10:00','12:00'), state:'FREE'}]};
  assert.equal(evaluateDynamicBooking({...base, observation: uncertain, dynamicTime: flexible}).state, 'UNKNOWN');
  const partial: CompleteSeatTimeline = {...clear, coverage: preferred, segments: [{...preferred, state:'FREE'}]};
  assert.equal(evaluateDynamicBooking({...base, observation: partial, dynamicTime: flexible}).state, 'UNKNOWN');
});

test('a completeness claim cannot hide gaps, overlaps, or malformed offsets', () => {
  for (const segments of [
    [{...range('09:00','10:00'), state:'FREE' as const}, {...range('10:15','12:00'), state:'FREE' as const}],
    [{...range('09:00','10:15'), state:'FREE' as const}, {...range('10:00','12:00'), state:'OCCUPIED' as const}],
    [{startAt:'2026-11-06T09:00:00', endAt:coverage.endAt, state:'FREE' as const}],
  ]) assert.equal(inspectSeatTimeline({...clear, segments}, base).state, 'UNKNOWN');
  assert.equal(parseInstant('2026-02-31T09:00:00+08:00'), null);
  assert.equal(parseInstant('2026-11-06T09:00:00+14:30'), null);
});

test('adjacent free slots can form an exact range spanning midnight', () => {
  const midnight = '2026-11-07T00:00:00+08:00', endAt = '2026-11-07T01:00:00+08:00';
  const overnight = {startAt: instant('23:00'), endAt};
  const inspected = inspectSeatTimeline({...clear, coverage: overnight, segments: [
    {startAt: overnight.startAt, endAt: midnight, state: 'FREE'}, {startAt: midnight, endAt, state: 'FREE'},
  ]}, base);
  assert.equal(inspected.state, 'VERIFIED');
  if (inspected.state !== 'VERIFIED') assert.fail();
  const gaps = findFreeIntervals(inspected.timeline, overnight);
  assert.deepEqual(gaps, {state: 'KNOWN', intervals: [{start: Date.parse(overnight.startAt), end: Date.parse(endAt)}]});
});

test('stale, future, and historical observations fail closed', () => {
  assert.equal(evaluateDynamicBooking({...base, now: now + 120_001}).state, 'STALE');
  assert.equal(evaluateDynamicBooking({...base, now: now - 1}).state, 'UNKNOWN');
  assert.equal(evaluateDynamicBooking({...base, observation: {...clear, source: 'HISTORICAL'}}).state, 'UNKNOWN');
});

test('live mode rejects mock data and requires an authenticated, verified scope', () => {
  assert.equal(inspectSeatTimeline(clear, {...base, mode:'LIVE', session:'CONFIRMED'}).state, 'UNKNOWN');
  assert.equal(inspectSeatTimeline({...clear, source:'OFFICIAL_VISIBLE'}, {...base, mode:'LIVE', session:'UNKNOWN'}).state, 'UNKNOWN');
  assert.equal(inspectSeatTimeline({...clear, source:'OFFICIAL_VISIBLE'}, {...base, mode:'LIVE', session:'LOST'}).state, 'SESSION_LOST');
});

test('an ordinary /reserve observation does not prove free slots or complete coverage', () => {
  const sample = normalizeReservePayload([{devId:target.devId, devName:target.seatCode, roomId:target.roomId, openStart:'09:00', openEnd:'12:00', devStatus:0, resvInfo:[]}], observedAt);
  const observation = observeUnverifiedLiveSeat(sample, target);
  assert.equal(observation?.completeness, 'UNVERIFIED');
  assert.equal(inspectSeatTimeline(observation, {...base, mode:'LIVE', session:'CONFIRMED'}).state, 'UNKNOWN');
  assert.equal(observeUnverifiedLiveSeat(sample, {...target, devId:2}), null);
});

test('rule conflicts and missing scoped verified eligibility prevent a recommendation', () => {
  assert.equal(evaluateDynamicBooking({...base, rules:{kind:'CONFLICT'}}).state, 'NEEDS_REVIEW');
  assert.equal(evaluateDynamicBooking({...base, rules:{kind:'UNKNOWN'}}).state, 'UNKNOWN');
  assert.equal(evaluateDynamicBooking({...base, eligibility:{kind:'UNKNOWN'}}).state, 'UNKNOWN');
  if (base.eligibility.kind !== 'VERIFIED') assert.fail();
  assert.equal(evaluateDynamicBooking({...base, eligibility:{...base.eligibility, eligible:false}}).state, 'INELIGIBLE');
  assert.equal(evaluateDynamicBooking({...base, eligibility:{...base.eligibility, appliesTo:range('09:30','12:00')}}).state, 'UNKNOWN');
});

test('stale rule evidence cannot be refreshed by a new seat snapshot', () => {
  if (base.rules.kind !== 'VERIFIED') assert.fail();
  const result = evaluateDynamicBooking({...base, rules:{...base.rules, observedAt:new Date(now-120_001).toISOString()}});
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.suggestion, null);
});

test('a shorter free gap never shortens the requested duration', () => {
  const short: CompleteSeatTimeline = {...clear, segments: [{...range('09:00','11:30'), state:'OCCUPIED'}, {...range('11:30','12:00'), state:'FREE'}]};
  assert.equal(evaluateDynamicBooking({...base, observation: short, dynamicTime: flexible}).state, 'NO_MATCH');
});

test('watcher records distinct changes, ignores replay, and distinguishes absence of new data', () => {
  const watcher = new AvailabilityWatcher({target, mode:'MOCK', startedAt:now, stopAt:now+300_000, maxObservations:10});
  assert.equal(watcher.observe(clear, now, 'UNKNOWN').state, 'OBSERVED_CHANGE');
  assert.equal(watcher.observe(clear, now+1, 'UNKNOWN').state, 'UNKNOWN');
  const freshTime = new Date(now+10).toISOString();
  assert.equal(watcher.observe({...clear, observedAt:freshTime, segments: [
    {...range('09:00','10:00'),state:'FREE'}, {...range('10:00','12:00'),state:'FREE'},
  ]}, now+10, 'UNKNOWN').state, 'UNCHANGED');
  assert.equal(watcher.status(now+20, 'UNKNOWN').state, 'UNKNOWN');
  const change = watcher.observe({...occupied, observedAt:new Date(now+20).toISOString()}, now+20, 'UNKNOWN');
  assert.equal(change.state, 'OBSERVED_CHANGE');
  assert.deepEqual(watcher.events().map(e => e.kind), ['BASELINE','AVAILABILITY_CHANGED']);
  assert.equal(watcher.status(now+120_021, 'UNKNOWN').state, 'STALE');
});

test('watcher requires finite limits and stops at observation count or time', () => {
  assert.throws(() => new AvailabilityWatcher({target, mode:'MOCK', startedAt:now, stopAt:Infinity, maxObservations:1}));
  const watcher = new AvailabilityWatcher({target, mode:'MOCK', startedAt:now, stopAt:now+1000, maxObservations:1});
  assert.equal(watcher.observe(clear, now, 'UNKNOWN').state, 'OBSERVED_CHANGE');
  assert.equal(watcher.status(now+1, 'UNKNOWN').state, 'STOPPED');
  const byTime = new AvailabilityWatcher({target, mode:'MOCK', startedAt:now, stopAt:now+1000, maxObservations:10});
  assert.equal(byTime.observe(clear, now+1000, 'UNKNOWN').state, 'STOPPED');
  assert.deepEqual(byTime.events(), []);
});

test('lost live session cannot continue collecting even if the seat data looks valid', () => {
  const watcher = new AvailabilityWatcher({target, mode:'LIVE', startedAt:now, stopAt:now+1000, maxObservations:10});
  assert.equal(watcher.observe({...clear, source:'LIVE_RESERVE'}, now, 'LOST').state, 'SESSION_LOST');
  assert.deepEqual(watcher.events(), []);
});
