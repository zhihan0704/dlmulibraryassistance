import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingTargetKey,
  countVerifiedTargetMatches,
  decideDailyRun,
  executeDailyMock,
  getDailySchedule,
  nextDailyAlarms,
  sameBookingTarget,
  validateDailyBookingConfig,
  type DailyBookingConfig,
  type DailyMockAdapter,
  type DailyPreflightEvidence,
  type DailyRunCheckpoint,
  type DailyRunInput,
} from '../src/core/daily-booking-scheduler';

const config: DailyBookingConfig = {
  enabled: true,
  mode: 'MOCK',
  target: {floorName: '一楼', roomName: '预约自习室', seatCode: 'D1-01', roomId: 'R-4', seatId: 'S-13', startTime: '17:30', endTime: '21:15', dayOffset: 1},
};
const bj = (time: string) => Date.parse(`2026-11-06T${time}+08:00`);
const schedule = getDailySchedule(config, bj('07:55:00'));
const nowMs = bj('08:00:10');
const evidence: DailyPreflightEvidence = {duplicateKey: schedule.duplicateKey, observedAt: bj('08:00:00'), auth: 'VERIFIED', rules: 'VERIFIED', seat: 'VERIFIED', exactMatchCount: 0};
const input: DailyRunInput = {config, schedule, nowMs, phase: 'OPEN', evidence};

test('07:55 / 08:00 / 08:01 使用北京时间并指向次日同一座位', () => {
  assert.equal(schedule.day, '2026-11-06');
  assert.equal(schedule.prepareAt, bj('07:55:00'));
  assert.equal(schedule.openAt, bj('08:00:00'));
  assert.equal(schedule.verifyAt, bj('08:01:00'));
  assert.deepEqual(schedule.target, {date: '2026-11-07', floorName: '一楼', roomName: '预约自习室', seatCode: 'D1-01', roomId: 'R-4', seatId: 'S-13', startAt: '2026-11-07T17:30:00+08:00', endAt: '2026-11-07T21:15:00+08:00'});
  assert.equal(getDailySchedule(config, Date.parse('2026-12-31T20:00:00Z')).target.date, '2027-01-02');
});

test('启动时只登记未来时点，错过的窗口不补跑', () => {
  assert.deepEqual(nextDailyAlarms(config, bj('07:56:00')).map(alarm => [alarm.phase, alarm.schedule.day]), [['OPEN', '2026-11-06'], ['VERIFY', '2026-11-06'], ['PREPARE', '2026-11-07']]);
  const rollover = nextDailyAlarms(config, bj('08:02:00'));
  assert.deepEqual(rollover.map(alarm => alarm.phase), ['PREPARE', 'OPEN', 'VERIFY']);
  assert.ok(rollover.every(alarm => alarm.schedule.target.date === '2026-11-08' && alarm.when > bj('08:02:00')));
  assert.deepEqual(nextDailyAlarms({...config, enabled: false}, nowMs), []);
});

test('每一阶段均按半开窗口限制，前一天的旧 alarm 无效', () => {
  assert.equal(decideDailyRun({...input, phase: 'PREPARE', nowMs: schedule.prepareAt - 1}).reason, 'OUTSIDE_WINDOW');
  assert.equal(decideDailyRun({...input, phase: 'PREPARE', nowMs: schedule.prepareAt}).action, 'PREPARE');
  assert.equal(decideDailyRun({...input, phase: 'PREPARE', nowMs: schedule.openAt}).reason, 'OUTSIDE_WINDOW');
  assert.equal(decideDailyRun({...input, nowMs: schedule.verifyAt}).reason, 'OUTSIDE_WINDOW');
  assert.equal(decideDailyRun({...input, phase: 'VERIFY', nowMs: schedule.verifyAt}).action, 'OBSERVE');
  assert.equal(decideDailyRun({...input, phase: 'VERIFY', nowMs: schedule.verifyAt + 60000}).reason, 'OUTSIDE_WINDOW');
  assert.equal(decideDailyRun({...input, nowMs: nowMs + 86400000}).reason, 'STALE_SCHEDULE');
  assert.equal(decideDailyRun({...input, config: {...config, target: {...config.target, seatCode: 'D1-02'}}}).reason, 'STALE_SCHEDULE');
});

test('重复键覆盖日期、房间、座位、起止时间，并归一化 ISO 和页面时间', () => {
  const target = schedule.target;
  assert.ok(sameBookingTarget(target, {...target, startAt: '2026-11-07 17:30', endAt: '2026-11-07T13:15:00Z'}));
  for (const edit of [{date: '2026-11-08'}, {roomId: 'R-5'}, {seatId: 'S-14'}, {startAt: '2026-11-07 17:31'}, {endAt: '2026-11-07 21:14'}]) {
    assert.equal(sameBookingTarget(target, {...target, ...edit}), false);
  }
  assert.throws(() => bookingTargetKey({...target, startAt: '2026-02-31 17:30'}));
  assert.throws(() => validateDailyBookingConfig({...config, target: {...config.target, dayOffset: 0}}));
  assert.throws(() => validateDailyBookingConfig({...config, target: {...config.target, endTime: '24:00'}}));
  assert.throws(() => validateDailyBookingConfig({...config, mode: 'PRODUCTION'}));
});

