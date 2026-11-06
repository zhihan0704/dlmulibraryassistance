import {transitionCheckin} from '../core/checkin-state-machine';
import {calculateWindow} from '../core/checkin-scheduler';
import {validateTransfer,validateBackupTransfer,type Transfer} from '../core/transfer';
import {DEFAULT_PRODUCT_SETTINGS,EXPLICIT_CHECKIN_TEXTS,identityHash,sha256,type ProductReservation,type OfficialReservation,type CheckinTask,type ProductEvent,type ProductSettings,type ProductState,type NotificationPlan} from '../core/product-model';

export const PRODUCT_STORES=['reservations','checkinTasks','stateEvents','snapshots','settings','notificationHistory'] as const;
type Store=typeof PRODUCT_STORES[number];
export interface ProductBackup {schemaVersion:1;kind:'DLMU_LOCAL_BACKUP';issuedAt:string;payload:{reservations:ProductReservation[];tasks:CheckinTask[];events:ProductEvent[];settings:ProductSettings;snapshots?:Record<string,unknown>[];notificationHistory?:Record<string,unknown>[]};sha256:string}
const request=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
const done=(t:IDBTransaction)=>new Promise<void>((resolve,reject)=>{t.oncomplete=()=>resolve();t.onabort=t.onerror=()=>reject(t.error??Error('本地事务失败'))});

