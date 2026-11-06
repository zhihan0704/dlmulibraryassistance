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
const officialOrigin = 'https://seats.dlmu.edu.cn';
const seatRoute = '#/ic/seatPredetermine/100455855';
const fakeLocation = {origin: officialOrigin, hash: seatRoute};
const reserveUrl = officialOrigin + '/ic-web/reserve';

class FakeXhr {
  responseType = '';
  responseText = '';
  responseURL = '';
  status = 200;
  withCredentials = false;
  requestHeaders: Record<string, string> = {};
  nativeOpenArguments: unknown[] = [];
  nativeSendBody: unknown;
  nativeSendError?: Error;
  private listeners: Record<string, {listener: Listener; once: boolean}[]> = {};

  open(_method: string, url: string): void {
    this.nativeOpenArguments = Array.from(arguments);
    this.responseURL = new URL(url, officialOrigin).href;
    this.status = 200;
    this.responseText = '';
  }

  send(body?: unknown): void {
    this.nativeSendBody = body;
    if (this.nativeSendError) throw this.nativeSendError;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  addEventListener(type: string, listener: Listener, options?: {once?: boolean}): void {
    (this.listeners[type] ??= []).push({listener, once: options?.once === true});
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter(entry => entry.listener !== listener);
  }

  fire(type: string): void {
    for (const {listener, once} of [...(this.listeners[type] ?? [])]) {
      if (once) this.removeEventListener(type, listener);
      listener.call(this, {type, isTrusted: true});
    }
  }
}

function syntheticResponse(url: string, body: BodyInit, status = 200, headers?: HeadersInit): Response {
  const response = new Response(body, {status, headers});
  Object.defineProperty(response, 'url', {value: url});
  return response;
}

const responseBody = '{"code":0,"data":[{"devId":100456941,"devName":"1D-001"}]}';
let fetchOverride: Response | null = null;
let originalPromise: Promise<Response>;
let originalReceiver: unknown;
let originalInit: RequestInit | undefined;
const fakeWindow = {
  postMessage: (message: unknown) => {
    posted.push(message as Record<string, unknown>);
  },
  addEventListener: (type: string, cb: Listener) => {
    (windowListeners[type] ??= []).push(cb);
  },
  fetch: function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    originalReceiver = this;
    originalInit = init;
    // A native fetch evaluates the input dictionary. The wrapper must not rerun an accessor.
    void init?.method;
    const response = fetchOverride ?? syntheticResponse(new URL(url, officialOrigin).href, responseBody);
    fetchOverride = null;
    originalPromise = Promise.resolve(response);
    return originalPromise;
  },
};

// 必须发生在导入之前：hook 在模块求值时即安装补丁
(globalThis as unknown as {window: unknown}).window = fakeWindow;
(globalThis as unknown as {location: unknown}).location = fakeLocation;
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
  assert.deepEqual(Object.keys(message).sort(), ['at', 'body', 'captureId', 'channel', 'route', 'transport', 'url']);
  assert.equal(message.route, seatRoute);
  assert.equal(message.transport, 'XHR');
  assert.ok(Number.isSafeInteger(message.captureId));
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
  const replay = posted.slice(before);
  const ready = replay.filter(message => message.channel === 'lsa:reserve-observer-ready');
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0].transports, ['XHR', 'FETCH']);
  assert.ok(replay.some(message => message.captureId === posted[0].captureId), '缓冲重放保留原捕获 ID');

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

test('XHR preserves native arguments, body, errors and reusable request state', async () => {
  posted.length = 0;
  const xhr = new FakeXhr();
  xhr.open('GET', '/ic-web/reserve');
  const input = {body: 'original'};
  xhr.send(input);
  assert.deepEqual(xhr.nativeOpenArguments, ['GET', '/ic-web/reserve']);
  assert.equal(xhr.nativeSendBody, input);
  // Opening another request discards the old callback even if it never loaded.
  xhr.open('POST', '/ic-web/reserve');
  xhr.send(input);
  xhr.responseText = responseBody;
  xhr.fire('load');
  assert.equal(posted.length, 0);

  xhr.open('GET', '/ic-web/reserve');
  const failure = new Error('original native exception');
  xhr.nativeSendError = failure;
  assert.throws(() => xhr.send(input), error => error === failure);
  xhr.nativeSendError = undefined;
  xhr.send(input);
  xhr.responseText = responseBody;
  xhr.fire('load');
  xhr.fire('load');
  assert.equal(posted.length, 1);
});

test('fetch returns the same promise and leaves the original body and caller arguments intact', async () => {
  posted.length = 0;
  const init = {method: 'GET', headers: {Accept: 'application/json'}};
  const receiver = {name: 'page'};
  const promise = fakeWindow.fetch.call(receiver, reserveUrl, init);
  assert.equal(promise, originalPromise);
  assert.equal(originalReceiver, receiver);
  assert.equal(originalInit, init);
  assert.equal(await (await promise).text(), responseBody);
  await tick();
  assert.equal(posted[0]?.transport, 'FETCH');
  assert.equal(posted[0]?.body, responseBody);
});

