/**
 * resvStatus 观测登记表（Phase 5–6）
 *
 * 只登记**实际观测到的**取值，以及它们与时间的相关性；
 * 不宣称任何位的确切业务含义。
 *
 * 三条纪律：
 *  1. 1029 必须独立对待，不得并入 1027 或 1093（样本极少，结论等级 D）。
 *  2. “与进行中相关”只描述相关性，不因此推断“已签到”。
 *  3. 未观测到的取值一律返回 null，由调用方按 UNKNOWN 处理。
 */

export type LifecycleHint = 'NOT_STARTED_LIKE' | 'IN_PROGRESS_LIKE' | 'UNKNOWN';
export type Grade = 'A' | 'B' | 'C' | 'D';

export interface ResvStatusObservation {
  value: number;
  /** 二进制置位（从 2^0 起） */
  bits: number[];
  /** 观测到的记录条数 */
  observedRecords: number;
  /** 其中处于“进行中”的比例；无法计算时为 null */
  inProgressShare: number | null;
  /** 相关性命中，不代表业务含义 */
  hint: LifecycleHint;
  grade: Grade;
  note: string;
}

/**
 * 数据来源：Phase 5 的 6 份现场样本（时序合并统计）+ Phase 6 生命周期观察。
 * 比例为「进行中记录数 / 该取值总记录数」。
 */
export const RESV_STATUS_OBSERVED: readonly ResvStatusObservation[] = [
  {
    value: 1027,
    bits: [1, 2, 1024],
    observedRecords: 1693,
    inProgressShare: 148 / 1693,
    hint: 'NOT_STARTED_LIKE',
    grade: 'B',
    note: '绝大多数为「未开始」，也有少量「进行中」（疑似未签到但时段已到）与「已结束」',
  },
  {
    value: 1029,
    bits: [1, 4, 1024],
    observedRecords: 8,
    inProgressShare: 4 / 8,
    hint: 'UNKNOWN',
    grade: 'D',
    note: '仅 2 个座位出现过，样本不足以判断；与 1027/1093 的关系不明，必须独立对待',
  },
  {
    value: 1093,
    bits: [1, 4, 64, 1024],
    observedRecords: 476,
    inProgressShare: 472 / 476,
    hint: 'IN_PROGRESS_LIKE',
    grade: 'B',
    note: '与「进行中」强相关，且只在当天出现、次日完全没有；但究竟是「已签到」还是「使用中」未确认',
  },
] as const;

/** 未登记的取值返回 null —— 调用方必须按 UNKNOWN 处理，不得猜 */
export function describeResvStatus(value: unknown): ResvStatusObservation | null {
  if (typeof value !== 'number') return null;
  return RESV_STATUS_OBSERVED.find((o) => o.value === value) ?? null;
}

/**
 * 是否属于「已观测但含义不明」的取值（目前只有 1029）。
 * 用途：确保 UI / 判决不会把它当成 1027 或 1093 处理。
 */
export function isObservedButUnclear(value: unknown): boolean {
  const o = describeResvStatus(value);
  return Boolean(o && o.hint === 'UNKNOWN');
}

/**
 * 该取值能否用于推断生命周期。
 * 只有 1027 / 1093 具备 B 级相关性；1029 与未登记值一律 false。
 */
export function canInferLifecycle(value: unknown): boolean {
  const o = describeResvStatus(value);
  return Boolean(o && o.grade !== 'D' && o.hint !== 'UNKNOWN');
}

/** 把「进行中占比」换算成一句人话，避免调用方自己编解释 */
export function describeShare(value: unknown): string {
  const o = describeResvStatus(value);
  if (!o) return '未登记的取值';
  if (o.inProgressShare === null) return '无可用比例';
  return `进行中占比 ${(o.inProgressShare * 100).toFixed(1)}%（${o.observedRecords} 条记录）`;
}
