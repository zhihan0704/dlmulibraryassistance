import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeReservePayload, summarizeSnapshot} from '../src/core/live-seats';
import {domSeatKey, fingerprintDom, fingerprintNetwork, networkSeatKey, SeatObservationMonitor, type DomSeatFingerprintInput, type SeatObservationChangeType} from '../src/core/seat-observation';

const start = Date.parse('2026-11-06T10:00:00+08:00');
const at = (offset = 0) => new Date(start + offset).toISOString();
const roomId = 100455855;
const rows = () => Array.from({length: 152}, (_, i) => ({
  devId: 10_000 + i,
  roomId,
  devName: '1D-' + String(i + 1).padStart(3, '0'),
  roomName: '电子阅览室',
  openStart: '07:30', openEnd: '21:40',
  devStatus: 0, openState: 1, coordinate: '2,4',
  resvInfo: [
    {startTime: '2026-11-06 09:00:00', endTime: '2026-11-06 11:00:00', resvStatus: 7},
    {startTime: '2026-11-06 14:00:00', endTime: '2026-11-06 15:00:00', resvStatus: 0},
  ],
}));
const domRow = (name: string): DomSeatFingerprintInput => ({name, className: 'draggable green', title: '可见提示', left: '2%', top: '4%', visibleTimes: ['09:00', '10:00']});

test('one reservation changes time while all 152 seat and booking-count aggregates stay equal', () => {
  const monitor = new SeatObservationMonitor();
  const before = normalizeReservePayload(rows(), at());
  const changed = rows();
  changed[42].resvInfo[0] = {startTime:'2026-11-06 10:00:00', endTime:'2026-11-06 12:00:00', resvStatus:7};
  const after = normalizeReservePayload(changed, at(1000));
  assert.deepEqual(summarizeSnapshot(before), summarizeSnapshot(after));
  assert.equal(monitor.observe(fingerprintNetwork(before), start).state, 'BASELINE');
  const update = monitor.observe(fingerprintNetwork(after), start+1000);
  assert.equal(update.state, 'CHANGED');
  assert.deepEqual(update.changes, [{
    key:networkSeatKey(roomId,10042,'1D-043'), name:'1D-043', roomId, devId:10042,
    kind:'UPDATED', observedAt:at(1000), changeTypes:['TIME_CHANGED','RECORD_ADDED','RECORD_REMOVED'],
  }]);
  assert.equal(update.eventCount, 1);
  assert.deepEqual(monitor.lastChangeFor(networkSeatKey(roomId,10042,'1D-043')), update.changes[0]);
  assert.equal(monitor.lastChangeFor(networkSeatKey(roomId,10041,'1D-042')), null);
});

test('network and interval order changes and new capture timestamps do not cause change events', () => {
  const monitor = new SeatObservationMonitor();
  monitor.observe(fingerprintNetwork(normalizeReservePayload(rows(),at())), start);
  const reordered = rows().reverse();
  reordered.forEach(row => row.resvInfo.reverse());
  const same = monitor.observe(fingerprintNetwork(normalizeReservePayload(reordered,at(1000))), start+1000);
  assert.equal(same.state, 'UNCHANGED');
  assert.equal(same.lastFreshAt, at(1000));
  assert.deepEqual(same.changes, []);
  assert.equal(same.eventCount, 0);
});

test('same captured response is deduped without claiming a new unchanged observation', () => {
  const monitor = new SeatObservationMonitor();
  const frame = fingerprintNetwork(normalizeReservePayload(rows(),at()));
  monitor.observe(frame,start);
  const duplicate = monitor.observe(frame,start+1);
  assert.equal(duplicate.state,'BASELINE');
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.accepted,false);
  assert.equal(duplicate.observationCount,1);
  assert.equal(duplicate.lastFreshAt,at());
  assert.equal(duplicate.eventCount,0);
});

