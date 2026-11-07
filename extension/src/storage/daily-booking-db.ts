import type {DailyBookingConfig, DailyPhase} from '../core/daily-booking-scheduler';
import {DAILY_DATABASE_NAME, openDailyDatabase} from './daily-database';

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
  session?: DailySessionGate;
}

export interface DailySessionGate {lostAt: number; verifiedAt?: number}
interface SessionRow extends DailySessionGate {id: 'daily-session'}
interface Claim {
  id: string;
  token: string;
  until: number;
  revision?: string;
  reads?: number;
  closed?: boolean;
  effects?: {navigation?: true; reminder?: true};
}
const STATE_ID = 'daily-fixed-seat';
const SESSION_ID = 'daily-session';
const READ_LIMIT = 8;
const LEASE_MS = 15_000;
const RECHECK_DELAY_MS = 3_000;

// A pre-2.1 claim may already have produced these effects. Treat an unknown delivery as consumed.
function effectsFor(claim: Claim): NonNullable<Claim['effects']> {
  return claim.effects ?? {navigation: true, reminder: true};
}

function ownsClaim(state: DailyState | undefined, claim: Claim | undefined, revision: string, token: string, now: number): claim is Claim {
  return state?.revision === revision && state.config.enabled && claim?.token === token && claim.until > now;
}

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
  constructor(private readonly name = DAILY_DATABASE_NAME) {}

  private get database(): Promise<IDBDatabase> { return openDailyDatabase(this.name); }

  async get(): Promise<DailyState | undefined> {
    const store = (await this.database).transaction('state').objectStore('state');
    const [state, session]: [DailyState | undefined, SessionRow | undefined] = await Promise.all([
      request(store.get(STATE_ID)), request(store.get(SESSION_ID)),
    ]);
    return state && {...state, session: session && {lostAt: session.lostAt, verifiedAt: session.verifiedAt}};
  }

  async session(): Promise<DailySessionGate | undefined> {
    const session: SessionRow | undefined = await request((await this.database).transaction('state').objectStore('state').get(SESSION_ID));
    return session && {lostAt: session.lostAt, verifiedAt: session.verifiedAt};
  }

  async configure(config: DailyBookingConfig): Promise<DailyState> {
    const tx = (await this.database).transaction('state', 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore('state');
    const previous: DailyState | undefined = await request(store.get(STATE_ID));
    const sameTarget = previous && (Object.keys(config.target) as Array<keyof DailyBookingConfig['target']>)
      .every(key => config.target[key] === previous.config.target[key]);
    const state: DailyState = {
      id: STATE_ID, revision: crypto.randomUUID(), config, result: sameTarget ? previous.result : null,
    };
    store.put(state);
    // Keep same-day effect claims even after re-binding. The exact target key is independent of the revision.
    await done;
    return state;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const tx = (await this.database).transaction('state', 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore('state');
    const state: DailyState | undefined = await request(store.get(STATE_ID));
    if (state && state.config.enabled !== enabled) store.put({...state, revision: crypto.randomUUID(), config: {...state.config, enabled}});
    await done;
  }

  async markSessionLost(now: number): Promise<boolean> {
    const tx = (await this.database).transaction('state', 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore('state');
    const [state, previous]: [DailyState | undefined, SessionRow | undefined] = await Promise.all([
      request(store.get(STATE_ID)), request(store.get(SESSION_ID)),
    ]);
    const changed = !previous || previous.verifiedAt !== undefined;
    if (changed) {
      const lostAt = Math.max(now, (previous?.verifiedAt ?? now - 1) + 1);
      store.put({id: SESSION_ID, lostAt} satisfies SessionRow);
      if (state) store.put({...state, revision: crypto.randomUUID()});
    }
    await done;
    return changed;
  }

  async confirmSession(lostAt: number, observedAt: number): Promise<boolean> {
    const tx = (await this.database).transaction('state', 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore('state');
    const [state, gate]: [DailyState | undefined, SessionRow | undefined] = await Promise.all([
      request(store.get(STATE_ID)), request(store.get(SESSION_ID)),
    ]);
    const accepted = gate?.lostAt === lostAt && gate.verifiedAt === undefined && Number.isSafeInteger(observedAt) && observedAt > lostAt;
    if (accepted) {
      store.put({id: SESSION_ID, lostAt, verifiedAt: observedAt} satisfies SessionRow);
      if (state) store.put({...state, revision: crypto.randomUUID()});
    }
    await done;
    return accepted;
  }

  // Expiry can recover only a bounded read. One-shot effects are tracked independently of the lease.
  async claim(revision: string, key: string, now: number): Promise<string | null> {
    const tx = (await this.database).transaction(['state', 'claims'], 'readwrite');
    const done = completed(tx);
    const state: DailyState | undefined = await request(tx.objectStore('state').get(STATE_ID));
    const store = tx.objectStore('claims');
    const current: Claim | undefined = await request(store.get(key));
    const reads = current ? current.reads ?? 1 : 0;
    const held = current && (!current.revision || current.revision === revision) && current.until > now;
    const token = state?.revision === revision && state.config.enabled && !current?.closed && reads < READ_LIMIT && !held
      ? crypto.randomUUID() : null;
    if (token) store.put({id: key, token, revision, until: now + LEASE_MS, reads: reads + 1, effects: current ? effectsFor(current) : {}} satisfies Claim);
    await done;
    return token;
  }

  async reserveNavigation(revision: string, key: string, token: string, now: number): Promise<boolean> {
    const tx = (await this.database).transaction(['state', 'claims'], 'readwrite');
    const done = completed(tx);
    const states = tx.objectStore('state');
    const [state, gate]: [DailyState | undefined, SessionRow | undefined] = await Promise.all([
      request(states.get(STATE_ID)), request(states.get(SESSION_ID)),
    ]);
    const store = tx.objectStore('claims');
    const claim: Claim | undefined = await request(store.get(key));
    const accepted = ownsClaim(state, claim, revision, token, now) && !effectsFor(claim).navigation &&
      (!gate || gate.verifiedAt !== undefined);
    if (accepted && claim) store.put({...claim, effects: {...effectsFor(claim), navigation: true}} satisfies Claim);
    await done;
    return accepted;
  }

  async finish(revision: string, key: string, token: string, result: DailyResult, now: number, notifyOpening: boolean): Promise<{saved: boolean; reminder: boolean}> {
    const tx = (await this.database).transaction(['state', 'claims'], 'readwrite');
    const done = completed(tx);
    const states = tx.objectStore('state');
    const claims = tx.objectStore('claims');
    const state: DailyState | undefined = await request(states.get(STATE_ID));
    const current: Claim | undefined = await request(claims.get(key));
    const saved = ownsClaim(state, current, revision, token, now);
    let reminder = false;
    if (saved && current) {
      const effects = effectsFor(current);
      reminder = notifyOpening && result.phase === 'OPEN' && !effects.reminder;
      const exhausted = result.pending && (current.reads ?? 1) >= READ_LIMIT;
      const pending = !!result.pending && !exhausted;
      states.put({...state, result: exhausted ? {...result, pending: false, message: `${result.message} 本次复核已达上限，请人工核对。`} : result});
      claims.put({
        ...current, closed: !pending, until: pending ? now + RECHECK_DELAY_MS : now,
        effects: reminder ? {...effects, reminder: true} : effects,
      } satisfies Claim);
      const keys = await request(claims.getAllKeys());
      // Only current-day phase claims are relevant to this single configured task.
      for (const old of keys) if (typeof old === 'string' && !old.startsWith(`${result.day}|`)) claims.delete(old);
    }
    await done;
    return {saved, reminder};
  }
}
