import type {Reservation} from './checkin-scheduler';
export function preparationSteps(r:Reservation){return [`确认预约座位 ${r.roomName} ${r.seatCode}`,'携带校园卡','前往学校官方签到机器并由本人刷卡','刷卡后记录用户报告，等待官方确认']}
