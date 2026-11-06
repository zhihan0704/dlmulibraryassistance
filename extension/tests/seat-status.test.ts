/**
 * Phase 5 状态语义测试
 *
 * 核心证据测试：`siteSeatClass()` 必须逐窗口复现网页自己渲染的状态类分布。
 * 六组现场样本（四组不同窗口 + 两组同时段不同时刻）全部参与。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {legacyDirectory} from './legacy-root';
import {decideSeatStatus, intervalsOnDate, siteSeatClass, type SeatLike} from '../src/core/seat-status';

const evidenceDir = legacyDirectory('research/phase5/evidence');

interface EvidenceFile {
  page: {dateInput: {value: string}; startInput: {value: string}; endInput: {value: string}; classCounts: Record<string, number>; menuText: string};
  live: {seats: Array<{name: string; devStatus: unknown; openState: unknown; openStart: string | null; openEnd: string | null; resvIntervals: Array<{startTime: string; endTime: string; resvStatus: number | null}>}>};
}

function loadEvidence(): Array<{name: string; data: EvidenceFile}> {
  return readdirSync(evidenceDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({name: f, data: JSON.parse(readFileSync(evidenceDir + f, 'utf8')) as EvidenceFile}));
}

const evidence = loadEvidence();

// ---------------------------------------------------------------------------
// 1. 证据复现：className 规则
// ---------------------------------------------------------------------------
test('【证据】siteSeatClass 逐窗口复现网页渲染的状态类分布', () => {
  assert.ok(evidence.length >= 6, `证据样本应有 6 个，实际 ${evidence.length}`);
  for (const {name, data} of evidence) {
    const date = data.page.dateInput.value;
    const start = data.page.startInput.value;
    const end = data.page.endInput.value;
    const predicted: Record<string, number> = {};
    for (const seat of data.live.seats) {
      const cls = siteSeatClass(seat, date, start, end, 30);
      predicted[cls] = (predicted[cls] || 0) + 1;
    }
    const observed = {
      green: data.page.classCounts.green || 0,
      yellowGreen: data.page.classCounts.yellowGreen || 0,
      yellow: data.page.classCounts.yellow || 0,
      gray: data.page.classCounts.gray || 0,
    };
    const actual = {
      green: predicted.green || 0,
      yellowGreen: predicted.yellowGreen || 0,
      yellow: predicted.yellow || 0,
      gray: predicted.gray || 0,
    };
    assert.deepEqual(actual, observed, `${name}（${date} ${start}-${end}）分类分布不一致`);
  }
});

test('【证据】阈值 30 分钟是唯一可行值：换成 60 分钟无法复现', () => {
  let anyMismatch = 0;
  for (const {name, data} of evidence) {
    const date = data.page.dateInput.value;
    const {startInput, endInput} = data.page;
    const predicted: Record<string, number> = {};
    for (const seat of data.live.seats) {
      const cls = siteSeatClass(seat, date, startInput.value, endInput.value, 60);
      predicted[cls] = (predicted[cls] || 0) + 1;
    }
    const observedGreen = data.page.classCounts.green || 0;
    const observedYellowGreen = data.page.classCounts.yellowGreen || 0;
    if ((predicted.green || 0) !== observedGreen || (predicted.yellowGreen || 0) !== observedYellowGreen) anyMismatch += 1;
    assert.ok(name.length > 0);
  }
  assert.ok(anyMismatch > 0, '若 60 分钟也能复现，则无法区分阈值，本结论不成立');
});

// ---------------------------------------------------------------------------
// 2. resvStatus 映射
// ---------------------------------------------------------------------------
const seatBase = (over: Partial<SeatLike> = {}): SeatLike => ({
  openStart: '07:30',
  openEnd: '21:40',
  resvIntervals: [],
  devStatus: 0,
  openState: 1,
  ...over,
});

test('resvStatus 1027 / 1029 / 1093 不影响分类：同一时间结构结果相同', () => {
  const mk = (status: number) =>
    seatBase({
      resvIntervals: [{startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 11:00:00', resvStatus: status}],
    });
  const classes = [1027, 1029, 1093].map((s) => siteSeatClass(mk(s), '2026-11-02', '09:00', '11:00', 30));
  assert.deepEqual(classes, ['yellow', 'yellow', 'yellow'], '三种 resvStatus 在相同时间结构下应得到相同分类');

  const verdicts = [1027, 1029, 1093].map(
    (s) => decideSeatStatus({seat: mk(s), reservationDate: '2026-11-02', start: '09:00', end: '11:00'}).verdict,
  );
  assert.deepEqual(verdicts, ['OCCUPIED', 'OCCUPIED', 'OCCUPIED']);
});

test('位 128 置位的记录不计入占用（与网页 getFreeArray 行为一致）', () => {
  const with128 = seatBase({
    resvIntervals: [{startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 11:00:00', resvStatus: 1027 | 128}],
  });
  const without = seatBase({resvIntervals: []});
  assert.equal(siteSeatClass(with128, '2026-11-02', '09:00', '11:00', 30), siteSeatClass(without, '2026-11-02', '09:00', '11:00', 30));
});

test('未观测到的 resvStatus 值不被假设为任何语义', () => {
  const unknownStatus = seatBase({
    resvIntervals: [{startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 11:00:00', resvStatus: 7}],
  });
  // 7 不含位 128，因此按占用处理；但判决不得因此变成 AVAILABLE
  const r = decideSeatStatus({seat: unknownStatus, reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
  assert.equal(r.verdict, 'OCCUPIED');
  assert.equal(r.dependsOnMinDuration, false);
});

// ---------------------------------------------------------------------------
// 3. openState 映射
// ---------------------------------------------------------------------------
test('openState 全为 1 时不改变任何结论；改为 0 也不改变（该字段不参与判决）', () => {
  const mk = (openState: unknown) => seatBase({openState});
  const a = decideSeatStatus({seat: mk(1), reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
  const b = decideSeatStatus({seat: mk(0), reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
  assert.equal(a.verdict, b.verdict, 'openState 不应影响判决');
  assert.equal(
    siteSeatClass(mk(1), '2026-11-02', '09:00', '11:00', 30),
    siteSeatClass(mk(0), '2026-11-02', '09:00', '11:00', 30),
  );
});

test('devStatus 0 与 1 得到相同判决（红线：devStatus 不参与判断）', () => {
  const mk = (devStatus: unknown) => seatBase({devStatus});
  const a = decideSeatStatus({seat: mk(0), reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
  const b = decideSeatStatus({seat: mk(1), reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.freeMinutes, b.freeMinutes);
});

// ---------------------------------------------------------------------------
// 4. 不同预约时段
// ---------------------------------------------------------------------------
test('不同预约时段导致不同判决：全空 / 全占 / 部分空', () => {
  const empty = seatBase();
  assert.equal(decideSeatStatus({seat: empty, reservationDate: '2026-11-02', start: '09:00', end: '11:00'}).verdict, 'UNKNOWN');

  const full = seatBase({resvIntervals: [{startTime: '2026-11-02 07:00:00', endTime: '2026-11-02 22:00:00', resvStatus: 1027}]});
  assert.equal(decideSeatStatus({seat: full, reservationDate: '2026-11-02', start: '09:00', end: '11:00'}).verdict, 'OCCUPIED');

  const partial = seatBase({resvIntervals: [{startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 10:00:00', resvStatus: 1027}]});
  assert.equal(
    decideSeatStatus({seat: partial, reservationDate: '2026-11-02', start: '09:00', end: '11:00'}).verdict,
    'NEEDS_REVIEW',
    '部分空闲依赖最短时长，应保持 NEEDS_REVIEW',
  );
});

test('部分空闲：给出最短时长时按该值裁决', () => {
  const partial = seatBase({resvIntervals: [{startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 10:20:00', resvStatus: 1027}]});
  const generous = decideSeatStatus({
    seat: partial,
    reservationDate: '2026-11-02',
    start: '09:00',
    end: '11:00',
    minDurationMinutes: 30,
  });
  assert.equal(generous.longestGapMinutes, 40);
  assert.equal(generous.verdict, 'UNKNOWN', '空档够长但资格未知，仍是 UNKNOWN');

  const strict = decideSeatStatus({
    seat: partial,
    reservationDate: '2026-11-02',
    start: '09:00',
    end: '11:00',
    minDurationMinutes: 60,
  });
  assert.equal(strict.verdict, 'OCCUPIED', '按 60 分钟下限，40 分钟空档不够');
});

// ---------------------------------------------------------------------------
// 5. 日期变化
// ---------------------------------------------------------------------------
test('日期变化：只统计所选日期的预约，前一天/后一天记录不参与', () => {
  const seat = seatBase({
    resvIntervals: [
      {startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 11:00:00', resvStatus: 1027},
      {startTime: '2026-11-03 09:00:00', endTime: '2026-11-03 11:00:00', resvStatus: 1027},
    ],
  });
  assert.equal(intervalsOnDate(seat, '2026-11-02').length, 1);
  assert.equal(intervalsOnDate(seat, '2026-11-03').length, 1);
  assert.equal(intervalsOnDate(seat, '2026-11-04').length, 0);
  assert.equal(decideSeatStatus({seat, reservationDate: '2026-11-04', start: '09:00', end: '11:00'}).verdict, 'UNKNOWN');
  assert.equal(decideSeatStatus({seat, reservationDate: '2026-11-02', start: '09:00', end: '11:00'}).verdict, 'OCCUPIED');
});

// ---------------------------------------------------------------------------
// 6. 闭馆时间
// ---------------------------------------------------------------------------
test('闭馆时间：完全落在开放时段外一律 CLOSED', () => {
  const seat = seatBase();
  for (const [s, e] of [
    ['06:00', '07:00'],
    ['22:00', '23:00'],
    ['21:41', '23:00'],
  ]) {
    const r = decideSeatStatus({seat, reservationDate: '2026-11-02', start: s, end: e});
    assert.equal(r.verdict, 'CLOSED', `${s}-${e} 应判 CLOSED`);
  }
});

test('部分越界不得直接判 CLOSED（任务三要求）：应为 NEEDS_REVIEW', () => {
  const seat = seatBase();
  for (const [s, e] of [
    ['07:00', '09:00'], // 开始早于开放
    ['20:00', '22:00'], // 结束晚于闭馆
    ['21:00', '22:30'],
  ]) {
    const r = decideSeatStatus({seat, reservationDate: '2026-11-02', start: s, end: e});
    assert.equal(r.verdict, 'NEEDS_REVIEW', `${s}-${e} 部分越界应为 NEEDS_REVIEW`);
    assert.match(r.reasons.join(' '), /落在开放时间/);
  }
});

test('边界恰好相等不算越界：start=openStart、end=openEnd 都在范围内', () => {
  const seat = seatBase();
  const atOpen = decideSeatStatus({seat, reservationDate: '2026-11-02', start: '07:30', end: '09:00'});
  assert.notEqual(atOpen.verdict, 'CLOSED');
  assert.notEqual(atOpen.verdict, 'NEEDS_REVIEW');

  const atClose = decideSeatStatus({seat, reservationDate: '2026-11-02', start: '19:40', end: '21:40'});
  assert.notEqual(atClose.verdict, 'CLOSED');
  assert.notEqual(atClose.verdict, 'NEEDS_REVIEW');
});

test('跨日窗口：完全落在开放时段外的判 CLOSED，部分重叠的判 NEEDS_REVIEW', () => {
  const seat = seatBase();
  const fullyOutside = decideSeatStatus({seat, reservationDate: '2026-11-02', start: '23:00', end: '01:00'});
  assert.equal(fullyOutside.verdict, 'CLOSED');
  assert.match(fullyOutside.reasons.join(' '), /跨日/);
  assert.equal(fullyOutside.windowMinutes, 120, '跨日窗口长度按 24 小时环绕计算');

  const partlyInside = decideSeatStatus({seat, reservationDate: '2026-11-02', start: '20:00', end: '01:00'});
  assert.equal(partlyInside.verdict, 'NEEDS_REVIEW');
  assert.equal(partlyInside.windowMinutes, 300);
});

test('缺开放时间判 UNKNOWN', () => {
  const r = decideSeatStatus({
    seat: seatBase({openStart: null, openEnd: null}),
    reservationDate: '2026-11-02',
    start: '09:00',
    end: '11:00',
  });
  assert.equal(r.verdict, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// 7. 状态冲突：最短时长来源冲突必须体现为 NEEDS_REVIEW
// ---------------------------------------------------------------------------
test('最短时长冲突：未提供下限时，部分空闲不得判 AVAILABLE 或 OCCUPIED', () => {
  const partial = seatBase({resvIntervals: [{startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 10:40:00', resvStatus: 1027}]});
  const r = decideSeatStatus({seat: partial, reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
  assert.equal(r.verdict, 'NEEDS_REVIEW');
  assert.equal(r.dependsOnMinDuration, true);
  assert.match(r.reasons.join(' '), /冲突/);
});

// ---------------------------------------------------------------------------
// 8. UNKNOWN 恒不变量
// ---------------------------------------------------------------------------
test('UNKNOWN 恒不变量：默认输入下永不 AVAILABLE', () => {
  const cases = [
    seatBase(),
    seatBase({resvIntervals: [{startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 10:00:00', resvStatus: 1027}]}),
    seatBase({devStatus: 0, openState: 1}),
    seatBase({devStatus: 9, openState: 0}),
  ];
  for (const seat of cases) {
    const r = decideSeatStatus({seat, reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
    assert.notEqual(r.verdict, 'AVAILABLE', '未提供资格与已确认规则时绝不允许 AVAILABLE');
  }
});

test('AVAILABLE 只在资格明确且规则确认时出现，且仍受最短时长约束', () => {
  const free = seatBase();
  const withEligibility = decideSeatStatus({
    seat: free,
    reservationDate: '2026-11-02',
    start: '09:00',
    end: '11:00',
    eligibility: 'ELIGIBLE',
    minDurationMinutes: 30,
  });
  assert.equal(withEligibility.verdict, 'AVAILABLE');

  const unresolvedRule = decideSeatStatus({
    seat: free,
    reservationDate: '2026-11-02',
    start: '09:00',
    end: '11:00',
    eligibility: 'ELIGIBLE',
    minDurationMinutes: null,
  });
  assert.equal(unresolvedRule.verdict, 'NEEDS_REVIEW', '规则未确认时即使整窗空闲也只能 NEEDS_REVIEW');

  const notEligible = decideSeatStatus({
    seat: free,
    reservationDate: '2026-11-02',
    start: '09:00',
    end: '11:00',
    eligibility: 'NOT_ELIGIBLE',
    minDurationMinutes: 30,
  });
  assert.equal(notEligible.verdict, 'OCCUPIED');
});

// ---------------------------------------------------------------------------
// 9. 历史数据与实时数据隔离
// ---------------------------------------------------------------------------
test('历史快照座位（无 resvInfo、无 openTimes）不会被判 AVAILABLE 或 OCCUPIED', () => {
  const historical: SeatLike = {
    openStart: null,
    openEnd: null,
    resvIntervals: [],
    devStatus: 0,
    openState: 1,
  };
  const r = decideSeatStatus({seat: historical, reservationDate: '2026-11-02', start: '09:00', end: '11:00'});
  assert.equal(r.verdict, 'UNKNOWN', '缺开放时段的历史数据必须是 UNKNOWN');
  assert.ok(r.reasons.length > 0);
});

test('【证据】历史快照解析器输出的座位仍全部为 UNKNOWN，未被本模块改写', async () => {
  const snapshot = JSON.parse(
    readFileSync(fileURLToPath(new URL('../src/data/verified-seat-snapshot.json', import.meta.url)), 'utf8'),
  );
  const {parseSeatSnapshot} = await import('../src/content/seat-reader');
  const parsed = parseSeatSnapshot(snapshot);
  assert.ok(parsed.seats.every((s) => s.status === 'UNKNOWN'));
});
