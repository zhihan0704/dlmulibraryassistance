export const DAILY_DATABASE_NAME = 'dlmu-daily-booking-v2';
export const DAILY_DATABASE_VERSION = 2;

export const ASSISTANT_STORE = {
  settings: 'assistant-settings',
  plans: 'assistant-plans',
  health: 'runtime-health',
  events: 'runtime-events',
  dedup: 'runtime-dedup',
} as const;

const stores: ReadonlyArray<readonly [string, string]> = [
  ['state', 'id'], ['claims', 'id'],
  [ASSISTANT_STORE.settings, 'id'], [ASSISTANT_STORE.plans, 'id'], [ASSISTANT_STORE.health, 'id'],
  [ASSISTANT_STORE.events, 'eventId'], [ASSISTANT_STORE.dedup, 'id'],
];

// This map caches connections only. Tasks, claims, and preferences all remain in IndexedDB.
const connections = new Map<string, Promise<IDBDatabase>>();

export function openDailyDatabase(name = DAILY_DATABASE_NAME): Promise<IDBDatabase> {
  const existing = connections.get(name);
  if (existing) return existing;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, DAILY_DATABASE_VERSION);
    let abandoned = false;
    request.onblocked = () => {
      abandoned = true;
      reject(Error('旧页面仍在使用本地数据库，请关闭后重试。已有配置已保留。'));
    };
    request.onupgradeneeded = () => {
      if (abandoned) { request.transaction?.abort(); return; }
      for (const [store, keyPath] of stores) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, {keyPath});
      }
    };
    request.onerror = () => reject(Error('无法打开本地数据库。已有配置已保留。'));
    request.onsuccess = () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      const forget = () => { if (connections.get(name) === opened) connections.delete(name); };
      database.onversionchange = () => { database.close(); forget(); };
      database.onclose = forget;
      resolve(database);
    };
  });
  connections.set(name, opened);
  void opened.catch(() => { if (connections.get(name) === opened) connections.delete(name); });
  return opened;
}
