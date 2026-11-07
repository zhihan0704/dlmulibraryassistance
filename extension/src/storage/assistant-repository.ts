import type {BookingPreferences} from '../core/intelligent-booking';
import type {RuntimeEvent, RuntimeSnapshot} from '../core/runtime-health';
import {parseInstant, sameSeat} from '../core/seat-timeline';
import {sha256} from '../core/product-model';
import {ASSISTANT_STORE, DAILY_DATABASE_NAME, openDailyDatabase} from './daily-database';
import {
  ASSISTANT_PLAN_LIMIT, RUNTIME_EVENT_LIMIT, RUNTIME_RETENTION_MS, beijingTimestamp,
  normalizeBackupPayload, normalizeHealthSnapshot, normalizePlanInput, normalizePreferences,
  normalizeStoredEvent, objectValue, validatePlanId,
  type AssistantBackup, type AssistantPlan, type PlanVerification, type RuntimeEventFilter,
} from './assistant-schema';

export type {AssistantBackup, AssistantPlan, AssistantPlanInput, PlanVerification, RuntimeEventFilter} from './assistant-schema';

const PREFS_ID = 'booking-preferences';
const NOTIFY_ID = 'runtime-notifications';
const HEALTH_ID = 'last-good';
const DEDUP_LIMIT = 2000;
const BACKUP_LIMIT = 250_000;
interface PreferenceRow {id: typeof PREFS_ID; preferences: BookingPreferences}
interface NotifyRow {id: typeof NOTIFY_ID; enabled: boolean}
interface HealthRow {id: typeof HEALTH_ID; snapshot: RuntimeSnapshot}
interface DedupRow {id: string; at: number}

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('无法读取本地助手数据'));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(Error('本地助手事务已回滚'));
  });
}

function preparedPlan(value: unknown): AssistantPlan {
  return {...normalizePlanInput(value), revision: crypto.randomUUID(), verification: 'PENDING'};
}

async function dedupId(kind: 'event' | 'notification', key: string): Promise<string> {
  if (typeof key !== 'string' || !key.trim() || key.length > 512) throw Error('去重标识无效');
  return `${kind}:${await sha256(key)}`;
}

function retained(at: number, now: number): boolean {
  return Number.isSafeInteger(at) && at <= now && at >= now - RUNTIME_RETENTION_MS;
}

function trimRows<T>(store: IDBObjectStore, rows: T[], key: (row: T) => string, at: (row: T) => number, limit: number, now: number): void {
  rows.sort((left, right) => at(right) - at(left));
  for (const [index, row] of rows.entries()) {
    if (index >= limit || !retained(at(row), now)) store.delete(key(row));
  }
}

/** Runtime records and booking plans share the existing daily-task database and transactions. */
export class AssistantRepository {
  constructor(private readonly name = DAILY_DATABASE_NAME) {}