test('uninterpreted raw status and opening time are individually compared', () => {
  const monitor = new SeatObservationMonitor();
  const before = normalizeReservePayload(rows().slice(0,1),at());
  monitor.observe(fingerprintNetwork(before),start);
  const after = normalizeReservePayload(rows().slice(0,1),at(1000));
  after.seats[0].resvIntervals[0].rawResvStatus = 'NOT_VERIFIED';
  const changedStatus = monitor.observe(fingerprintNetwork(after),start+1000);
  assert.equal(changedStatus.state,'CHANGED');
  assert.deepEqual(changedStatus.changes[0].changeTypes, ['STATUS_CHANGED']);
  assert.doesNotMatch(JSON.stringify(changedStatus), /NOT_VERIFIED|09:00:00|canonical/);
  const changedOpening = normalizeReservePayload(rows().slice(0,1),at(2000));
  changedOpening.seats[0].resvIntervals[0].rawResvStatus = 'NOT_VERIFIED';
  changedOpening.seats[0].openEnd = '21:00';
  const changedBounds = monitor.observe(fingerprintNetwork(changedOpening),start+2000);
  assert.equal(changedBounds.state,'CHANGED');
  assert.deepEqual(changedBounds.changes[0].changeTypes, ['TIME_CHANGED']);
});

test('network identity includes room, device and seat code', () => {
  const monitor = new SeatObservationMonitor();
  const before = rows().slice(0,1);
  monitor.observe(fingerprintNetwork(normalizeReservePayload(before,at())),start);
  const moved = [{...before[0], roomId:roomId+1}];
  const result = monitor.observe(fingerprintNetwork(normalizeReservePayload(moved,at(1000))),start+1000);
  assert.deepEqual(result.changes.map(c=>[c.roomId,c.kind]),[[roomId+1,'ADDED'],[roomId,'REMOVED']]);
  assert.deepEqual(result.changes.map(c=>c.changeTypes),[['SEAT_CHANGED'],['SEAT_CHANGED']]);
});

test('observed interval addition and disappearance stay separate even with duplicate time pairs', () => {
  const monitor = new SeatObservationMonitor();
  const [seat] = rows();
  monitor.observe(fingerprintNetwork(normalizeReservePayload([seat], at())), start);
  const sameTime = {...seat.resvInfo[0], resvStatus: 11};
  seat.resvInfo.push(sameTime);
  const addition = monitor.observe(fingerprintNetwork(normalizeReservePayload([seat], at(1000))), start+1000);
  assert.deepEqual(addition.changes[0].changeTypes, ['RECORD_ADDED']);

  // Keeping the original 11 status while removing a different duplicate is not a status change.
  seat.resvInfo.shift();
  const removal = monitor.observe(fingerprintNetwork(normalizeReservePayload([seat], at(2000))), start+2000);
  assert.deepEqual(removal.changes[0].changeTypes, ['RECORD_REMOVED']);
  assert.doesNotMatch(JSON.stringify(removal), /CANCEL|取消|占用|签到/);
  seat.resvInfo.reverse();
  assert.equal(monitor.observe(fingerprintNetwork(normalizeReservePayload([seat], at(3000))), start+3000).state,'UNCHANGED');
});

test('multiple independent changes coexist without exporting fingerprint or mutable remembered events', () => {
  const monitor = new SeatObservationMonitor();
  const [seat] = rows();
  monitor.observe(fingerprintNetwork(normalizeReservePayload([seat], at())), start);
  seat.coordinate = '3,5';
  seat.openEnd = '21:15';
  seat.openState = 0;
  seat.resvInfo.push({startTime:'2026-11-06 17:00:00', endTime:'2026-11-06 18:00:00', resvStatus: 42});
  const update = monitor.observe(fingerprintNetwork(normalizeReservePayload([seat], at(1000))), start+1000);
  assert.deepEqual(update.changes[0].changeTypes, ['SEAT_CHANGED','TIME_CHANGED','RECORD_ADDED','STATUS_CHANGED']);
  assert.doesNotMatch(JSON.stringify(update), /21:15|17:00:00|canonical|resvStatus/);

  const key = networkSeatKey(roomId, seat.devId, seat.devName);
  (update.changes[0].changeTypes as SeatObservationChangeType[]).length = 0;
  const remembered = monitor.lastChangeFor(key)!;
  assert.equal(remembered.changeTypes.length, 4);
  (remembered.changeTypes as SeatObservationChangeType[]).length = 0;
  assert.equal(monitor.lastChangeFor(key)?.changeTypes.length, 4);
});

