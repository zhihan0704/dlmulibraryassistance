import {parseInstant, validSeatTarget, type SeatTarget} from './seat-timeline';

export const runtimeEventCatalog = {
  BROWSER_STARTED: ['INFO', 'Edge 已启动，扩展开始恢复'],
  EXTENSION_INITIALIZED: ['INFO', '扩展后台已初始化'],
  PAGE_ENTERED: ['INFO', '已进入学校业务页面'],
  SESSION_LOST: ['WARN', '认证中断，等待人工登录和个人预约复核'],
  SESSION_RECOVERED: ['INFO', '个人预约页复核完成，等待新的座位观察'],
  DATA_CAPTURED: ['INFO', '取得新的页面观察'],
  SEAT_CHANGED: ['INFO', '座位页面或座位字段发生变化'],
  TIME_CHANGED: ['INFO', '观察到座位时间字段变化'],
  RECORD_ADDED: ['INFO', '观察到新的预约时间记录'],
  RECORD_REMOVED: ['INFO', '上次观察的记录在本次响应中消失，原因待核实'],
  STATUS_CHANGED: ['INFO', '原始状态值变化，含义待核实'],
  CANDIDATE_FOUND: ['INFO', '已核验数据支持新的空档建议'],
  TASK_STARTED: ['INFO', '计划提醒或预约核对已开始'],
  TASK_PAUSED: ['INFO', '每日提醒已暂停'],
  TASK_RESUMED: ['INFO', '每日提醒已恢复'],
  TASK_FAILED: ['ERROR', '本次任务读取失败，请人工核对'],
  DATA_STALE: ['WARN', '页面观察已过期，等待新数据'],
  RESERVATION_VERIFIED: ['INFO', '官方个人页显示唯一匹配的有效预约'],
  RESERVATION_UNVERIFIED: ['WARN', '本次未能核验到唯一有效预约，请人工核对'],
  NETWORK_ERROR: ['WARN', '当前网页连接离线或受到访问限制'],
  PARSER_ERROR: ['ERROR', '当前页面或响应未通过结构校验'],
  NOTIFICATION_SENT: ['INFO', 'Edge 已接受一条桌面提醒'],
} as const;

export type RuntimeEventType = keyof typeof runtimeEventCatalog;
export type RuntimeSource = 'BROWSER' | 'WORKER' | 'NETWORK' | 'DOM' | 'PLANNER' | 'TASK';
export interface RuntimeEvent {
  eventId: string;
  eventType: RuntimeEventType;
  timestamp: string;
  source: RuntimeSource;
  severity: 'INFO' | 'WARN' | 'ERROR';
  relatedSeat: SeatTarget | null;
  relatedTask: string | null;
  description: string;
}

export const shanghaiTimestamp = (epoch: number): string => new Date(epoch + 8 * 3_600_000).toISOString().replace('Z', '+08:00');
const SOURCES = new Set<string>(['BROWSER', 'WORKER', 'NETWORK', 'DOM', 'PLANNER', 'TASK']);
const SEAT_CODE = /^[A-Za-z][A-Za-z0-9-]{0,31}$|^\d[A-Za-z][A-Za-z0-9-]{0,30}$/;
export function safeRuntimeSeat(input: unknown): SeatTarget | null {
  const value = input as SeatTarget | undefined;
  return validSeatTarget(value) && SEAT_CODE.test(value.seatCode)
    ? {roomId: value.roomId, devId: value.devId, seatCode: value.seatCode} : null;
}

export function normalizeRuntimeEvent(input: unknown): RuntimeEvent {
  const value = input as Partial<RuntimeEvent> | undefined;
  const timestamp = parseInstant(value?.timestamp);
  if (!value || typeof value.eventId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.eventId) ||
      !value.eventType || !Object.hasOwn(runtimeEventCatalog, value.eventType) || !value.source || !SOURCES.has(value.source) || timestamp === null) {
    throw Error('运行事件格式无效');
  }
  const [severity, description] = runtimeEventCatalog[value.eventType];
  const relatedTask = typeof value.relatedTask === 'string' && /^(?:daily-fixed-seat|plan:\d{4}-\d{2}-\d{2})$/.test(value.relatedTask)
    ? value.relatedTask : null;
  return {eventId: value.eventId, eventType: value.eventType, timestamp: shanghaiTimestamp(timestamp), source: value.source,
    severity, description, relatedSeat: safeRuntimeSeat(value.relatedSeat), relatedTask};
}

export function createRuntimeEvent(input: {eventType: RuntimeEventType; timestamp: number; source: RuntimeSource;
  relatedSeat?: SeatTarget | null; relatedTask?: string | null}): RuntimeEvent {
  return normalizeRuntimeEvent({...input, eventId: crypto.randomUUID(), timestamp: shanghaiTimestamp(input.timestamp)});
}

