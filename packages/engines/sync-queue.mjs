// RCH-8: the rules a phone follows when it has a day's work in its pocket and no network.
//
// The milestone plan names one test and the whole of this file exists to pass it honestly: do a
// complete beat in airplane mode — check in, take an order, take a photo — then close the app,
// open it, join a bad network, and have every one of those things arrive exactly once.
//
// Four rules carry that.
//
// **The phone decides the reference, not the network.** Every piece of work is given a
// `clientRef` the moment the rep finishes it, on the device, before anything is sent. It never
// changes, however many times the item is retried. The server's write routes treat a repeat of a
// reference as the thing it already recorded. So "did my order get through?" is a question
// nobody has to answer: sending it again is free.
//
// **An unknown outcome is a retry, a known refusal is not.** A request that dies in the air
// leaves the phone with no idea whether the server acted. That is the normal case on a bad line,
// and the answer is always to send it again — which is safe, by the rule above. A 400 is the
// opposite: the server read the request, understood it, and refused. Sending that again a
// thousand times changes nothing, so it stops and the rep is told.
//
// **Work that refers to earlier work waits for it.** An order taken during a visit points at
// that visit, and while the phone is offline the visit has no real identity yet — only a local
// one. So the order waits until the visit has gone up and come back with a server id, and the
// local id in the order is swapped for the real one. Nothing is guessed and nothing is invented
// on the device: the only ids a phone makes up are its own, and they are marked as such.
//
// **The rep can see the queue.** A sync that fails silently is worse than no sync at all,
// because the rep goes home believing the day is in. Every item is in a state with a name, the
// counts are shown, and anything that stopped says why in words a person can act on.
//
// Pure: no database, no HTTP, no storage, no clock of its own. Everything comes in as an
// argument so that the whole of it can be tested without a phone.

// ---------------------------------------------------------------------------
// What a phone may queue
// ---------------------------------------------------------------------------

// A local id is a name the phone gave something before the server had ever heard of it. The
// prefix is not decoration: it is what makes an unresolved reference impossible to mistake for a
// real one, here, in a payload, in a log, or in a support conversation.
export const LOCAL_PREFIX = 'local:';

export const isLocalId = (v) => typeof v === 'string' && v.startsWith(LOCAL_PREFIX);

// The work a rep does in the field, and the route each one goes to. The phone holds nothing the
// server does not already accept from the web — this is the same API, called from a pocket.
//
// `dependsOn` names the payload field that may carry a local id.
//
// `ref` says whether this kind carries a device reference. It is true only where a repeat would
// otherwise become a second record: a rep may genuinely take two identical orders at one counter,
// and collect the same amount twice in a day, so nothing in the content can tell a retry apart.
// Where it is false the server is already unique by its own nature — one day per rep per date,
// one open visit per rep per shop — and sending a reference it does not read would be a field
// invented to look careful. The write routes reject unknown fields, so this is checked, not
// assumed.
//
// `settled` lists the refusals that mean "this already happened". The server is saying the work
// is in, which for a retry is success wearing a 409. These are the server's real codes; a
// mistake here would turn a success into a blocked item, or worse, a failure into a silent one.
export const OUTBOX_KINDS = [
  {
    kind: 'attendance.start',
    title: 'Day started',
    method: 'POST',
    path: 'reach/attendance/start',
    permission: 'reach.attend',
    ref: false,
    settled: ['ALREADY_STARTED'],
  },
  {
    kind: 'file.upload',
    title: 'Photo',
    method: 'POST',
    // The only kind that sends bytes rather than JSON. The reference travels in the query string
    // because the body is the photo itself.
    path: 'files',
    permission: 'files.upload',
    ref: true,
    binary: true,
    settled: [],
  },
  {
    kind: 'visit.checkin',
    title: 'Check-in',
    method: 'POST',
    path: 'reach/visits/check-in',
    permission: 'reach.visit',
    // RCH-4 built this one; the column has been there since the visit was written.
    ref: true,
    dependsOn: 'file_id',
    settled: [],
  },
  {
    kind: 'order.place',
    title: 'Order',
    method: 'POST',
    path: 'reach/trade/customer/:customer_id/order',
    permission: 'reach.order',
    ref: true,
    dependsOn: 'visit_id',
    settled: [],
  },
  {
    kind: 'receipt.collect',
    title: 'Collection',
    method: 'POST',
    path: 'reach/trade/customer/:customer_id/receipt',
    permission: 'reach.collect',
    ref: true,
    // No dependency, and that is not an oversight: a receipt has no visit column, so a
    // collection refers to nothing that has to exist first. It still travels after the
    // check-in, because the queue sends in the order the rep did things.
    settled: [],
  },
  {
    // The report travels with the check-out rather than as a request of its own: the server
    // accepts it in the same body, and one request cannot half-arrive the way two can.
    kind: 'visit.checkout',
    title: 'Check-out',
    method: 'POST',
    path: 'reach/visits/:visit_id/check-out',
    permission: 'reach.visit',
    ref: false,
    dependsOn: 'visit_id',
    settled: ['ALREADY_CLOSED'],
  },
  {
    kind: 'attendance.end',
    title: 'Day ended',
    method: 'POST',
    path: 'reach/attendance/end',
    permission: 'reach.attend',
    ref: false,
    // ALREADY_ENDED means the day is in. NOT_STARTED is deliberately absent: it means the day was
    // never opened, which is a real problem the rep must see, not a repeat to swallow.
    settled: ['ALREADY_ENDED'],
  },
];

