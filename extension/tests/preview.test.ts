import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPreview, API_WINDOW_MINUTES, type PreviewInput} from '../src/core/preview';

const ok = (over: Partial<PreviewInput> = {}): PreviewInput => ({
  seatName: '1D-001',
  date: '2026-11-02',
  start: '09:00',
  end: '10:00',
  source: 'CURRENT_PAGE',
  ...over,
});

test('预演给出完整清单：8 项检查，且每项都带状态与说明', () => {
  const r = createPreview(ok());
  assert.equal(r.checks.length, 8);
  const ids = r.checks.map((c) => c.id);
  for (const id of ['seat', 'date', 'time', 'duration', 'login', 'seatStatus', 'eligibility', 'source']) {
    assert.ok(ids.includes(id), `缺少检查项 ${id}`);
  }
  assert.ok(r.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0));
});

test('合法输入：通过项为 PASS，时长与计划时刻正确', () => {
  const r = createPreview(ok());
  assert.equal(r.validation, 'VALID');
  assert.equal(r.durationMinutes, 60);
  assert.equal(r.plannedStartAt, '2026-11-02T09:00:00+08:00');
  assert.equal(r.checks.find((c) => c.id === 'seat')?.state, 'PASS');
  assert.equal(r.checks.find((c) => c.id === 'date')?.state, 'PASS');
  assert.equal(r.checks.find((c) => c.id === 'time')?.state, 'PASS');
});

test('恒不变量：无论如何都不可提交、规则恒 NEEDS_REVIEW', () => {
  const cases: PreviewInput[] = [
    ok(),
    ok({seatName: 'X-999'}),
    ok({date: '2026-02-31'}),
    ok({start: '10:00', end: '09:00'}),
    ok({start: '09:00', end: '09:05'}),
    ok({source: 'HISTORICAL'}),
    ok({source: 'UNKNOWN'}),
  ];
  for (const input of cases) {
    const r = createPreview(input);
    assert.equal(r.executeAllowed, false, '任何情况下都不得允许执行');
    assert.equal(r.rule, 'NEEDS_REVIEW');
    assert.equal(r.eligibility, 'UNKNOWN');
    assert.equal(r.seatStatus, 'UNKNOWN');
    assert.ok(r.blockedReasons.length > 0, '必须说明为什么不能提交');
    // 永不出现「可预约 / 空闲」这类结论字样
    const text = JSON.stringify(r);
    assert.equal(text.includes('AVAILABLE'), false);
    assert.equal(text.includes('可预约'), false);
  }
});

test('非法座位编号：判 FAIL 且整体 INVALID', () => {
  const r = createPreview(ok({seatName: 'DEMO-01'}));
  assert.equal(r.validation, 'INVALID');
  assert.equal(r.checks.find((c) => c.id === 'seat')?.state, 'FAIL');
});

test('非法日期与倒序时段：时段无效时不计算时长', () => {
  const badDate = createPreview(ok({date: '2026-02-31'}));
  assert.equal(badDate.checks.find((c) => c.id === 'date')?.state, 'FAIL');
  assert.equal(badDate.validation, 'INVALID');

  const reversed = createPreview(ok({start: '10:00', end: '09:00'}));
  assert.equal(reversed.checks.find((c) => c.id === 'time')?.state, 'FAIL');
  assert.equal(reversed.durationMinutes, null);
  assert.equal(reversed.plannedStartAt, null);
});

test('时长超出接口窗口：仍不判 FAIL，只标记规则冲突并列入阻塞原因', () => {
  const r = createPreview(ok({start: '08:00', end: '13:00'})); // 300 分钟
  assert.equal(r.durationMinutes, 300);
  const duration = r.checks.find((c) => c.id === 'duration');
  assert.equal(duration?.state, 'NEEDS_REVIEW');
  assert.match(duration!.detail, /超出范围/);
  assert.ok(r.blockedReasons.some((b) => b.includes('超出范围')));
  // 规则冲突本身不应把 validation 判成 INVALID（冲突不是「输入错」）
  assert.equal(r.validation, 'VALID');
});

test('规则冲突被显式写进说明，且暴露接口窗口常量', () => {
  const r = createPreview(ok());
  const duration = r.checks.find((c) => c.id === 'duration');
  assert.match(duration!.detail, /1–4 小时/);
  assert.match(duration!.detail, /冲突未解/);
  assert.deepEqual(r.apiWindowMinutes, {min: API_WINDOW_MINUTES.min, max: API_WINDOW_MINUTES.max});
});

test('历史快照来源被标为 NEEDS_REVIEW 并阻止执行', () => {
  const r = createPreview(ok({source: 'HISTORICAL'}));
  assert.equal(r.checks.find((c) => c.id === 'source')?.state, 'NEEDS_REVIEW');
  assert.match(r.checks.find((c) => c.id === 'source')!.detail, /历史快照/);
  assert.ok(r.blockedReasons.some((b) => b.includes('实时数据')));
});
