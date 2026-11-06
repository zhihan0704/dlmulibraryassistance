import type {NotificationPlan} from './product-model';
export interface NotificationRepository {
  dueNotifications(now?:number):Promise<NotificationPlan[]>;
  claimNotification(plan:NotificationPlan):Promise<boolean>;
}
/** Shared delivery policy. Claims are atomic in IndexedDB, including across browser tabs. */
export class NotificationManager {
  constructor(private repository:NotificationRepository,private deliver:(plan:NotificationPlan)=>Promise<void>){}
  async check(now=Date.now()):Promise<{delivered:number;failed:number}>{
    if(!Number.isFinite(now))throw Error('系统时间无效');
    let delivered=0,failed=0;
    for(const plan of await this.repository.dueNotifications(now)){
      if(!await this.repository.claimNotification(plan))continue;
      try{await this.deliver(plan);delivered++}catch{failed++}
    }
    return {delivered,failed};
  }
}
