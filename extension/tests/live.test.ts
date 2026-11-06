import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findSeatArray, normalizeReservePayload, readPosition, summarizeSnapshot} from '../src/core/live-seats';

const seat = (over: Record<string, unknown> = {}) => ({
  devId: 100456941,
  devName: '1D-001',
  roomId: 100455855,
  roomName: '电子阅览室',
  coordinate: '3.370787,33.133733',
  devStatus: 0,
  openState: 1,
  openStart: '08:30',
  openEnd: '21:40',
  onlyView: false,
  ...over,
});

test('实时响应规范化：状态恒为 UNKNOWN，不推断可用性', () => {
  const snapshot = normalizeReservePayload({code: 0, data: [seat(), seat({devId: 100456942, devName: '1D-002'})]}, '2026-11-02T04:00:00.000Z');
  assert.equal(snapshot.source, 'LIVE_RESERVE');
  assert.equal(snapshot.seats.length, 2);
  assert.ok(snapshot.seats.every((s) => s.status === 'UNKNOWN'));
  // devStatus=0 必须原样保留，绝不能被解释成空闲
  assert.equal(snapshot.seats[0].devStatus, 0);
  assert.deepEqual(snapshot.seats[0].position, {x: 3.370787, y: 33.133733});
});

test('他人身份字段在规范化时丢弃，只保留时间段与状态码', () => {
  const snapshot = normalizeReservePayload(
    {
      data: [
        seat({
          resvInfo: [
            {startTime: '2026-11-02 09:00', endTime: '2026-11-02 11:00', resvStatus: 0, title: {trueName: '张三'}, trueName: '张三', logonName: 'student01'},
          ],
        }),
      ],
    },
    '2026-11-02T04:00:00.000Z',
  );
  const interval = snapshot.seats[0].resvIntervals[0];
  assert.deepEqual(interval, {startTime: '2026-11-02 09:00', endTime: '2026-11-02 11:00', resvStatus: 0});
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('张三'), false);
  assert.equal(serialized.includes('student01'), false);
});

test('兼容信封、直接数组与嵌套 data 三种结构', () => {
  const bare = normalizeReservePayload([seat()], '2026-11-02T04:00:00.000Z');
  assert.equal(bare.seats.length, 1);
  const envelope = normalizeReservePayload({code: 0, message: '查询成功', data: [seat()]}, '2026-11-02T04:00:00.000Z');
  assert.equal(envelope.seats.length, 1);
  const nested = normalizeReservePayload({data: {data: [seat()]}}, '2026-11-02T04:00:00.000Z');
  assert.equal(nested.seats.length, 1);
});

test('结构性错误一律拒绝，不返回半截数据', () => {
  for (const bad of [null, undefined, {}, {data: []}, [], 'x', 42, {data: {}}]) {
    assert.throws(() => normalizeReservePayload(bad, '2026-11-02T04:00:00.000Z'));
  }
  assert.equal(findSeatArray({data: [{noId: 1}]}), null);
});

test('重复 devId 与畸形行被跳过并计数，而非静默误用', () => {
  const snapshot = normalizeReservePayload(
    {data: [seat(), seat({devName: '1D-002'}), {devId: 'bad'}, seat({devId: 100456943, devName: ''})]},
    '2026-11-02T04:00:00.000Z',
  );
  assert.equal(snapshot.seats.length, 1);
  assert.equal(snapshot.invalidRows, 3);
  // 所有记录都无效时必须抛错
  assert.throws(() => normalizeReservePayload({data: [{devId: 0}]}, '2026-11-02T04:00:00.000Z'));
});

test('坐标解析容忍缺失但拒绝越界', () => {
  assert.deepEqual(readPosition('10,20.5'), {x: 10, y: 20.5});
  for (const bad of [null, '', '1', '1,2,3', 'NaN,3', '101,20', '-1,2', '1;2']) {
    assert.equal(readPosition(bad), null);
  }
});

