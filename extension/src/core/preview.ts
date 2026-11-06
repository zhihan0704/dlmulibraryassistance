/**
 * 只读预约预演（第四阶段）
 *
 * 预演只做**本地清单检查**：把「要提交一笔预约还需要哪些条件」逐项摊开，
 * 标明每一项是已满足、已知不满足、还是根本没确认。
 *
 * 硬约束（沿用既有红线的编程表达）：
 *  - rule 恒为 NEEDS_REVIEW（规则冲突未解，见 docs/rules-verification.md）
 *  - eligibility / seatStatus 恒为 UNKNOWN
 *  - executeAllowed 恒为 false —— 本函数不存在任何「可以提交」的返回分支
 */

export interface PreviewInput {
  seatName: string;
  date: string;
  start: string;
  end: string;
  source: 'HISTORICAL' | 'CURRENT_PAGE' | 'UNKNOWN';
}

export type CheckState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NEEDS_REVIEW';

export interface PreviewCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface PreviewResult {
  input: PreviewInput;
  validation: 'VALID' | 'INVALID';
  /** 恒为 NEEDS_REVIEW */
  rule: 'NEEDS_REVIEW';
  /** 恒为 UNKNOWN */
  eligibility: 'UNKNOWN';
  /** 恒为 UNKNOWN（来源见 input.source） */
  seatStatus: 'UNKNOWN';
  /** 恒为 false */
  executeAllowed: false;
  durationMinutes: number | null;
  /** 接口 resvRule 的实测窗口（证据值，不是校方规则） */
  apiWindowMinutes: {min: number; max: number};
  /** 按北京时间推算的计划开始时刻；无法推算时为 null */
  plannedStartAt: string | null;
  checks: PreviewCheck[];
  /** 为什么现在不能提交 */
  blockedReasons: string[];
  logs: string[];
}

const SEAT_NAME = /^1D-(00[1-9]|0[1-9]\d|1[0-4]\d|15[0-2])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 来自 seats-safe.json 的 resvRule 实测值（minResvTime=30, maxResvTime=240）。
 * 仅作「接口侧的已知数值」用于陈述，**不**据此判定可预约：
 * 官方帮助页写的是「1–4 小时」，两者冲突未解。
 */
export const API_WINDOW_MINUTES = {min: 30, max: 240} as const;

function toMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (!Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString().slice(0, 10) === value;
}

export function createPreview(x: PreviewInput): PreviewResult {
  const checks: PreviewCheck[] = [];
  const blockedReasons: string[] = [];

  // 1. 座位编号
  const seatOk = SEAT_NAME.test(x.seatName);
  checks.push({
    id: 'seat',
    label: '指定座位',
    state: seatOk ? 'PASS' : 'FAIL',
    detail: seatOk ? `${x.seatName}（符合已核验的编号格式）` : '请选择已核验的座位编号',
  });

  // 2. 日期
  const dateOk = isValidDate(x.date);
  checks.push({
    id: 'date',
    label: '日期',
    state: dateOk ? 'PASS' : 'FAIL',
    detail: dateOk ? x.date : '日期无效',
  });

  // 3. 时间段
  const timeOk = TIME.test(x.start) && TIME.test(x.end) && x.start < x.end;
  checks.push({
    id: 'time',
    label: '时间段',
    state: timeOk ? 'PASS' : 'FAIL',
    detail: timeOk ? `${x.start}–${x.end}` : '时段无效（需 HH:MM 且开始早于结束）',
  });

  // 4. 时长与规则
  const durationMinutes = timeOk ? toMinutes(x.end) - toMinutes(x.start) : null;
  if (durationMinutes === null) {
    checks.push({id: 'duration', label: '时长与预约规则', state: 'UNKNOWN', detail: '时段无效，无法计算时长'});
  } else {
    const withinApi =
      durationMinutes >= API_WINDOW_MINUTES.min && durationMinutes <= API_WINDOW_MINUTES.max;
    checks.push({
      id: 'duration',
      label: '时长与预约规则',
      state: 'NEEDS_REVIEW',
      detail:
        `${durationMinutes} 分钟；接口 resvRule 允许 ${API_WINDOW_MINUTES.min}–${API_WINDOW_MINUTES.max} 分钟，` +
        `帮助页写「1–4 小时」，两来源冲突未解` +
        (withinApi ? '（按接口值落在范围内，但不作为放行依据）' : '（按接口值已超出范围）'),
    });
    if (!withinApi) blockedReasons.push('时长按接口值已超出范围');
    blockedReasons.push('预约时长规则存在来源冲突（NEEDS_REVIEW）');
  }

  // 5. 登录状态
  checks.push({
    id: 'login',
    label: '登录状态',
    state: 'UNKNOWN',
    detail: '登录检测尚未实现（login-detector 恒返回 UNKNOWN），需人工确认已登录',
  });
  blockedReasons.push('登录状态未知');

  // 6. 座位实时状态
  checks.push({
    id: 'seatStatus',
    label: '座位状态',
    state: 'UNKNOWN',
    detail: '状态映射未通过现场核验；devStatus 已被证明与可约性无关',
  });
  blockedReasons.push('座位状态未知');

  // 7. 预约资格
  checks.push({
    id: 'eligibility',
    label: '预约资格',
    state: 'UNKNOWN',
    detail: '违规次数、封禁状态、已有预约等资格信息未接入',
  });
  blockedReasons.push('预约资格未知');

  // 8. 数据来源
  const sourceDetail =
    x.source === 'HISTORICAL'
      ? '历史快照，不代表当前状态'
      : x.source === 'CURRENT_PAGE'
        ? '当前页面 DOM，不含 devId 与原始 resvInfo'
        : '来源未知';
  checks.push({
    id: 'source',
    label: '数据来源',
    state: x.source === 'UNKNOWN' ? 'UNKNOWN' : 'NEEDS_REVIEW',
    detail: sourceDetail,
  });
  if (x.source !== 'CURRENT_PAGE') blockedReasons.push('依据的数据不是当前页面实时数据');

  const failed = checks.some((c) => c.state === 'FAIL');
  const plannedStartAt = dateOk && timeOk ? `${x.date}T${x.start}:00+08:00` : null;

  return {
    input: x,
    validation: failed ? 'INVALID' : 'VALID',
    rule: 'NEEDS_REVIEW',
    eligibility: 'UNKNOWN',
    seatStatus: 'UNKNOWN',
    executeAllowed: false,
    durationMinutes,
    apiWindowMinutes: {...API_WINDOW_MINUTES},
    plannedStartAt,
    checks,
    blockedReasons,
    logs: [
      '本地检查输入',
      ...checks.map((c) => `[${c.state}] ${c.label}：${c.detail}`),
      '规则冲突：NEEDS_REVIEW',
      '预约资格：UNKNOWN',
      '座位状态：UNKNOWN',
      '未生成或提交真实预约',
    ],
  };
}