test('fetch skips accessor options rather than evaluating method twice', async () => {
  posted.length = 0;
  let getterCalls = 0;
  const init = {get method() { getterCalls += 1; return 'GET'; }};
  assert.equal(await (await fakeWindow.fetch(reserveUrl, init)).text(), responseBody);
  await tick();
  assert.equal(getterCalls, 1);
  assert.equal(posted.length, 0);
});

test('redirected responses outside the exact path and HTTP 429 are ignored', async () => {
  posted.length = 0;
  for (const url of [officialOrigin + '/sso/login', 'https://other.example/ic-web/reserve']) {
    fetchOverride = syntheticResponse(url, responseBody);
    await fakeWindow.fetch(reserveUrl);
    const xhr = new FakeXhr();
    xhr.open('GET', reserveUrl);
    xhr.send();
    xhr.responseURL = url;
    xhr.responseText = responseBody;
    xhr.fire('load');
  }
  fetchOverride = syntheticResponse(reserveUrl, 'RATE_LIMIT_TEST_SENTINEL', 429);
  await fakeWindow.fetch(reserveUrl);
  await tick();
  assert.equal(posted.length, 0);
});

test('exact same-origin 401/403 messages expose status only and preserve page response', async () => {
  posted.length = 0;
  const secret = 'TEST_ONLY_PRIVATE_AUTH_RESPONSE';
  fetchOverride = syntheticResponse(reserveUrl, secret, 401);
  assert.equal(await (await fakeWindow.fetch(reserveUrl)).text(), secret);
  await tick();
  const xhr = new FakeXhr();
  xhr.open('GET', reserveUrl);
  xhr.send();
  xhr.status = 403;
  xhr.responseText = secret;
  xhr.fire('load');
  assert.deepEqual(posted.map(message => message.httpStatus), [401, 403]);
  assert.ok(posted.every(message => !Object.hasOwn(message, 'body')));
  assert.ok(!JSON.stringify(posted).includes(secret));
  assert.ok(Number(posted[0].captureId) < Number(posted[1].captureId));
});

test('invalid and oversized response bodies produce bounded status-only messages', async () => {
  posted.length = 0;
  fetchOverride = syntheticResponse(reserveUrl, 'TEST_ONLY_NON_JSON_PRIVATE_BODY');
  await fakeWindow.fetch(reserveUrl);
  await tick();
  fetchOverride = syntheticResponse(reserveUrl, responseBody, 200, {'Content-Length': String(5 * 1024 * 1024)});
  await fakeWindow.fetch(reserveUrl);
  await tick();
  assert.deepEqual(posted.map(message => message.observationError), ['INVALID_RESPONSE', 'BODY_TOO_LARGE']);
  assert.ok(posted.every(message => !Object.hasOwn(message, 'body')));
});

test('decoded fetch stream is capped without truncating the page body', async () => {
  posted.length = 0;
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  fetchOverride = syntheticResponse(reserveUrl, stream);
  const response = await fakeWindow.fetch(reserveUrl);
  assert.equal((await response.arrayBuffer()).byteLength, bytes.byteLength);
  await tick();
  assert.equal(posted[0]?.observationError, 'BODY_TOO_LARGE');
  assert.ok(!Object.hasOwn(posted[0], 'body'));
});

test('late body decoding cannot supersede a newer response arrival', async () => {
  posted.length = 0;
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { writer = controller; },
  });
  fetchOverride = syntheticResponse(reserveUrl, stream);
  const first = await fakeWindow.fetch(reserveUrl);
  await fakeWindow.fetch(reserveUrl);
  await tick();
  assert.equal(posted.length, 1);
  writer.enqueue(new TextEncoder().encode(responseBody));
  writer.close();
  assert.equal(await first.text(), responseBody);
  await tick();
  assert.equal(posted.length, 1);
});

function navigate(hash: string): void {
  fakeLocation.hash = hash;
  for (const listener of windowListeners.hashchange ?? []) listener({newURL: officialOrigin + '/' + hash});
}

test('responses cannot cross a prior route or return-to-same-route boundary', async () => {
  posted.length = 0;
  navigate(seatRoute + '?TEST_ONLY_QUERY=omitted');
  const xhr = new FakeXhr();
  xhr.open('GET', reserveUrl);
  xhr.send();
  navigate('#/ic/seatPredetermine/100455856');
  navigate(seatRoute);
  xhr.responseText = responseBody;
  xhr.fire('load');
  assert.equal(posted.length, 0);

  navigate(seatRoute + '?TEST_ONLY_QUERY=omitted');
  const current = new FakeXhr();
  current.open('GET', reserveUrl);
  current.send();
  current.responseText = responseBody;
  current.fire('load');
  assert.equal(posted[0]?.route, seatRoute);
  assert.ok(!JSON.stringify(posted).includes('TEST_ONLY_QUERY'));
  navigate(seatRoute);
});