test('DOM class order, row order, time order, and equivalent position formatting are canonical', () => {
  const monitor = new SeatObservationMonitor();
  const first = [domRow('1D-001'),domRow('1D-002')];
  monitor.observe(fingerprintDom(first,at()),start);
  const next = [first[1],{...first[0],className:'green draggable green',visibleTimes:['10:00','09:00'],left:'2.00%'}];
  assert.equal(monitor.observe(fingerprintDom(next,at(1000)),start+1000).state,'UNCHANGED');
});

test('DOM title and visible time changes are detected per seat without returning raw title', () => {
  const monitor = new SeatObservationMonitor();
  const first = [domRow('1D-001'),domRow('1D-002')];
  monitor.observe(fingerprintDom(first,at()),start);
  const result = monitor.observe(fingerprintDom([{...first[0],title:'RAW TITLE ONLY IN LOCAL COMPARISON'},first[1]],at(1000)),start+1000);
  assert.equal(result.state,'CHANGED');
  assert.equal(result.changes[0].key,domSeatKey('1D-001'));
  assert.equal(result.changes.length,1);
  assert.deepEqual(result.changes[0].changeTypes,['SEAT_CHANGED']);
  assert.doesNotMatch(JSON.stringify(result),/RAW TITLE|canonical/);
  const another = monitor.observe(fingerprintDom([{...first[0],title:'RAW TITLE ONLY IN LOCAL COMPARISON',visibleTimes:['09:30','10:00']},first[1]],at(2000)),start+2000);
  assert.equal(another.state,'CHANGED');
  assert.deepEqual(another.changes[0].changeTypes,['TIME_CHANGED']);
});

test('DOM title time and class changes report presentation evidence only', () => {
  const monitor = new SeatObservationMonitor();
  const seat = {...domRow('D1-01'), title:'页面提示 09:00–10:00'};
  monitor.observe(fingerprintDom([seat], at()), start);
  const updated = {...seat, title:'页面提示 09:30–10:00', className:'draggable yellow'};
  const result = monitor.observe(fingerprintDom([updated], at(1000)), start+1000);
  assert.deepEqual(result.changes[0].changeTypes, ['SEAT_CHANGED','TIME_CHANGED']);
  assert.doesNotMatch(JSON.stringify(result), /页面提示|yellow|09:30|canonical/);
});

test('unavailable and unknown source retain last sample time but clear its freshness', () => {
  const monitor = new SeatObservationMonitor({maxAgeMs:1000});
  monitor.observe(fingerprintDom([domRow('1D-001')],at()),start);
  const parseError = monitor.invalidate('UNKNOWN','解析失败',start+1);
  assert.equal(parseError.lastFreshAt,at());
  assert.equal(parseError.freshness,'UNKNOWN');
  assert.equal(parseError.state,'UNKNOWN');
  const missing = monitor.invalidate('SOURCE_UNAVAILABLE',undefined,start+1001);
  assert.equal(missing.state,'SOURCE_UNAVAILABLE');
  assert.equal(missing.freshness,'STALE');
});

