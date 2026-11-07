import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rankBookingCandidates, readOnlyBookingEvidence, validateBookingPreferences,
  type BookingPreferences, type IntelligentBookingInput, type SeatDecisionEvidence} from '../src/core/intelligent-booking';
import {normalizeReservePayload} from '../src/core/live-seats';
import type {CompleteSeatTimeline, SeatTarget, TimeRange} from '../src/core/seat-timeline';

const primary = {roomId: 10, devId: 1, seatCode: 'MOCK-01'};
const backup = {roomId: 10, devId: 2, seatCode: 'MOCK-02'};
const otherBackup = {roomId: 11, devId: 3, seatCode: 'MOCK-03'};
const unconfigured = {roomId: 10, devId: 4, seatCode: 'MOCK-04'};
const date = '2026-11-06';
const instant = (time: string, day = date) => `${day}T${time}:00.000+08:00`;
const range = (start: string, end: string): TimeRange => ({startAt: instant(start), endAt: instant(end)});
const window = range('18:00', '22:00');
const preferred = range('19:00', '20:00');
const observedAt = instant('17:00');
const now = Date.parse(observedAt);

const prefs: BookingPreferences = {date, primarySeat: primary, backupSeats: [backup, otherBackup], preferred,
  allowedWindow: window, minDurationMinutes: 15, preferLonger: true, allowTimeAdjustment: true,
  allowBackupSeats: false, allowShorter: false};

function evidence(target: SeatTarget, segments?: CompleteSeatTimeline['segments'], appliesTo = window): SeatDecisionEvidence {
  return {
    target,
    observation: {target, source: 'MOCK', observedAt, completeness: 'COMPLETE', verificationRef: 'synthetic-timeline',
      coverage: appliesTo, segments: segments ?? [{...appliesTo, state: 'FREE'}]},
    rules: {kind: 'VERIFIED', source: 'MOCK', evidenceRef: 'synthetic-rules', observedAt, appliesTo,
      roomId: target.roomId, minDurationMinutes: 30, maxDurationMinutes: 120, startStepMinutes: 15, stepAnchorAt: appliesTo.startAt},
    eligibility: {kind: 'VERIFIED', source: 'MOCK', evidenceRef: 'synthetic-eligibility', observedAt, appliesTo, target, eligible: true},
  };
}

function rank(preferences: Partial<BookingPreferences> = {}, samples = [evidence(primary)], context: Partial<IntelligentBookingInput> = {}) {
  return rankBookingCandidates({preferences: {...prefs, ...preferences}, evidence: samples, mode: 'MOCK', session: 'UNKNOWN', now, ...context});
}

test('preferences preserve explicit seat priority and export only allowlisted fields', () => {
  const actual = validateBookingPreferences({...prefs, hidden: 'synthetic-secret',
    primarySeat: {...primary, hidden: 'synthetic-secret'}, preferred: {
      startAt: '2026-11-06T11:00:00Z', endAt: '2026-11-06T12:00:00Z', hidden: 'synthetic-secret',
    }});
  assert.deepEqual(actual, prefs);
  assert.doesNotMatch(JSON.stringify(actual), /synthetic-secret/);
  assert.throws(() => validateBookingPreferences({...prefs, backupSeats: [primary]}));
  assert.throws(() => validateBookingPreferences({...prefs, backupSeats: [backup, backup]}));
  assert.throws(() => validateBookingPreferences({...prefs, backupSeats: [{...backup, devId: 0}]}));
  assert.throws(() => validateBookingPreferences({...prefs, primarySeat: {...primary, seatCode: 'MOCK\0'}}));
  assert.throws(() => validateBookingPreferences({...prefs, date: '2026-11-07'}));
  assert.throws(() => validateBookingPreferences({...prefs, preferred: {...preferred, endAt: '2026-11-06T20:00:00'}}));
  assert.throws(() => validateBookingPreferences({...prefs, allowedWindow: range('19:30', '22:00')}));
  assert.throws(() => validateBookingPreferences({...prefs, minDurationMinutes: 0}));
  assert.throws(() => validateBookingPreferences({...prefs, minDurationMinutes: 61}));
  assert.throws(() => validateBookingPreferences({...prefs, allowShorter: undefined}));
});

