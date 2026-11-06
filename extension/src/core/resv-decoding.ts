/**
 * resvStatus 位标志解码（Phase 7）
 *
 * 设计原则（对应任务二）：
 *  1. **永远保存原始整数**，任何解释都不得覆盖 raw。
 *  2. 区分「已确认位」与「候选位」；候选位的因果不得写成已证明。
 *  3. 未知位**只列出、不解释**（例如位 1 在站点字典里没有，就不给它起名字）。
 *  4. **不根据二进制组合推断完整业务状态**：本模块只回答「哪些位被置上」，
 *     不回答「这个座位能不能约」。
 *  5. 遇到不认识的取值一律安全降级为 UNKNOWN，不猜。
 *
 * 证据来源：
 *  - 站点自带 JS 的状态字典（`chunk-common_*.js`），记为 C（代码取证）；
 *  - 本项目的现场观察（1027→1029 的迁移、173 条记录的分布），记为 A/B。
 */

export type Grade = 'A' | 'B' | 'C' | 'D';
export type BitSource = 'site-dictionary' | 'site-dictionary+observation';

export interface BitMeaning {
  bit: number;
  label: string;
  grade: Grade;
  source: BitSource;
  note: string;
}

/**
 * 站点字典里出现的位。
 * 注意：`64 = 已签到` 只是**候选**——字典这么写、且与观察强相关，
 * 但「签到动作导致置位」从未被直接观测到，故 grade 为 C。
 */
export const BIT_MEANINGS: readonly BitMeaning[] = [
  {bit: 2, label: '待生效', grade: 'B', source: 'site-dictionary+observation', note: '1027 含此位；14:02 实测该记录尚未生效'},
  {bit: 4, label: '生效中', grade: 'B', source: 'site-dictionary+observation', note: '1029 含此位；19:21 观察到 1027→1029 的迁移'},
  {bit: 64, label: '已签到', grade: 'C', source: 'site-dictionary', note: '字典写作已签到；因果未观测，仅有强相关'},
  {bit: 128, label: '已结束', grade: 'C', source: 'site-dictionary', note: '字典存在，但实测 resvInfo 中从未出现（结束时记录倾向被移除）'},
  {bit: 16, label: '违约', grade: 'C', source: 'site-dictionary', note: '未观测到'},
  {bit: 256, label: '待审核', grade: 'C', source: 'site-dictionary', note: '未观测到'},
  {bit: 512, label: '审核未通过', grade: 'C', source: 'site-dictionary', note: '未观测到'},
  {bit: 1024, label: '审核通过', grade: 'C', source: 'site-dictionary', note: '全部已观测取值都含此位'},
  {bit: 2048, label: '暂离中', grade: 'C', source: 'site-dictionary', note: '未观测到'},
] as const;

/** 现场直接观测到的取值计数（Phase 7 长跑，19:35–21:50，173 条记录） */
export const OBSERVED_VALUE_COUNTS: Readonly<Record<number, number>> = {
  1027: 23,
  1029: 4,
  1093: 146,
};

export interface DecodedResvStatus {
  /** 原始整数，一字不改 */
  raw: number;
  /** 所有置位的位（按升序），包含未知位 */
  setBits: number[];
  /** 有位字典解释的位 */
  known: BitMeaning[];
  /** 没有字典解释的位 —— 只列出数字，不给名字 */
  unknownBits: number[];
  /** 已知位对应的标签 */
  labels: string[];
  /** 已知位中最低的证据等级（最弱一环） */
  weakestGrade: Grade;
  /** 是否所有置位都被解释（false 表示存在未知位） */
  fullyExplained: boolean;
  /**
   * 恒为 false：本模块**不**推断完整业务状态。
   * 调用方不得把它当作「可预约 / 已占用」的依据。
   */
  businessStateInferred: false;
}

function bitsOf(value: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < 32; b++) {
    const p = 1 << b;
    if ((value & p) === p) out.push(p);
  }
  return out;
}

/** 未登记的取值返回 null（调用方必须按 UNKNOWN 处理） */
export function decodeResvStatus(value: unknown): DecodedResvStatus | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const setBits = bitsOf(value);
  if (setBits.length === 0) return null;

  const known: BitMeaning[] = [];
  const unknownBits: number[] = [];
  for (const b of setBits) {
    const m = BIT_MEANINGS.find((x) => x.bit === b);
    if (m) known.push(m);
    else unknownBits.push(b);
  }
  if (known.length === 0) {
    // 一个已知位都没有 → 完全无法解释，安全降级
    return null;
  }

  const rank: Record<Grade, number> = {A: 4, B: 3, C: 2, D: 1};
  const weakestGrade = known.reduce<Grade>((acc, m) => (rank[m.grade] < rank[acc] ? m.grade : acc), 'A');

  return {
    raw: value,
    setBits,
    known,
    unknownBits,
    labels: known.map((m) => m.label),
    weakestGrade,
    fullyExplained: unknownBits.length === 0,
    businessStateInferred: false,
  };
}

/**
 * 安全降级：把一个取值归入「能否据此做判断」的粗粒度结论。
 * 只有同时满足「全部位已解释」「不含候选位」时才给出 `USABLE`，
 * 否则一律 `CAUTION` 或 `UNKNOWN`。
 */
export function decodeSafety(value: unknown): {
  level: 'USABLE' | 'CAUTION' | 'UNKNOWN';
  reason: string;
} {
  const d = decodeResvStatus(value);
  if (!d) return {level: 'UNKNOWN', reason: '未登记的取值，无法解释'};
  if (!d.fullyExplained) {
    return {level: 'CAUTION', reason: `存在未解释的位 ${d.unknownBits.join(',')}，不得据此推断业务状态`};
  }
  if (d.known.some((m) => m.grade === 'C')) {
    return {level: 'CAUTION', reason: '含有仅由站点字典推断、未经观察证实的位'};
  }
  return {level: 'USABLE', reason: '全部位均已有观察支撑（仍不代表完整业务状态）'};
}

/** 供报告使用的一句话描述；明确标注等级，不隐藏不确定性 */
export function describeDecoded(value: unknown): string {
  const d = decodeResvStatus(value);
  if (!d) return `${String(value)}：未登记取值，UNKNOWN`;
  const parts = [`${d.raw} = ${d.setBits.join(' + ')}`];
  parts.push(`已知位：${d.known.map((m) => `${m.bit}=${m.label}(${m.grade})`).join(', ')}`);
  if (d.unknownBits.length) parts.push(`未知位：${d.unknownBits.join(', ')}（不解释）`);
  return parts.join('；');
}
