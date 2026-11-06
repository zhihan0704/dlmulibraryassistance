import {NotificationManager} from '../core/notification-manager';
import {ProductRepository} from '../storage/product-db';
import type {OfficialReservation} from '../core/product-model';
const repository=new ProductRepository('dlmu-extension-product-v1');
let queue:Promise<unknown>=Promise.resolve();
const serialize=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn);queue=next.catch(()=>{});return next};
const PANEL_PATH='/src/sidepanel/index.html';
function panelSender(s:chrome.runtime.MessageSender){return s.id===chrome.runtime.id&&s.url===chrome.runtime.getURL(PANEL_PATH.slice(1))}
function officialSender(s:chrome.runtime.MessageSender){try{return s.id===chrome.runtime.id&&new URL(s.url??'').origin==='https://seats.dlmu.edu.cn'&&new URL(s.url??'').hash.split('?')[0]==='#/ic/userinfo'&&s.frameId===0}catch{return false}}
function notify(){void chrome.runtime.sendMessage({type:'PRODUCT_UPDATED'}).catch(()=>{})}
async function reschedule(){
  await chrome.alarms.clear('dlmu-product-reminder');const s=await repository.state();const now=Date.now();
  const future=s.tasks.filter(t=>!t.userSwipedAt&&t.state!=='OFFICIAL_CONFIRMED'&&t.state!=='EXPIRED').map(t=>Date.parse(t.preparationAt)).filter(t=>t>now);
  if(future.length)await chrome.alarms.create('dlmu-product-reminder',{when:Math.min(...future)});
}
const reminders=new NotificationManager(repository,plan=>new Promise<void>((resolve,reject)=>chrome.notifications.create(plan.id,{type:'basic',iconUrl:'icons/icon128.png',title:plan.title,message:plan.message},()=>{const error=chrome.runtime.lastError;if(error)reject(Error(error.message));else resolve()})));
async function remind(){if(chrome.notifications)await reminders.check();await reschedule()}
export function installProductController(){
  chrome.runtime.onMessage.addListener((m,s,reply)=>{
    if(!m?.type?.startsWith('PRODUCT_')||m.type==='PRODUCT_UPDATED')return;
    if(m.type==='PRODUCT_IMPORT_OFFICIAL'&&!officialSender(s)){reply({ok:false,error:'只接受官方个人预约页顶层内容脚本的数据'});return}
    if(m.type!=='PRODUCT_IMPORT_OFFICIAL'&&!panelSender(s)){reply({ok:false,error:'只接受本扩展侧边栏操作'});return}
    void serialize(async()=>{
      switch(m.type){
        case 'PRODUCT_GET':return {ok:true,data:await repository.state()};
        case 'PRODUCT_EXPORT':return {ok:true,backup:await repository.exportBackup()};
        case 'PRODUCT_IMPORT_OFFICIAL':await repository.observeOfficial(m.rows as OfficialReservation[]);break;
        case 'PRODUCT_OBSERVE':{
          const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
          if(!tab?.id||!tab.url)throw Error('请先打开官方个人预约页面');
          const url=new URL(tab.url);
          if(['id.dlmu.edu.cn','atrust.dlmu.edu.cn'].includes(url.hostname)){await repository.setAuth('LOGIN_REQUIRED');throw Error('请在学校网页人工完成登录，任务已保留')}
          if(url.origin!=='https://seats.dlmu.edu.cn'||url.hash.split('?')[0]!=='#/ic/userinfo')throw Error('请在官方个人中心打开个人预约列表');
          const response=await chrome.tabs.sendMessage(tab.id,{type:'READ_MY_RESERVATIONS'});
          if(!response?.ok)throw Error(response?.error??'官方个人预约页尚未就绪');
          await repository.observeOfficial(response.rows);break;
        }
        case 'PRODUCT_USER_SWIPED':await repository.reportSwiped(m.id);break;
        case 'PRODUCT_SETTINGS':await repository.settings({reminderMinutes:m.settings?.reminderMinutes,pwaUrl:m.settings?.pwaUrl});break;
        case 'PRODUCT_IMPORT_TRANSFER':await repository.importTransfer(m.transfer);break;
        case 'PRODUCT_RESTORE_BACKUP':await repository.restoreBackup(m.backup);break;
        default:throw Error('未知产品操作');
      }
      await remind();notify();return {ok:true,data:await repository.state()};
    }).then(reply,e=>reply({ok:false,error:e instanceof Error?e.message:'本地操作失败'}));return true;
  });
  chrome.alarms.onAlarm.addListener(a=>{if(a.name==='dlmu-product-reminder')void serialize(remind)});
  chrome.tabs.onUpdated.addListener((_id,change)=>{
    if(!change.url)return;try{const u=new URL(change.url);if(['id.dlmu.edu.cn','atrust.dlmu.edu.cn'].includes(u.hostname))void serialize(async()=>{await repository.setAuth('LOGIN_REQUIRED');notify();await remind()})}catch{}
  });
  chrome.runtime.onStartup.addListener(()=>{void serialize(async()=>{await repository.setAuth('UNKNOWN');await remind();notify()})});
  void serialize(async()=>{await repository.setAuth('UNKNOWN');await remind()});
}