/** Local-only database. IDB transactions serialize changes across panel/background tabs. */
export class ProductRepository {
  private database:Promise<IDBDatabase>;
  constructor(name='dlmu-product-v1') {
    this.database=new Promise((resolve,reject)=>{
      const r=indexedDB.open(name,1);
      r.onupgradeneeded=()=>{for(const store of PRODUCT_STORES)if(!r.result.objectStoreNames.contains(store))r.result.createObjectStore(store,{keyPath:'id'})};
      r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result)};
      r.onerror=()=>reject(r.error); r.onblocked=()=>reject(Error('请关闭其他旧版本页面后重试数据库升级'));
    });
  }
  async close(){(await this.database).close()}
  private async all<T>(store:Store):Promise<T[]>{const db=await this.database;return request(db.transaction(store).objectStore(store).getAll())}
  async state(now=Date.now()):Promise<ProductState>{
    const [reservations,tasks,events,settings]=await Promise.all([this.all<ProductReservation>('reservations'),this.all<CheckinTask>('checkinTasks'),this.all<ProductEvent>('stateEvents'),this.all<ProductSettings&{authState?:string}>('settings')]);
    const config=settings.find(s=>s.id==='main')??DEFAULT_PRODUCT_SETTINGS;
    const auth=(settings as unknown as {id:string;value?:string}[]).find(s=>s.id==='auth')?.value??'UNKNOWN';
    return {reservations:reservations.sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt)),tasks:tasks.map(t=>{if(['OFFICIAL_CONFIRMED','AUTH_REQUIRED'].includes(t.state))return t;const r=reservations.find(r=>r.id===t.reservationId);if(r?.cancelled||r&&now>=Date.parse(r.endAt))return {...t,state:'EXPIRED'};if(t.userSwipedAt)return {...t,state:'AWAITING_OFFICIAL_CONFIRMATION'};if(now>=Date.parse(t.preparationAt))return {...t,state:'PREPARATION_DUE'};return t}),events:events.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)),settings:config,authState:auth};
  }
  async settings(update:Partial<ProductSettings>){
    const state=await this.state();const value:ProductSettings={id:'main',reminderMinutes:update.reminderMinutes??state.settings.reminderMinutes,pwaUrl:update.pwaUrl??state.settings.pwaUrl};
    if(!Number.isInteger(value.reminderMinutes)||value.reminderMinutes<0||value.reminderMinutes>10080)throw Error('提醒提前时间无效');
    if(value.pwaUrl){const u=new URL(value.pwaUrl);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('手机网页地址必须使用 HTTPS');if(u.username||u.password||u.search||u.hash)throw Error('手机地址不得包含认证、查询或导入信息')}
    const db=await this.database;const tx=db.transaction(['settings','checkinTasks','reservations'],'readwrite');const finished=done(tx);
    tx.objectStore('settings').put(value);
    const tasks=await request<CheckinTask[]>(tx.objectStore('checkinTasks').getAll());
    for(const task of tasks){const r=await request<ProductReservation>(tx.objectStore('reservations').get(task.reservationId));if(r){const w=calculateWindow({id:r.id,seatCode:r.seatCode,roomName:r.roomName,startAt:r.startAt,endAt:r.endAt,source:r.source,observedAt:r.observedAt},null,value.reminderMinutes);tx.objectStore('checkinTasks').put({...task,preparationAt:w.preparationAt})}}
    await finished;
  }
  private async saveReservation(r:ProductReservation,official:boolean){
    const db=await this.database;const settings=(await this.state()).settings;
    const tx=db.transaction(['reservations','checkinTasks','stateEvents','snapshots'],'readwrite');const finished=done(tx);
    const old=await request<ProductReservation|undefined>(tx.objectStore('reservations').get(r.id));
    const task=await request<CheckinTask|undefined>(tx.objectStore('checkinTasks').get(r.id));
    if(old&&Date.parse(r.observedAt)<Date.parse(old.observedAt)){await finished;return}
    // QR imports never overwrite a locally observed official record or its confirmation.
    if(old?.provenance==='OFFICIAL_DOM'&&!official){await finished;return}
    const window=calculateWindow({id:r.id,seatCode:r.seatCode,roomName:r.roomName,startAt:r.startAt,endAt:r.endAt,source:r.source,observedAt:r.observedAt},null,settings.reminderMinutes);
    const next:CheckinTask={id:r.id,reservationId:r.id,state:r.officialConfirmed?'OFFICIAL_CONFIRMED':r.cancelled?'EXPIRED':task?.userSwipedAt?'AWAITING_OFFICIAL_CONFIRMATION':'UPCOMING',preparationAt:window.preparationAt,officialOpensAt:null,userSwipedAt:task?.userSwipedAt??null,officialConfirmedAt:r.officialConfirmed?r.observedAt:null,updatedAt:r.observedAt};
    tx.objectStore('reservations').put(r);tx.objectStore('checkinTasks').put(next);
    const snapId=awaitSafeId(r); // synchronous identity; no await while transaction is active
    const previousSnapshot=await request(tx.objectStore('snapshots').get(snapId));if(!previousSnapshot)tx.objectStore('snapshots').add({id:snapId,reservationId:r.id,at:r.observedAt,displayStatus:r.displayStatus,source:r.source,officialConfirmed:r.officialConfirmed});
    if(!old||old.displayStatus!==r.displayStatus||old.officialConfirmed!==r.officialConfirmed||old.cancelled!==r.cancelled){const event:ProductEvent={id:snapId,reservationId:r.id,at:r.observedAt,type:!old?'RESERVATION_IMPORTED':r.officialConfirmed?'OFFICIAL_CONFIRMED':r.cancelled?'CANCELLED_OBSERVED':'OFFICIAL_STATUS_CHANGED',message:r.officialConfirmed?'官方页面明确显示签到确认':r.cancelled?'官方页面显示预约取消':r.displayStatus||'已导入预约，官方签到状态未知',source:r.source};tx.objectStore('stateEvents').put(event)}
    await finished;
  }
  async importTransfer(input:Transfer){const x=validateTransfer(input);const r:ProductReservation={...x,id:x.recordIdentityHash,floorId:null,roomId:null,seatId:null,recordIdentity:x.recordIdentityHash,observedAt:x.issuedAt,displayStatus:'UNKNOWN',officialConfirmed:false,cancelled:false,provenance:'TRANSFER'};await this.saveReservation(r,false)}
  async observeOfficial(rows:OfficialReservation[]){
    if(!Array.isArray(rows)||rows.length>500)throw Error('预约列表无效');
    const keys=await Promise.all(rows.map(r=>identityHash(r)));if(new Set(keys).size!==keys.length)throw Error('预约不能唯一匹配');
    const prepared=rows.map((r,i)=>{
      if(!r.id||r.id.length>200||/(…|\.{3}$)/.test(r.id)||r.source!=='OFFICIAL_VISIBLE_DOM'||typeof r.displayStatus!=='string'||r.displayStatus.length>100)throw Error('缺少完整官方预约编号或状态');
      const id=keys[i];const transfer=validateTransfer({schemaVersion:1,issuedAt:r.observedAt,expiresAt:new Date(Date.parse(r.observedAt)+86400000).toISOString(),date:r.date,floorName:r.floorName,roomName:r.roomName,seatCode:r.seatCode,startAt:r.startAt,endAt:r.endAt,recordIdentityHash:id,source:r.source});
      return {...transfer,id,floorId:null,roomId:null,seatId:null,recordIdentity:id,observedAt:r.observedAt,displayStatus:r.displayStatus,officialConfirmed:EXPLICIT_CHECKIN_TEXTS.includes(r.displayStatus),cancelled:['已取消','预约已取消','取消成功'].includes(r.displayStatus),provenance:'OFFICIAL_DOM' as const};
    });
    for(const r of prepared)await this.saveReservation(r,true);
    await this.setAuth('AUTHENTICATED');
  }
  async reportSwiped(id:string){
    const db=await this.database;const tx=db.transaction(['checkinTasks','stateEvents'],'readwrite');const finished=done(tx);const task=await request<CheckinTask|undefined>(tx.objectStore('checkinTasks').get(id));
    if(!task){tx.abort();await finished.catch(()=>{});throw Error('任务不存在')}
    if(!task.userSwipedAt&&task.state!=='OFFICIAL_CONFIRMED'&&task.state!=='EXPIRED'){
      const at=new Date().toISOString();const reported=transitionCheckin(task.state,{type:'USER_SWIPED',at});const waiting=transitionCheckin(reported,{type:'WAIT',at});tx.objectStore('checkinTasks').put({...task,state:waiting,userSwipedAt:at,updatedAt:at});
      tx.objectStore('stateEvents').add({id:crypto.randomUUID(),reservationId:id,at,type:'USER_REPORTED_CARD_SWIPED',message:'用户报告本人已刷校园卡；等待官方确认',source:'USER'});
    }
    await finished;
  }
  async setAuth(authState:string){
    if(!['AUTHENTICATED','SSO_EXPIRED','BUSINESS_SESSION_EXPIRED','LOGIN_REQUIRED','RECOVERING','PAGE_NOT_READY','UNKNOWN'].includes(authState))throw Error('认证状态无效');
    const db=await this.database;const tx=db.transaction(['settings','stateEvents'],'readwrite');const finished=done(tx);const old=await request<{value:string}|undefined>(tx.objectStore('settings').get('auth'));
    tx.objectStore('settings').put({id:'auth',value:authState});if(old?.value!==authState)tx.objectStore('stateEvents').add({id:crypto.randomUUID(),reservationId:'session',at:new Date().toISOString(),type:'AUTH_STATE',source:'BROWSER',message:authState});await finished;
  }
  async exportBackup():Promise<ProductBackup>{const state=await this.state();const payload={reservations:state.reservations,tasks:state.tasks,events:state.events,settings:state.settings,snapshots:await this.all<Record<string,unknown>>('snapshots'),notificationHistory:await this.all<Record<string,unknown>>('notificationHistory')};return {schemaVersion:1,kind:'DLMU_LOCAL_BACKUP',issuedAt:new Date().toISOString(),payload,sha256:await sha256(JSON.stringify(payload))}}
  async restoreBackup(raw:unknown){
    const backup=raw as ProductBackup;
    if(!backup||backup.schemaVersion!==1||backup.kind!=='DLMU_LOCAL_BACKUP'||Object.keys(backup).some(k=>!['schemaVersion','kind','issuedAt','payload','sha256'].includes(k))||!Number.isFinite(Date.parse(backup.issuedAt))||Date.parse(backup.issuedAt)>Date.now()+60000||!backup.payload||await sha256(JSON.stringify(backup.payload))!==backup.sha256)throw Error('备份完整性校验失败');
    const p=backup.payload;
    if(Object.keys(p).some(k=>!['reservations','tasks','events','settings','snapshots','notificationHistory'].includes(k))||!Array.isArray(p.reservations)||p.reservations.length>500||!Array.isArray(p.tasks)||p.tasks.length>500||!Array.isArray(p.events)||p.events.length>10000||p.snapshots&&(!Array.isArray(p.snapshots)||p.snapshots.length>20000)||p.notificationHistory&&(!Array.isArray(p.notificationHistory)||p.notificationHistory.length>20000))throw Error('备份结构无效');
    const config=p.settings;
    if(!config||Object.keys(config).some(k=>!['id','reminderMinutes','pwaUrl'].includes(k))||!Number.isInteger(config.reminderMinutes)||config.reminderMinutes<0||config.reminderMinutes>10080||typeof config.pwaUrl!=='string')throw Error('备份设置无效');
    if(config.pwaUrl){const u=new URL(config.pwaUrl);if(u.username||u.password||u.search||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('备份网页地址无效')}
    const normalized=p.reservations.map(r=>{
      const x=validateBackupTransfer({schemaVersion:1,issuedAt:r.issuedAt,expiresAt:r.expiresAt,date:r.date,floorName:r.floorName,roomName:r.roomName,seatCode:r.seatCode,startAt:r.startAt,endAt:r.endAt,recordIdentityHash:r.recordIdentityHash,source:r.source});
      if(r.id!==x.recordIdentityHash||typeof r.cancelled!=='boolean')throw Error('备份预约身份无效');
      return {...x,id:x.recordIdentityHash,floorId:null,roomId:null,seatId:null,recordIdentity:x.recordIdentityHash,observedAt:x.issuedAt,displayStatus:'备份记录：需重新官方核验',officialConfirmed:false,cancelled:r.cancelled,provenance:'BACKUP' as const};
    });
    const ids=new Set(normalized.map(r=>r.id));if(ids.size!==normalized.length)throw Error('备份预约重复');
    for(const t of p.tasks)if(!ids.has(t.id)||t.reservationId!==t.id||t.userSwipedAt!==null&&(typeof t.userSwipedAt!=='string'||!Number.isFinite(Date.parse(t.userSwipedAt))||Date.parse(t.userSwipedAt)>Date.now()+60000))throw Error('备份任务无效');
    for(const e of p.events)if(typeof e.id!=='string'||e.id.length>300||typeof e.reservationId!=='string'||!Number.isFinite(Date.parse(e.at))||typeof e.type!=='string'||e.type.length>100||typeof e.message!=='string'||e.message.length>500||typeof e.source!=='string')throw Error('备份历史无效');
    const db=await this.database;const tx=db.transaction([...PRODUCT_STORES],'readwrite');const finished=done(tx);
    const protectedIds=new Set<string>();
    for(const r of normalized){const old=await request<ProductReservation|undefined>(tx.objectStore('reservations').get(r.id));if(old?.provenance==='OFFICIAL_DOM'){protectedIds.add(r.id);continue}tx.objectStore('reservations').put(r);const t=p.tasks.find(t=>t.id===r.id);const window=calculateWindow({id:r.id,seatCode:r.seatCode,roomName:r.roomName,startAt:r.startAt,endAt:r.endAt,source:r.source,observedAt:r.observedAt},null,config.reminderMinutes);const existing=await request<CheckinTask|undefined>(tx.objectStore('checkinTasks').get(r.id));const swiped=existing?.userSwipedAt??t?.userSwipedAt??null;tx.objectStore('checkinTasks').put({id:r.id,reservationId:r.id,state:swiped?'AWAITING_OFFICIAL_CONFIRMATION':'UPCOMING',preparationAt:window.preparationAt,officialOpensAt:null,userSwipedAt:swiped,officialConfirmedAt:null,updatedAt:r.observedAt})}
    for(const e of p.events)tx.objectStore('stateEvents').put({id:'backup:'+e.id.replace(/^(backup:)+/,''),reservationId:e.reservationId,at:e.at,type:'IMPORTED_HISTORY',message:'备份历史（未重新核验）：'+e.message.slice(0,300),source:'BACKUP'});
    for(const snapshot of p.snapshots??[]){if(typeof snapshot.id!=='string'||typeof snapshot.reservationId!=='string'||typeof snapshot.at!=='string'||!Number.isFinite(Date.parse(snapshot.at)))continue;const id='backup:'+snapshot.id.replace(/^(backup:)+/,'');const existing=await request(tx.objectStore('snapshots').get(id));if(!existing)tx.objectStore('snapshots').add({id,reservationId:snapshot.reservationId.slice(0,100),at:snapshot.at,displayStatus:typeof snapshot.displayStatus==='string'?snapshot.displayStatus.slice(0,100):'UNKNOWN',source:'BACKUP',officialConfirmed:false})}
    for(const n of p.notificationHistory??[]){if(typeof n.id!=='string'||typeof n.at!=='string'||!Number.isFinite(Date.parse(n.at)))continue;tx.objectStore('notificationHistory').put({id:'backup:'+n.id.replace(/^(backup:)+/,''),at:n.at,kind:'IMPORTED_HISTORY'})}
    // Imported reminder claims use a prefix: they do not suppress new-device reminders.
    tx.objectStore('settings').put({id:'main',reminderMinutes:config.reminderMinutes,pwaUrl:config.pwaUrl});tx.objectStore('settings').put({id:'auth',value:'UNKNOWN'});await finished;
  }
  async dueNotifications(now=Date.now()):Promise<NotificationPlan[]>{const s=await this.state(now);const plans:NotificationPlan[]=[];for(const t of s.tasks){const r=s.reservations.find(r=>r.id===t.reservationId);if(!r)continue;if(r.cancelled){plans.push({id:r.id+':cancelled',reservationId:r.id,kind:'cancelled',at:new Date(now).toISOString(),title:'预约取消提示',message:r.provenance==='OFFICIAL_DOM'?'官方页面显示预约已取消，请核对。':'备份记录标记取消，请重新核对官方页面。'});continue}if(now>=Date.parse(t.preparationAt)&&now<Date.parse(r.endAt)&&!t.userSwipedAt&&!r.officialConfirmed)plans.push({id:r.id+':prepare',reservationId:r.id,kind:'prepare',at:new Date(now).toISOString(),title:'签到准备提醒',message:`${r.roomName} ${r.seatCode}：携带校园卡，前往学校官方机器。`})}if(['SSO_EXPIRED','LOGIN_REQUIRED','BUSINESS_SESSION_EXPIRED'].includes(s.authState)){const last=s.events.find(e=>e.type==='AUTH_STATE');plans.push({id:'auth:'+(last?.id??s.authState),reservationId:'session',kind:'auth',at:new Date(now).toISOString(),title:'需要人工登录',message:'请在官方网页正常登录；任务与历史记录已保留。'})}return plans}
  async claimNotification(plan:NotificationPlan):Promise<boolean>{const db=await this.database;const tx=db.transaction('notificationHistory','readwrite');const finished=done(tx);const old=await request(tx.objectStore('notificationHistory').get(plan.id));if(old){await finished;return false}tx.objectStore('notificationHistory').add({id:plan.id,at:plan.at,kind:plan.kind});await finished;return true}
}
function awaitSafeId(r:ProductReservation){return r.id+':'+r.observedAt+':'+r.displayStatus}