const BY_KIND = new Map(OUTBOX_KINDS.map((k) => [k.kind, k]));

export const kindOf = (kind) => BY_KIND.get(kind) ?? null;

// ---------------------------------------------------------------------------
// The states an item can be in
// ---------------------------------------------------------------------------

// QUEUED   — made on the phone, not yet accepted by the server.
// SENT     — the server took it. Terminal, and the only state that means the work is in.
// BLOCKED  — the server refused it in a way that retrying cannot fix, or the work it depends on
//            was refused. Terminal until a person does something. Never silently dropped.
export const OUTBOX_STATES = ['QUEUED', 'SENT', 'BLOCKED'];

// ---------------------------------------------------------------------------
// When to try again
// ---------------------------------------------------------------------------

// Backoff doubles and then stops growing. The ceiling is deliberately low — a rep walking
// between shops passes in and out of coverage every few minutes, and an hour-long backoff would
// mean a day's work sitting in a pocket long after the network came back. The app also retries
// immediately when the device reports it is online again, so this only governs a line that is
// present but failing.
export const FIRST_RETRY_MS = 5 * 1000;
export const MAX_RETRY_MS = 5 * 60 * 1000;

export function retryDelayMs(attempts) {
  const n = Math.max(0, Math.floor(Number(attempts) || 0));
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, n - 1));
}

// ---------------------------------------------------------------------------
// Swapping local ids for real ones
// ---------------------------------------------------------------------------

// An item is only ever sent with real identities. This walks the path and the payload, replaces
// every local id with the server id the earlier item came back with, and says plainly when one
// is still missing rather than sending a `local:` string to the server and hoping.
export function resolveLinks({ path = '', payload = {}, idMap = {} }) {
  const missing = [];
  const swap = (value) => {
    if (!isLocalId(value)) return value;
    const real = idMap[value];
    if (!real) {
      missing.push(value);
      return value;
    }
    return real;
  };

  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return swap(value);
  };

  const resolvedPayload = walk(payload);

  // The path carries ids too — `reach/visits/:visit_id/check-out` is filled from the payload, and
  // a field used in the path is not also sent in the body.
  const used = [];
  const resolvedPath = String(path).replace(/:([a-z_]+)/g, (whole, field) => {
    if (!Object.hasOwn(resolvedPayload, field)) {
      missing.push(whole);
      return whole;
    }
    used.push(field);
    return String(resolvedPayload[field]);
  });
  for (const field of used) delete resolvedPayload[field];

  return { path: resolvedPath, payload: resolvedPayload, missing, ready: missing.length === 0 };
}

// ---------------------------------------------------------------------------
// What goes up next
// ---------------------------------------------------------------------------