test('no response does not advance freshness and expired samples become STALE', () => {
  const monitor = new SeatObservationMonitor({maxAgeMs:1000});
  monitor.observe(fingerprintDom([domRow('1D-001')],at()),start);
  const read = monitor.status(start+500);
  assert.equal(read.accepted,false);
  assert.equal(read.lastFreshAt,at());
  const stale = monitor.status(start+1001);
  assert.equal(stale.state,'STALE');
  assert.equal(stale.freshness,'STALE');
});

test('session loss blocks earlier observations and resumes with a new baseline only', () => {
  const monitor = new SeatObservationMonitor();
  monitor.observe(fingerprintDom([domRow('1D-001')],at()),start);
  const lost = monitor.invalidate('SESSION_LOST',undefined,start+1000);
  assert.equal(lost.state,'SESSION_LOST');
  assert.equal(lost.lastFreshAt,at());
  assert.equal(monitor.observe(fingerprintDom([domRow('1D-002')],at(900)),start+1001).state,'SESSION_LOST');
  assert.equal(monitor.invalidate('UNKNOWN',undefined,start+1001).state,'SESSION_LOST');
  const recovered = monitor.observe(fingerprintDom([domRow('1D-002')],at(1002)),start+1002);
  assert.equal(recovered.state,'BASELINE');
  assert.equal(recovered.eventCount,0);
  assert.deepEqual(recovered.changes,[]);
});

test('route reset drops old identity, sample, history and comparison', () => {
  const monitor = new SeatObservationMonitor();
  monitor.observe(fingerprintDom([domRow('1D-001')],at()),start);
  monitor.observe(fingerprintDom([{...domRow('1D-001'),left:'50%'}],at(1000)),start+1000);
  assert.equal(monitor.lastChangeFor(domSeatKey('1D-001'))?.kind,'UPDATED');
  monitor.reset();
  assert.equal(monitor.status(start+1001).state,'SOURCE_UNAVAILABLE');
  assert.equal(monitor.status(start+1001).lastFreshAt,null);
  assert.equal(monitor.lastChangeFor(domSeatKey('1D-001')),null);
  assert.equal(monitor.observe(fingerprintDom([domRow('D1-01')],at(1100)),start+1100).state,'BASELINE');
});

test('future, ambiguous, and incomplete observations fail without overwriting earlier samples', () => {
  const monitor = new SeatObservationMonitor();
  const first = fingerprintDom([domRow('1D-001')],at());
  monitor.observe(first,start);
  assert.equal(monitor.observe(fingerprintDom([domRow('1D-002')],at(1000)),start+999).state,'UNKNOWN');
  assert.equal(monitor.observe(fingerprintDom([domRow('1D-002')],at()),start+1001).state,'UNKNOWN');
  assert.equal(monitor.status(start+1001).lastFreshAt,at());
  assert.throws(()=>fingerprintDom([domRow('1D-001'),domRow('1D-001')],at(1002)),/重复/);
  const malformed = normalizeReservePayload([rows()[0],{}],at(1002));
  assert.throws(()=>fingerprintNetwork(malformed),/无效座位/);
  assert.throws(()=>fingerprintNetwork({...normalizeReservePayload(rows().slice(0,1),at()),invalidIntervals:1}),/无效座位及时段/);
  assert.throws(()=>fingerprintNetwork({...normalizeReservePayload(rows().slice(0,1),at()),apiPath:'/similar/reserve'}),/来源不符/);
});

test('deadline, observation limit, and explicit stop end a passive observation session', () => {
  const frame = fingerprintDom([domRow('1D-001')],at());
  const count = new SeatObservationMonitor({maxObservations:1});
  assert.equal(count.observe(frame,start).state,'BASELINE');
  assert.equal(count.status(start+1).state,'STOPPED');
  const deadline = new SeatObservationMonitor({stopAt:start+1});
  assert.equal(deadline.observe(frame,start+1).state,'STOPPED');
  const explicit = new SeatObservationMonitor();
  explicit.stop();
  assert.equal(explicit.observe(frame,start).state,'STOPPED');
});
