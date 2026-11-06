import test from 'node:test';
import assert from 'node:assert/strict';
import {matchingOfficialRecords, readDailySeat} from '../src/core/daily-observations';
import {normalizeReservePayload} from '../src/core/live-seats';
import type {BookingTarget} from '../src/core/daily-booking-scheduler';
import type {OfficialReservation} from '../src/core/product-model';

const now = Date.parse('2030-01-01T07:55:00+08:00');
const seat = {devId: 54321, devName: 'D1-01', roomId: 123, roomName: '预约自习室', devStatus: 0, resvInfo: []};
const snapshot = normalizeReservePayload([seat], new Date(now).toISOString());
const read = (route = '#/ic/seatPredetermine/123', title = '预约自习室', codes = ['D1-01'], when = now, live = snapshot) =>
  readDailySeat(live, route, title, codes, '预约自习室', 'D1-01', when);

test('实时目标标识要求路由、区域、座位 DOM 和新鲜响应一致', () => {
  assert.deepEqual(read(), {roomId: '123', seatId: '54321', roomName: '预约自习室', seatCode: 'D1-01', observedAt: now});
  assert.equal(read('#/ic/seatPredetermine/987'), null);
  assert.equal(read('#/ic/userinfo'), null);
  assert.equal(read(undefined, '电子阅览室'), null);
  assert.equal(read(undefined, undefined, ['D1-02']), null);
  assert.equal(read(undefined, undefined, ['D1-01', 'D1-01']), null);
  assert.equal(read(undefined, undefined, undefined, now + 120_001), null);
  assert.equal(read(undefined, undefined, undefined, now - 1), null);
  const duplicate = normalizeReservePayload([seat, {...seat, devId: 54322}], new Date(now).toISOString());
  assert.equal(read(undefined, undefined, undefined, now, duplicate), null);
});

const target: BookingTarget = {
  date: '2030-01-02', floorName: '一楼', roomName: '预约自习室', seatCode: 'D1-01', roomId: '123', seatId: '54321',
  startAt: '2030-01-02T09:00:00+08:00', endAt: '2030-01-02T10:00:00+08:00',
};
const row: OfficialReservation = {...target, id: 'TEST-ONLY-1', source: 'OFFICIAL_VISIBLE_DOM',
  observedAt: new Date(now).toISOString(), displayStatus: '审核通过', officialConfirmed: false, cancelled: false};

test('个人预约核验要求完整匹配并区分重复、取消、未知状态', () => {
  assert.equal(matchingOfficialRecords(target, [row]), 1);
  assert.equal(matchingOfficialRecords(target, [row, {...row, id: 'TEST-ONLY-2'}]), 2);
  assert.equal(matchingOfficialRecords(target, [{...row, floorName: '二楼'}]), 0);
  assert.equal(matchingOfficialRecords(target, [{...row, roomName: '电子阅览室'}]), 0);
  assert.equal(matchingOfficialRecords(target, [{...row, endAt: '2030-01-02T10:01:00+08:00'}]), 0);
  assert.equal(matchingOfficialRecords(target, [{...row, cancelled: true, displayStatus: '已取消'}]), 0);
  assert.equal(matchingOfficialRecords(target, [{...row, displayStatus: '状态不明'}]), null);
});
