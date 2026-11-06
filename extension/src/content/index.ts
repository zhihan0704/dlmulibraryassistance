import {parsePersonalRecords} from './personal-records';
import {EventMonitor, relevantMutation} from '../core/event-monitor';
import {parseVisibleSeats} from './page-seat-reader';
import {isTarget} from './page-detector';
import {readSeats} from './seat-reader';
import {detectLogin} from './login-detector';
import {normalizeReservePayload, summarizeSnapshot, type LiveSnapshot} from '../core/live-seats';
import {readDailySeat} from '../core/daily-observations';

const networkMonitor = new EventMonitor<{total:number;statuses:Record<string,number>}>(120000);
const domMonitor = new EventMonitor<{total:number;statuses:Record<string,number>}>(120000);
const LIVE_CHANNEL = 'lsa:reserve-response';
const WANT_CHANNEL = 'lsa:want-buffer';

/** 实时快照只存在内存中：不落盘、不入日志，避免座位/预约数据长期驻留。 */
let live: LiveSnapshot | null = null;
let liveError: string | null = null;
let hookSeen = false;
let capturedCount = 0;
/** 同一响应可能被「实时投递」与「缓冲重放」各送一次，按此键去重，避免计数虚高。 */
let lastKey: string | null = null;

interface DomSummary {
  at: string;
  route: string;
  roomTitle: string;
  count: number;
  classCounts: Record<string, number>;
  withFreeIntervals: number;
}
let lastDom: DomSummary | null = null;
/** 上次成功读取的「内容指纹」，用于判断页面变化是否真的改变了数据 */
let lastDomKey = '';

function domKey(d: DomSummary): string {
  return `${d.count}|${JSON.stringify(d.classCounts)}|${d.withFreeIntervals}`;
}

const STATUS_TOKENS = ['green', 'yellowGreen', 'yellow', 'gray', 'noopenlook', 'isCheckedSeat'];

/** 只统计已知状态类，未知类归入 other，避免把布局类当状态。 */
function countClasses(className: string): string[] {
  const tokens = className.split(/\s+/).filter(Boolean);
  const known = tokens.filter((t) => STATUS_TOKENS.includes(t));
  return known.length ? known : ['other'];
}

function notifyRuntime(): void {
  try {
    // 侧边栏可能未打开：此处的「无人接收」属正常情况，忽略即可
    void chrome.runtime.sendMessage({type: 'LIVE_UPDATE'}).catch(() => {});
  } catch {
    /* ignore */
  }
}

function acceptLive(rawBody: string, at: string, url: string): void {
  const key = `${at}|${url}`;
  if (key === lastKey) return;
  lastKey = key;
  hookSeen = true;
  capturedCount += 1;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    live = normalizeReservePayload(parsed, at, url);
    liveError = null;
    const summary=summarizeSnapshot(live); networkMonitor.accept({total:summary.total,statuses:{withResv:summary.withResv,withoutResv:summary.withoutResv}},'NETWORK',at);
  } catch (e) {
    // 保留上一次成功快照，避免界面在解析失败时显示空数据
    liveError = e instanceof Error ? e.message : '实时响应解析失败';
  }
  notifyRuntime();
}

function readDom(): DomSummary {
  const roomTitle = document.querySelector('.seat h3')?.textContent ?? '';
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('.seat-area .draggable'));
  const items = nodes.map((e) => ({
    name: e.querySelector('em')?.textContent?.trim() ?? '',
    left: e.style.left,
    top: e.style.top,
    className: e.className,
  }));
  // 解析器保持严格校验：路由、房间标题、152 个唯一编号
  parseVisibleSeats(location.hash, roomTitle, items);

  const classCounts: Record<string, number> = {};
  let withFreeIntervals = 0;
  for (const node of nodes) {
    for (const token of countClasses(node.className)) {
      classCounts[token] = (classCounts[token] ?? 0) + 1;
    }
    // title 形如 "1D-001\n空闲时间：\n21:30 - 21:40"；无空闲时不含「空闲时间：」
    const title = node.getAttribute('title') ?? '';
    if (title.includes('空闲时间：') && !/空闲时间：\s*无/.test(title)) withFreeIntervals += 1;
  }

  return {
    at: new Date().toISOString(),
    route: location.hash,
    roomTitle: roomTitle.trim(),
    count: nodes.length,
    classCounts,
    withFreeIntervals,
  };
}

