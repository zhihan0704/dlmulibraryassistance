/**
 * 预约记录生命周期（Phase 7 任务三）
 *
 * 只描述**可以从数据里看到**的相位，不推断「取消 / 完成 / 违约」——
 * 这三件事都需要写入侧的信息，本扩展永远不碰。
 *
 * 关键区分：
 *  - 「记录消失」≠「预约被取消」。消失也可能只是被服务端清理。
 *  - 「时间已过结束」是**时钟事实**（A 级），与状态位无关。
 *  - 「已签到」是**候选解释**（C 级），不是本模块的断言。
 *
 * 现场证据（2026-11-02 长跑）：
 *  - 19:35–21:50 共 180 次采样，173 条记录，**0 次状态变化、0 次移除**；
 *  - 21:40 结束的记录到 21:49 仍在；
 *  - 而 1D-126 的两条 13:00–15:20 / 15:20–19:20 记录在 19:22 已不在 resvInfo 中。
 *  → 移除**不是"到点即刻"**，规则未查明（D）。
 */

import {decodeResvStatus, type Grade} from './resv-decoding';

export type RecordPhase =
  | 'PENDING_EFFECTIVE' // 待生效
  | 'EFFECTIVE_NOT_CHECKED_IN' // 生效中、未见已签到位
  | 'EFFECTIVE_CHECKED_IN' // 生效中、含已签到位（候选解释）
  | 'ENDED_BY_TIME' // 时钟上已过结束（与状态位无关）
  | 'UNKNOWN';

export interface RecordLike {
  startTime: string; // "YYYY-MM-DD HH:MM:SS"
  endTime: string;
  resvStatus: unknown;
}

export interface PhaseResult {
  phase: RecordPhase;
  grade: Grade;
  reason: string;
  /** 该相位是否依赖「已签到」这一候选解释 */
  dependsOnCheckinBit: boolean;
}