// Ready means: still queued, its backoff has passed, and everything it refers to is already in.
//
// Order is creation order, always. A rep's day reads as a sequence and it arrives as one, so the
// register and the visit list tell the same story as the rep's own memory of the morning.
export function readyToSend(items = [], { now = Date.now(), limit = 1 } = {}) {
  const sent = new Set(items.filter((i) => i.state === 'SENT').map((i) => i.localId));
  const ordered = [...items].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const out = [];
  for (const item of ordered) {
    if (item.state !== 'QUEUED') continue;
    if (Number(item.retryAfter ?? 0) > now) continue;
    // A parent that is blocked is also a parent that is not sent, so one test covers both. What
    // happens to the child is `cascadeBlocks`'s business, not this function's.
    const parent = parentOf(item);
    if (parent && !sent.has(parent)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// The one thing this item waits for, if it waits for anything. Reading it from the payload rather
// than storing it twice means the dependency can never disagree with the request that is sent.
export function parentOf(item) {
  const spec = kindOf(item?.kind);
  if (!spec || !spec.dependsOn) return null;
  const value = item.payload?.[spec.dependsOn];
  return isLocalId(value) ? value : null;
}

// ---------------------------------------------------------------------------
// What a response does to an item
// ---------------------------------------------------------------------------

// Everything the phone learns from one attempt, turned into the item's next state. This is the
// rule that decides whether a day's work survives a bad network, so it is written as one readable
// table rather than spread through the app.
//
// `result` is either `{ ok: true, status, body }` or `{ ok: false, status, code, message }`, and
// a request that never arrived is `{ ok: false, status: 0 }`.
// The refusals that mean "this sign-in will not do", as opposed to "you may not do this".
// Everything the API raises when the identity itself is the problem, and nothing else.
const SIGN_IN_CODES = [
  'LOGIN_REQUIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'SESSION_CHANGED',
  'ACCOUNT_UNAVAILABLE',
  'MFA_NOT_SUPPORTED_ON_DEVICE',
  'PLATFORM_ACCESS_CHANGED',
];

export function applyResult(item, result, { now = Date.now() } = {}) {
  const spec = kindOf(item.kind);
  const attempts = Number(item.attempts ?? 0) + 1;

  if (result?.ok) {
    return {
      ...item,
      state: 'SENT',
      attempts,
      sentAt: now,
      serverId: result.body?.id ?? null,
      lastError: '',
      retryAfter: 0,
    };
  }

  const status = Number(result?.status ?? 0);
  const code = String(result?.code ?? '');

  // The server saying "that is already done" is the server saying the work is in. On a first
  // attempt it would be a genuine mistake, but a retry cannot tell the difference and does not
  // need to: either way the record exists, which is all the rep was promised.
  if (spec && spec.settled.includes(code)) {
    return {
      ...item,
      state: 'SENT',
      attempts,
      sentAt: now,
      serverId: item.serverId ?? null,
      lastError: '',
      retryAfter: 0,
      settled: true,
    };
  }

  // Signed out, or the session moved on. Not this item's fault and not counted against it: the
  // app signs in again and the whole queue is tried from the top.
  //
  // A 403 is only one of these when it is about the sign-in itself. A plain "you do not have
  // permission" is the opposite case — the rep will never be allowed to send that item, and
  // treating it as a sign-in problem would bounce them to the login screen again and again
  // while the real reason sat unsaid. Those fall through and are blocked, like any other
  // refusal the server understood.
  if (status === 401 || (status === 403 && SIGN_IN_CODES.includes(code)))
    return {
      ...item,
      state: 'QUEUED',
      attempts: Number(item.attempts ?? 0),
      lastError: result?.message || 'Sign in again to send this.',
      retryAfter: now,
      needsSignIn: true,
    };

  // Understood and refused. More tries will not help; a person has to change something.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return {
      ...item,
      state: 'BLOCKED',
      attempts,
      lastError: result?.message || 'The server would not accept this.',
      lastCode: code,
      retryAfter: 0,
    };

  // Nothing arrived, the line is busy, or the server is having a bad minute. Try again later.
  return {
    ...item,
    state: 'QUEUED',
    attempts,
    lastError:
      result?.message || (status === 0 ? 'No network yet — still waiting.' : 'The server is busy.'),
    lastCode: code,
    retryAfter: now + retryDelayMs(attempts),
  };
}

// An item that can never be sent because the work it belongs to was refused. Left queued it would
// retry for ever against a parent that is never coming; blocked it is visible, and it carries the
// reason from the thing that actually failed.
export function cascadeBlocks(items = []) {
  const byId = new Map(items.map((i) => [i.localId, i]));
  const ordered = [...items].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const out = new Map(items.map((i) => [i.localId, i]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of ordered) {
      const current = out.get(item.localId);
      if (current.state !== 'QUEUED') continue;
      const parentId = parentOf(current);
      if (!parentId) continue;
      const parent = out.get(parentId) ?? byId.get(parentId);
      if (parent && parent.state === 'BLOCKED') {
        out.set(item.localId, {
          ...current,
          state: 'BLOCKED',
          lastError: `Waiting on ${kindOf(parent.kind)?.title ?? 'earlier work'}, which could not be sent.`,
          lastCode: 'PARENT_BLOCKED',
          retryAfter: 0,
        });
        changed = true;
      }
    }
  }
  return ordered.map((i) => out.get(i.localId));
}

// ---------------------------------------------------------------------------
// What the rep is shown
// ---------------------------------------------------------------------------

// The queue screen in one object. A rep should be able to glance at a phone and know whether the
// day is in, so this answers that first and explains second.
export function queueSummary(items = []) {
  const queued = items.filter((i) => i.state === 'QUEUED');
  const blocked = items.filter((i) => i.state === 'BLOCKED');
  const sent = items.filter((i) => i.state === 'SENT');
  return {
    total: items.length,
    queued: queued.length,
    sent: sent.length,
    blocked: blocked.length,
    // The one sentence at the top of the screen.
    headline: blocked.length
      ? `${blocked.length} ${blocked.length === 1 ? 'item needs' : 'items need'} your attention`
      : queued.length
        ? `${queued.length} ${queued.length === 1 ? 'item' : 'items'} waiting to send`
        : 'Everything is sent',
    settled: items.every((i) => i.state === 'SENT'),
    problems: blocked.map((i) => ({
      localId: i.localId,
      kind: i.kind,
      title: kindOf(i.kind)?.title ?? i.kind,
      why: i.lastError || 'The server would not accept this.',
      code: i.lastCode ?? '',
    })),
  };
}

// ---------------------------------------------------------------------------
// Making an item
// ---------------------------------------------------------------------------

// The only way an item is created. The reference is minted here, once, and the caller supplies
// it rather than this file reaching for a global — a phone's crypto and a test's counter are both
// legitimate sources, and neither belongs in an engine.
export function queueItem({ kind, payload = {}, localId, clientRef, seq, now = Date.now() }) {
  const spec = kindOf(kind);
  if (!spec) throw Error(`Unknown kind of work: ${kind}`);
  if (!localId || !isLocalId(localId))
    throw Error(`A queued item needs its own local id beginning "${LOCAL_PREFIX}".`);
  if (!clientRef)
    throw Error('A queued item needs a client reference, or a retry could duplicate it.');
  return {
    localId,
    kind,
    seq: Number(seq ?? 0),
    // The reference only goes into the request for the kinds whose route reads it. The write
    // routes refuse unknown fields, so sending it everywhere would turn the first retry of a
    // day-start into a 400 and block the rep's whole morning behind it.
    payload: spec.ref ? { ...payload, client_ref: clientRef } : { ...payload },
    clientRef,
    state: 'QUEUED',
    attempts: 0,
    retryAfter: 0,
    createdAt: now,
    sentAt: null,
    serverId: null,
    lastError: '',
    lastCode: '',
  };
}

// After an item is accepted, anything that was waiting on it can be filled in. Built fresh from
// the queue each time rather than kept as state, so it can never drift from what actually went up.
export function idMapOf(items = []) {
  const map = {};
  for (const item of items)
    if (item.state === 'SENT' && item.serverId) map[item.localId] = item.serverId;
  return map;
}
