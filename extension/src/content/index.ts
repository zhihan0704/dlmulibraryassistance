import {DlmuAdapter} from '../adapters/dlmu-adapter';
import {relevantMutation} from '../core/event-monitor';
import {summarizeSnapshot, type LiveSnapshot} from '../core/live-seats';
import {domSeatKey, fingerprintDom, fingerprintNetwork, networkSeatKey, SeatObservationMonitor} from '../core/seat-observation';
import {LIVE_CHANNEL, LIVE_MAX_AGE_MS, READY_CHANNEL, WANT_CHANNEL, type DomSummary, type LiveReply} from '../shared/live-monitor';
import {readSeats} from './seat-reader';

const initialPage = DlmuAdapter.identifyPage(location.href);
if (initialPage.kind !== 'OTHER' && initialPage.kind !== 'SSO') observePage();

function observePage(): void {
  const network = new SeatObservationMonitor({maxAgeMs: LIVE_MAX_AGE_MS, maxObservations: 10_000});
  const dom = new SeatObservationMonitor({maxAgeMs: LIVE_MAX_AGE_MS, maxObservations: 10_000});
  const capturedBy = {XHR: 0, FETCH: 0};
  const recentIds = new Set<number>();
  let highestId = 0;
  let transports: LiveReply['transports'] = [];
  let live: LiveSnapshot | null = null;
  let lastDom: DomSummary | null = null;
  let liveError: string | null = null;
  let networkError: LiveReply['networkError'] = navigator.onLine === false ? 'OFFLINE' : null;
  let domError: string | null = null;
  let lastCapturedAt: string | null = null;
  let page = initialPage;
  let active = true;
  let session: LiveReply['session'] = 'UNKNOWN';
  let recoveryCutoff = 0;
  let sessionReady = false;
  let sessionCheck = 0;
  let personalKey = '';
  let debounce: number | undefined;
  let domRunning = false;
  let staleTimer: number | undefined;

  function notify() {
    void chrome.runtime.sendMessage({type: 'LIVE_UPDATE'}).catch(() => {});
  }

  function reportObservation(eventType: 'DATA_CAPTURED' | 'PARSER_ERROR' | 'NETWORK_ERROR' | 'DATA_STALE',
    source: 'NETWORK' | 'DOM', at: string, seatCount?: number, changes: unknown[] = []) {
    if (page.kind !== 'SEATS') return;
    void chrome.runtime.sendMessage({type: 'ASSISTANT_OBSERVATION', eventType, source, route: page.route,
      at, seatCount, changes: changes.slice(0, 2000)}).catch(() => {});
  }

  function resetData() {
    window.clearTimeout(staleTimer);
    live = null;
    lastDom = null;
    lastCapturedAt = null;
    liveError = null;
    networkError = navigator.onLine === false ? 'OFFLINE' : null;
    domError = null;
    network.reset();
    dom.reset();
    if (session === 'SESSION_LOST') {
      network.invalidate('SESSION_LOST');
      dom.invalidate('SESSION_LOST');
    }
  }

  function syncRoute() {
    const current = DlmuAdapter.identifyPage(location.href);
    if (current.kind === page.kind && current.route === page.route) return;
    page = current;
    personalKey = '';
    resetData();
    connectObserver();
    scheduleRead();
    notify();
  }

  function setSession(value: LiveReply['session']) {
    if (session === value) return;
    const resumed = session === 'SESSION_LOST';
    session = value;
    if (value === 'SESSION_LOST') {
      window.clearTimeout(staleTimer);
      network.invalidate('SESSION_LOST');
      dom.invalidate('SESSION_LOST');
    } else if (resumed) {
      resetData();
      scheduleRead();
    }
    connectObserver();
    notify();
  }

  async function checkSession() {
    const check = ++sessionCheck;
    const reply = await chrome.runtime.sendMessage({type: 'DAILY_SESSION_STATUS'}).catch(() => null);
    if (check !== sessionCheck || !reply?.ok) return;
    recoveryCutoff = Number.isSafeInteger(reply.verifiedAt) ? reply.verifiedAt : 0;
    setSession(reply.lost ? 'SESSION_LOST' : reply.verified ? 'REVERIFIED' : 'UNKNOWN');
  }

  function captureError(message: string, error: LiveReply['networkError'] = null) {
    const changed = liveError !== message || networkError !== error;
    liveError = message;
    networkError = error;
    network.invalidate('UNKNOWN', message);
    if (changed) reportObservation(error ? 'NETWORK_ERROR' : 'PARSER_ERROR', 'NETWORK', new Date().toISOString());
    notify();
  }

  window.addEventListener('message', event => {
    if (!active || event.source !== window || event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.channel === READY_CHANNEL && Array.isArray(data.transports)) {
      const next = Array.from(new Set<'XHR' | 'FETCH'>(data.transports.filter((item: unknown) => item === 'XHR' || item === 'FETCH')));
      if (next.join() !== transports.join()) { transports = next; notify(); }
      return;
    }
    if (data.channel !== LIVE_CHANNEL || !sessionReady || data.url !== '/ic-web/reserve') return;
    syncRoute();
    if (page.kind !== 'SEATS' || data.route !== page.route ||
        !Number.isSafeInteger(data.captureId) || data.captureId < 1 ||
        (data.transport !== 'XHR' && data.transport !== 'FETCH') || typeof data.at !== 'string') return;
    const at = Date.parse(data.at);
    if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > LIVE_MAX_AGE_MS ||
        recentIds.has(data.captureId) || data.captureId <= highestId - 128) return;
    highestId = Math.max(highestId, data.captureId);
    recentIds.add(data.captureId);
    for (const id of recentIds) if (id <= highestId - 128) recentIds.delete(id);
    capturedBy[data.transport as 'XHR' | 'FETCH'] += 1;
    if (lastCapturedAt && at < Date.parse(lastCapturedAt)) { notify(); return; }
    lastCapturedAt = data.at;

    if (data.httpStatus === 401) {
      ++sessionCheck;
      setSession('SESSION_LOST');
      void chrome.runtime.sendMessage({type: 'DAILY_SESSION_LOST'}).catch(() => {});
      return;
    }
    if (session === 'SESSION_LOST' || navigator.onLine === false || at < recoveryCutoff) { notify(); return; }
    if (data.httpStatus === 403) { captureError('学校页面返回访问受限（403），当前数据待核验', 'ACCESS_RESTRICTED'); return; }
    if (data.observationError || typeof data.body !== 'string' || data.body.length > 4 * 1024 * 1024) {
      captureError('响应无法解析或超过大小限制');
      return;
    }
    try {
      const next = DlmuAdapter.parseSeatResponse(data.body, data.at, page);
      const observed = network.observe(fingerprintNetwork(next));
      if (observed.accepted) {
        live = next;
        liveError = null;
        networkError = null;
        reportObservation('DATA_CAPTURED', 'NETWORK', next.capturedAt, next.seats.length, observed.changes);
        window.clearTimeout(staleTimer);
        staleTimer = window.setTimeout(() => {
          if (active && session !== 'SESSION_LOST' && network.status(Date.now()).state === 'STALE') {
            reportObservation('DATA_STALE', 'NETWORK', next.capturedAt);
            notify();
          }
        }, Math.max(1, at + LIVE_MAX_AGE_MS + 10 - Date.now()));
      }
      notify();
    } catch {
      captureError('座位响应结构或区域校验失败');
    }
  });

  function readDom() {
    if (session === 'SESSION_LOST') throw Error('请先在官方个人预约页重新核验');
    const {roomTitle, rows} = DlmuAdapter.readSeatPage(document, page);
    const at = new Date().toISOString();
    const classCounts: Record<string, number> = {};
    let withFreeIntervals = 0;
    const classTokens = new Set(['green', 'yellowGreen', 'yellow', 'gray', 'noopenlook', 'isCheckedSeat']);
    for (const row of rows) {
      const known = row.className.split(/\s+/).filter(token => classTokens.has(token));
      for (const token of known.length ? known : ['other']) classCounts[token] = (classCounts[token] ?? 0) + 1;
      if (row.title.includes('空闲时间：') && !/空闲时间：\s*无/.test(row.title)) withFreeIntervals++;
    }
    const wasInvalid = domError !== null;
    const observation = dom.observe(fingerprintDom(rows, at));
    if (observation.accepted) {
      lastDom = {at, route: page.route, roomTitle, count: rows.length, classCounts, withFreeIntervals};
      domError = null;
      if (observation.state !== 'UNCHANGED' || wasInvalid) reportObservation('DATA_CAPTURED', 'DOM', at, rows.length, observation.changes);
    }
    if (observation.state === 'BASELINE' || observation.state === 'CHANGED' || wasInvalid && observation.accepted) notify();
    return lastDom;
  }

  function readCurrentPage() {
    syncRoute();
    if (!active || document.hidden || !sessionReady) return;
    if (page.kind === 'PERSONAL') {
      try {
        const result = DlmuAdapter.readPersonal(document, page.route);
        const key = JSON.stringify(result.rows.map(({observedAt: _at, ...row}) => row));
        if (!result.rows.length || key === personalKey) return;
        personalKey = key;
        void chrome.runtime.sendMessage({type: 'PRODUCT_IMPORT_OFFICIAL', rows: result.rows}).catch(() => {});
      } catch { /* Wait for the normal table render. */ }
    }
    if (page.kind !== 'SEATS' || session === 'SESSION_LOST') return;
    try { readDom(); }
    catch {
      const error = '座位区域尚未就绪或页面结构异常';
      dom.invalidate('UNKNOWN', error);
      if (domError !== error) {
        domError = error;
        reportObservation('PARSER_ERROR', 'DOM', new Date().toISOString());
        notify();
      }
    }
  }

  function scheduleRead() {
    window.clearTimeout(debounce);
    if (active && !document.hidden) debounce = window.setTimeout(readCurrentPage, 250);
  }

  const observer = new MutationObserver(records => {
    const selector = page.kind === 'PERSONAL' ? '.el-table,table' : '.seat-area,.seat h3';
    if (relevantMutation(records, selector)) scheduleRead();
  });

  function connectObserver() {
    observer.disconnect();
    window.clearTimeout(debounce);
    domRunning = active && !document.hidden && (page.kind === 'PERSONAL' || page.kind === 'SEATS' && session !== 'SESSION_LOST');
    if (!domRunning) return;
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'title', 'style', 'hidden', 'aria-hidden']});
    scheduleRead();
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'DAILY_SESSION_UPDATED') { void checkSession(); return; }
    syncRoute();
    if (message?.type === 'GET_LIVE') {
      const now = Date.now();
      const selected = page.kind === 'SEATS' && String(message.roomId) === page.roomId &&
        Number.isSafeInteger(message.seatId) && typeof message.seatCode === 'string' && message.seatCode.length <= 32;
      const networkState = network.status(now), domState = dom.status(now);
      const response: LiveReply = {ok: true, route: page.route, live: live ? {snapshot: live, summary: summarizeSnapshot(live)} : null,
        liveError, networkError, domError, hookSeen: transports.length > 0, transports, capturedCount: capturedBy.XHR + capturedBy.FETCH,
        capturedBy, lastCapturedAt, session, domRunning: domRunning && page.kind === 'SEATS', dom: lastDom,
        eventMonitor: {network: networkState, dom: domState, events: networkState.eventCount + domState.eventCount},
        selected: {network: selected ? network.lastChangeFor(networkSeatKey(message.roomId, message.seatId, message.seatCode)) : null,
          dom: selected ? dom.lastChangeFor(domSeatKey(message.seatCode)) : null}};
      reply(response);
    }
    if (message?.type === 'READ_PAGE_SEATS') {
      try {
        const observed = readDom();
        if (!observed) throw Error('当前没有有效的页面观察');
        reply({ok: true, dom: observed, observedAt: observed.at, source: 'CURRENT_PAGE_DOM', note: '页面读取时刻，非服务器更新时间'});
      } catch { reply({ok: false, error: '座位页面未就绪或会话待恢复'}); }
    }
    if (message?.type === 'READ_DAILY_SEAT') {
      let seat = null;
      if (active && sessionReady && session !== 'SESSION_LOST' && !liveError && network.status(Date.now()).freshness === 'FRESH') {
        try {
          const {roomTitle, rows} = DlmuAdapter.readSeatPage(document, page);
          seat = DlmuAdapter.matchSeat(live, page.route, roomTitle, rows.map(row => row.name), message.roomName, message.seatCode, Date.now());
        } catch { /* Reject mismatched or changed page structures. */ }
      }
      reply({seat});
    }
    if (message?.type === 'READ_MY_RESERVATIONS') {
      try { reply({ok: true, ...DlmuAdapter.readPersonal(document, page.route)}); }
      catch { reply({ok: false, error: '个人预约页未就绪或结构异常'}); }
    }
    if (message?.type === 'PAGE_SNAPSHOT') {
      reply({target: true, room: page.kind === 'SEATS' ? page.roomId : 'UNKNOWN', login: session,
        seats: readSeats(), updatedAt: new Date().toISOString()});
    }
  });

  window.addEventListener('hashchange', syncRoute);
  window.addEventListener('popstate', syncRoute);
  document.addEventListener('visibilitychange', () => { syncRoute(); connectObserver(); notify(); });
  window.addEventListener('offline', () => {
    window.clearTimeout(staleTimer);
    captureError('当前浏览器处于离线状态', 'OFFLINE');
  });
  window.addEventListener('online', () => {
    resetData();
    scheduleRead();
    void checkSession();
    notify();
  });
  window.addEventListener('pagehide', () => {
    active = false;
    window.clearTimeout(staleTimer);
    network.stop();
    dom.stop();
    connectObserver();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    active = true;
    resetData();
    personalKey = '';
    void checkSession();
    syncRoute();
    connectObserver();
    notify();
  });
  void checkSession().finally(() => {
    sessionReady = true;
    window.postMessage({channel: WANT_CHANNEL}, location.origin);
    connectObserver();
  });
}