export interface RuntimeSnapshot {
  capturedAt: string;
  route: string;
  seatCount: number;
  source: 'NETWORK' | 'DOM';
}
export function normalizeRuntimeSnapshot(input: unknown): RuntimeSnapshot {
  const value = input as RuntimeSnapshot | undefined;
  const at = parseInstant(value?.capturedAt);
  if (!value || at === null || typeof value.route !== 'string' || !/^#\/ic\/seatPredetermine\/[1-9]\d{0,14}$/.test(value.route) ||
      !Number.isSafeInteger(value.seatCount) || value.seatCount < 1 || value.seatCount > 2000 ||
      (value.source !== 'NETWORK' && value.source !== 'DOM')) throw Error('运行快照格式无效');
  return {capturedAt: shanghaiTimestamp(at), route: value.route, seatCount: value.seatCount, source: value.source};
}

export type RuntimeHealthState = 'HEALTHY' | 'WAITING_FOR_PAGE' | 'SESSION_LOST' | 'NETWORK_ERROR' |
  'PARSER_ERROR' | 'DATA_STALE' | 'WORKER_RECOVERING' | 'TASK_PAUSED' | 'UNKNOWN';
export interface RuntimeHealthEvidence {
  browser: 'CONNECTED' | 'UNKNOWN';
  extension: 'CONNECTED' | 'UNKNOWN';
  worker: 'READY' | 'RECOVERING' | 'UNKNOWN';
  content: 'CONNECTED' | 'DISCONNECTED';
  page: 'SEATS' | 'PERSONAL' | 'OFFICIAL' | 'SSO' | 'OTHER';
  session: 'UNKNOWN' | 'REVERIFIED' | 'SESSION_LOST';
  network: 'FRESH' | 'STALE' | 'WAITING' | 'ERROR';
  dom: 'FRESH' | 'STALE' | 'WAITING' | 'ERROR';
  parseError: boolean;
  indexedDB: 'READY' | 'ERROR' | 'UNKNOWN';
  alarms: 'SCHEDULED' | 'MISSING' | 'NONE' | 'ERROR' | 'UNKNOWN';
  task: 'ENABLED' | 'PAUSED' | 'NONE';
  lastResponse: string | null;
  lastDom: string | null;
  lastParsed: string | null;
  lastTask: string | null;
  lastGood: RuntimeSnapshot | null;
  lastError: RuntimeEvent | null;
}
export interface RuntimeHealth extends RuntimeHealthEvidence {state: RuntimeHealthState; reason: string}

export function evaluateRuntimeHealth(evidence: RuntimeHealthEvidence): RuntimeHealth {
  const health = (state: RuntimeHealthState, reason: string) => ({...evidence, state, reason});
  if (evidence.page === 'SSO' || evidence.session === 'SESSION_LOST') return health('SESSION_LOST', '请人工登录，并打开官方个人预约页复核');
  if (evidence.indexedDB === 'ERROR') return health('UNKNOWN', '本地数据库读取失败，暂缓建议和核验');
  if (evidence.worker === 'RECOVERING') return health('WORKER_RECOVERING', '扩展后台正在恢复本地任务');
  if (evidence.worker === 'UNKNOWN' || evidence.extension !== 'CONNECTED' || evidence.browser !== 'CONNECTED') return health('UNKNOWN', '尚未取得扩展后台响应');
  if (evidence.page === 'OTHER' || evidence.content === 'DISCONNECTED') return health('WAITING_FOR_PAGE', '请打开学校业务页面并等待扩展连接');
  if (evidence.network === 'ERROR') return health('NETWORK_ERROR', '网页连接暂不可用，等待下一份有效响应');
  if (evidence.parseError || evidence.dom === 'ERROR') return health('PARSER_ERROR', '页面或响应校验失败，等待重新观察');
  if (evidence.network === 'STALE' || evidence.dom === 'STALE') return health('DATA_STALE', '当前观察已过期，等待学校页面产生新数据');
  if (evidence.alarms === 'MISSING' || evidence.alarms === 'ERROR') return health('UNKNOWN', '预约提醒时钟尚未核对');
  if (evidence.task === 'PAUSED') return health('TASK_PAUSED', '每日提醒处于暂停状态');
  if (evidence.page !== 'SEATS' || evidence.network !== 'FRESH' || evidence.dom !== 'FRESH') return health('WAITING_FOR_PAGE', '已连接，正在等待座位页的有效数据');
  return health('HEALTHY', '当前座位页的网络与页面观察有效');
}
