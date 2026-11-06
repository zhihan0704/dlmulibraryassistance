import type {Transfer} from './transfer';
import type {CheckinState} from './checkin-state-machine';

export interface OfficialReservation {
  id:string; date:string; floorName:string; roomName:string; seatCode:string;
  startAt:string; endAt:string; displayStatus:string; source:'OFFICIAL_VISIBLE_DOM';
  observedAt:string; officialConfirmed:boolean; cancelled:boolean;
}
export interface ProductReservation extends Transfer {
  id:string; floorId:string|null;roomId:string|null;seatId:string|null;recordIdentity:string; observedAt:string; displayStatus:string; officialConfirmed:boolean;
  cancelled:boolean; provenance:'OFFICIAL_DOM'|'TRANSFER'|'BACKUP';
}
export interface CheckinTask {
  id:string; reservationId:string; state:CheckinState; preparationAt:string;
  officialOpensAt:string|null; userSwipedAt:string|null; officialConfirmedAt:string|null;
  updatedAt:string;
}
export interface ProductEvent {id:string;reservationId:string;at:string;type:string;message:string;source:string}
export interface ProductSettings {id:'main';reminderMinutes:number;pwaUrl:string}
export interface ProductState {
  reservations:ProductReservation[]; tasks:CheckinTask[]; events:ProductEvent[];
  settings:ProductSettings; authState:string;
}
export interface NotificationPlan {id:string;reservationId:string;kind:'prepare'|'cancelled'|'auth';at:string;title:string;message:string}
export const DEFAULT_PRODUCT_SETTINGS:ProductSettings={id:'main',reminderMinutes:20,pwaUrl:''};
export const EXPLICIT_CHECKIN_TEXTS=['已签到','签到成功','使用中（已签到）'];

export async function identityHash(r:Pick<OfficialReservation,'id'|'seatCode'|'startAt'|'endAt'|'roomName'>):Promise<string> {
  const value=JSON.stringify([r.id,r.seatCode,r.startAt,r.endAt,r.roomName]);
  return sha256(value);
}
export async function sha256(value:string):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function asTransfer(r:ProductReservation,now=Date.now()):Transfer {
  return {schemaVersion:1,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),date:r.date,floorName:r.floorName,roomName:r.roomName,seatCode:r.seatCode,startAt:r.startAt,endAt:r.endAt,recordIdentityHash:r.recordIdentityHash,source:r.source};
}
