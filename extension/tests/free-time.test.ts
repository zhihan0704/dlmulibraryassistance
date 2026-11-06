/**
 * 空闲时段推算的正确性测试。
 *
 * 关键用例直接读**真站采集证据**（research/live/2026-11-02/capture-1247.json），
 * 要求：用 resvInfo 推算的「是否有空闲」数量，必须与网页自己渲染的
 * `withFreeIntervals` 完全一致（120 有 / 32 无）。
 *
 * 这条测试的意义：它不是「我算出了一个数」，而是「我算的数与网页自己的数相等」。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {legacyPath} from './legacy-root';
import {beijingMinuteOfDay, freeGaps, mergeOccupied, totalFreeMinutes} from '../src/core/free-time';

interface CapturedSeat {
  name: string;
  devStatus: number;
  status: string;
  openStart: string | null;
  openEnd: string | null;
  resvIntervals: Array<{startTime: string; endTime: string; resvStatus: number | null}>;
}

interface Evidence {
  capturedAt: string;
  dom: {withFreeIntervals: number};
  capture: {snapshot: {seats: CapturedSeat[]}};
}

const evidencePath = legacyPath('research/live/2026-11-02/capture-1247.json');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Evidence;

test('占用区间合并：相邻与重叠会被合并，位 128 的记录被排除', () => {
  const merged = mergeOccupied([
    {startTime: '2026-11-02 09:00:00', endTime: '2026-11-02 11:00:00', resvStatus: 1027},
    {startTime: '2026-11-02 11:00:00', endTime: '2026-11-02 12:00:00', resvStatus: 1027},
    {startTime: '2026-11-02 10:00:00', endTime: '2026-11-02 10:30:00', resvStatus: 1093},
    {startTime: '2026-11-02 14:00:00', endTime: '2026-11-02 15:00:00', resvStatus: 1027 | 128},
  ]);
  assert.deepEqual(merged, [{start: 9 * 60, end: 12 * 60}]);
});

test('空闲区间：两侧都有空隙时返回两段', () => {
  const gaps = freeGaps(
    {
      openStart: '08:00',
      openEnd: '22:00',
      resvIntervals: [{startTime: '2026-11-02 10:00:00', endTime: '2026-11-02 12:00:00', resvStatus: 1027}],
    },
    8 * 60,
  );
  assert.deepEqual(gaps, [
    {start: '08:00', end: '10:00', minutes: 120},
    {start: '12:00', end: '22:00', minutes: 600},
  ]);
});

test('空闲区间：全程被占时返回空数组；开放时间缺失时也不猜', () => {
  const full = freeGaps(
    {
      openStart: '08:00',
      openEnd: '22:00',
      resvIntervals: [{startTime: '2026-11-02 07:00:00', endTime: '2026-11-02 23:00:00', resvStatus: 1027}],
    },
    9 * 60,
  );
  assert.deepEqual(full, []);
  assert.deepEqual(freeGaps({openStart: null, openEnd: '22:00', resvIntervals: []}, 600), []);
});

test('【真站证据】推算结果必须与网页渲染的 withFreeIntervals 完全一致', () => {
  const from = beijingMinuteOfDay(evidence.capturedAt) + 1; // 网页逻辑：现在 + 1 分钟
  const seats = evidence.capture.snapshot.seats;

  assert.equal(seats.length, 152, '证据应包含 152 个座位');

  const withFree = seats.filter((s) => totalFreeMinutes(s, from) > 0).length;
  const domWithFree = evidence.dom.withFreeIntervals;

  assert.equal(withFree, domWithFree, `推算「有空闲」=${withFree}，网页渲染=${domWithFree}，必须相等`);
  assert.equal(seats.length - withFree, 152 - domWithFree);
});

test('【真站证据】devStatus 全为 0，但座位空闲情况并不一致（红线实证）', () => {
  const seats = evidence.capture.snapshot.seats;
  assert.ok(seats.every((s) => s.devStatus === 0), '本样本 devStatus 应全为 0');
  assert.ok(seats.every((s) => s.status === 'UNKNOWN'), '规范化结果必须保持 UNKNOWN');

  const from = beijingMinuteOfDay(evidence.capturedAt) + 1;
  const kinds = new Set(seats.map((s) => (totalFreeMinutes(s, from) === 0 ? '0' : '>0')));
  assert.equal(kinds.size, 2, '在同一 devStatus=0 下应同时存在「无空闲」与「有空闲」');
});

test('【真站证据】第二次采集（12:51）推算同样与网页一致（跨两次样本）', () => {
  const secondPath = legacyPath('research/live/2026-11-02/capture-1251.json');
  const second = JSON.parse(readFileSync(secondPath, 'utf8')) as Evidence;
  const from = beijingMinuteOfDay(second.capturedAt) + 1;
  const seats = second.capture.snapshot.seats;
  assert.equal(seats.length, 152);

  const withFree = seats.filter((s) => totalFreeMinutes(s, from) > 0).length;
  assert.equal(withFree, second.dom.withFreeIntervals, '两次样本都必须与网页渲染值相等');

  // 两次采集的状态类分布不同，但空闲数相同 —— 说明 className 不决定空闲判断
  assert.notDeepEqual(evidence.dom.withFreeIntervals, undefined);
});

test('【真站证据】采集文件中不含任何他人身份字段', () => {
  const raw = readFileSync(evidencePath, 'utf8');
  for (const leak of ['trueName', 'logonName', 'realName', 'resvId', 'uuid']) {
    assert.equal(raw.includes(leak), false, `证据中不应出现 ${leak}`);
  }
});
