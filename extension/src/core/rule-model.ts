/**
 * 预约规则模型（Phase 5）
 *
 * 把核验过的规则做成**可测试的数据结构**，而不是散落在文档里。
 * 每条规则都带：官方说法、实测观察、判定状态、证据等级。
 *
 * 关键约定：**存在来源冲突的规则，其「生效值」一律为 null**。
 * 调用方拿到 null 就必须降级为 NEEDS_REVIEW，不允许自行挑一边。
 */

export type RuleGrade = 'A' | 'B' | 'C' | 'D';
export type RuleStatus = 'CONFIRMED' | 'CONFLICT' | 'UNKNOWN';

export interface RuleRecord {
  id: string;
  name: string;
  /** 官方帮助页原文（无则 null） */
  official: string | null;
  /** 实测观察到的值 */
  observed: string | null;
  status: RuleStatus;
  grade: RuleGrade;
  /** 若冲突，说明冲突双方 */
  conflict?: {officialSide: string; observedSide: string};
  note?: string;
}

export const RULES: readonly RuleRecord[] = [
  {
    id: 'open-hours',
    name: '开放时段（工作日 07:30 起 / 周末 08:30 起，闭馆 21:40）',
    official: '未写具体开门时间',
    observed: '2026-11-01 周日 08:30–21:40；2026-11-02 周一 07:30–21:40；2026-11-03 周二 07:30 起',
    status: 'CONFIRMED',
    grade: 'A',
    note: '三个日期实测，且与 /ic-web/seatRoom/openScope 的工作日/周末规则吻合',
  },
  {
    id: 'close-time',
    name: '闭馆时间',
    official: '周一到周日 21:50',
    observed: '21:40（8 次采集一致）',
    status: 'CONFLICT',
    grade: 'B',
    conflict: {officialSide: '21:50', observedSide: '21:40'},
    note: '可能「图书馆闭馆」与「阅览室开放结束」不是同一概念，但无证据证明，故不选边',
  },
  {
    id: 'min-duration',
    name: '最短预约时长',
    official: '预约可选时长为 1–4 小时',
    observed: '网页按 30 分钟判断能否预约（阈值扫描唯一解）',
    status: 'CONFLICT',
    grade: 'B',
    conflict: {officialSide: '60 分钟', observedSide: '30 分钟'},
    note: 'resvRule.minResvTime=30；6 样本 × 14 阈值扫描中只有 30 能复现网页分类',
  },
  {
    id: 'max-duration',
    name: '最长预约时长',
    official: '4 小时',
    observed: '240 分钟，4 小时窗口被页面接受',
    status: 'CONFIRMED',
    grade: 'A',
  },
  {
    id: 'advance-days',
    name: '提前预约天数',
    official: '可提前一天',
    observed: 'earliestResvTime=1440 分钟；11-02 可选中 11-03',
    status: 'CONFIRMED',
    grade: 'A',
  },
  {
    id: 'booking-range',
    name: '可预约日期范围',
    official: '提前一天',
    observed: null,
    status: 'UNKNOWN',
    grade: 'D',
    note: '未做越界试探（会触碰规则边界）',
  },
  {
    id: 'daily-count',
    name: '每日可预约次数',
    official: null,
    observed: null,
    status: 'UNKNOWN',
    grade: 'D',
    note: '无对应接口字段',
  },
  {
    id: 'duplicate-limit',
    name: '重复预约限制',
    official: null,
    observed: null,
    status: 'UNKNOWN',
    grade: 'D',
    note: 'allowConflict / seriesTimeLimit 无可靠语义',
  },
  {
    id: 'on-already-reserved',
    name: '已预约情况下的处理规则',
    official: null,
    observed: null,
    status: 'UNKNOWN',
    grade: 'D',
  },
  {
    id: 'cancel-rule',
    name: '预约取消截止',
    official: '生效前可取消，生效时间为开始前 10 分钟',
    observed: 'cancelTime=15（分钟）',
    status: 'CONFLICT',
    grade: 'C',
    conflict: {officialSide: '10 分钟', observedSide: '15 分钟'},
    note: '未观察实际取消行为；显示值还会被未采集的 sysConfig 修正',
  },
  {
    id: 'leave-rule',
    name: '暂离保留时长',
    official: '普通 30 分钟；11:00–13:00 与 16:30–18:30 保留 90 分钟',
    observed: null,
    status: 'UNKNOWN',
    grade: 'D',
  },
  {
    id: 'checkin-grace',
    name: '签到宽限',
    official: '提前 10 分钟或延迟 15 分钟',
    observed: 'earlyInTime=10、laterLineTime=600（前端零引用）',
    status: 'UNKNOWN',
    grade: 'D',
    note: '数值对不上，且代码里没有使用点',
  },
  {
    id: 'violation',
    name: '违规与封禁',
    official: '违规满 5 次限制使用 3 天',
    observed: null,
    status: 'UNKNOWN',
    grade: 'D',
  },
] as const;

export function ruleById(id: string): RuleRecord | undefined {
  return RULES.find((r) => r.id === id);
}

export function rulesByStatus(status: RuleStatus): RuleRecord[] {
  return RULES.filter((r) => r.status === status);
}

/**
 * 最短预约时长的「生效政策值」。
 * 由于官方与实测冲突，这里**恒返回 null** —— 调用方必须据此降级为 NEEDS_REVIEW。
 *
 * 注意区分：这只是「政策是否已确定」。系统**实际执行的**时长区间见
 * `OBSERVED_DURATION_BOUNDS`（那是实测行为，不是官方政策）。
 */
export function effectiveMinDuration(): number | null {
  return null;
}

/**
 * 系统**实际执行**的单次预约时长区间（实测）。
 *
 * 证据：在页面上选择一个开始时间后，只展开「结束时间」下拉读取可选项，
 * 不点击确认、不提交任何预约。
 *  - 开始 15:30 → 结束最早 16:00（+30），最晚 19:30（**+240**）
 *  - 开始 17:50 → 结束最早 18:20（+30），最晚 21:40（+230，受闭馆时间截断）
 *
 * 结论（B，多证据）：页面强制执行 **30–240 分钟**。
 * 这与帮助页「1–4 小时」在上限一致、在下限冲突（30 vs 60）。
 */
export const OBSERVED_DURATION_BOUNDS = {
  minMinutes: 30,
  maxMinutes: 240,
  grade: 'B' as const,
  evidence: 'duration-probe-start1530.json / duration-probe-start17501.json',
} as const;

/** 官方帮助页声明的时长口径（原文口径，用于对照，不作为执行依据） */
export const OFFICIAL_DURATION_TEXT = {minHours: 1, maxHours: 4, grade: 'A' as const} as const;

/**
 * 时长下限是否存在「政策 vs 实测」冲突。
 * 恒为 true（30 vs 60 未消解）—— 调用方据此保持 NEEDS_REVIEW。
 */
export function hasMinDurationConflict(): boolean {
  return OBSERVED_DURATION_BOUNDS.minMinutes !== OFFICIAL_DURATION_TEXT.minHours * 60;
}

/**
 * 闭馆时间的「生效值」。
 * 同样因冲突恒返回 null（实测 21:40 与官方 21:50 不一致）。
 */
export function effectiveCloseTime(): string | null {
  return null;
}
