import type {DailyBookingConfig, DailyPhase} from '../core/daily-booking-scheduler';

export interface DailyResult {
  phase: DailyPhase;
  day: string;
  targetDate: string;
  at: number;
  message: string;
  pending?: boolean;
}

export interface DailyState {
  id: 'daily-fixed-seat';
  revision: string;
  config: DailyBookingConfig;
  result: DailyResult | null;
}

interface Claim {id: string; token: string; until: number}
const STATE_ID = 'daily-fixed-seat';

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? Error('每日任务存储失败'));
  });
}

export class DailyBookingRepository {
  private readonly database: Promise<IDBDatabase>;

  constructor(name = 'dlmu-daily-booking-v2') {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('state', {keyPath: 'id'});
      open.result.createObjectStore('claims', {keyPath: 'id'});
    };
    this.database = request(open);
  }

  async get(): Promise<DailyState | undefined> {
    return request((await this.database).transaction('state').objectStore('state').get(STATE_ID));
  }

  async configure(config: DailyBookingConfig): Promise<DailyState> {
    const tx = (await this.database).transaction(['state', 'claims'], 'readwrite');
    const done = completed(tx);
    const state: DailyState = {id: STATE_ID, revision: crypto.randomUUID(), config, result: null};
    tx.objectStore('state').put(state);
    tx.objectStore('claims').clear();
    await done;
    return state;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const tx = (await this.database).transaction('state', 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore('state');
    const state: DailyState | undefined = await request(store.get(STATE_ID));
    if (state) store.put({...state, config: {...state.config, enabled}});
    await done;
  }

  // An expiring claim may recover a read after a worker crash. It cannot authorize a write.
  async claim(revision: string, key: string, now: number): Promise<string | null> {
    const tx = (await this.database).transaction(['state', 'claims'], 'readwrite');
    const done = completed(tx);
    const state: DailyState | undefined = await request(tx.objectStore('state').get(STATE_ID));
    const store = tx.objectStore('claims');
    const current: Claim | undefined = await request(store.get(key));
    const token = state?.revision === revision && state.config.enabled && !(current && current.until > now)
      ? crypto.randomUUID() : null;
    if (token) store.put({id: key, token, until: now + 15_000} satisfies Claim);
    await done;
    return token;
  }

  async finish(revision: string, key: string, token: string, result: DailyResult, until: number): Promise<void> {
    const tx = (await this.database).transaction(['state', 'claims'], 'readwrite');
    const done = completed(tx);
    const states = tx.objectStore('state');
    const claims = tx.objectStore('claims');
    const state: DailyState | undefined = await request(states.get(STATE_ID));
    const current: Claim | undefined = await request(claims.get(key));
    if (state?.revision === revision && state.config.enabled && current?.token === token) {
      states.put({...state, result});
      claims.put({...current, until});
      const keys = await request(claims.getAllKeys());
      // Only current-day phase claims are relevant to this single configured task.
      for (const old of keys) if (typeof old === 'string' && !old.startsWith(`${result.day}|`)) claims.delete(old);
    }
    await done;
  }
}
