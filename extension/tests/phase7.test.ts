/**
 * Phase 7 测试：位标志解码、记录生命周期、四维分离、前置检查。
 *
 * 其中「记录分布」一项直接读 180 周期长跑证据，断言 173 条记录 / 18 份快照 / 0 事件。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {legacyPath} from './legacy-root';
import {
  BIT_MEANINGS,
  OBSERVED_VALUE_COUNTS,
  decodeResvStatus,
  decodeSafety,
  describeDecoded,
} from '../src/core/resv-decoding';
import {
  classifyRecordPhase,
  diffSnapshots,
  summarizeRoom,
  whatDoesDisappearanceMean,
  type RecordKeyed,
} from '../src/core/resv-lifecycle';
import {reservationPreflight, DIMENSION_BOUNDARIES} from '../src/core/reservation-preflight';
import type {SeatLike} from '../src/core/seat-status';

interface WatchEvidence {
  cycles: number;
  intervalSec: number;
  startedAtBeijing: string;
  finishedAtBeijing: string;
  events: unknown[];
  sessionLosses: unknown[];
  firstSnapshot: {at: string; records: Array<{key: string; status: number}>};
  finalSnapshot: {at: string; recordCount: number; records: Array<{key: string; status: number}>};
  periodicSnapshots: Array<{at: string; records: Array<{key: string; status: number}>}>;
}

const evidencePath = legacyPath('research/phase7/evidence/room-watch-1935-2150.json');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as WatchEvidence;

// ---------------------------------------------------------------------------
// 1–3. 三个已知取值的解码
// ---------------------------------------------------------------------------
test('1027 解码：1+2+1024，含「待生效」，位 1 为未知位', () => {
  const d = decodeResvStatus(1027);
  assert.ok(d);
  assert.equal(d.raw, 1027, '原始整数必须原样保留');
  assert.deepEqual(d.setBits, [1, 2, 1024]);
  assert.deepEqual(d.unknownBits, [1], '位 1 不在站点字典中，必须列为未知');
  assert.ok(d.labels.includes('待生效'));
  assert.equal(d.fullyExplained, false);
  assert.equal(d.businessStateInferred, false, '不得推断完整业务状态');
});

test('1029 解码：1+4+1024，含「生效中」，不含已签到位', () => {
  const d = decodeResvStatus(1029);
  assert.ok(d);
  assert.deepEqual(d.setBits, [1, 4, 1024]);
  assert.ok(d.labels.includes('生效中'));
  assert.equal(d.raw & 64, 0, '1029 不含位 64');
});

test('1093 解码：1+4+64+1024，含「已签到」候选位（等级 C）', () => {
  const d = decodeResvStatus(1093);
  assert.ok(d);
  assert.deepEqual(d.setBits, [1, 4, 64, 1024]);
  assert.equal(d.raw & 64, 64);
  const checkedIn = d.known.find((m) => m.bit === 64);
  assert.ok(checkedIn);
  assert.equal(checkedIn.label, '已签到');
  assert.equal(checkedIn.grade, 'C', '已签到位只能记为候选（代码推断 + 强相关），不得升为因果');
  assert.equal(d.weakestGrade, 'C');
});

test('三个取值的位组合互不相同，且与现场计数一致', () => {
  const combos = [1027, 1029, 1093].map((v) => decodeResvStatus(v)!.setBits.join('+'));
  assert.equal(new Set(combos).size, 3);
  assert.deepEqual(OBSERVED_VALUE_COUNTS, {1027: 23, 1029: 4, 1093: 146});
  assert.equal(23 + 4 + 146, 173, '三者之和应等于长跑中的 173 条记录');
});

// ---------------------------------------------------------------------------
// 4. 未知位与未知取值
// ---------------------------------------------------------------------------
test('未知位只列出、不解释；完全没有已知位的取值安全降级为 null', () => {
  const withUnknown = decodeResvStatus(1027 | 8); // 加一个字典里没有的位
  assert.ok(withUnknown);
  assert.ok(withUnknown.unknownBits.includes(8));
  assert.equal(withUnknown.known.some((m) => m.bit === 8), false, '未知位不得被赋标签');
  assert.equal(withUnknown.fullyExplained, false);

  for (const v of [8, 32, 4096, 0, -1, 1.5, null, undefined, '1027' as unknown as number]) {
    assert.equal(decodeResvStatus(v), null, `${String(v)} 应无法解释并降级`);
  }
});

test('安全降级：含候选位或未知位时不得给出 USABLE', () => {
  assert.equal(decodeSafety(1027).level, 'CAUTION', '位 1 未解释');
  assert.equal(decodeSafety(1093).level, 'CAUTION', '含候选位 64');
  // 完全没有已知位的取值 → 无法解释 → UNKNOWN
  assert.equal(decodeSafety(8).level, 'UNKNOWN');
  assert.equal(decodeSafety(4096).level, 'UNKNOWN');
  // 含大量未知位但仍能识别部分位 → 只能是 CAUTION，且必须点名未知位
  const messy = decodeSafety(9999);
  assert.equal(messy.level, 'CAUTION');
  assert.match(messy.reason, /未解释的位/);
  // 只有全部位都有观察支撑时才允许 USABLE
  assert.equal(decodeSafety(6).level, 'USABLE', '2+4 均为有观察支撑的位');
});

test('位字典自身一致性：位值互不重复、均为 2 的幂、标签非空', () => {
  const bits = BIT_MEANINGS.map((m) => m.bit);
  assert.equal(new Set(bits).size, bits.length);
  for (const b of bits) assert.equal(b & (b - 1), 0, `${b} 不是 2 的幂`);
  for (const m of BIT_MEANINGS) assert.ok(m.label.length > 0 && m.note.length > 0);
});

// ---------------------------------------------------------------------------
// 5. 64 位标志
// ---------------------------------------------------------------------------
test('64 位只在 1093 上出现；1027/1029 均无', () => {
  assert.equal(1027 & 64, 0);
  assert.equal(1029 & 64, 0);
  assert.equal(1093 & 64, 64);
  // 位 64 的语义等级必须是 C —— 不允许因为"字典这么说"就当作已证实
  assert.equal(BIT_MEANINGS.find((m) => m.bit === 64)!.grade, 'C');
});

// ---------------------------------------------------------------------------
// 6. 时间自然流逝不会自动转换
// ---------------------------------------------------------------------------
const rec = (over: Partial<{startTime: string; endTime: string; resvStatus: number}> = {}) => ({
  startTime: '2026-11-02 19:30:00',
  endTime: '2026-11-02 21:40:00',
  resvStatus: 1029,
  ...over,
});

test('时间流逝不改变相位：1029 记录从开始前到开始后仍是「生效中未签到」', () => {
  const date = '2026-11-02';
  const before = classifyRecordPhase(rec(), 19 * 60 + 10, date);
  const afterStart = classifyRecordPhase(rec(), 19 * 60 + 32, date);
  const deepInto = classifyRecordPhase(rec(), 21 * 60 + 30, date);
  for (const p of [before, afterStart, deepInto]) {
    assert.equal(p.phase, 'EFFECTIVE_NOT_CHECKED_IN');
    assert.equal(p.dependsOnCheckinBit, false);
  }
  // 到点不会凭空产生「已签到」相位
  assert.notEqual(afterStart.phase, 'EFFECTIVE_CHECKED_IN');
});

test('过了结束时刻后按「时钟事实」判为已结束（A 级，与状态位无关）', () => {
  const p = classifyRecordPhase(rec(), 21 * 60 + 45, '2026-11-02');
  assert.equal(p.phase, 'ENDED_BY_TIME');
  assert.equal(p.grade, 'A');
  assert.equal(p.dependsOnCheckinBit, false);
});

test('跨日记录不参与判断', () => {
  const p = classifyRecordPhase(rec(), 20 * 60, '2026-11-03');
  assert.equal(p.phase, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// 7. 记录消失
// ---------------------------------------------------------------------------
const keyed = (key: string, status: number, seat = '1D-001'): RecordKeyed => ({
  key,
  seat,
  start: '2026-11-02 19:30:00',
  end: '2026-11-02 21:40:00',
  status,
});

test('快照对比能识别新增/移除/变化，且不解释移除原因', () => {
  const prev = [keyed('1D-001|a', 1027), keyed('1D-002|a', 1093), keyed('1D-003|a', 1029)];
  const cur = [keyed('1D-002|a', 1093), keyed('1D-003|a', 1093), keyed('1D-004|a', 1027)];
  const d = diffSnapshots(prev, cur);
  assert.deepEqual(d.removed.map((r) => r.key), ['1D-001|a']);
  assert.deepEqual(d.added.map((r) => r.key), ['1D-004|a']);
  assert.deepEqual(d.changed.map((c) => c.key), ['1D-003|a']);
  assert.equal(d.changed[0].from, 1029);
  assert.equal(d.changed[0].to, 1093);
  assert.equal(d.disappearanceMeaning, 'UNKNOWN', '消失的含义必须标为 UNKNOWN');
});

// ---------------------------------------------------------------------------
// 8. 消失 ≠ 取消
// ---------------------------------------------------------------------------
test('记录消失不得被解释为取消/完成/违约', () => {
  const ans = whatDoesDisappearanceMean();
  assert.equal(ans.grade, 'D');
  assert.match(ans.answer, /不能说明|UNKNOWN/);
  assert.equal(/取消成功|已完成|违约了/.test(ans.answer), false, '不得出现确定性结论字样');
});

test('【真站证据】173 条记录在 2h15m 内 0 次变化、0 次移除', () => {
  assert.equal(evidence.cycles, 180);
  assert.equal(evidence.intervalSec, 45);
  assert.equal(evidence.events.length, 0);
  assert.equal(evidence.sessionLosses.length, 0);
  assert.equal(evidence.periodicSnapshots.length, 18);
  assert.equal(evidence.firstSnapshot.records.length, 173);
  assert.equal(evidence.finalSnapshot.recordCount, 173);

  // 18 份快照的分布必须完全一致
  const sig = (records: Array<{status: number}>) => {
    const m: Record<string, number> = {};
    for (const r of records) m[String(r.status)] = (m[String(r.status)] || 0) + 1;
    return JSON.stringify(Object.entries(m).sort());
  };
  const sigs = new Set(evidence.periodicSnapshots.map((s) => sig(s.records)));
  assert.equal(sigs.size, 1, '快照分布应完全静止');
  assert.deepEqual(JSON.parse([...sigs][0]), [['1027', 23], ['1029', 4], ['1093', 146]]);
});

test('房间汇总能把同一快照分成四个相位，且不含可用性结论', () => {
  const nowMinute = 19 * 60 + 35;
  const records = evidence.firstSnapshot.records.map((r) => {
    const [seat, start] = r.key.split('|');
    return {startTime: start, endTime: `${start.slice(0, 10)} 23:59:00`, resvStatus: r.status};
  });
  const summary = summarizeRoom(records, nowMinute, '2026-11-02');
  assert.equal(summary.total, 173);
  assert.equal(summary.byRawStatus['1027'], 23);
  assert.equal(summary.byRawStatus['1029'], 4);
  assert.equal(summary.byRawStatus['1093'], 146);
  assert.deepEqual(summary.unknownStatusValues, []);
  assert.equal(summary.includesCandidateInterpretation, true, '含已签到位相位时必须标记');
  assert.equal('available' in summary, false, '汇总里不得出现可用性字段');
});

// ---------------------------------------------------------------------------
// 9. 座位状态与预约记录状态分离
// ---------------------------------------------------------------------------
const seat = (over: Partial<SeatLike> = {}): SeatLike => ({
  openStart: '07:30',
  openEnd: '21:40',
  resvIntervals: [],
  devStatus: 0,
  openState: 1,
  ...over,
});

test('四维分离：坐下用性、记录相位、签到位、资格 各自独立，不得合并', () => {
  assert.equal(Object.keys(DIMENSION_BOUNDARIES).length, 4);
  const r = reservationPreflight({
    seat: seat(),
    existingRecord: rec(),
    reservationDate: '2026-11-02',
    start: '19:30',
    end: '21:40',
    nowMinute: 19 * 60 + 35,
  });
  assert.equal(r.dimensions.timeWindow.verdict, 'UNKNOWN', '空座位但资格未知 → 时间维度不单独给可用');
  assert.equal(r.dimensions.recordStatus.phase, 'EFFECTIVE_NOT_CHECKED_IN');
  assert.equal(r.dimensions.checkinStatus.present, false);
  assert.equal(r.dimensions.eligibility.value, 'UNKNOWN');
  assert.notEqual(r.dimensions.timeWindow.verdict, r.dimensions.recordStatus.phase, '两个维度不得同值复用');
  assert.equal(r.dimensions.checkinStatus.detail.includes('不代表'), true, '签到位不得等同于本人到场');
});

test('预约记录含已签到位时，只影响签到维度，不改变座位时间结论', () => {
  const base = {
    seat: seat(),
    reservationDate: '2026-11-02',
    start: '19:30',
    end: '21:40',
    nowMinute: 19 * 60 + 35,
  };
  const withBit = reservationPreflight({...base, existingRecord: rec({resvStatus: 1093})});
  const withoutBit = reservationPreflight({...base, existingRecord: rec({resvStatus: 1029})});
  assert.equal(withBit.dimensions.checkinStatus.present, true);
  assert.equal(withoutBit.dimensions.checkinStatus.present, false);
  assert.equal(withBit.dimensions.timeWindow.verdict, withoutBit.dimensions.timeWindow.verdict);
});

// ---------------------------------------------------------------------------
// 10. 资格未知阻断
// ---------------------------------------------------------------------------
test('资格未知时恒不可提交，且列出阻断原因', () => {
  for (const eligibility of [undefined, 'UNKNOWN'] as const) {
    const r = reservationPreflight({
      seat: seat(),
      reservationDate: '2026-11-02',
      start: '09:00',
      end: '11:00',
      nowMinute: 9 * 60,
      eligibility,
    });
    assert.equal(r.ready, false);
    assert.equal(r.executesRealReservation, false);
    assert.ok(r.blockers.some((b) => b.includes('资格')));
  }
});

test('即使资格明确可约、整窗空闲，也仍不可提交（规则冲突未解）', () => {
  const r = reservationPreflight({
    seat: seat(),
    reservationDate: '2026-11-02',
    start: '09:00',
    end: '11:00',
    nowMinute: 9 * 60,
    eligibility: 'ELIGIBLE',
    minDurationMinutes: null,
  });
  assert.equal(r.ready, false, '恒不变量：任何输入都不得让 ready 为 true');
  assert.equal(r.checks.find((c) => c.id === 'time-window')?.state, 'NEEDS_REVIEW');
});
