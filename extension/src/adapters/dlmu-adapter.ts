import type {LibraryAdapter} from './library-adapter';import {parseSeatSnapshot} from '../content/seat-reader';
export class DlmuAdapter implements LibraryAdapter {
 constructor(private readonly snapshot?:unknown){}
 async detectPage(){return typeof location!=='undefined'&&location.origin==='https://seats.dlmu.edu.cn'}
 async getCurrentRoom(){return this.snapshot? '100455855':null}
 async getSeats(){return this.snapshot?parseSeatSnapshot(this.snapshot).seats:[]}
 async getSeatStatus(){return 'UNKNOWN'}
 async getReservationRules(){return 'NEEDS_REVIEW' as const}
 async getMyReservations():Promise<{seatId:string}[]>{throw Error('未接入个人记录；禁止生产接口调用')}
}
