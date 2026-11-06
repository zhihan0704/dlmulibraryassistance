import type {Seat} from '../shared/types';
export interface EvidenceSeat extends Omit<Seat,'source'> {source:'VERIFIED_SNAPSHOT';devId:number;coordinate:string;devStatus:unknown;openState:unknown;resvInfo?:unknown;resvInfoPresent:boolean;status:'UNKNOWN'}
export interface ParsedSnapshot {seats:EvidenceSeat[];observedAt:string;resvInfoSchema:unknown;sourceSha256?:string}
export function parseCoordinate(value:unknown):{x:number;y:number}{if(typeof value!=='string')throw Error('坐标缺失');const a=value.split(',');if(a.length!==2||a.some(s=>!/^\s*\d+(?:\.\d+)?\s*$/.test(s)))throw Error('坐标格式无效');const [x,y]=a.map(Number);if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>100||y<0||y>100)throw Error('坐标超出百分比范围');return {x,y}}
export function parseSeatSnapshot(input:unknown):ParsedSnapshot {
 const root=input as any;if(!root||!Array.isArray(root.seats)||root.seats.length!==152)throw Error('必须为152个座位');if(typeof root.observedAt!=='string'||!Number.isFinite(Date.parse(root.observedAt)))throw Error('缺少有效采集时间');
 const names=new Set<string>(),ids=new Set<number>();const seats:EvidenceSeat[]=root.seats.map((s:any)=>{if(s.roomId!==100455855||s.roomName!=='电子阅览室')throw Error('区域归属错误');if(!Number.isSafeInteger(s.devId)||s.devId<=0)throw Error('devId无效');if(typeof s.devName!=='string'||!/^1D-(00[1-9]|0[1-9]\d|1[0-4]\d|15[0-2])$/.test(s.devName))throw Error('座位编号无效');if(names.has(s.devName)||ids.has(s.devId))throw Error('座位编号或ID重复');names.add(s.devName);ids.add(s.devId);const base:EvidenceSeat={id:String(s.devId),name:s.devName,roomId:String(s.roomId),position:parseCoordinate(s.coordinate),updatedAt:root.observedAt,source:'VERIFIED_SNAPSHOT',status:'UNKNOWN',devId:s.devId,coordinate:s.coordinate,devStatus:s.devStatus,openState:s.openState,resvInfoPresent:Object.hasOwn(s,'resvInfo')};if(base.resvInfoPresent)base.resvInfo=structuredClone(s.resvInfo);return base});
 return {seats,observedAt:root.observedAt,resvInfoSchema:root.resvInfoSchema??'UNKNOWN',sourceSha256:root.sourceSha256};
}
// 当前实时DOM没有devId和原始占用字段；不将历史快照冒充实时DOM。
export function readSeats():Seat[]{return []}
