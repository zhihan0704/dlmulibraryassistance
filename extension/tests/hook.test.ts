/**
 * 被动旁路的真实行为测试。
 *
 * 做法：在导入前布置 window / location / XMLHttpRequest / fetch 替身，
 * 让 reserve-hook.ts 里的**实际补丁代码**跑起来，再模拟页面的请求与响应，
 * 断言它只对 /ic-web/reserve 生效、只读响应体、不触碰请求头。
 *
 * 本测试不访问网络，也不接触任何真实站点或凭据。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

type Listener = (event: unknown) => void;

const posted: Array<Record<string, unknown>> = [];
const windowListeners: Record<string, Listener[]> = {};
const fetchCalls: string[] = [];

class FakeXhr {
  responseType = '';
  responseText = '';
  withCredentials = false;
  requestHeaders: Record<string, string> = {};
  private listeners: Record<string, Listener[]> = {};
  __lsaUrl?: string;

  open(_method: string, url: string): void {
    this.__lsaUrl = url;
  }

  send(_body?: unknown): void {
    /* 页面自己的发送行为，测试不关心 */
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  fire(type: string): void {
    for (const cb of this.listeners[type] ?? []) cb.call(this, {type});
  }
}

const fakeWindow = {
  postMessage: (message: unknown) => {
    posted.push(message as Record<string, unknown>);
  },
  addEventListener: (type: string, cb: Listener) => {
    (windowListeners[type] ??= []).push(cb);
  },
  fetch: (input: unknown) => {
    fetchCalls.push(typeof input === 'string' ? input : String((input as Request)?.url ?? input));
    return Promise.resolve(new Response('{"code":0,"data":[{"devId":100456941,"devName":"1D-001"}]}'));
  },
};

// 必须发生在导入之前：hook 在模块求值时即安装补丁
(globalThis as unknown as {window: unknown}).window = fakeWindow;
(globalThis as unknown as {location: unknown}).location = {origin: 'https://seats.dlmu.edu.cn'};
(globalThis as unknown as {XMLHttpRequest: unknown}).XMLHttpRequest = FakeXhr;

await import('../src/content/reserve-hook');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('XHR：仅捕获 /ic-web/reserve，且只读响应体', async () => {
  posted.length = 0;

  const other = new FakeXhr();
  other.open('GET', '/ic-web/seatMenu?roomIds=100455855');
  other.send();
  other.responseText = '{"code":0,"data":[]}';
  other.fire('load');
  await tick();
  assert.equal(posted.length, 0, '非目标路径不得被捕获');

  const target = new FakeXhr();
  target.open('GET', '/ic-web/reserve?roomIds=100455855&resvDates=2026-11-02');
  target.send();
  target.responseText = '{"code":0,"data":[{"devId":100456941}]}';
  target.fire('load');
  await tick();

  assert.equal(posted.length, 1);
  const message = posted[0];
  assert.equal(message.channel, 'lsa:reserve-response');
  assert.equal(message.body, '{"code":0,"data":[{"devId":100456941}]}');
  assert.match(String(message.url), /\/ic-web\/reserve/);
  assert.ok(typeof message.at === 'string');
  // 不得携带任何请求侧信息
  assert.deepEqual(Object.keys(message).sort(), ['at', 'body', 'channel', 'url']);
  assert.equal(target.requestHeaders['Cookie'], undefined);
});

test('XHR：绝对地址与带 hash 的地址也能识别，其它域外路径不处理', async () => {
  posted.length = 0;

  const abs = new FakeXhr();
  abs.open('GET', 'https://seats.dlmu.edu.cn/ic-web/reserve?x=1#frag');
  abs.send();
  abs.responseText = '{"code":0,"data":[]}';
  abs.fire('load');
  await tick();
  assert.equal(posted.length, 1);

  const notTarget = new FakeXhr();
  notTarget.open('GET', '/ic-web/reserveExtra?x=1');
  notTarget.send();
  notTarget.responseText = '{"code":0,"data":[]}';
  notTarget.fire('load');
  await tick();
  assert.equal(posted.length, 1, 'reserveExtra 不得被误判为目标路径');
});

test('XHR：responseType 非文本时不读取，避免拿到不可用内容', async () => {
  posted.length = 0;
  const binary = new FakeXhr();
  binary.responseType = 'blob';
  binary.open('GET', '/ic-web/reserve');
  binary.send();
  binary.fire('load');
  await tick();
  assert.equal(posted.length, 0);
});

test('fetch：兜底通道同样只对目标路径生效', async () => {
  posted.length = 0;

  await fakeWindow.fetch('/ic-web/seatMenu');
  await tick();
  assert.equal(posted.length, 0);

  await fakeWindow.fetch('/ic-web/reserve?roomIds=100455855');
  await tick();
  await tick();
  assert.ok(posted.length >= 1);
  assert.equal(posted[0].channel, 'lsa:reserve-response');
  assert.match(String(posted[0].body), /devId/);
  assert.ok(fetchCalls.length >= 2);
});

test('缓冲：content script 就绪后索取可重放早期响应', async () => {
  const before = posted.length;
  const wantHandler = (windowListeners.message ?? []).find((cb) => typeof cb === 'function');
  assert.ok(wantHandler, 'hook 应注册 message 监听以响应缓冲索取');

  wantHandler({source: fakeWindow, origin:'https://seats.dlmu.edu.cn', data: {channel: 'lsa:want-buffer'}});
  await tick();
  assert.ok(posted.length > before, '索取后应重放已缓冲的响应');

  // 非同源/非本窗口的消息必须被忽略
  const after = posted.length;
  wantHandler({source: {}, data: {channel: 'lsa:want-buffer'}});
  await tick();
  assert.equal(posted.length, after);
});


test('XHR security: cross-origin, prefixed path and POST are not observed', async()=>{
 posted.length=0;
 for(const [method,url] of [['GET','https://other.example/ic-web/reserve'],['GET','/prefix/ic-web/reserve'],['POST','/ic-web/reserve']]){const x=new FakeXhr();x.open(method,url);x.send();x.responseText='{"code":0,"data":[{"devId":1}]}';x.fire('load')}
 await tick();assert.equal(posted.length,0);
});

test('XHR security: credentials and identities removed before MAIN bridge, URL query removed', async()=>{
 posted.length=0;const x=new FakeXhr();x.open('GET','/ic-web/reserve?token=do-not-forward');x.send();x.responseText=JSON.stringify({code:0,token:'secret',data:[{devId:1,devName:'1D-001',roomId:100455855,devStatus:0,openState:1,token:'secret',trueName:'private',resvInfo:[{startTime:'2026-11-05 09:00:00',endTime:'2026-11-05 10:00:00',resvStatus:1027,trueName:'private',logonName:'private',token:'secret'}]}]});x.fire('load');await tick();assert.equal(posted.length,1);assert.equal(posted[0].url,'/ic-web/reserve');const body=String(posted[0].body);for(const k of ['secret','private','trueName','logonName','token'])assert.equal(body.includes(k),false);assert.ok(body.includes('resvStatus'));
});

test('fetch security: POST and cross-origin normal page calls pass through without capture', async()=>{
 posted.length=0;await (fakeWindow.fetch as unknown as (input:string,init?:RequestInit)=>Promise<Response>)('/ic-web/reserve',{method:'POST'});await fakeWindow.fetch('https://other.example/ic-web/reserve');await tick();await tick();assert.equal(posted.length,0);
});
