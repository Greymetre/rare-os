// RCH-8: the part that actually sends the day, and the only part that talks to the network.
//
// Every rule about what goes first, what waits, what is retried and what has stopped lives in
// `packages/engines/sync-queue.mjs`, which is pure and has its own tests. This file is the hands:
// it reads the queue out of IndexedDB, asks the engine what may go, puts it on the wire, hands
// the answer back to the engine, and writes the result down. It decides nothing.
//
// That split is deliberate and it is what makes the offline promise testable at all. A rule you
// can only exercise by flying a phone to a market is a rule nobody checks.
//
// One thing here is subtle enough to say out loud: **items go up one at a time, in order.** It
// would be faster to send five at once, and it would also mean that when the line dies halfway
// the phone has five unknown outcomes instead of one, several of which may refer to each other.
// A rep's day is a sequence of a few dozen things; sending them in the order they happened costs
// a second and removes a whole category of bug.

import {
  applyResult,
  cascadeBlocks,
  idMapOf,
  kindOf,
  queueSummary,
  readyToSend,
  resolveLinks,
} from '../../../packages/engines/sync-queue.mjs';
import { accessToken } from './auth';
import { allItems, putItems, type Queued } from './store';

const API = '/api/';

export type SyncOutcome = {
  sent: number;
  blocked: number;
  queued: number;
  offline: boolean;
  needsSignIn: boolean;
  headline: string;
};

// What one request to the server came back as, in the shape the engine understands. Everything
// that is not an answer from the server — no line, a timeout, DNS — is status 0, which the
// engine reads as "unknown outcome, try again".
async function send(item: Queued, token: string, idMap: Record<string, string>): Promise<any> {
  const spec = kindOf(item.kind);
  if (!spec) return { ok: false, status: 400, code: 'UNKNOWN_KIND', message: 'Unknown work.' };

  // The map comes from the pass that is running, not from storage. Storage is only written when
  // the pass ends, so reading it here would mean an order could never learn the id of the
  // check-in that went up moments earlier — the queue would advance one step per pass and then
  // sit, with nothing blocked and nothing to show for it.
  const resolved = resolveLinks({ path: spec.path, payload: item.payload, idMap });
  // Should not happen — the engine does not offer an item whose parent is unsent — but sending a
  // `local:` string to the server would be far worse than refusing to.
  //
  // It is returned as a skip rather than as a refusal. A refusal would be a 4xx, and a 4xx is
  // how the engine is told "this will never work", which would permanently block a real order
  // over what is only meant to be a safety net.
  if (!resolved.ready) return { skip: true as const };

  let url = API + resolved.path;
  const headers: Record<string, string> = { authorization: 'Bearer ' + token };
  let body: BodyInit | undefined;

  if (spec.binary) {
    // A photo. The bytes are the body, so the reference and what the photo is for travel in the
    // query string instead.
    const query = new URLSearchParams({
      purpose: String(item.payload.purpose ?? 'other'),
      ref: item.clientRef,
    });
    if (item.payload.name) query.set('name', String(item.payload.name));
    url += '?' + query.toString();
    headers['content-type'] = item.contentType || 'application/octet-stream';
    body = item.blob;
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(resolved.payload);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: spec.method, headers, body });
  } catch {
    return { ok: false, status: 0 };
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.ok) return { ok: true, status: res.status, body: payload ?? {} };
  return {
    ok: false,
    status: res.status,
    code: payload?.code ?? payload?.error?.code ?? '',
    message: payload?.message ?? payload?.error?.message ?? '',
  };
}

// One pass over the queue. Called when the app opens, when the browser says the network is back,
// when the rep taps "send now", and on a slow timer while anything is waiting.
//
// `ignoreBackoff` throws away the waiting period the failed attempts built up. The backoff
// exists for a line that is present and failing; it is the wrong thing entirely in the two cases
// that pass this flag. A rep who taps "Send now" is owed an attempt, not a button that appears
// to do nothing for two minutes — and a day spent in airplane mode ends with every item several
// failures deep, so without this the first thing a rep sees on getting signal is a queue that
// sits there. The browser announcing the network is back is the same: the thing the backoff was
// waiting out has just ended.
export async function syncOnce({ ignoreBackoff = false } = {}): Promise<SyncOutcome> {
  let items = cascadeBlocks(await allItems<Queued>()) as Queued[];
  if (ignoreBackoff) items = items.map((i) => (i.state === 'QUEUED' ? { ...i, retryAfter: 0 } : i));
  const idle = () => {
    const view = queueSummary(items);
    return {
      sent: view.sent,
      blocked: view.blocked,
      queued: view.queued,
      offline: false,
      needsSignIn: false,
      headline: view.headline,
    };
  };

  if (!items.some((i) => i.state === 'QUEUED')) {
    await putItems(items);
    return idle();
  }

  let token: string | null;
  try {
    token = await accessToken();
  } catch {
    await putItems(items);
    return { ...idle(), needsSignIn: true, headline: 'Sign in again to send your work' };
  }
  // No token and no error means the refresh could not be reached: the rep is offline, which is
  // the normal state, not a problem to report in red.
  if (!token) {
    await putItems(items);
    return { ...idle(), offline: true, headline: 'Waiting for a network' };
  }

  const changed = new Map<string, Queued>();
  // A ceiling on one pass, so that a very long queue still yields to the screen between batches
  // rather than freezing the app for a minute.
  for (let n = 0; n < 50; n += 1) {
    const [next] = readyToSend(items, { now: Date.now(), limit: 1 });
    if (!next) break;
    const result = await send(next, token, idMapOf(items));
    // Nothing was sent and nothing was learned, so the item is left exactly as it was. Stopping
    // the pass is right: the thing it is waiting for is not going to appear mid-loop.
    if (result.skip) break;
    const after = applyResult(next, result, { now: Date.now() }) as Queued;
    items = cascadeBlocks(items.map((i) => (i.localId === after.localId ? after : i))) as Queued[];
    for (const i of items) changed.set(i.localId, i);

    if (after.needsSignIn) {
      await putItems([...changed.values()]);
      return { ...idle(), needsSignIn: true, headline: 'Sign in again to send your work' };
    }
    // Nothing arrived. There is no point walking the rest of the queue into the same silence.
    if (!result.ok && result.status === 0) {
      await putItems([...changed.values()]);
      return { ...idle(), offline: true, headline: 'Waiting for a network' };
    }
  }

  await putItems([...changed.values()]);
  return idle();
}

// Tell the server what this phone is still carrying. Never blocks the rep and never fails
// loudly: if it does not get through, the only thing lost is a line on an administrator's
// screen, and the work itself is unaffected.
export async function heartbeat(deviceRef: string, appVersion: string) {
  const items = await allItems<Queued>();
  const view = queueSummary(items);
  let token: string | null = null;
  try {
    token = await accessToken();
  } catch {
    return;
  }
  if (!token) return;
  await fetch(API + 'reach/device/heartbeat', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({
      device_ref: deviceRef,
      platform: navigator.platform || 'web',
      app_version: appVersion,
      queued: view.queued,
      blocked: view.blocked,
    }),
  }).catch(() => undefined);
}

// Fetch the whole day in one request. Returns null when there is no line, so the caller falls
// back to what is already stored rather than showing an error over a perfectly good cached day.
export async function fetchDay(): Promise<any | null> {
  let token: string | null;
  try {
    token = await accessToken();
  } catch {
    return null;
  }
  if (!token) return null;
  try {
    const res = await fetch(API + 'reach/device/day', {
      headers: { authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