  private async transaction<T>(stores: string | string[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await openDailyDatabase(this.name);
    const tx = db.transaction(stores, mode);
    const done = complete(tx);
    void done.catch(() => {});
    try {
      const value = await operation(tx);
      await done;
      return value;
    } catch (error) {
      try { tx.abort(); } catch { /* Already completed or aborted. */ }
      await done.catch(() => {});
      throw error;
    }
  }

  async getPreferences(): Promise<BookingPreferences | null> {
    return this.transaction(ASSISTANT_STORE.settings, 'readonly', async tx => {
      const row: PreferenceRow | undefined = await read(tx.objectStore(ASSISTANT_STORE.settings).get(PREFS_ID));
      return row ? normalizePreferences(row.preferences) : null;
    });
  }

  async savePreferences(input: unknown): Promise<BookingPreferences> {
    const preferences = normalizePreferences(input);
    return this.transaction(ASSISTANT_STORE.settings, 'readwrite', async tx => {
      tx.objectStore(ASSISTANT_STORE.settings).put({id: PREFS_ID, preferences} satisfies PreferenceRow);
      return preferences;
    });
  }

  async listPlans(): Promise<AssistantPlan[]> {
    return this.transaction(ASSISTANT_STORE.plans, 'readonly', async tx => {
      const plans: AssistantPlan[] = await read(tx.objectStore(ASSISTANT_STORE.plans).getAll());
      return plans.sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  async savePlan(input: unknown): Promise<AssistantPlan> {
    const plan = preparedPlan(input);
    return this.transaction(ASSISTANT_STORE.plans, 'readwrite', async tx => {
      const store = tx.objectStore(ASSISTANT_STORE.plans);
      if (!await read(store.getKey(plan.id)) && await read(store.count()) >= ASSISTANT_PLAN_LIMIT) throw Error('预约计划已达保存上限');
      store.put(plan);
      return plan;
    });
  }

  async removePlan(id: string): Promise<boolean> {
    validatePlanId(id);
    return this.transaction(ASSISTANT_STORE.plans, 'readwrite', async tx => {
      const store = tx.objectStore(ASSISTANT_STORE.plans);
      if (!await read(store.getKey(id))) return false;
      store.delete(id);
      return true;
    });
  }

  /** This method is called by the trusted local controller after official read-only verification. */
  async setPlanVerification(id: string, revision: string, verification: PlanVerification, observedAt?: string): Promise<boolean> {
    validatePlanId(id);
    if (!['PENDING', 'VERIFIED', 'NEEDS_REVIEW'].includes(verification)) throw Error('计划核验状态无效');
    const at = parseInstant(observedAt);
    if (((verification === 'VERIFIED' || observedAt !== undefined) && at === null) || (at !== null && at > Date.now())) throw Error('缺少有效观察时间');
    return this.transaction(ASSISTANT_STORE.plans, 'readwrite', async tx => {
      const store = tx.objectStore(ASSISTANT_STORE.plans);
      const previous: AssistantPlan | undefined = await read(store.get(id));
      if (!previous || previous.revision !== revision || (at !== null && previous.observedAt && at < Date.parse(previous.observedAt))) return false;
      const {observedAt: _old, ...plan} = previous;
      store.put({...plan, verification, ...(at === null ? {} : {observedAt: beijingTimestamp(at)})} satisfies AssistantPlan);
      return true;
    });
  }

  async getHealth(): Promise<RuntimeSnapshot | null> {
    return this.transaction(ASSISTANT_STORE.health, 'readonly', async tx => {
      const row: HealthRow | undefined = await read(tx.objectStore(ASSISTANT_STORE.health).get(HEALTH_ID));
      return row ? normalizeHealthSnapshot(row.snapshot) : null;
    });
  }

  async saveHealth(input: unknown): Promise<boolean> {
    const snapshot = normalizeHealthSnapshot(input);
    return this.transaction(ASSISTANT_STORE.health, 'readwrite', async tx => {
      const store = tx.objectStore(ASSISTANT_STORE.health);
      const previous: HealthRow | undefined = await read(store.get(HEALTH_ID));
      if (previous && Date.parse(previous.snapshot.capturedAt) >= Date.parse(snapshot.capturedAt)) return false;
      store.put({id: HEALTH_ID, snapshot} satisfies HealthRow);
      return true;
    });
  }

  async appendEvent(input: unknown, dedupKey?: string): Promise<boolean> {
    const event = normalizeStoredEvent(input);
    const now = Date.now(), at = Date.parse(event.timestamp);
    if (!retained(at, now)) return false;
    const key = dedupKey === undefined ? null : await dedupId('event', dedupKey);
    return this.transaction([ASSISTANT_STORE.events, ASSISTANT_STORE.dedup], 'readwrite', async tx => {
      const events = tx.objectStore(ASSISTANT_STORE.events);
      const dedup = tx.objectStore(ASSISTANT_STORE.dedup);
      if (await read(events.getKey(event.eventId))) return false;
      const previous: DedupRow | undefined = key ? await read(dedup.get(key)) : undefined;
      if (previous && retained(previous.at, now)) return false;
      events.add(event);
      if (key) dedup.put({id: key, at: now} satisfies DedupRow);
      trimRows(events, await read(events.getAll()) as RuntimeEvent[], row => row.eventId, row => Date.parse(row.timestamp), RUNTIME_EVENT_LIMIT, now);
      if (key) trimRows(dedup, await read(dedup.getAll()) as DedupRow[], row => row.id, row => row.at, DEDUP_LIMIT, now);
      return true;
    });
  }

  async listEvents(filter: RuntimeEventFilter = {}): Promise<RuntimeEvent[]> {
    const now = Date.now();
    const limit = Number.isSafeInteger(filter.limit) ? Math.max(0, Math.min(RUNTIME_EVENT_LIMIT, filter.limit!)) : 100;
    const rows = await this.transaction(ASSISTANT_STORE.events, 'readonly', tx => read(tx.objectStore(ASSISTANT_STORE.events).getAll()));
    const events: RuntimeEvent[] = [];
    for (const raw of rows) {
      try {
        const event = normalizeStoredEvent(raw);
        if (!retained(Date.parse(event.timestamp), now)) continue;
        if (filter.date && event.timestamp.slice(0, 10) !== filter.date) continue;
        if (filter.task && event.relatedTask !== filter.task) continue;
        if (filter.seat && (typeof filter.seat === 'string' ? event.relatedSeat?.seatCode !== filter.seat : !sameSeat(event.relatedSeat, filter.seat))) continue;
        events.push(event);
      } catch { /* Invalid historical diagnostic data is not exported. */ }
    }
    return events.sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.eventId.localeCompare(left.eventId)).slice(0, limit);
  }

  async exportEvents(filter: RuntimeEventFilter = {}): Promise<RuntimeEvent[]> {
    return this.listEvents({limit: RUNTIME_EVENT_LIMIT, ...filter});
  }

  async clearEvents(): Promise<void> {
    await this.transaction(ASSISTANT_STORE.events, 'readwrite', async tx => { tx.objectStore(ASSISTANT_STORE.events).clear(); });
    // Keeping dedup claims prevents a history cleanup from re-sending previously delivered notices.
  }

  async getNotificationsEnabled(): Promise<boolean> {
    return this.transaction(ASSISTANT_STORE.settings, 'readonly', async tx => {
      const row: NotifyRow | undefined = await read(tx.objectStore(ASSISTANT_STORE.settings).get(NOTIFY_ID));
      return row?.enabled === true;
    });
  }

  async setNotificationsEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw Error('提醒开关无效');
    await this.transaction(ASSISTANT_STORE.settings, 'readwrite', async tx => {
      tx.objectStore(ASSISTANT_STORE.settings).put({id: NOTIFY_ID, enabled} satisfies NotifyRow);
    });
  }

  async claimNotification(key: string, at = Date.now()): Promise<boolean> {
    const now = Date.now();
    if (!retained(at, now)) return false;
    const id = await dedupId('notification', key);
    return this.transaction([ASSISTANT_STORE.settings, ASSISTANT_STORE.dedup], 'readwrite', async tx => {
      const settings = tx.objectStore(ASSISTANT_STORE.settings);
      const enabled: NotifyRow | undefined = await read(settings.get(NOTIFY_ID));
      if (enabled?.enabled !== true) return false;
      const store = tx.objectStore(ASSISTANT_STORE.dedup);
      const previous: DedupRow | undefined = await read(store.get(id));
      if (previous && retained(previous.at, now)) return false;
      store.put({id, at: now} satisfies DedupRow);
      trimRows(store, await read(store.getAll()) as DedupRow[], row => row.id, row => row.at, DEDUP_LIMIT, now);
      return true;
    });
  }

  async exportConfig(): Promise<AssistantBackup> {
    const payload = await this.transaction([ASSISTANT_STORE.settings, ASSISTANT_STORE.plans], 'readonly', async tx => {
      const settings = tx.objectStore(ASSISTANT_STORE.settings);
      const [prefs, notifications, plans]: [PreferenceRow | undefined, NotifyRow | undefined, AssistantPlan[]] = await Promise.all([
        read(settings.get(PREFS_ID)), read(settings.get(NOTIFY_ID)), read(tx.objectStore(ASSISTANT_STORE.plans).getAll()),
      ]);
      return normalizeBackupPayload({preferences: prefs?.preferences ?? null, plans, notificationsEnabled: notifications?.enabled === true});
    });
    return {schemaVersion: 1, kind: 'DLMU_ASSISTANT_CONFIG', exportedAt: beijingTimestamp(Date.now()), payload, sha256: await sha256(JSON.stringify(payload))};
  }

  async restoreConfig(value: unknown): Promise<void> {
    const backup = objectValue(value, '配置备份无效');
    if (backup.schemaVersion !== 1 || backup.kind !== 'DLMU_ASSISTANT_CONFIG' || typeof backup.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(backup.sha256) || typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt)) ||
        Object.keys(backup).some(key => !['schemaVersion', 'kind', 'exportedAt', 'payload', 'sha256'].includes(key))) throw Error('配置备份无效');
    const serialized = JSON.stringify(backup.payload);
    if (!serialized || serialized.length > BACKUP_LIMIT || await sha256(serialized) !== backup.sha256) throw Error('配置备份完整性校验失败');
    const payload = normalizeBackupPayload(backup.payload);
    await this.transaction([ASSISTANT_STORE.settings, ASSISTANT_STORE.plans], 'readwrite', async tx => {
      const plans = tx.objectStore(ASSISTANT_STORE.plans);
      const existing = await read(plans.getAllKeys());
      if (new Set([...existing, ...payload.plans.map(plan => plan.id)]).size > ASSISTANT_PLAN_LIMIT) throw Error('合并后的预约计划超过保存上限');
      for (const plan of payload.plans) plans.put(preparedPlan(plan));
      const settings = tx.objectStore(ASSISTANT_STORE.settings);
      if (payload.preferences) settings.put({id: PREFS_ID, preferences: payload.preferences} satisfies PreferenceRow);
      else settings.delete(PREFS_ID);
      settings.put({id: NOTIFY_ID, enabled: payload.notificationsEnabled} satisfies NotifyRow);
    });
  }

  async clearAssistantData(): Promise<void> {
    const stores = Object.values(ASSISTANT_STORE);
    await this.transaction(stores, 'readwrite', async tx => { for (const store of stores) tx.objectStore(store).clear(); });
  }
}
