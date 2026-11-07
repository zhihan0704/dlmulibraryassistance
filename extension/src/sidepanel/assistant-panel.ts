import type {BookingPreferences, rankBookingCandidates} from '../core/intelligent-booking';
import type {RuntimeEvent, RuntimeHealth} from '../core/runtime-health';
import type {DailyBookingConfig} from '../core/daily-booking-scheduler';
import type {SeatTarget} from '../core/seat-timeline';
import type {AssistantPlan} from '../storage/assistant-repository';

type SeatOption = SeatTarget & {roomName?: string};
interface AssistantView {
  health: RuntimeHealth;
  preferences: BookingPreferences | null;
  plans: AssistantPlan[];
  notifications: boolean;
  seats: SeatOption[];
  dailyTarget: DailyBookingConfig['target'] | null;
  analysis: ReturnType<typeof rankBookingCandidates> | null;
}
const ZONE = 'Asia/Shanghai';
const CLOCK = new Intl.DateTimeFormat('zh-CN', {timeZone: ZONE, dateStyle: 'medium', timeStyle: 'short'});
const seatKey = (seat: SeatTarget) => `${seat.roomId}/${seat.devId}/${seat.seatCode}`;
const dateNow = () => new Intl.DateTimeFormat('sv-SE', {timeZone: ZONE}).format(new Date());
const labelTime = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? `${CLOCK.format(new Date(value))}（北京时间）` : '尚未取得';
const local = (value: string) => value.slice(0, 16);
const iso = (value: string) => `${value}:00+08:00`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  item.textContent = content;
  if (className) item.className = className;
  return item;
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountAssistantPanel(after: HTMLElement, liveSection: HTMLElement) {
  const tasks = element('section', '');
  tasks.id = 'assistant-tasks';
  tasks.innerHTML = '<h2>今日任务与日期计划</h2><p class="muted">按北京时间显示。不同日期分别保存。提醒后请在学校页面自行确认。</p><div data-plans></div>';
  const preferences = element('section', '');
  preferences.id = 'assistant-preferences';
  preferences.innerHTML = `<h2>我的预约偏好</h2>
    <p class="muted">在学校座位页取得最新数据后选择座位。已保存的座位可以继续编辑。</p>
    <form data-preferences>
      <label>首选座位<select name="primary" required></select></label>
      <div class="row"><label>首选开始<input name="start" type="datetime-local" required></label><label>首选结束<input name="end" type="datetime-local" required></label></div>
      <div class="row"><label>可调整起点<input name="from" type="datetime-local" required></label><label>可调整终点<input name="to" type="datetime-local" required></label></div>
      <label>自己可接受的最短时长（分钟）<input name="minimum" type="number" min="1" max="1440" value="60" required></label>
      <div class="assistant-options">
        <label><input type="checkbox" name="adjust">允许在范围内移动时段</label>
        <label><input type="checkbox" name="shorten">规则已核验时允许缩短</label>
        <label><input type="checkbox" name="longer" checked>相近方案优先连续时长</label>
        <label><input type="checkbox" name="fallback">允许使用已配置的备用座位</label>
      </div>
      <label>添加备用座位<select name="backup"></select></label><button type="button" data-add-seat>加入备用列表</button>
      <ol data-backups></ol>
      <details><summary>本日计划提醒与学校核验</summary>
        <div class="row"><label>楼层<input name="floor" maxlength="16" placeholder="例如 一楼"></label><label>区域名称<input name="room" maxlength="32"></label></div>
        <div class="row"><label>执行提醒<input name="reminder" type="datetime-local"></label><label>优先级<select name="priority"><option value="1">高</option><option value="2" selected>普通</option><option value="3">低</option></select></label></div>
      </details>
      <button type="submit" value="preferences">保存预约偏好</button><button type="submit" value="plan">保存该日期计划</button>
    </form><p data-assistant-feedback role="status"></p>`;
  const suggestions = element('section', '');
  suggestions.id = 'assistant-suggestions';
  suggestions.innerHTML = '<h2>智能空档建议</h2><p class="muted">按已保存的偏好或打开的日期计划分析。建议与预约记录分别显示。</p><div data-analysis role="status"></div>';
  const healthSection = element('section', '');
  healthSection.id = 'assistant-health';
  healthSection.innerHTML = '<h2>运行状态</h2><p data-health role="status">正在连接扩展后台…</p><details><summary>连接、数据和提醒详情</summary><ul data-health-details></ul></details>';
  const logs = element('section', '');
  logs.id = 'assistant-logs';
  logs.innerHTML = `<h2>运行日志与通知</h2>
    <div class="assistant-options"><label><input type="checkbox" data-notifications>开启新版桌面通知</label></div>
    <div class="row"><label>日期<input type="date" data-log-date></label><label>座位编号<input type="search" data-log-seat maxlength="32"></label></div>
    <label>任务<select data-log-task><option value="">全部任务</option><option value="daily-fixed-seat">每日提醒</option></select></label>
    <button type="button" data-query>查询事件</button><button type="button" data-export-events>导出查询结果</button><button type="button" data-clear-events>清除日志</button>
    <ol data-events class="assistant-events"></ol>
    <details><summary>偏好与计划备份</summary><p class="muted">备份包含新版偏好、日期计划和通知设置。恢复会更新本机偏好及备份中包含的日期。</p>
      <button type="button" data-export-config>下载配置备份</button>
      <label>选择备份 JSON<input type="file" accept=".json,application/json" data-import-config></label>
      <button type="button" data-clear-data>清理新版数据</button></details><p data-log-feedback role="status"></p>`;
  after.after(tasks, preferences, suggestions, healthSection, liveSection, logs);

  const form = preferences.querySelector<HTMLFormElement>('form')!;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const primary = form.querySelector<HTMLSelectElement>('[name=primary]')!;
  const backup = form.querySelector<HTMLSelectElement>('[name=backup]')!;
  const backupList = preferences.querySelector<HTMLOListElement>('[data-backups]')!;
  const feedback = preferences.querySelector<HTMLElement>('[data-assistant-feedback]')!;
  const logFeedback = logs.querySelector<HTMLElement>('[data-log-feedback]')!;
  const notifications = logs.querySelector<HTMLInputElement>('[data-notifications]')!;
  const logTask = logs.querySelector<HTMLSelectElement>('[data-log-task]')!;
  const seats = new Map<string, SeatOption>();
  let draftBackups: SeatTarget[] = [];
  let editingDate: string | undefined;
  let seeded = false;
  let generation = 0;
  let eventGeneration = 0;
  let refreshTimer: number | undefined;

  async function call<T>(type: string, data: object = {}): Promise<T> {
    let timer: number | undefined;
    try {
      const reply = await Promise.race([chrome.runtime.sendMessage({type: 'ASSISTANT_' + type, ...data}),
        new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => reject(Error('扩展后台暂未响应')), 5000); })]);
      if (!reply?.ok) throw Error(reply?.error ?? '扩展后台暂未响应');
      return reply.data as T;
    } finally { window.clearTimeout(timer); }
  }

  function setSeats(view: AssistantView) {
    const current = primary.value, other = backup.value;
    const selected = seats.get(current);
    seats.clear();
    for (const source of [...view.plans.map(plan => plan.preferences), ...(view.preferences ? [view.preferences] : [])]) {
      for (const seat of [source.primarySeat, ...source.backupSeats]) seats.set(seatKey(seat), seat);
    }
    if (view.dailyTarget) {
      const seat = {roomId: Number(view.dailyTarget.roomId), devId: Number(view.dailyTarget.seatId), seatCode: view.dailyTarget.seatCode, roomName: view.dailyTarget.roomName};
      if (Number.isSafeInteger(seat.roomId) && seat.roomId > 0 && Number.isSafeInteger(seat.devId) && seat.devId > 0) seats.set(seatKey(seat), seat);
    }
    for (const seat of [selected, ...draftBackups, ...view.seats]) if (seat) seats.set(seatKey(seat), seat);
    for (const [select, previous] of [[primary, current], [backup, other]] as const) {
      select.replaceChildren(new Option('请选择座位', ''));
      for (const seat of seats.values()) select.add(new Option(`${seat.seatCode} · ${seat.roomName || '区域 ' + seat.roomId}`, seatKey(seat)));
      select.value = seats.has(previous) ? previous : '';
    }
  }

  function renderBackups() {
    backupList.replaceChildren();
    draftBackups.forEach((seat, index) => {
      const row = element('li', seat.seatCode + ' ');
      for (const [text, offset] of [['上移', -1], ['下移', 1], ['移除', 0]] as const) {
        const button = element('button', text);
        button.type = 'button';
        button.disabled = offset < 0 && index === 0 || offset > 0 && index === draftBackups.length - 1;
        button.onclick = () => {
          draftBackups.splice(index, 1);
          if (offset) draftBackups.splice(index + offset, 0, seat);
          renderBackups();
        };
        row.append(button);
      }
      backupList.append(row);
    });
  }

  function populate(prefs: BookingPreferences, plan?: AssistantPlan) {
    primary.value = seatKey(prefs.primarySeat);
    field('start').value = local(prefs.preferred.startAt);
    field('end').value = local(prefs.preferred.endAt);
    field('from').value = local(prefs.allowedWindow.startAt);
    field('to').value = local(prefs.allowedWindow.endAt);
    field('minimum').value = String(prefs.minDurationMinutes);
    field('adjust').checked = prefs.allowTimeAdjustment;
    field('shorten').checked = prefs.allowShorter;
    field('longer').checked = prefs.preferLonger;
    field('fallback').checked = prefs.allowBackupSeats;
    field('reminder').value = plan?.reminderAt ? local(plan.reminderAt) : '';
    field('priority').value = String(plan?.priority ?? 2);
    field('floor').value = plan?.floorName ?? '';
    field('room').value = plan?.roomName ?? seats.get(primary.value)?.roomName ?? '';
    draftBackups = [...prefs.backupSeats];
    renderBackups();
  }

  function readPreferences(): BookingPreferences {
    const seat = seats.get(primary.value);
    if (!seat) throw Error('请选择首选座位');
    return {date: field('start').value.slice(0, 10), primarySeat: seat, backupSeats: draftBackups,
      preferred: {startAt: iso(field('start').value), endAt: iso(field('end').value)},
      allowedWindow: {startAt: iso(field('from').value), endAt: iso(field('to').value)},
      minDurationMinutes: field('minimum').valueAsNumber, allowTimeAdjustment: field('adjust').checked,
      allowShorter: field('shorten').checked, preferLonger: field('longer').checked, allowBackupSeats: field('fallback').checked};
  }

  async function action(work: () => Promise<unknown>, success: string, target = feedback) {
    target.textContent = '';
    try { await work(); target.textContent = success; await refresh(); }
    catch (error) { target.textContent = error instanceof Error ? error.message : '操作未完成'; }
  }

  function renderPlans(view: AssistantView) {
    const area = tasks.querySelector('[data-plans]')!;
    area.replaceChildren();
    if (!view.plans.length) area.append(element('p', '暂无单独保存的日期计划。', 'muted'));
    const today = dateNow();
    for (const plan of view.plans) {
      const {date, primarySeat, preferred, allowedWindow} = plan.preferences;
      const item = element('article', '');
      const verified = plan.verification === 'VERIFIED' ? '官方个人页已核验' : plan.verification === 'NEEDS_REVIEW' ? '本次未取得唯一匹配，待核对' : '尚未核对预约';
      item.append(element('strong', `${date === today ? '今日 · ' : ''}${date} · ${primarySeat.seatCode}`),
        element('p', `${labelTime(preferred.startAt)} 至 ${labelTime(preferred.endAt)}`),
        element('small', `允许范围 ${labelTime(allowedWindow.startAt)} 至 ${labelTime(allowedWindow.endAt)} · 优先级 ${['', '高', '普通', '低'][plan.priority]}`),
        element('p', `提醒 ${plan.reminderAt ? labelTime(plan.reminderAt) : '未设置'} · ${verified}`));
      const edit = element('button', '打开日期计划');
      edit.onclick = () => { editingDate = date; populate(plan.preferences, plan); preferences.scrollIntoView(); void refresh(); };
      const check = element('button', '核对学校预约');
      check.onclick = () => void action(() => call('VERIFY_PLAN', {id: plan.id}), '已检查当前学校个人页，请查看计划核验结果。');
      const remove = element('button', '移除本机计划');
      remove.onclick = () => {
        if (window.confirm(`移除 ${date} 的本机计划？`)) void action(() => call('REMOVE_PLAN', {id: plan.id}), '已移除本机计划。');
      };
      item.append(edit, check, remove);
      area.append(item);
    }
    const old = logTask.value;
    logTask.replaceChildren(new Option('全部任务', ''), new Option('每日提醒', 'daily-fixed-seat'),
      ...view.plans.map(plan => new Option(plan.preferences.date, plan.id)));
    if (Array.from(logTask.options).some(option => option.value === old)) logTask.value = old;
  }

  function renderAnalysis(view: AssistantView) {
    const area = suggestions.querySelector('[data-analysis]')!;
    const analysis = view.analysis;
    const message = !analysis ? '请先保存偏好或打开日期计划。' : analysis.state === 'READY' ? '已核验数据支持以下建议。'
      : analysis.state === 'NO_MATCH' ? '当前已核验范围内没有符合偏好的建议。' : '待核验。当前证据不足以推荐可预约时段。';
    area.replaceChildren(element('p', message, analysis?.state === 'READY' ? 'success' : 'waiting'));
    if (!analysis) return;
    for (const review of analysis.reviews) area.append(element('p', `${review.target.seatCode} · ${review.reason}`, 'muted'));
    for (const candidate of analysis.candidates.slice(0, 12)) {
      const item = element('article', '');
      item.append(element('strong', `${candidate.target.seatCode} · ${candidate.durationMinutes} 分钟`),
        element('p', `${labelTime(candidate.startAt)} 至 ${labelTime(candidate.endAt)}`),
        element('small', `规则已核验 · 连续空档 ${candidate.continuousMinutes} 分钟 · 观察 ${labelTime(candidate.observedAt)}`));
      const details = element('details', '');
      details.append(element('summary', '查看推荐理由'), ...candidate.reasons.map(reason => element('p', reason, 'muted')));
      const use = element('button', '填入本日计划表单');
      use.onclick = () => {
        primary.value = seatKey(candidate.target);
        draftBackups = draftBackups.filter(seat => seatKey(seat) !== primary.value);
        renderBackups();
        field('start').value = local(candidate.startAt);
        field('end').value = local(candidate.endAt);
        feedback.textContent = '已填入表单。请核对并保存本日计划。';
        preferences.scrollIntoView();
      };
      item.append(details, use);
      area.append(item);
    }
  }

  function renderHealth(health: RuntimeHealth) {
    const summary = healthSection.querySelector<HTMLElement>('[data-health]')!;
    summary.textContent = health.reason;
    summary.className = health.state === 'HEALTHY' ? 'success' : 'waiting';
    summary.dataset.state = health.state;
    healthSection.querySelector('[data-health-details]')!.replaceChildren(...[
      `Edge 与扩展 ${health.browser === 'CONNECTED' && health.extension === 'CONNECTED' ? '已连接' : '待确认'}`,
      `扩展后台 ${health.worker === 'READY' ? '已就绪' : '正在恢复或待确认'}`,
      `当前页面 ${health.page === 'SEATS' ? '学校座位页' : health.page === 'PERSONAL' ? '学校个人预约页' : health.page === 'SSO' ? '学校登录页' : '等待学校业务页'}`,
      `页面连接 ${health.content === 'CONNECTED' ? '已连接' : '等待连接'}`,
      `登录 ${health.session === 'SESSION_LOST' ? '待人工登录' : health.session === 'REVERIFIED' ? '上次中断已复核' : '待核验'}`,
      `有效响应 ${labelTime(health.lastResponse)}`, `最近 DOM 观察 ${labelTime(health.lastDom)}`, `最近成功解析 ${labelTime(health.lastParsed)}`,
      `最近任务检查 ${labelTime(health.lastTask)}`,
      `本地数据库 ${health.indexedDB === 'READY' ? '可读取' : '待核对'}`,
      `提醒时钟 ${health.alarms === 'SCHEDULED' ? '已核对' : health.alarms === 'NONE' ? '未启用' : '等待核对'}`,
      `上次有效历史快照 ${health.lastGood ? `${labelTime(health.lastGood.capturedAt)}，${health.lastGood.seatCount} 个座位` : '暂无'}`,
      `最近异常 ${health.lastError ? `${labelTime(health.lastError.timestamp)} ${health.lastError.description}` : '暂无记录'}`,
    ].map(value => element('li', value)));
  }

  async function refresh() {
    const request = ++generation;
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      const view = await call<AssistantView>('STATE', {tabId: tab?.id, date: editingDate});
      if (request !== generation) return;
      setSeats(view);
      if (!seeded) {
        seeded = true;
        if (view.preferences) populate(view.preferences);
        else if (view.dailyTarget) {
          const target = view.dailyTarget;
          primary.value = seatKey({roomId: Number(target.roomId), devId: Number(target.seatId), seatCode: target.seatCode});
          field('start').value = field('from').value = `${dateNow()}T${target.startTime}`;
          field('end').value = field('to').value = `${dateNow()}T${target.endTime}`;
          field('floor').value = target.floorName;
          field('room').value = target.roomName;
        }
      }
      notifications.checked = view.notifications;
      renderHealth(view.health);
      renderPlans(view);
      renderAnalysis(view);
    } catch {
      if (request !== generation) return;
      const status = healthSection.querySelector<HTMLElement>('[data-health]')!;
      status.textContent = '扩展后台暂未响应，等待连接恢复。';
      status.dataset.state = 'UNKNOWN';
      suggestions.querySelector('[data-analysis]')!.replaceChildren(element('p', '当前无法重新核验建议。', 'waiting'));
    }
  }

  function filter() {
    return {date: logs.querySelector<HTMLInputElement>('[data-log-date]')!.value || undefined,
      seat: logs.querySelector<HTMLInputElement>('[data-log-seat]')!.value.trim() || undefined, task: logTask.value || undefined, limit: 100};
  }
  async function refreshEvents() {
    const request = ++eventGeneration;
    const eventList = logs.querySelector('[data-events]')!;
    try {
      const events = await call<RuntimeEvent[]>('EVENTS', {filter: filter()});
      if (request !== eventGeneration) return;
      eventList.replaceChildren(...events.map(event => element('li', `${labelTime(event.timestamp)} · ${event.description}${event.relatedSeat ? ` · ${event.relatedSeat.seatCode}` : ''}${event.relatedTask ? ` · ${event.relatedTask === 'daily-fixed-seat' ? '每日提醒' : event.relatedTask.slice(5)}` : ''}`, event.severity !== 'INFO' ? 'waiting' : undefined)));
      if (!events.length) eventList.append(element('li', '没有符合条件的事件。', 'muted'));
    } catch { if (request === eventGeneration) eventList.replaceChildren(element('li', '运行日志暂不可读。', 'waiting')); }
  }

  form.onsubmit = event => {
    event.preventDefault();
    const savePlan = (event.submitter as HTMLButtonElement | null)?.value === 'plan';
    void action(async () => {
      const input = readPreferences();
      if (savePlan) {
        await call('SAVE_PLAN', {plan: {preferences: input, priority: Number(field('priority').value),
          reminderAt: field('reminder').value ? iso(field('reminder').value) : null,
          floorName: field('floor').value.trim() || undefined, roomName: field('room').value.trim() || undefined}});
        editingDate = input.date;
      } else { await call('SAVE_PREFERENCES', {preferences: input}); editingDate = undefined; }
    }, savePlan ? '已保存本机日期计划。' : '已保存预约偏好。');
  };
  primary.onchange = () => {
    const seat = seats.get(primary.value);
    if (seat?.roomName) field('room').value = seat.roomName;
  };
  preferences.querySelector<HTMLButtonElement>('[data-add-seat]')!.onclick = () => {
    const seat = seats.get(backup.value);
    if (!seat || backup.value === primary.value || draftBackups.some(item => seatKey(item) === backup.value) || draftBackups.length >= 8) {
      feedback.textContent = '请选择另一个尚未添加的座位，最多保留八个备用座位。';
      return;
    }
    draftBackups.push(seat);
    renderBackups();
  };
  const logButton = (selector: string, handler: () => void) => { logs.querySelector<HTMLButtonElement>(selector)!.onclick = handler; };
  notifications.onchange = () => void action(() => call('NOTIFICATIONS', {enabled: notifications.checked}), '已保存通知设置。', logFeedback);
  logButton('[data-query]', () => void refreshEvents());
  logButton('[data-export-events]', () => void action(async () => download('dlmu-runtime-events.json', await call('EXPORT_EVENTS', {filter: filter()})), '已生成查询结果。', logFeedback));
  logButton('[data-clear-events]', () => {
    if (window.confirm('清除本机运行日志？')) void action(async () => { await call('CLEAR_EVENTS'); await refreshEvents(); }, '已清除运行日志。', logFeedback);
  });
  logButton('[data-export-config]', () => void action(async () => download('dlmu-assistant-config.json', await call('EXPORT_CONFIG')), '已生成配置备份。', logFeedback));
  logButton('[data-clear-data]', () => {
    if (window.confirm('清除 2.2 偏好、日期计划和运行日志？')) void action(async () => {
      await call('CLEAR_DATA'); form.reset(); draftBackups = []; editingDate = undefined; seeded = false; renderBackups(); await refreshEvents();
    }, '已清理新版数据。', logFeedback);
  });
  logs.querySelector<HTMLInputElement>('[data-import-config]')!.onchange = event => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !window.confirm('用所选备份更新本机偏好和其中包含的日期计划？')) return;
    void action(async () => {
      if (file.size > 1_000_000) throw Error('配置文件过大');
      await call('RESTORE_CONFIG', {backup: JSON.parse(await file.text())});
      form.reset(); draftBackups = []; editingDate = undefined; seeded = false; renderBackups();
    }, '已恢复偏好和日期计划。', logFeedback);
  };
  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => { void refresh(); void refreshEvents(); }, 180);
  }
  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((_id, change) => { if (change.url || change.status === 'complete') scheduleRefresh(); });
  chrome.runtime.onMessage.addListener(message => {
    if (['ASSISTANT_UPDATED', 'LIVE_UPDATE', 'DAILY_UPDATED'].includes(message?.type)) scheduleRefresh();
  });
  void refresh();
  void refreshEvents();
}
