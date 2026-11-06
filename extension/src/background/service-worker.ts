import {installProductController} from './product-controller';
import {installDailyBookingController} from './daily-booking-controller';
import {getRecovery,resetAfterStartup} from './recovery-storage';
import {manage} from './task-manager';
let queue:Promise<unknown>=Promise.resolve();const serial=(m:any)=>{const result=queue.then(()=>manage(m));queue=result.catch(()=>{});return result};
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(console.error);
chrome.runtime.onMessage.addListener((m,s,reply)=>{if(s.id!==chrome.runtime.id)return;if(!['LIST','CREATE','ACTION'].includes(m?.type))return;serial(m).then(tasks=>reply({ok:true,tasks}),e=>reply({ok:false,error:e.message}));return true});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='lsa-wake')void serial({type:'WAKE'})});chrome.runtime.onStartup.addListener(()=>{void serial({type:'WAKE'})});chrome.runtime.onInstalled.addListener(()=>{void serial({type:'WAKE'})});void serial({type:'WAKE'});

chrome.runtime.onStartup.addListener(()=>{void resetAfterStartup()});
chrome.runtime.onMessage.addListener((m,s,reply)=>{if(s.id!==chrome.runtime.id||m?.type!=='RECOVERY_STATUS')return;getRecovery().then(task=>reply({ok:true,task}),()=>reply({ok:false}));return true});

installProductController();
installDailyBookingController();
