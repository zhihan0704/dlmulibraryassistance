import type {DailySchedule} from '../core/daily-booking-scheduler';
import type {DailySessionGate, DailyState} from '../storage/daily-booking-db';

interface DailyReply {ok: boolean; state?: DailyState; session?: DailySessionGate; next?: DailySchedule; error?: string}
const shanghaiTime = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium'});

export function mountDailyBooking(section: HTMLElement): void {
  section.id = 'daily-booking';
  section.innerHTML = `<h2>每日预约助手</h2>
    <p>固定座位 · 每天北京时间 08:00 提醒预约次日。07:55 准备，08:01 核对个人预约。</p>
    <p class="waiting">当前为辅助模式。请在学校网页核对资格、时长及空闲状态，再亲自确认预约。</p>
    <p data-daily-summary>正在读取本机设置…</p>
    <p class="waiting" data-daily-session role="status"></p>
    <p data-daily-result role="status"></p>
    <details data-daily-settings open><summary>固定座位与使用时段</summary>
      <p class="muted">先在学校网页打开对应区域，等座位加载后再核对并保存。保存后请启用提醒。</p>
      <form data-daily-form>
        <div class="row"><label>楼层<input name="floorName" value="一楼" maxlength="24" required></label>
        <label>区域<input name="roomName" value="预约自习室" maxlength="64" required></label></div>
        <label>固定座位<input name="seatCode" value="D1-01" maxlength="32" required></label>
        <div class="row"><label>使用开始<input name="startTime" type="time" required></label>
        <label>使用结束<input name="endTime" type="time" required></label></div>
        <button type="submit">核对当前座位并保存</button>
      </form>
    </details>
    <div class="row daily-actions">
      <button class="primary" data-daily-toggle disabled>启用每日提醒</button>
      <button data-daily-open>打开学校预约页</button>
      <button data-daily-personal>查看个人预约</button>
    </div>
    <p data-daily-error role="alert"></p>`;
  const form = section.querySelector<HTMLFormElement>('[data-daily-form]')!;
  const toggle = section.querySelector<HTMLButtonElement>('[data-daily-toggle]')!;
  const summary = section.querySelector<HTMLElement>('[data-daily-summary]')!;
  const outcome = section.querySelector<HTMLElement>('[data-daily-result]')!;
  const sessionLine = section.querySelector<HTMLElement>('[data-daily-session]')!;
  const error = section.querySelector<HTMLElement>('[data-daily-error]')!;
  let enabled = false;
  let busy = false;
  let configured = false;

  function render(reply: DailyReply, fill: boolean): void {
    const state = reply.state;
    sessionLine.textContent = reply.session && reply.session.verifiedAt === undefined
      ? '读取暂停。请人工完成学校登录，再打开个人预约页核验。' : '';
    configured = !!state;
    enabled = state?.config.enabled ?? false;
    toggle.textContent = enabled ? '暂停每日提醒' : '启用每日提醒';
    toggle.disabled = busy || !configured;
    if (!state) {
      summary.textContent = '尚未核对固定座位。';
      return;
    }
    const target = state.config.target;
    summary.textContent = `${target.floorName} · ${target.roomName} · ${target.seatCode}｜使用时段 ${target.startTime}–${target.endTime}｜` +
      (enabled && reply.next ? `下次预约使用日期 ${reply.next.target.date}` : '每日提醒已暂停');
    outcome.textContent = state.result ? `${shanghaiTime.format(state.result.at)} · ${state.result.message}` : '等待第一次每日检查。';
    if (fill) {
      for (const name of ['floorName', 'roomName', 'seatCode', 'startTime', 'endTime'] as const) {
        (form.elements.namedItem(name) as HTMLInputElement).value = target[name];
      }
      section.querySelector<HTMLDetailsElement>('[data-daily-settings]')!.open = false;
    }
  }

  async function send(message: object, fill = false): Promise<void> {
    const reply: DailyReply | undefined = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw Error(reply?.error ?? '每日提醒暂时无法读取。');
    render(reply, fill);
  }

  async function interact(message: object, fill = false): Promise<void> {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    error.textContent = '';
    try { await send(message, fill); }
    catch (e) { error.textContent = e instanceof Error ? e.message : '每日预约助手操作失败。'; }
    finally { busy = false; toggle.disabled = !configured; }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const fields: Record<string, string> = {};
    new FormData(form).forEach((value, key) => { fields[key] = String(value).trim(); });
    void interact({type: 'DAILY_BIND', ...fields}, true);
  });
  toggle.onclick = () => void interact({type: 'DAILY_TOGGLE', enabled: !enabled});
  section.querySelector<HTMLButtonElement>('[data-daily-open]')!.onclick = () => void interact({type: 'DAILY_OPEN'});
  section.querySelector<HTMLButtonElement>('[data-daily-personal]')!.onclick = () => void interact({type: 'DAILY_OPEN', personal: true});
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'DAILY_UPDATED' && !busy) void send({type: 'DAILY_GET'}).catch(() => {});
  });
  void interact({type: 'DAILY_GET'}, true);
}
