// RCH-8: where a day lives while there is no network.
//
// The acceptance test says the app is closed and reopened before anything is sent, so none of
// this can live in memory and none of it can live in `localStorage` either — a day's photos
// would blow through its few megabytes, and it has no transactions, so a write interrupted by
// the operating system killing a backgrounded app can tear.
//
// IndexedDB is the only thing in a browser that is both large enough and transactional. It is
// used here directly, with no wrapper library, because what it is asked to do is small: three
// stores, read all, write one, delete one.
//
// Two stores hold things that must survive a reboot, and one holds a thing that must not:
//
//   `outbox`  — the rep's unsent work. Losing a row here loses a real order.
//   `day`     — what was downloaded at the depot, so the round can be worked with no signal.
//   `auth`    — the refresh token.
//
// On the refresh token: it is in IndexedDB rather than an httpOnly cookie, and that is a real
// trade, not an oversight. A cookie cannot survive the twelve-hour gap this app exists to cover,
// and script that can read this storage could equally drive the app. What it buys is that a rep
// who works all day out of coverage still syncs at six without signing in again. The mitigations
// are elsewhere and real: the access token lives five minutes, the client is its own, and
// signing a device out revokes it server-side.

const DB_NAME = 'rare-field';
const DB_VERSION = 1;
export const OUTBOX = 'outbox';
export const DAY = 'day';
export const AUTH = 'auth';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // `localId` is the key because it is the one name for a piece of work that exists from the
      // moment the rep finishes it, before the server has ever heard of it.
      if (!db.objectStoreNames.contains(OUTBOX))
        db.createObjectStore(OUTBOX, { keyPath: 'localId' });
      if (!db.objectStoreNames.contains(DAY)) db.createObjectStore(DAY);
      if (!db.objectStoreNames.contains(AUTH)) db.createObjectStore(AUTH);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = fn(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const putItem = (item: unknown) => run<IDBValidKey>(OUTBOX, 'readwrite', (s) => s.put(item));
export const allItems = <T>() => run<T[]>(OUTBOX, 'readonly', (s) => s.getAll());
export const dropItem = (localId: string) =>
  run<undefined>(OUTBOX, 'readwrite', (s) => s.delete(localId));

export const readDay = <T>(key: string) => run<T | undefined>(DAY, 'readonly', (s) => s.get(key));
export const writeDay = (key: string, value: unknown) =>
  run<IDBValidKey>(DAY, 'readwrite', (s) => s.put(value, key));

export const readAuth = <T>(key: string) => run<T | undefined>(AUTH, 'readonly', (s) => s.get(key));
export const writeAuth = (key: string, value: unknown) =>
  run<IDBValidKey>(AUTH, 'readwrite', (s) => s.put(value, key));
export const clearAuth = () => run<undefined>(AUTH, 'readwrite', (s) => s.clear());

// Several items at once, in one transaction. The sync runner saves the whole queue after a pass,
// and doing that as twenty separate transactions would leave the queue half-updated if the app
// were killed in the middle — which, on a phone, is a thing that happens rather than a thing to
// hope about.
export async function putItems(items: unknown[]): Promise<void> {
  if (!items.length) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OUTBOX, 'readwrite');
    const store = tx.objectStore(OUTBOX);
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// A photo is kept as a Blob on the item itself. IndexedDB stores Blobs natively, so the bytes
// never become a base64 string — which would make them a third larger and have to be decoded
// again before sending.
export type Queued = {
  localId: string;
  kind: string;
  seq: number;
  payload: Record<string, unknown>;
  clientRef: string;
  state: 'QUEUED' | 'SENT' | 'BLOCKED';
  attempts: number;
  retryAfter: number;
  createdAt: number;
  sentAt: number | null;
  serverId: string | null;
  lastError: string;
  lastCode: string;
  settled?: boolean;
  needsSignIn?: boolean;
  blob?: Blob;
  contentType?: string;
  label?: string;
};