if (isTarget(location.href)) {
  // 向 MAIN world 索取 hook 缓冲的早期响应，避免 document_start → document_idle 之间丢数据
  try {
    window.postMessage({channel: WANT_CHANNEL}, location.origin);
  } catch {
    /* ignore */
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data as {channel?: string; body?: unknown; at?: unknown; url?: unknown} | null;
    if (!data || data.channel !== LIVE_CHANNEL) return;
    if (typeof data.body !== 'string' || typeof data.at !== 'string') return;
    acceptLive(data.body, data.at, typeof data.url === 'string' ? data.url : '/ic-web/reserve');
  });

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m?.type === 'READ_DAILY_SEAT') {
      const title = document.querySelector('.seat h3')?.textContent ?? '';
      const codes = Array.from(document.querySelectorAll('.seat-area .draggable em'), node => node.textContent?.trim() ?? '');
      const seat = liveError ? null : readDailySeat(live, location.hash, title, codes, m.roomName, m.seatCode, Date.now());
      reply({seat});
      return;
    }
    if (m?.type === 'READ_MY_RESERVATIONS') {
      try { reply({ok:true,...parsePersonalRecords(document,location.hash)}); }
      catch(error){reply({ok:false,error:error instanceof Error?error.message:'预约读取失败'});}
      return;
    }
    if (m?.type === 'READ_PAGE_SEATS') {
      try {
        const dom = readDom();
        lastDom = dom;
        lastDomKey = domKey(dom);
        reply({ok: true, dom, observedAt: dom.at, source: 'CURRENT_PAGE_DOM', note: '页面读取时刻，非数据刷新时刻'});
      } catch (e) {
        reply({ok: false, error: e instanceof Error ? e.message : '页面数据不可用'});
      }
      return;
    }
    if (m?.type === 'GET_LIVE') {
      reply({
        ok: true,
        live: live ? {snapshot: live, summary: summarizeSnapshot(live)} : null,
        liveError,
        hookSeen,
        capturedCount,
        eventMonitor: {network:networkMonitor.status(Date.now(),isTarget(location.href)),dom:domMonitor.status(Date.now(),isTarget(location.href)),events:networkMonitor.timeline().length+domMonitor.timeline().length},
        dom: lastDom,
      });
      return;
    }
    if (m?.type === 'PAGE_SNAPSHOT') {
      reply({target: true, room: 'UNKNOWN', login: detectLogin(), seats: readSeats(), updatedAt: new Date().toISOString(), reason: '等待获取真实座位数据；页面结构和登录标识尚未核验'});
    }
  });

  // 该站是 SPA：座位是异步渲染的，侧边栏可能先于座位出现就绪。
  // 因此监听 DOM 与路由变化，在数据真正变化时主动通知侧边栏，避免用户手动刷新。
  let debounce: number | undefined;
  function safeRefreshDom(): void {
    try {
      const dom = readDom();
      const key = domKey(dom);
      domMonitor.accept({total:dom.count,statuses:dom.classCounts},'DOM',dom.at);
      lastDom = dom;
      if (key !== lastDomKey) {
        lastDomKey = key;
        notifyRuntime();
      }
    } catch {
      /* 座位还没渲染完、或不在目标路由：静默忽略，等下一次变化 */
    }
  }
  function scheduleRefresh(): void {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(safeRefreshDom, 600);
  }

  window.addEventListener('hashchange', scheduleRefresh);
  try {
    const seatObserver=new MutationObserver(records=>{if(relevantMutation(records))scheduleRefresh()});seatObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'title', 'style'],
    });
    window.addEventListener('pagehide',()=>{seatObserver.disconnect();window.clearTimeout(debounce)});window.addEventListener('pageshow',()=>{seatObserver.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','title','style']});scheduleRefresh()});
  } catch {
    /* 观察失败不影响主要功能 */
  }
}

if(isTarget(location.href)){
 let timer:number|undefined,key='',stopped=false;
 const publish=()=>{if(stopped||location.hash.split('?')[0]!=='#/ic/userinfo')return;try{const result=parsePersonalRecords(document,location.hash);const next=JSON.stringify(result.rows.map(({observedAt:_at,...r})=>r));if(next===key||!result.rows.length)return;key=next;void chrome.runtime.sendMessage({type:'PRODUCT_IMPORT_OFFICIAL',rows:result.rows}).catch(()=>{})}catch{/* wait for normal table rendering */}};
 const schedule=()=>{window.clearTimeout(timer);timer=window.setTimeout(publish,500)};
 const observer=new MutationObserver(records=>{if(records.some(r=>{const e=r.target instanceof Element?r.target:r.target.parentElement;return !!e?.closest('.el-table,table')||Array.from(r.addedNodes).some(n=>n instanceof Element&&(n.matches('table,.el-table')||!!n.querySelector('table,.el-table')))}))schedule()});
 observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});window.addEventListener('hashchange',schedule);window.addEventListener('pageshow',()=>{stopped=false;observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});schedule()});document.addEventListener('visibilitychange',schedule);window.addEventListener('pagehide',()=>{stopped=true;observer.disconnect();window.clearTimeout(timer)});publish();
}
