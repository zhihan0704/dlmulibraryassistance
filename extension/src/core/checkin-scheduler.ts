/** Shared, deterministic scheduling. All instants require explicit timezone offsets. */
export interface Reservation {id:string;seatCode:string;roomName:string;startAt:string;endAt:string;source:string;observedAt:string}
export interface CheckinWindow {officialEarlyMinutes:number|null;userReminderMinutes:number;preparationAt:string;officialOpensAt:string|null}
export function parseZonedInstant(value: unknown): number {
  if (typeof value !== 'string') throw new Error('时间无效');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) throw new Error('时间必须为含时区的完整ISO时间');
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]),minute=Number(m[5]),second=Number(m[6]);
  const leap=year%4===0&&(year%100!==0||year%400===0);const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1900||year>9999||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)throw Error('日期或时间无效');
  if(m[8]!=='Z'){const [h,min]=m[8].slice(1).split(':').map(Number);if(h>14||min>59||(h===14&&min!==0))throw Error('时区偏移无效')}
  const instant=Date.parse(value);if(!Number.isFinite(instant))throw Error('时间无效');return instant;
}
export function calculateWindow(reservation:Reservation,officialEarlyMinutes:number|null,userReminderMinutes:number):CheckinWindow {
  const start=parseZonedInstant(reservation.startAt),end=parseZonedInstant(reservation.endAt);
  if(end<=start)throw Error('预约结束时间必须晚于开始时间');
  for(const x of [userReminderMinutes,...(officialEarlyMinutes===null?[]:[officialEarlyMinutes])])if(!Number.isInteger(x)||x<0||x>10080)throw Error('提前分钟无效');
  return {officialEarlyMinutes,userReminderMinutes,preparationAt:new Date(start-userReminderMinutes*60000).toISOString(),officialOpensAt:officialEarlyMinutes===null?null:new Date(start-officialEarlyMinutes*60000).toISOString()};
}