test('primary alternatives rank before exact matches on explicit backups in user order', () => {
  const moved = evidence(primary, [{...range('18:00', '20:15'), state: 'OCCUPIED'}, {...range('20:15', '22:00'), state: 'FREE'}]);
  const samples = [evidence(otherBackup), evidence(unconfigured), evidence(backup), moved];
  const result = rank({allowBackupSeats: true}, samples);
  assert.equal(result.state, 'READY');
  assert.deepEqual(result.candidates.map(c => c.target), [primary, backup, otherBackup]);
  assert.equal(result.candidates[0].startAt, instant('20:15'));
  assert.equal(result.candidates[1].exactTime, true);
  assert.equal(result.candidates[2].seatPriority, 2);
  assert.ok(result.candidates[1].reasons.includes('用户指定的第 1 个备用座位'));
  assert.equal(result.executesRealReservation, false);
  assert.deepEqual(rank({}, samples).candidates.map(c => c.target), [primary]);
  assert.equal(rank({allowBackupSeats: true, backupSeats: []}, [evidence(unconfigured)]).state, 'NEEDS_REVIEW');
});

test('the engine never automatically changes preferences when primary evidence is missing', () => {
  const original = structuredClone(prefs);
  const result = rank({allowBackupSeats: true}, [evidence(backup), evidence(otherBackup)]);
  assert.deepEqual(prefs, original);
  assert.equal(result.candidates[0].target.devId, backup.devId);
  assert.deepEqual(result.reviews.map(r => r.target), [primary]);
  assert.ok(result.candidates[0].reasons.some(reason => reason.includes('首选座位的证据待核验')));
  assert.equal(result.executesRealReservation, false);
});

test('adjustments stay inside fully observed half-open bounds and the verified start grid', () => {
  const unaligned = evidence(primary, [{...range('18:00', '19:07'), state: 'OCCUPIED'}, {...range('19:07', '22:00'), state: 'FREE'}]);
  assert.equal(rank({allowedWindow: range('18:00', '20:14')}, [unaligned]).state, 'NO_MATCH');
  assert.equal(rank({allowTimeAdjustment: false}, [unaligned]).state, 'NO_MATCH');
  const [candidate] = rank({allowedWindow: range('18:00', '20:15')}, [unaligned]).candidates;
  assert.equal(candidate.startAt, instant('19:15'));
  assert.equal(candidate.endAt, instant('20:15'));
  assert.equal(candidate.durationMinutes, 60);
  assert.equal(candidate.observedAt, observedAt);
});

test('shortening requires opt-in and respects both verified and user minimums', () => {
  const short = evidence(primary, [{...range('18:00', '19:00'), state: 'OCCUPIED'},
    {...range('19:00', '19:30'), state: 'FREE'}, {...range('19:30', '22:00'), state: 'OCCUPIED'}]);
  assert.equal(rank({}, [short]).state, 'NO_MATCH');
  assert.equal(rank({allowShorter: true, minDurationMinutes: 31}, [short]).state, 'NO_MATCH');
  const [candidate] = rank({allowShorter: true, allowTimeAdjustment: false}, [short]).candidates;
  assert.equal(candidate.startAt, preferred.startAt);
  assert.equal(candidate.durationMinutes, 30);
  assert.equal(candidate.shortened, true);
  assert.ok(candidate.reasons.some(reason => reason.includes('缩短 30 分钟')));
  const tooShort = evidence(primary, [{...range('18:00', '19:00'), state: 'OCCUPIED'},
    {...range('19:00', '19:29'), state: 'FREE'}, {...range('19:29', '22:00'), state: 'OCCUPIED'}]);
  assert.equal(rank({allowShorter: true}, [tooShort]).state, 'NO_MATCH');
});

test('verified maximum duration requires opt-in before shortening', () => {
  const sample = evidence(primary);
  assert.equal(sample.rules.kind, 'VERIFIED');
  sample.rules = {...sample.rules, maxDurationMinutes: 45};
  assert.equal(rank({}, [sample]).state, 'NO_MATCH');
  assert.equal(rank({allowShorter: true}, [sample]).candidates[0].durationMinutes, 45);
});

test('same-seat sorting explains exact, longer and nearer matches', () => {
  const split = evidence(primary, [{...range('18:00', '19:15'), state: 'OCCUPIED'},
    {...range('19:15', '19:45'), state: 'FREE'}, {...range('19:45', '21:00'), state: 'OCCUPIED'},
    {...range('21:00', '22:00'), state: 'FREE'}]);
  const longer = rank({allowShorter: true}, [split]).candidates;
  const closer = rank({allowShorter: true, preferLonger: false}, [split]).candidates;
  assert.deepEqual(longer.map(c => c.startAt), [instant('21:00'), instant('19:15')]);
  assert.deepEqual(closer.map(c => c.startAt), [instant('19:15'), instant('21:00')]);
  assert.equal(longer[0].continuousMinutes, 60);
  assert.equal(closer[0].continuousMinutes, 30);
  assert.ok(longer[0].reasons.some(reason => reason.includes('优先保留更长时长')));
  assert.ok(closer[0].reasons.some(reason => reason.includes('优先接近首选开始时间')));
  assert.equal(rank().candidates[0].exactTime, true);
  assert.equal(rank().candidates[0].ruleStatus, 'VERIFIED');
});