test('只将字段完整匹配且活跃、已验证的记录计入重复', () => {
  const row = {...schedule.target, active: true, verified: true};
  assert.equal(countVerifiedTargetMatches(schedule.target, [row, {...row, active: false}, {...row, verified: false}, {...row, seatCode: 'D1-02'}, {...row, floorName: '二楼'}]), 1);
  const duplicate = decideDailyRun({...input, evidence: {...evidence, exactMatchCount: 1}});
  assert.equal(duplicate.reason, 'EXACT_DUPLICATE');
  assert.equal(duplicate.action, 'STOP');
});

test('模拟执行需要同一目标的新观察、登录、规则和座位验证', () => {
  assert.equal(decideDailyRun(input).action, 'SUBMIT_MOCK');
  for (const [candidate, reason] of [
    [{...evidence, observedAt: nowMs + 1}, 'EVIDENCE_UNAVAILABLE'],
    [{...evidence, observedAt: nowMs - 60001}, 'EVIDENCE_UNAVAILABLE'],
    [{...evidence, duplicateKey: 'other'}, 'EVIDENCE_UNAVAILABLE'],
    [{...evidence, exactMatchCount: null}, 'EVIDENCE_UNAVAILABLE'],
    [{...evidence, auth: 'LOGIN_REQUIRED'}, 'AUTH_REQUIRED'],
    [{...evidence, rules: 'UNRESOLVED'}, 'RULES_UNVERIFIED'],
    [{...evidence, seat: 'MISMATCH'}, 'SEAT_UNVERIFIED'],
  ] as const) assert.deepEqual(decideDailyRun({...input, evidence: candidate}), {action: 'STOP', reason, duplicateKey: schedule.duplicateKey});
});

test('生产默认辅助，规则未解决时仍可在开窗时提示官方核对', async () => {
  const assisted = {...input, config: {...config, mode: 'ASSISTED' as const}, evidence: null};
  assert.deepEqual(decideDailyRun(assisted), {action: 'ASSIST', reason: 'ASSISTED_ONLY', duplicateKey: schedule.duplicateKey});
  const impossible = async (): Promise<never> => { throw new Error('辅助流程不得调用模拟提交适配器'); };
  const result = await executeDailyMock(assisted, {claimAttempt: impossible, saveCheckpoint: impossible, submitMock: impossible, now: () => nowMs});
  assert.equal(result.result, 'SKIPPED');
});

test('模拟并发开窗仅在原子占位后执行一次，正向响应仍等待复核', async () => {
  let stored: DailyRunCheckpoint | null = null;
  const writes: string[] = [];
  const adapter: DailyMockAdapter = {
    async claimAttempt(checkpoint) {
      if (stored) return false;
      stored = checkpoint;
      writes.push('claimed');
      return true;
    },
    async saveCheckpoint(checkpoint) { stored = checkpoint; },
    async submitMock() { assert.equal(stored?.state, 'ATTEMPTED'); writes.push('simulated'); },
    now: () => nowMs,
  };
  const results = await Promise.all([executeDailyMock(input, adapter), executeDailyMock(input, adapter)]);
  assert.deepEqual(writes, ['claimed', 'simulated']);
  assert.deepEqual(results.map(result => result.result).sort(), ['AWAITING_VERIFICATION', 'CLAIM_HELD']);
  assert.equal(decideDailyRun({...input, previous: stored}).reason, 'ALREADY_ATTEMPTED');
});

test('占位完成已过开窗时不再模拟提交', async () => {
  let submitted = false;
  const result = await executeDailyMock(input, {
    claimAttempt: async () => true,
    saveCheckpoint: async () => {},
    submitMock: async () => { submitted = true; },
    now: () => schedule.verifyAt,
  });
  assert.equal(result.result, 'SKIPPED');
  assert.equal(result.decision.reason, 'OUTSIDE_WINDOW');
  assert.equal(submitted, false);
});

test('模拟提交超时记录 UNCERTAIN，下一次只复核，不重复提交', async () => {
  let calls = 0;
  let abortObserved = false;
  const saved: DailyRunCheckpoint[] = [];
  const adapter: DailyMockAdapter = {
    claimAttempt: async () => true,
    saveCheckpoint: async checkpoint => { saved.push(checkpoint); },
    submitMock: async (_target, signal) => {
      calls += 1;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { abortObserved = true; resolve(); }, {once: true}));
    },
    now: () => nowMs,
  };
  const initial = await executeDailyMock(input, adapter, 5);
  assert.equal(initial.result, 'UNCERTAIN');
  assert.equal(initial.checkpoint?.state, 'UNCERTAIN');
  assert.equal(abortObserved, true);
  assert.equal((await executeDailyMock({...input, previous: initial.checkpoint}, adapter)).decision.reason, 'ALREADY_ATTEMPTED');
  assert.equal(calls, 1);
  const verify: DailyRunInput = {...input, nowMs: schedule.verifyAt, phase: 'VERIFY', previous: initial.checkpoint};
  const unknown = await executeDailyMock({...verify, evidence: {...evidence, exactMatchCount: 2}}, adapter);
  assert.equal(unknown.checkpoint?.state, 'UNCERTAIN');
  const result = await executeDailyMock({...verify, evidence: {...evidence, observedAt: schedule.verifyAt, exactMatchCount: 1}}, adapter);
  assert.equal(result.result, 'VERIFIED');
  assert.deepEqual(saved.map(checkpoint => checkpoint.state), ['UNCERTAIN', 'SUCCEEDED']);
  assert.equal(calls, 1);
});
