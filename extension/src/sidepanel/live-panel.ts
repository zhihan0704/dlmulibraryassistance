import {DlmuAdapter} from '../adapters/dlmu-adapter';
import type {LiveSeat} from '../core/live-seats';
import type {SeatObservationStatus} from '../core/seat-observation';
import {LIVE_MAX_AGE_MS, type LiveReply} from '../shared/live-monitor';

const TIME = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium'});
const LABELS: Record<SeatObservationStatus['state'], string> = {
  BASELINE: '已取得首次观察', CHANGED: '发现变化', UNCHANGED: '新观察内容相同',
  STALE: '数据已过期，等待新观察', UNKNOWN: '数据待核验', SESSION_LOST: '认证待恢复',
  SOURCE_UNAVAILABLE: '等待页面数据', STOPPED: '本次监听已停止',
};

function time(value: string | null | undefined): string {
  const stamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? TIME.format(stamp) + '（北京时间）' : '暂无';
}

function line(label: string, value: string): HTMLParagraphElement {
  const p = document.createElement('p');
  const small = document.createElement('small');
  small.textContent = label + '：';
  p.append(small, document.createTextNode(value));
  return p;
}

export function mountLivePanel(host: HTMLElement): void {
  host.innerHTML = `<h2>实时监听 · 当前页面</h2>
<p class="muted">监听页面自然产生的响应和座位变化。显示的时间是本机捕获或读取时间。</p>
<p id="live-site" role="status">正在识别当前页面…</p>
<div id="live-resp"></div>
<div id="live-dom"></div>
<div id="live-seats-wrap" hidden>
  <h3>最近捕获的座位地图</h3>
  <label>搜索座位<input id="live-search" type="search" placeholder="例如 1D-052"></label>
  <p id="live-seat-count" class="muted"></p>
  <div class="map-scroll"><div id="live-seat-map" role="group" aria-label="最近捕获的座位"></div></div>
  <p id="live-selected" aria-live="polite">尚未选择座位</p>
  <p id="live-selected-change"></p>
</div>
<p class="waiting" id="live-unknown">座位可用性待核验（UNKNOWN）。预约记录、状态码和 DOM 样式仅供观察。</p>
<button type="button" id="live-refresh">读取当前页面缓存</button>
<p id="live-error" role="alert"></p>`;

  const site = host.querySelector<HTMLElement>('#live-site')!;
  const domBox = host.querySelector<HTMLElement>('#live-dom')!;
  const respBox = host.querySelector<HTMLElement>('#live-resp')!;
  const errorBox = host.querySelector<HTMLElement>('#live-error')!;
  const seatsWrap = host.querySelector<HTMLElement>('#live-seats-wrap')!;
  const seatMap = host.querySelector<HTMLElement>('#live-seat-map')!;
  const seatCount = host.querySelector<HTMLElement>('#live-seat-count')!;
  const search = host.querySelector<HTMLInputElement>('#live-search')!;
  const selectedLine = host.querySelector<HTMLElement>('#live-selected')!;
  const selectedChange = host.querySelector<HTMLElement>('#live-selected-change')!;
  let tabId: number | undefined;
  let route = '';
  let selected: Pick<LiveSeat, 'roomId' | 'devId' | 'name'> | null = null;
  let liveSeats: LiveSeat[] = [];
  let mapKey = '';
  let generation = 0;
  let expiry: number | undefined;
  let updateTimer: number | undefined;

  function renderSeats(): void {
    seatsWrap.hidden = !liveSeats.length && !selected;
    const query = search.value.trim().toUpperCase();
    const shown = liveSeats.filter(seat => seat.name.toUpperCase().includes(query));
    const key = JSON.stringify([selected?.devId, shown.map(seat => [seat.devId, seat.name, seat.position, seat.resvIntervals.length])]);
    if (mapKey === key) return;
    mapKey = key;
    seatCount.textContent = `显示 ${shown.length} / ${liveSeats.length} 个座位`;
    seatMap.replaceChildren();
    for (const seat of shown) {
      const button = document.createElement('button');
      button.className = 'real-seat live-seat';
      button.type = 'button';
      button.textContent = seat.name;
      button.dataset.devId = String(seat.devId);
      button.setAttribute('aria-pressed', String(selected?.devId === seat.devId));
      button.title = `${seat.name} · ${seat.resvIntervals.length} 条预约时间记录 · 状态待核验`;
      if (seat.position) {
        button.style.left = `${seat.position.x}%`;
        button.style.top = `${seat.position.y}%`;
      }
      button.onclick = () => { selected = seat; renderSeats(); renderSelection(); void refresh(); };
      seatMap.append(button);
    }
  }

  function renderSelection(reply?: LiveReply) {
    if (!selected) {
      selectedLine.textContent = '尚未选择座位';
      selectedChange.textContent = '';
      return;
    }
    const seat = liveSeats.find(row => row.devId === selected?.devId && row.name === selected?.name);
    const ranges = seat?.resvIntervals.map(interval => `${interval.startTime}–${interval.endTime}`).join('，');
    selectedLine.textContent = `已选择 ${selected.name} · devId ${selected.devId} · ` + (seat
      ? `预约时间记录 ${seat.resvIntervals.length} 条${ranges ? `（${ranges}，网页时间）` : ''} · 状态 UNKNOWN`
      : '当前观察中没有匹配的座位 · 状态 UNKNOWN');
    const changes = reply?.selected;
    selectedChange.textContent = `最近一次目标座位变化｜响应 ${time(changes?.network?.observedAt)}｜DOM ${time(changes?.dom?.observedAt)}`;
  }

  function reset(message: string): void {
    site.textContent = message;
    domBox.replaceChildren();
    respBox.replaceChildren();
    selected = null;
    route = '';
    liveSeats = [];
    renderSeats();
    renderSelection();
  }

  function render(reply: LiveReply) {
    if (route !== reply.route) { route = reply.route; selected = null; }
    const {network, dom: domState} = reply.eventMonitor;
    site.textContent = '学校官方页面 · ' + (reply.route || '等待进入座位区域');
    respBox.replaceChildren(
      line('响应旁路', reply.hookSeen ? `已安装并运行（${reply.transports.join(' / ')}）` : '等待旁路就绪'),
      line('本标签页捕获', `${reply.capturedCount} 次 · XHR ${reply.capturedBy.XHR} · fetch ${reply.capturedBy.FETCH}`),
      line('最近响应捕获', time(reply.lastCapturedAt)),
      line('最近有效响应捕获', time(network.lastFreshAt)),
      line('响应观察', LABELS[network.state]),
      line('数据新鲜度', network.freshness === 'FRESH' ? '两分钟内的页面观察' : network.freshness === 'STALE' ? '已过期' : '待核验'),
      line('会话', reply.session === 'SESSION_LOST' ? '请人工登录并打开官方个人预约页核验' : reply.session === 'REVERIFIED' ? '上次认证中断已通过个人页复核' : '待核验'),
      line('服务器更新时间', '未取得服务器时间戳'),
    );
    if (reply.liveError) respBox.append(line('最近响应解析问题', reply.liveError));
    if (reply.live) {
      const {summary} = reply.live;
      respBox.append(line(network.freshness === 'FRESH' ? '响应座位数' : '上次有效响应座位数', String(summary.total)),
        line('含预约时间记录', `${summary.withResv} 个座位`));
    }
    domBox.replaceChildren(
      line('座位 DOM 监听', reply.domRunning ? '运行中' : '等待座位页在前台就绪'),
      line('DOM 观察', LABELS[domState.state]),
      line('最近 DOM 观察', time(domState.lastFreshAt)),
      line('最近 DOM 变化', time(domState.lastChangedAt)),
      line('本区域变化事件', String(reply.eventMonitor.events)),
    );
    if (reply.domError) domBox.append(line('页面读取问题', reply.domError));
    if (reply.dom) domBox.append(line('区域', reply.dom.roomTitle), line('DOM 座位数', String(reply.dom.count)),
      line('页面标注空闲时段的座位', `${reply.dom.withFreeIntervals} 个（样式与文字观察）`));
    liveSeats = reply.session === 'SESSION_LOST' ? [] : reply.live?.snapshot.seats ?? [];
    renderSeats();
    renderSelection(reply);

    const now = Date.now();
    const deadlines = [network, domState].filter(value => value.freshness === 'FRESH' && value.lastFreshAt)
      .map(value => Date.parse(value.lastFreshAt!) + LIVE_MAX_AGE_MS + 1).filter(at => at > now);
    if (deadlines.length) expiry = window.setTimeout(() => void refresh(), Math.min(...deadlines) - now);
  }

  async function refresh(): Promise<void> {
    const requested = ++generation;
    window.clearTimeout(expiry);
    errorBox.textContent = '';
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (generation !== requested) return;
      if (tabId !== tab?.id) { tabId = tab?.id; selected = null; route = ''; }
      const page = DlmuAdapter.identifyPage(tab?.url ?? '');
      if (page.kind === 'SSO') { reset('学校统一认证页面 · 等待人工登录'); return; }
      if (tabId === undefined || page.kind === 'OTHER' || tab.incognito) { reset('当前标签页未识别为学校官方页面'); return; }
      const reply: LiveReply | undefined = await chrome.tabs.sendMessage(tabId, {
        type: 'GET_LIVE', roomId: selected?.roomId, seatId: selected?.devId, seatCode: selected?.name,
      }, {frameId: 0});
      if (generation !== requested) return;
      if (!reply?.ok) { reset('学校页面脚本尚未提供数据'); return; }
      render(reply);
    } catch {
      if (generation !== requested) return;
      reset('当前页面脚本无法读取');
      errorBox.textContent = '请确认扩展已加载。可在学校标签页手动刷新一次后再读取。';
    }
  }

  function scheduleRefresh() {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(() => void refresh(), 180);
  }

  search.addEventListener('input', renderSeats);
  host.querySelector<HTMLButtonElement>('#live-refresh')!.onclick = () => void refresh();
  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && (change.url || change.status)) scheduleRefresh(); });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'LIVE_UPDATE' && sender.tab?.id === tabId) scheduleRefresh();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });
  void refresh();
}