function clockMinutes(stamp: string): number {
  const hhmm = stamp.length > 5 ? stamp.slice(11, 16) : stamp;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 判定一条记录的当前相位。
 *
 * `nowMinute` 为北京时间当日分钟数；`date` 为要判断的日期（YYYY-MM-DD）。
 * 记录不在该日期时返回 UNKNOWN（不跨日推断）。
 */
export function classifyRecordPhase(record: RecordLike, nowMinute: number, date: string): PhaseResult {
  if (!record || typeof record.startTime !== 'string' || typeof record.endTime !== 'string') {
    return {phase: 'UNKNOWN', grade: 'D', reason: '记录结构不完整', dependsOnCheckinBit: false};
  }
  if (record.startTime.slice(0, 10) !== date) {
    return {phase: 'UNKNOWN', grade: 'D', reason: '记录不属于所判日期，不做跨日推断', dependsOnCheckinBit: false};
  }

  const start = clockMinutes(record.startTime);
  const end = clockMinutes(record.endTime);

  // 时钟事实优先：已经过了结束时间，无论状态位如何都是「已结束」
  if (Number.isFinite(start) && Number.isFinite(end) && nowMinute >= end) {
    return {
      phase: 'ENDED_BY_TIME',
      grade: 'A',
      reason: `当前时刻 ${fmt(nowMinute)} 已过结束 ${fmt(end)}（时钟判定，与状态位无关）`,
      dependsOnCheckinBit: false,
    };
  }

  const decoded = decodeResvStatus(record.resvStatus);
  if (!decoded) {
    return {phase: 'UNKNOWN', grade: 'D', reason: `状态取值 ${String(record.resvStatus)} 无法解释`, dependsOnCheckinBit: false};
  }

  const has = (bit: number) => (decoded.raw & bit) !== 0;
  const effective = has(4);
  const checkedIn = has(64);

  if (effective && checkedIn) {
    return {
      phase: 'EFFECTIVE_CHECKED_IN',
      grade: 'C',
      reason: '含「生效中」与「已签到」两位；已签到位的语义仅由站点字典支撑，因果未观测',
      dependsOnCheckinBit: true,
    };
  }
  if (effective) {
    return {
      phase: 'EFFECTIVE_NOT_CHECKED_IN',
      grade: 'B',
      reason: '含「生效中」位、不含「已签到」位',
      dependsOnCheckinBit: false,
    };
  }
  if (has(2)) {
    return {
      phase: 'PENDING_EFFECTIVE',
      grade: 'B',
      reason: '含「待生效」位、不含「生效中」位',
      dependsOnCheckinBit: false,
    };
  }
  return {phase: 'UNKNOWN', grade: 'D', reason: '位组合不含待生效/生效中，无法归入已知相位', dependsOnCheckinBit: false};
}

function fmt(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface RecordKeyed {
  key: string; // 座位|开始时间
  seat: string;
  start: string;
  end: string;
  status: unknown;
}

export interface SnapshotDiff {
  added: RecordKeyed[];
  removed: RecordKeyed[];
  changed: Array<{key: string; from: unknown; to: unknown; seat: string; start: string}>;
  /** 记录消失的含义：恒为 UNKNOWN —— 不可据此断定取消/完成/违约 */
  disappearanceMeaning: 'UNKNOWN';
}

/** 比较两次快照，得到增删改。纯函数，不做任何业务推断。 */
export function diffSnapshots(previous: RecordKeyed[], current: RecordKeyed[]): SnapshotDiff {
  const prevMap = new Map(previous.map((r) => [r.key, r]));
  const curMap = new Map(current.map((r) => [r.key, r]));
  const added: RecordKeyed[] = [];
  const removed: RecordKeyed[] = [];
  const changed: SnapshotDiff['changed'] = [];

  for (const [k, cur] of curMap) {
    const before = prevMap.get(k);
    if (!before) added.push(cur);
    else if (before.status !== cur.status) changed.push({key: k, from: before.status, to: cur.status, seat: cur.seat, start: cur.start});
  }
  for (const [k, before] of prevMap) {
    if (!curMap.has(k)) removed.push(before);
  }
  return {added, removed, changed, disappearanceMeaning: 'UNKNOWN'};
}

export interface RoomSummary {
  total: number;
  byPhase: Record<RecordPhase, number>;
  byRawStatus: Record<string, number>;
  unknownStatusValues: number[];
  /** 该汇总是否包含依赖候选解释（已签到位）的相位 */
  includesCandidateInterpretation: boolean;
}

/** 汇总一个房间快照里所有记录的相位分布（纯统计，不做可用性判断） */
export function summarizeRoom(records: RecordLike[], nowMinute: number, date: string): RoomSummary {
  const byPhase: Record<RecordPhase, number> = {
    PENDING_EFFECTIVE: 0,
    EFFECTIVE_NOT_CHECKED_IN: 0,
    EFFECTIVE_CHECKED_IN: 0,
    ENDED_BY_TIME: 0,
    UNKNOWN: 0,
  };
  const byRawStatus: Record<string, number> = {};
  const unknown = new Set<number>();

  for (const r of records) {
    const phase = classifyRecordPhase(r, nowMinute, date);
    byPhase[phase.phase] += 1;
    if (typeof r.resvStatus === 'number') {
      byRawStatus[String(r.resvStatus)] = (byRawStatus[String(r.resvStatus)] || 0) + 1;
      if (!decodeResvStatus(r.resvStatus)) unknown.add(r.resvStatus);
    }
  }

  return {
    total: records.length,
    byPhase,
    byRawStatus,
    unknownStatusValues: [...unknown],
    includesCandidateInterpretation: byPhase.EFFECTIVE_CHECKED_IN > 0,
  };
}

/**
 * 记录消失能说明什么。
 * 目前唯一确定的答案：**什么也不能说明**（见文件头注释的现场证据）。
 */
export function whatDoesDisappearanceMean(): {grade: Grade; answer: string} {
  return {
    grade: 'D',
    answer:
      '不能说明任何业务含义。实测中移除时机不一致（21:40 结束的记录 21:49 仍在；另一座位的记录结束 2 分钟后即消失），' +
      '无法区分「服务端清理」「取消」「违约释放」等原因，故保持 UNKNOWN。',
  };
}
