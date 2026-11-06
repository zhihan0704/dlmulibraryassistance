export type Status='DRAFT'|'WAITING'|'AUTH_REQUIRED'|'CHECKING'|'READY'|'EXECUTING'|'VERIFYING'|'SUCCESS'|'FAILED'|'CANCELLED'|'NEEDS_REVIEW';
export interface Seat {id:string;name:string;roomId:string;status:'AVAILABLE'|'UNKNOWN';position:{x:number;y:number}|null;updatedAt:string;source:'MOCK'|'DOM'|'VERIFIED_SNAPSHOT'}
export interface ReservationTask {id:string;roomId:string;seatId:string;reservationDate:string;startTime:string;endTime:string;scheduledAt:number;status:Status;createdAt:string;updatedAt:string;paused:boolean;mode:'MOCK';logs:{at:string;message:string}[]}
export interface Snapshot {target:boolean;room:'UNKNOWN';login:'UNKNOWN';seats:Seat[];updatedAt:string;reason:string}