test('adjacent free segments merge over midnight while overlapping and unknown evidence fail closed', () => {
  const tomorrow = '2026-11-07';
  const midnight = instant('00:00', tomorrow);
  const crossDay = {startAt: instant('23:30'), endAt: instant('00:30', tomorrow)};
  const sample = evidence(primary, [{startAt: crossDay.startAt, endAt: midnight, state: 'FREE'},
    {startAt: midnight, endAt: crossDay.endAt, state: 'FREE'}], crossDay);
  const preference = {preferred: crossDay, allowedWindow: crossDay};
  const [candidate] = rank(preference, [sample]).candidates;
  assert.equal(candidate.endAt, instant('00:30', tomorrow));
  assert.equal(candidate.durationMinutes, 60);
  const overlap = evidence(primary, [{startAt: crossDay.startAt, endAt: instant('00:10', tomorrow), state: 'OCCUPIED'},
    {startAt: midnight, endAt: crossDay.endAt, state: 'FREE'}], crossDay);
  assert.equal(rank(preference, [overlap]).state, 'NEEDS_REVIEW');
  const unknown = evidence(primary, [{...crossDay, state: 'UNKNOWN'}], crossDay);
  assert.equal(rank(preference, [unknown]).state, 'NEEDS_REVIEW');
});

test('incomplete, conflicting, stale, future, lost and mismatched evidence yields no recommendation', () => {
  const verified = evidence(primary);
  assert.equal(verified.observation?.completeness, 'COMPLETE');
  assert.equal(verified.eligibility.kind, 'VERIFIED');
  for (const result of [
    rank({}, [{...verified, rules: {kind: 'UNKNOWN'}}]),
    rank({}, [{...verified, rules: {kind: 'CONFLICT'}}]),
    rank({}, [{...verified, eligibility: {kind: 'UNKNOWN'}}]),
    rank({}, [{...verified, eligibility: {...verified.eligibility, target: backup}}]),
    rank({}, [{...verified, observation: {...verified.observation, source: 'HISTORICAL'}}]),
    rank({}, [evidence(primary, undefined, preferred)]),
    rank({}, [verified, verified]),
    rank({}, [verified], {now: now + 120_001}),
    rank({}, [verified], {now: now - 1}),
    rank({}, [verified], {mode: 'LIVE', session: 'CONFIRMED'}),
    rank({}, [{...verified, observation: {...verified.observation, source: 'OFFICIAL_VISIBLE'}}], {mode: 'LIVE', session: 'LOST'}),
  ]) {
    assert.equal(result.state, 'NEEDS_REVIEW');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.executesRealReservation, false);
  }
});

test('passively captured status and empty reservations do not imply complete live evidence', () => {
  const row = {devId: primary.devId, devName: primary.seatCode, roomId: primary.roomId,
    openStart: '18:00', openEnd: '22:00', openState: 0, devStatus: 0, resvInfo: []};
  const raw = normalizeReservePayload([row], observedAt);
  const observations = readOnlyBookingEvidence(raw, prefs);
  assert.equal(observations[0].observation?.completeness, 'UNVERIFIED');
  assert.deepEqual(observations[0].rules, {kind: 'UNKNOWN'});
  assert.deepEqual(observations[0].eligibility, {kind: 'UNKNOWN'});
  assert.equal(rank({}, observations, {mode: 'LIVE', session: 'CONFIRMED'}).state, 'NEEDS_REVIEW');
  assert.equal(readOnlyBookingEvidence({...raw, invalidRows: 1}, prefs)[0].observation, null);
  assert.equal(readOnlyBookingEvidence({...raw, invalidIntervals: 1}, prefs)[0].observation, null);
  assert.equal(readOnlyBookingEvidence({...raw, apiPath: '/wrong'}, prefs)[0].observation, null);
  assert.equal(readOnlyBookingEvidence({...raw, seats: [...raw.seats, ...raw.seats]}, prefs)[0].observation, null);
});
