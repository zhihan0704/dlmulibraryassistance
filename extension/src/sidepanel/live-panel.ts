import type {LiveRoomSummary, LiveSnapshot} from '../core/live-seats';
import {beijingMinuteOfDay, freeGaps, NOW_OFFSET_MINUTES} from '../core/free-time';

const TARGET_PREFIX = 'https://seats.dlmu.edu.cn/';

interface LiveReply {
  ok: boolean;
  live: {
    snapshot: LiveSnapshot;
    summary: {total: number; withResv: number; withoutResv: number; invalidRows: number; rooms: LiveRoomSummary[]};
  } | null;
  liveError: string | null;
  hookSeen: boolean;
  capturedCount: number;
  dom: {
    at: string;
    route: string;
    roomTitle: string;
    count: number;
    classCounts: Record<string, number>;
    withFreeIntervals: number;
  } | null;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) : '时间无效';
}

function line(label: string, value: string): HTMLParagraphElement {
  const p = document.createElement('p');
  const small = document.createElement('small');
  small.textContent = label + '：';
  p.append(small, document.createTextNode(value));
  return p;
}

export function mountLivePanel(host: HTMLElement): void {
  host.innerHTML = `<h2>实时数据 · 当前页面</h2>
<p class="muted">数据来自你正在浏览的图书馆网页本身。扩展不发起请求、不读取 Cookie、不读取他人信息。</p>
<p id="live-site">正在识别当前页面…</p>
<div id="live-dom"></div>
<div id="live-resp"></div>
<div id="live-seats-wrap" hidden>
  <h3>实时座位（按网页坐标）</h3>
  <label>搜索座位<input id="live-search" type="search" placeholder="例如 1D-052" aria-label="搜索实时座位"></label>
  <p id="live-seat-count" class="muted"></p>
  <div class="map-scroll"><div id="live-seat-map" role="group" aria-label="当前页面实时座位"></div></div>
  <p id="live-selected" aria-live="polite">尚未选择实时座位</p>
</div>
<p class="waiting" id="live-unknown">座位状态：UNKNOWN —— 状态映射尚未通过现场核验，不推断空闲或占用。</p>
<button type="button" id="live-refresh">刷新当前页面数据</button>
<p id="live-error" role="alert"></p>`;

  const site = host.querySelector<HTMLParagraphElement>('#live-site')!;
  const domBox = host.querySelector<HTMLDivElement>('#live-dom')!;
  const respBox = host.querySelector<HTMLDivElement>('#live-resp')!;
  const errorBox = host.querySelector<HTMLParagraphElement>('#live-error')!;
  const seatsWrap = host.querySelector<HTMLDivElement>('#live-seats-wrap')!;
  const seatMap = host.querySelector<HTMLDivElement>('#live-seat-map')!;
  const seatCount = host.querySelector<HTMLParagraphElement>('#live-seat-count')!;
  const search = host.querySelector<HTMLInputElement>('#live-search')!;
  const selectedLine = host.querySelector<HTMLParagraphElement>('#live-selected')!;

  let liveSeats: LiveSnapshot['seats'] = [];
  let selectedId: number | null = null;

  function renderSeats(): void {
    if (!liveSeats.length) {
      seatsWrap.hidden = true;
      return;
    }
    seatsWrap.hidden = false;
    const query = search.value.trim().toUpperCase();
    const shown = liveSeats.filter((s) => s.name.toUpperCase().includes(query));
    seatCount.textContent = `显示 ${shown.length} / ${liveSeats.length} 个实时座位 · 全部 UNKNOWN`;
    seatMap.replaceChildren();
    for (const seat of shown) {
      const b = document.createElement('button');
      b.className = 'real-seat live-seat';
      b.type = 'button';
      b.textContent = seat.name;
      b.dataset.devId = String(seat.devId);
      b.setAttribute('aria-label', `${seat.name} UNKNOWN`);
      b.setAttribute('aria-pressed', String(selectedId === seat.devId));
      const intervalText =
        seat.resvIntervals.length > 0
          ? `${seat.resvIntervals.length} 条预约时间记录`
          : '无预约时间记录';
      b.title = `${seat.name} · devId ${seat.devId} · ${intervalText} · UNKNOWN`;
      if (seat.position) {
        b.style.left = `${seat.position.x}%`;
        b.style.top = `${seat.position.y}%`;
      }
      b.onclick = () => {
        selectedId = seat.devId;
        const ranges = seat.resvIntervals
          .map((i) => `${i.startTime}–${i.endTime}`)
          .join('，');
        // 空闲时段是「客观时间区间」，不是「可预约」判断 —— 措辞上严格区分
        const from = beijingMinuteOfDay(new Date().toISOString()) + NOW_OFFSET_MINUTES;
        const gaps = freeGaps(seat, from);
        const freeText = gaps.length
          ? `${gaps.map((g) => `${g.start}–${g.end}`).join('，')}（合计 ${gaps.reduce((n, g) => n + g.minutes, 0)} 分钟）`
          : '无';
        selectedLine.textContent =
          `已选择 ${seat.name} · devId ${seat.devId} · 开放 ${seat.openStart ?? '?'}–${seat.openEnd ?? '?'}` +
          ` · 预约时间记录 ${seat.resvIntervals.length} 条` +
          (ranges ? `（${ranges}）` : '') +
          ` · 按预约记录推算的自现在起空闲时段：${freeText}` +
          ' · 状态 UNKNOWN（不判断可否预约）';
        renderSeats();
      };
      seatMap.append(b);
    }
  }

  search.addEventListener('input', renderSeats);

  function reset(message: string): void {
    site.textContent = message;
    domBox.replaceChildren();
    respBox.replaceChildren();
    liveSeats = [];
    seatsWrap.hidden = true;
    seatMap.replaceChildren();
  }

  function renderDom(reply: LiveReply): void {
    domBox.replaceChildren();
    const dom = reply.dom;
    if (!dom) {
      domBox.append(line('页面 DOM', '尚未读取（请刷新一次图书馆页面）'));
      return;
    }
    domBox.append(line('页面路由', dom.route || '(空)'));
    domBox.append(line('房间标题', dom.roomTitle || '(未识别)'));
    domBox.append(line('DOM 座位数', String(dom.count)));
    const dist = Object.entries(dom.classCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
    domBox.append(line('状态类分布', dist || '(无)'));
    domBox.append(line('带空闲时段的座位', String(dom.withFreeIntervals)));
    domBox.append(line('DOM 读取时刻', fmtTime(dom.at)));
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'DOM 不含 devId 与原始 resvInfo；此处状态类仅为网页给节点加的样式名，语义未确认。';
    domBox.append(note);
  }

  function renderLive(reply: LiveReply): void {
    respBox.replaceChildren();
    const head = line('响应旁路', reply.hookSeen ? '已安装并运行' : '未捕获到（页面可能尚未请求，或需刷新一次）');
    respBox.append(head);
    respBox.append(line('捕获次数', String(reply.capturedCount)));

    if (reply.liveError) {
      const err = document.createElement('p');
      err.className = 'waiting';
      err.textContent = '最近一次解析失败：' + reply.liveError;
      respBox.append(err);
    }
    if (!reply.live) {
      respBox.append(line('座位数据', '尚未取得实时响应'));
      liveSeats = [];
      seatsWrap.hidden = true;
      return;
    }
    const {snapshot, summary} = reply.live;
    liveSeats = snapshot.seats;
    renderSeats();
    respBox.append(line('数据来源', 'LIVE_RESERVE（网页自身请求的响应）'));
    respBox.append(line('捕获时刻', fmtTime(snapshot.capturedAt)));
    const age=Date.now()-Date.parse(snapshot.capturedAt);respBox.append(line('数据新鲜度',age<0||!Number.isFinite(age)?'UNKNOWN：系统时间需核对':age>120000?'STALE：页面没有提供新响应，不代表状态未变化':'最近一次页面响应；不保证此刻实时'));
    respBox.append(line('实时座位数', String(summary.total)));
    const rooms = summary.rooms.map((r) => `${r.roomName || '(未命名)'} ${r.roomId} ×${r.count}`).join(' · ');
    respBox.append(line('房间分布', rooms || '(无)'));
    respBox.append(line('含预约记录的座位', String(summary.withResv)));
    respBox.append(line('无预约记录的座位', String(summary.withoutResv)));
    if (summary.invalidRows > 0) respBox.append(line('被跳过的畸形行', String(summary.invalidRows)));
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      '「含预约记录」只表示该座位 resvInfo 非空，不等于占用；resvStatus 为位掩码且语义未确认，因此不据此判断可用性。他人姓名与账号字段已在页内丢弃，未进入扩展。';
    respBox.append(note);
  }

  async function refresh(): Promise<void> {
    errorBox.textContent = '';
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (!tab?.id || !tab.url?.startsWith(TARGET_PREFIX)) {
        reset('当前不是目标网站');
        return;
      }
      site.textContent = '已识别目标网站';
      let reply: LiveReply;
      try {
        reply = (await chrome.tabs.sendMessage(tab.id, {type: 'GET_LIVE'})) as LiveReply;
      } catch {
        reset('无法读取页面脚本，请在图书馆页面按 F5 刷新后再试');
        errorBox.textContent = '扩展脚本尚未注入该标签页。';
        return;
      }
      if (!reply || reply.ok !== true) {
        reset('页面脚本未返回数据');
        return;
      }
      await chrome.tabs.sendMessage(tab.id, {type: 'READ_PAGE_SEATS'}).catch(() => {});
      const after = (await chrome.tabs.sendMessage(tab.id, {type: 'GET_LIVE'}).catch(() => null)) as LiveReply | null;
      const final = after && after.ok ? after : reply;
      renderDom(final);
      renderLive(final);
    } catch (e) {
      errorBox.textContent = e instanceof Error ? e.message : '读取失败';
    }
  }

  host.querySelector<HTMLButtonElement>('#live-refresh')!.onclick = () => void refresh();

  let timer: number | undefined;
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type !== 'LIVE_UPDATE') return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 400);
  });

  void refresh();
}
