import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  normalizeBackupPayload, normalizeHealthSnapshot, normalizePlanInput, normalizePreferences, normalizeStoredEvent,
} from '../src/storage/assistant-schema';

const primarySeat = {roomId: 12, devId: 34, seatCode: 'D1-01'};
const preferred = {startAt: '2026-11-07T09:30:00Z', endAt: '2026-11-07T13:15:00Z'};
const preferences = {
  date: '2026-11-07', primarySeat, backupSeats: [], preferred, allowedWindow: preferred,
  minDurationMinutes: 120, preferLonger: true, allowTimeAdjustment: false, allowBackupSeats: false, allowShorter: false,
};

test('偏好和多日期计划只保存允许字段并采用北京时间', () => {
  const clean = normalizePreferences({...preferences, Cookie: 'fixture-cookie', primarySeat: {...primarySeat, token: 'fixture-token'}});
  assert.deepEqual(clean.primarySeat, primarySeat);
  assert.equal(clean.preferred.startAt, '2026-11-07T17:30:00.000+08:00');
  assert.doesNotMatch(JSON.stringify(clean), /fixture-cookie|fixture-token/);
  const plan = normalizePlanInput({preferences, verification: 'VERIFIED', observedAt: 'fake-proof', floorName: '一楼', roomName: '预约自习室'});
  assert.equal(plan.id, 'plan:2026-11-07');
  assert.equal(plan.priority, 2);
  assert.equal(plan.reminderAt, null);
  assert.equal(Object.hasOwn(plan, 'verification'), false);
  assert.equal(Object.hasOwn(plan, 'observedAt'), false);
  assert.throws(() => normalizePlanInput({id: 'plan:2026-11-08', preferences}));
  assert.throws(() => normalizePlanInput({preferences, roomName: 'Cookie bearer fixture-token'}));
  assert.throws(() => normalizePlanInput({preferences, reminderAt: preferred.endAt}));
});

test('配置备份拒绝重复日期和未定义字段', () => {
  const plan = normalizePlanInput({preferences});
  assert.throws(() => normalizeBackupPayload({preferences, plans: [plan, plan], notificationsEnabled: false}));
  assert.throws(() => normalizeBackupPayload({preferences, plans: [], notificationsEnabled: false, token: 'fixture-secret'}));
  const clean = normalizeBackupPayload({preferences: null, plans: [plan], notificationsEnabled: false});
  assert.equal(clean.plans.length, 1);
  assert.equal(clean.preferences, null);
});

test('诊断日志重建固定说明，丢弃凭据式座位编号和任意任务标识', () => {
  const event = normalizeStoredEvent({
    eventId: '00000000-0000-4000-8000-000000000001', eventType: 'NETWORK_ERROR', source: 'NETWORK',
    timestamp: '2026-11-06T09:00:00Z', severity: 'INFO', description: 'Bearer fixture-secret',
    relatedSeat: {...primarySeat, seatCode: 'token123', rawHeaders: 'Cookie fixture-header'},
    relatedTask: 'plan:2026-99-99', rawUrl: 'https://fixture.invalid?token=secret',
  });
  assert.equal(event.timestamp, '2026-11-06T17:00:00.000+08:00');
  assert.equal(event.severity, 'WARN');
  assert.equal(event.relatedSeat, null);
  assert.equal(event.relatedTask, null);
  assert.doesNotMatch(JSON.stringify(event), /Bearer|fixture|rawHeaders|rawUrl|token/);
});

test('最后有效观察只持久化真实通道的摘要，拒绝未来时间和带敏感参数的路由', () => {
  const capturedAt = '2026-11-06T09:00:00Z';
  const now = Date.parse(capturedAt);
  const sample = {capturedAt, route: '#/ic/seatPredetermine/12', seatCount: 152, source: 'NETWORK'};
  const clean = normalizeHealthSnapshot({...sample, token: 'fixture-secret', seats: [{id: 'fixture-row'}]}, now);
  assert.deepEqual(clean, {...sample, capturedAt: '2026-11-06T17:00:00.000+08:00'});
  assert.throws(() => normalizeHealthSnapshot(sample, now - 1));
  assert.throws(() => normalizeHealthSnapshot({...sample, route: '#/ic/seatPredetermine/12?token=fixture'}, now));
  assert.throws(() => normalizeHealthSnapshot({...sample, source: 'MOCK'}, now));
});
