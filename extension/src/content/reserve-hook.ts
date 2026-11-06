/**
 * 被动旁路（MAIN world）
 *
 * 目的：读取图书馆网页**自己**发出的 GET /ic-web/reserve 响应。
 *
 * 严格边界（与项目安全要求一致）：
 *  - 只**读**页面已收到响应的正文；不修改请求、不修改响应、不阻断页面逻辑。
 *  - 不发起任何请求（无 fetch、无 XHR），因此不需要放宽 CSP connect-src。
 *  - 不读取、不缓存、不转发任何请求头 / Cookie / Token / 凭据。
 *  - 不处理该路径以外的响应。
 *
 * 该文件以 IIFE 形式注入，运行在页面自身的 JS 上下文中，
 * 通过 window.postMessage 交给 ISOLATED world 的 content script。
 */

const TARGET_PATH = '/ic-web/reserve';
/** 响应正文上限（字符）。reserve 实测约 310KB，留足余量后拒绝异常大包。 */
const MAX_BODY = 4 * 1024 * 1024;
const CHANNEL = 'lsa:reserve-response';
const WANT_CHANNEL = 'lsa:want-buffer';
/**
 * 缓冲最近几次响应：content script 在 document_idle 才就绪，
 * 在此之前到达的响应若只 postMessage 会丢失，故保留少量副本供其索取。
 */
const BUFFER_MAX = 3;

interface ReserveEntry {
  url: string;
  body: string;
  at: string;
}

const buffer: ReserveEntry[] = [];

function isTargetUrl(url: string): boolean {
  try {const parsed=new URL(url,location.origin);return parsed.origin===location.origin&&parsed.pathname===TARGET_PATH&&!parsed.username&&!parsed.password} catch{return false}
}
/** Only allowlisted non-personal fields cross the MAIN/ISOLATED world boundary. */
function sanitizeBody(body:string):string|null {
 try {
  const raw:unknown=JSON.parse(body);
  const scalar=(v:unknown)=>v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v));
  const seat=(value:unknown):unknown=>{
   if(!value||typeof value!=='object'||Array.isArray(value))return null;
   const row=value as Record<string,unknown>,out:Record<string,unknown>={};
   for(const k of ['devId','devName','roomId','roomName','coordinate','devStatus','openState','openStart','openEnd','onlyView'])if(Object.hasOwn(row,k)&&scalar(row[k]))out[k]=row[k];
   if(Array.isArray(row.resvInfo))out.resvInfo=row.resvInfo.slice(0,1000).filter(r=>r&&typeof r==='object'&&!Array.isArray(r)).map(r=>{const o:Record<string,unknown>={};for(const k of ['startTime','endTime','resvStatus'])if(Object.hasOwn(r,k)&&scalar(r[k]))o[k]=r[k];return o});
   return out;
  };
  const rows=(x:unknown)=>Array.isArray(x)&&x.length<=2000?x.map(seat).filter(Boolean):null;
  if(Array.isArray(raw)){const result=rows(raw);return result?JSON.stringify(result):null}
  if(!raw||typeof raw!=='object')return null;
  const root=raw as Record<string,unknown>;let data:unknown=rows(root.data);
  if(!data&&root.data&&typeof root.data==='object'&&!Array.isArray(root.data)){const nested=root.data as Record<string,unknown>;const list=rows(nested.data);if(list)data={data:list}}
  if(!data)return null;
  const out:Record<string,unknown>={};if(scalar(root.code)&&Object.hasOwn(root,'code'))out.code=root.code;out.data=data;
  return JSON.stringify(out);
 }catch{return null}
}

function emit(entry: ReserveEntry): void {
  try {
    window.postMessage({channel: CHANNEL, ...entry}, location.origin);
  } catch {
    /* 通道不可用不应影响页面 */
  }
}

function record(url: string, body: string, at: string): void {
  if (!body || body.length > MAX_BODY) return;
  const safe=sanitizeBody(body);if(!safe)return;
  const entry: ReserveEntry = {url: TARGET_PATH, body:safe, at};
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  emit(entry);
}

// content script 就绪后会来索取缓冲，避免早期响应丢失
try {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as {channel?: string} | null;
    if (!data || data.channel !== WANT_CHANNEL) return;
    for (const entry of buffer) if(Date.now()-Date.parse(entry.at)<30000)emit(entry);
  });
} catch {
  /* ignore */
}

function patchXhr(): void {
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const requests=new WeakMap<XMLHttpRequest,{url:string;method:string}>();

  proto.open = function (this: XMLHttpRequest & {__lsaUrl?: string}, _method: string, url: string | URL) {
    try {
      this.__lsaUrl = typeof url === 'string' ? url : String(url);
      requests.set(this,{url:this.__lsaUrl,method:_method.toUpperCase()});
    } catch {
      /* ignore */
    }
    return originalOpen.apply(this, arguments as never);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest & {__lsaUrl?: string}) {
    const request=requests.get(this);
    const url = request?.url ?? '';
    if (request?.method==='GET'&&isTargetUrl(url)) {
      this.addEventListener('load', () => {
        try {
          if(typeof this.status==='number'&&(this.status<200||this.status>=300))return;
          const type = this.responseType;
          if (type === '' || type === 'text') {
            const text = this.responseText;
            if (typeof text === 'string' && text.length > 0) {
              record(url, text, new Date().toISOString());
            }
          }
        } catch {
          /* 读取失败不抛给页面 */
        }
      });
    }
    return originalSend.apply(this, arguments as never);
  } as typeof proto.send;
}

function patchFetch(): void {
  if (typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch;

  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const result = originalFetch.apply(this, arguments as never);
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : ((input as Request)?.url ?? '');
      const method=(init?.method??(typeof input==='object'&&'method' in input?(input as Request).method:'GET')).toUpperCase();
      if (method==='GET'&&isTargetUrl(url)) {
        result
          .then((response) => {
            if(!response.ok)return;
            try {
              response
                .clone()
                .text()
                .then((text) => record(url, text, new Date().toISOString()))
                .catch(() => {});
            } catch {
              /* ignore */
            }
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
    return result;
  } as typeof window.fetch;
}

try {
  patchXhr();
  patchFetch();
} catch {
  /* 注入失败时保持沉默，页面功能不受影响 */
}

// 显式声明为模块：便于类型检查与测试以 import 方式加载本文件；
// 打包为 IIFE 后该导出为空对象，不影响注入行为。
export {};
