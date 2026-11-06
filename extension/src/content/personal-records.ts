/** Strict, read-only extraction of the currently visible official personal table. */
export interface OfficialReservation {id:string;date:string;floorName:string;roomName:string;seatCode:string;startAt:string;endAt:string;displayStatus:string;source:'OFFICIAL_VISIBLE_DOM';observedAt:string;officialConfirmed:boolean;cancelled:boolean}
export interface PersonalParseResult {rows:OfficialReservation[];issues:string[];route:string;observedAt:string}
const REQUIRED=['预约编号','预约对象','预约时间','状态'];
export function explicitOfficialConfirmation(text:string){return new Set(['已签到','签到成功','使用中（已签到）']).has(text.trim().replace(/\s+/g,' '))}
export function parsePersonalCells(cells:string[],indexes:Record<string,number>,observedAt:string):OfficialReservation|null {
 const get=(name:string)=>(cells[indexes[name]]??'').replace(/\r/g,'').trim();const id=get('预约编号');if(!id||id.length>200||/(…|\.{3}$)/.test(id)||/\s/.test(id))return null;
 const match=get('预约对象').replace(/\s+/g,' ').match(/^(.+?楼)\s*(.*?)\s*([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)$/);if(!match||!match[2].trim())return null;
 const times=get('预约时间').match(/\d{4}-\d{2}-\d{2}[ T]+\d{2}:\d{2}(?::\d{2})?/g);if(!times||times.length!==2)return null;
 const iso=(time:string)=>{const value=time.replace(/[ T]+/,'T');return value+(value.length===16?':00':'')+'+08:00'};const startAt=iso(times[0]),endAt=iso(times[1]);if(!Number.isFinite(Date.parse(startAt))||!Number.isFinite(Date.parse(endAt))||Date.parse(endAt)<=Date.parse(startAt))return null;const roundtrip=(value:string)=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19)===value.slice(0,19);if(!roundtrip(startAt)||!roundtrip(endAt))return null;
 const displayStatus=get('状态').replace(/\s+/g,' ');if(!displayStatus||displayStatus.length>100||!Number.isFinite(Date.parse(observedAt)))return null;
 return {id,date:startAt.slice(0,10),floorName:match[1].trim(),roomName:match[2].trim(),seatCode:match[3],startAt,endAt,displayStatus,source:'OFFICIAL_VISIBLE_DOM',observedAt,officialConfirmed:explicitOfficialConfirmation(displayStatus),cancelled:new Set(['已取消','预约已取消','取消成功']).has(displayStatus)};
}
function cellText(e:Element){return ((e as HTMLElement).innerText||e.textContent||'').trim()}
function isVisible(e:Element){if(e.closest('[hidden],[aria-hidden="true"]'))return false;const v=e.ownerDocument.defaultView;if(v){let current:Element|null=e;while(current){const s=v.getComputedStyle(current);if(s.display==='none'||s.visibility==='hidden')return false;current=current.parentElement}}return true}
export function parsePersonalRecords(doc:Document,route:string,observedAt=new Date().toISOString()):PersonalParseResult {
 if(route.split('?')[0]!=='#/ic/userinfo')throw Error('请在官方个人中心打开个人预约列表');const issues:string[]=[],candidates:OfficialReservation[]=[];let recognized=false;
 for(const table of Array.from(doc.querySelectorAll('table'))){if(!isVisible(table)||table.closest('.el-table__fixed,.el-table__fixed-right'))continue;const labels=Array.from(table.querySelectorAll('thead th')).map(cellText);if(!REQUIRED.every(n=>labels.includes(n)))continue;recognized=true;const indexes=Object.fromEntries(REQUIRED.map(n=>[n,labels.indexOf(n)]));const scope=table.closest('.el-table')??table;
 for(const row of Array.from(scope.querySelectorAll('tbody tr'))){if(row.closest('.el-table__fixed,.el-table__fixed-right'))continue;const cells=Array.from(row.children).filter(e=>e.tagName==='TD');if(!cells.length||cells.some(e=>e.hasAttribute('colspan')))continue;const parsed=parsePersonalCells(cells.map(cellText),indexes,observedAt);if(parsed)candidates.push(parsed);else issues.push('一条预约缺少完整编号、区域或有效时间，未导入')}}
 if(!recognized)throw Error('预约表头未识别，停止读取');const groups=new Map<string,OfficialReservation[]>();for(const row of candidates)groups.set(row.id,[...(groups.get(row.id)??[]),row]);const rows:OfficialReservation[]=[];for(const values of groups.values()){const keys=new Set(values.map(({observedAt:_at,...r})=>JSON.stringify(r)));if(keys.size===1)rows.push(values[0]);else issues.push('同一编号出现冲突记录，UNKNOWN，未导入')}
 return {rows,issues:Array.from(new Set(issues)),route,observedAt};
}
