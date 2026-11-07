import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRuntimeEvent, evaluateRuntimeHealth, normalizeRuntimeEvent, normalizeRuntimeSnapshot,
  type RuntimeHealthEvidence, type RuntimeHealthState} from '../src/core/runtime-health';

const healthy: RuntimeHealthEvidence = {
  browser: 'CONNECTED', extension: 'CONNECTED', worker: 'READY', content: 'CONNECTED', page: 'SEATS', session: 'UNKNOWN',
  network: 'FRESH', dom: 'FRESH', parseError: false, indexedDB: 'READY', alarms: 'SCHEDULED', task: 'ENABLED',
  lastResponse: '2026-11-06T12:30:00+08:00', lastDom: '2026-11-06T12:30:00+08:00', lastParsed: '2026-11-06T12:30:00+08:00',
  lastTask: null, lastGood: null, lastError: null,
};

test('running worker does not imply a connected or authenticated seat page', () => {
  assert.equal(evaluateRuntimeHealth({...healthy, page: 'OTHER', content: 'DISCONNECTED'}).state, 'WAITING_FOR_PAGE');
  assert.equal(evaluateRuntimeHealth({...healthy, page: 'SSO'}).state, 'SESSION_LOST');
  const status = evaluateRuntimeHealth(healthy);
  assert.equal(status.state, 'HEALTHY');
  assert.equal(status.session, 'UNKNOWN');
});

test('offline, parse failure, database failures and pending recovery remain distinguishable', () => {
  const cases: [Partial<RuntimeHealthEvidence>, RuntimeHealthState][] = [
    [{network: 'ERROR'}, 'NETWORK_ERROR'], [{dom: 'ERROR'}, 'PARSER_ERROR'], [{parseError: true}, 'PARSER_ERROR'],
    [{network: 'STALE'}, 'DATA_STALE'], [{indexedDB: 'ERROR'}, 'UNKNOWN'], [{worker: 'RECOVERING'}, 'WORKER_RECOVERING'],
    [{task: 'PAUSED'}, 'TASK_PAUSED'], [{alarms: 'MISSING'}, 'UNKNOWN'],
  ];
  for (const [evidence, expected] of cases) assert.equal(evaluateRuntimeHealth({...healthy, ...evidence}).state, expected);
});

test('an old snapshot is retained for diagnostics without establishing current health', () => {
  const lastGood = normalizeRuntimeSnapshot({capturedAt: '2026-11-06T04:30:00Z', route: '#/ic/seatPredetermine/5',
    seatCount: 152, source: 'NETWORK', rawResponse: 'private test marker'});
  const status = evaluateRuntimeHealth({...healthy, session: 'SESSION_LOST', lastGood});
  assert.equal(status.state, 'SESSION_LOST');
  assert.equal(status.lastGood?.capturedAt, '2026-11-06T12:30:00.000+08:00');
  assert.equal(JSON.stringify(status.lastGood).includes('private test marker'), false);
  assert.throws(() => normalizeRuntimeSnapshot({...lastGood, route: '#/ic/seatPredetermine/5?secret=test'}));
});

test('events derive descriptions and severity from typed facts and discard identity extras', () => {
  const base = createRuntimeEvent({eventType: 'RECORD_REMOVED', timestamp: Date.parse('2026-11-06T04:30:00Z'), source: 'NETWORK'});
  const projected = normalizeRuntimeEvent({...base, description: 'test secret', severity: 'ERROR', relatedTask: 'user-record-test',
    relatedSeat: {roomId: 1, devId: 2, seatCode: 'D1-01', name: 'student-test'}, raw: 'header-test'});
  assert.equal(projected.severity, 'INFO');
  assert.match(projected.description, /消失.*待核实/);
  assert.equal(projected.relatedTask, null);
  assert.deepEqual(projected.relatedSeat, {roomId: 1, devId: 2, seatCode: 'D1-01'});
  assert.doesNotMatch(JSON.stringify(projected), /test secret|student-test|header-test/);
  assert.equal(projected.timestamp, '2026-11-06T12:30:00.000+08:00');
});
