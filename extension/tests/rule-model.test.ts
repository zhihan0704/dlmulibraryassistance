/**
 * 规则模型测试：确认冲突规则不会被悄悄定死成某一方。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES,
  effectiveCloseTime,
  effectiveMinDuration,
  ruleById,
  rulesByStatus,
} from '../src/core/rule-model';

test('每条规则都有 id、名称、状态与证据等级', () => {
  assert.ok(RULES.length >= 13, `规则数应 >= 13，实际 ${RULES.length}`);
  const ids = new Set<string>();
  for (const r of RULES) {
    assert.ok(r.id && !ids.has(r.id), `id 缺失或重复: ${r.id}`);
    ids.add(r.id);
    assert.ok(r.name.length > 0);
    assert.ok(['CONFIRMED', 'CONFLICT', 'UNKNOWN'].includes(r.status));
    assert.ok(['A', 'B', 'C', 'D'].includes(r.grade));
  }
});

test('CONFIRMED 的规则必须同时有官方说法与实测观察', () => {
  for (const r of rulesByStatus('CONFIRMED')) {
    assert.ok(r.observed, `${r.id} 标为 CONFIRMED 但没有实测观察`);
    assert.ok(r.grade === 'A' || r.grade === 'B', `${r.id} 标为 CONFIRMED 但等级只有 ${r.grade}`);
  }
});

test('CONFLICT 的规则必须写出冲突双方，且等级不得为 A', () => {
  const conflicts = rulesByStatus('CONFLICT');
  assert.ok(conflicts.length >= 2, '至少应有最短时长与闭馆时间两条冲突');
  for (const r of conflicts) {
    assert.ok(r.conflict, `${r.id} 标为 CONFLICT 但没有冲突说明`);
    assert.ok(r.conflict.officialSide && r.conflict.observedSide);
    assert.notEqual(r.grade, 'A', `${r.id} 有冲突却给了 A 级`);
  }
});

test('最短时长与闭馆时间确实在冲突名单里', () => {
  const ids = rulesByStatus('CONFLICT').map((r) => r.id);
  assert.ok(ids.includes('min-duration'), '最短时长应处于冲突状态');
  assert.ok(ids.includes('close-time'), '闭馆时间应处于冲突状态');
});

test('冲突规则的「生效值」恒为 null（不允许调用方自行选边）', () => {
  assert.equal(ruleById('min-duration')?.status, 'CONFLICT');
  assert.equal(effectiveMinDuration(), null, '最短时长冲突未解，不得返回具体值');
  assert.equal(ruleById('close-time')?.status, 'CONFLICT');
  assert.equal(effectiveCloseTime(), null, '闭馆时间冲突未解，不得返回具体值');
});

test('UNKNOWN 规则不得被当成已确认：没有 observed 的规则不能用于判断', () => {
  for (const r of rulesByStatus('UNKNOWN')) {
    assert.equal(r.grade, 'D', `${r.id} 标为 UNKNOWN 但等级不是 D`);
  }
});

test('开放时段是 A 级已确认，且记录了三个日期的实测', () => {
  const r = ruleById('open-hours');
  assert.ok(r);
  assert.equal(r.status, 'CONFIRMED');
  assert.equal(r.grade, 'A');
  assert.match(r.observed ?? '', /07:30/);
  assert.match(r.observed ?? '', /08:30/);
});
