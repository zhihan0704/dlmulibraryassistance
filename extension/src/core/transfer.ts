import {calculateWindow,parseZonedInstant} from './checkin-scheduler';
/** These are untrusted transfer claims, never proof of official confirmation or authentication. */
export interface Transfer {schemaVersion:1;issuedAt:string;expiresAt:string;date:string;floorName:string;roomName:string;seatCode:string;startAt:string;endAt:string;recordIdentityHash:string;source:string}
const KEYS=['schemaVersion','issuedAt','expiresAt','date','floorName','roomName','seatCode','startAt','endAt','recordIdentityHash','source'] as const;
const plain=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
export function validateTransfer(input:unknown,now=Date.now()):Transfer{return validate(input,now,false)}
/** Local backup restoration permits expired transport envelopes, never future issuance or malformed data. */
export function validateBackupTransfer(input:unknown,now=Date.now()):Transfer{return validate(input,now,true)}
function validate(input:unknown,now:number,allowExpired:boolean):Transfer {
 if(!plain(input)||Object.keys(input).length!==KEYS.length||Object.keys(input).some(k=>!KEYS.includes(k as typeof KEYS[number]))||input.schemaVersion!==1)throw Error('数据结构无效');
 if(!Number.isFinite(now))throw Error('系统时间无效');
 for(const key of KEYS.filter(k=>k!=='schemaVersion')){const v=input[key];if(typeof v!=='string'||!v.trim()||v.length>200||/[\u0000-\u001f\u007f]/.test(v))throw Error('字段无效')}
 const a=input as unknown as Transfer;
 const issued=parseZonedInstant(a.issuedAt),expires=parseZonedInstant(a.expiresAt),start=parseZonedInstant(a.startAt);
 if(!/^[a-f0-9]{64}$/.test(a.recordIdentityHash)||issued>now+60000||expires<=issued||(!allowExpired&&expires<=now))throw Error('数据过期或时间无效');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(a.date)||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(start))!==a.date)throw Error('日期与北京时间预约日期不一致');
 calculateWindow({id:a.recordIdentityHash,seatCode:a.seatCode,roomName:a.roomName,startAt:a.startAt,endAt:a.endAt,source:a.source,observedAt:a.issuedAt},null,20);
 return Object.fromEntries(KEYS.map(k=>[k,a[k]])) as unknown as Transfer;
}
export function transferUrl(base:string,data:Transfer){const u=new URL(base);if(u.username||u.password||u.search)throw Error('PWA地址不能携带凭据或查询参数');if(u.protocol!=='https:'&&!((u.hostname==='localhost'||u.hostname==='127.0.0.1')&&u.protocol==='http:'))throw Error('PWA地址需要HTTPS');u.hash=encodeURIComponent(JSON.stringify(validateTransfer(data)));return u.toString()}
export function makeIcs(input:Transfer,minutes=20){const x=validateBackupTransfer(input);const utc=(s:string)=>new Date(parseZonedInstant(s)).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');if(!Number.isInteger(minutes)||minutes<0||minutes>10080)throw Error('提醒时间无效');return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//DLMU Assistant//CN','BEGIN:VEVENT',`UID:${x.recordIdentityHash}@local`,`DTSTAMP:${utc(new Date().toISOString())}`,`DTSTART:${utc(x.startAt)}`,`DTEND:${utc(x.endAt)}`,'SUMMARY:图书馆预约与现场刷卡','BEGIN:VALARM',`TRIGGER:-PT${minutes}M`,'ACTION:DISPLAY','DESCRIPTION:携带校园卡','END:VALARM','END:VEVENT','END:VCALENDAR',''].join('\r\n')}