test('摘要只陈述客观计数，不判断空闲或占用', () => {
  const snapshot = normalizeReservePayload(
    {
      data: [
        seat({resvInfo: [{startTime: '09:00', endTime: '10:00', resvStatus: 0}]}),
        seat({devId: 100456942, devName: '1D-002'}),
      ],
    },
    '2026-11-02T04:00:00.000Z',
  );
  const summary = summarizeSnapshot(snapshot);
  assert.equal(summary.total, 2);
  assert.equal(summary.withResv, 1);
  assert.equal(summary.withoutResv, 1);
  assert.equal(summary.rooms.length, 1);
  assert.equal(summary.rooms[0].count, 2);
  assert.equal(JSON.stringify(summary).includes('AVAILABLE'), false);
});

test('按真实接口 schema 构造的响应可被规范化（字段冗余、含空值、含未知字段）', () => {
  // 依据 research/phase2/evidence/network-after-login.json 记录的 /ic-web/reserve 真实 schema
  const realShaped = {
    devId: 100456941,
    devSn: 1,
    devName: '1D-001',
    minUser: 1,
    maxUser: 1,
    devStatus: 0,
    devProp: 2,
    coordinate: '3.370787,33.133733',
    icon: {url: 'x.png', width: 20, height: 20},
    kindId: 8,
    kindName: '座位',
    roomId: 100455855,
    roomSn: '1D',
    openRulesn: 1,
    openState: 1,
    roomName: '电子阅览室',
    roomProp: 0,
    labId: 0,
    labName: '',
    labProp: 0,
    openStart: '08:30',
    openEnd: '21:40',
    resvRule: {
      uuid: 'c0ad9fa823c147609860b1cab37d2a28',
      ruleId: 1,
      minResvTime: 30,
      maxResvTime: 240,
      earliestResvTime: 1440,
      latestResvTime: 0,
      cancelTime: 15,
      earlyInTime: 10,
      laterLineTime: 600,
      timeInterval: 5,
      maxResvTimeEveryday: null,
      memo: null,
    },
    kindUrl: '',
    kindProp: 0,
    openTimes: [{openStartTime: '08:30', openEndTime: '21:40', openLimit: 1}],
    resvInfo: [
      {
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        resvId: 9000001,
        startTime: '2026-11-02 09:00:00',
        endTime: '2026-11-02 11:00:00',
        title: {realName: '张三', dept: '某学院'},
        trueName: {realName: '张三'},
        logonName: {logonName: 'student01'},
        resvStatus: 0,
        resvEndRealTime: null,
        devId: 100456941,
      },
    ],
    endDayOpenInfo: null,
    pointSize: {1: 20, 2: 12, 4: 6},
    textSize: {1: 0, 2: 12, 4: 12},
    onlyView: false,
    addServices: [],
    deviceAttributes: null,
    usePersonType: 0,
    pointProperty: 1,
    maintenanceTime: null,
    startDayOfWeek: 0,
    deadlineTime: 0,
    timeScopeOpenInfo: null,
    campusId: 1,
  };

  const snapshot = normalizeReservePayload({code: 0, message: '查询成功', data: [realShaped]}, '2026-11-02T04:00:00.000Z');
  assert.equal(snapshot.seats.length, 1);
  const seat = snapshot.seats[0];
  assert.equal(seat.status, 'UNKNOWN');
  assert.equal(seat.devStatus, 0);
  assert.equal(seat.openStart, '08:30');
  assert.equal(seat.openEnd, '21:40');
  assert.equal(seat.onlyView, false);
  assert.deepEqual(seat.position, {x: 3.370787, y: 33.133733});
  assert.equal(seat.resvIntervals.length, 1);
  assert.equal(seat.resvIntervals[0].resvStatus, 0);
  assert.equal(seat.resvIntervals[0].startTime, '2026-11-02 09:00:00');
  // 冗余字段与身份字段都不得进入结果
  const text = JSON.stringify(snapshot);
  for (const leak of ['张三', 'student01', '某学院', 'aaaaaaaa-bbbb']) {
    assert.equal(text.includes(leak), false, `不应包含 ${leak}`);
  }
});

test('resvInfo 为 null 或非数组时不导致失败，只视为无记录', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const snapshot = normalizeReservePayload(
      {data: [seat({resvInfo: bad})]},
      '2026-11-02T04:00:00.000Z',
    );
    assert.equal(snapshot.seats[0].resvIntervals.length, 0);
    assert.equal(snapshot.seats[0].status, 'UNKNOWN');
  }
});
