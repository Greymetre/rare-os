// RCH-8: the rules that have to hold for a day's work to survive a day without network.
//
// The milestone's acceptance test is a whole beat in airplane mode, reconnected on a bad line,
// everything arriving exactly once. These tests are that sentence taken apart: what the phone
// queues, what it sends first, what it does when it is told nothing, what it does when it is
// told no, and what the rep sees when something will never go.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PREFIX,
  OUTBOX_KINDS,
  applyResult,
  cascadeBlocks,
  idMapOf,
  isLocalId,
  kindOf,
  parentOf,
  queueItem,
  queueSummary,
  readyToSend,
  resolveLinks,
  retryDelayMs,
} from '../packages/engines/sync-queue.mjs';

let counter = 0;
const ref = () => `ref-${++counter}`;
const local = () => `${LOCAL_PREFIX}id-${++counter}`;

// A rep's morning, in the order it happened, exactly as a phone would hold it.
function morning() {
  let seq = 0;
  const selfie = local();
  const visit = local();
  const order = local();
  const items = [
    queueItem({
      kind: 'attendance.start',
      localId: local(),
      clientRef: ref(),
      seq: seq++,
      payload: { work_type_id: 'wt-1', latitude: 28.6, longitude: 77.2 },
    }),
    queueItem({
      kind: 'file.upload',
      localId: selfie,
      clientRef: ref(),
      seq: seq++,
      payload: { purpose: 'selfie' },
    }),
    queueItem({
      kind: 'visit.checkin',
      localId: visit,
      clientRef: ref(),
      seq: seq++,
      payload: { customer_id: 'cust-1', file_id: selfie, latitude: 28.6, longitude: 77.2 },
    }),
    queueItem({
      kind: 'order.place',
      localId: order,
      clientRef: ref(),
      seq: seq++,
      payload: { customer_id: 'cust-1', visit_id: visit, lines: [{ item_id: 'i1', quantity: 3 }] },
    }),
    queueItem({
      kind: 'visit.checkout',
      localId: local(),
      clientRef: ref(),
      seq: seq++,
      payload: { visit_id: visit, version: 1, report: { answers: [] } },
    }),
  ];
  return { items, selfie, visit, order };
}

// ---------------------------------------------------------------------------

test('every kind that can be repeated into a second record carries a reference', () => {
  // This is the whole exactly-once promise stated as a property rather than trusted to care.
  // An order or a collection repeated is a second one; a day or a check-out repeated is refused
  // by the server's own uniqueness, which is why those need nothing.
  const needRef = ['order.place', 'receipt.collect', 'file.upload', 'visit.checkin'];
  for (const spec of OUTBOX_KINDS)
    assert.equal(spec.ref, needRef.includes(spec.kind), `${spec.kind} reference`);
});

test('a kind that needs no reference does not send one', () => {
  // The write routes reject unknown fields. A reference sent where it is not read would turn the
  // first retry into a 400 and block everything queued behind it.
  const start = queueItem({
    kind: 'attendance.start',
    localId: local(),
    clientRef: ref(),
    seq: 0,
    payload: { work_type_id: 'wt-1' },
  });
  assert.equal(Object.hasOwn(start.payload, 'client_ref'), false);
  const order = queueItem({
    kind: 'order.place',
    localId: local(),
    clientRef: 'abc',
    seq: 1,
    payload: { customer_id: 'c', lines: [] },
  });
  assert.equal(order.payload.client_ref, 'abc');
});

test('an item cannot be made without its own local id and reference', () => {
  assert.throws(
    () => queueItem({ kind: 'order.place', localId: 'plain-id', clientRef: 'r' }),
    /local id/,
  );
  assert.throws(
    () => queueItem({ kind: 'order.place', localId: local(), clientRef: '' }),
    /reference/,
  );
  assert.throws(
    () => queueItem({ kind: 'nonsense', localId: local(), clientRef: 'r' }),
    /Unknown kind/,
  );
});

// ---------------------------------------------------------------------------

test('the day goes up in the order it happened', () => {
  const { items } = morning();
  assert.deepEqual(
    readyToSend(items, { now: 0, limit: 10 }).map((i) => i.kind),
    // The order and the check-out wait: both point at a visit that has no server id yet, and the
    // check-in waits on the selfie it carries.
    ['attendance.start', 'file.upload'],
  );
});

test('work that refers to earlier work waits for it, then goes', () => {
  let { items, selfie, visit } = morning();
  const send = (localId, serverId) => {
    items = items.map((i) =>
      i.localId === localId ? applyResult(i, { ok: true, body: { id: serverId } }, { now: 1 }) : i,
    );
  };

  send(items[0].localId, 'day-1');
  assert.deepEqual(
    readyToSend(items, { now: 1, limit: 10 }).map((i) => i.kind),
    ['file.upload'],
  );

  send(selfie, 'file-1');
  // Now the check-in can go, but the order and check-out still cannot.
  assert.deepEqual(
    readyToSend(items, { now: 1, limit: 10 }).map((i) => i.kind),
    ['visit.checkin'],
  );

  send(visit, 'visit-1');
  assert.deepEqual(
    readyToSend(items, { now: 1, limit: 10 }).map((i) => i.kind),
    ['order.place', 'visit.checkout'],
  );
});

test('a local id is swapped for the real one before anything is sent', () => {
  let { items, visit } = morning();
  items = items.map((i) =>
    i.localId === visit ? applyResult(i, { ok: true, body: { id: 'visit-real' } }, { now: 1 }) : i,
  );
  const order = items.find((i) => i.kind === 'order.place');
  const out = resolveLinks({
    path: kindOf('order.place').path,
    payload: order.payload,
    idMap: idMapOf(items),
  });
  assert.equal(out.ready, true);
  assert.equal(out.path, 'reach/trade/customer/cust-1/order');
  assert.equal(out.payload.visit_id, 'visit-real');
  // The field that filled the path is not also sent in the body.
  assert.equal(Object.hasOwn(out.payload, 'customer_id'), false);
});

test('a reference that cannot be resolved is named, never guessed', () => {
  const { items } = morning();
  const order = items.find((i) => i.kind === 'order.place');
  const out = resolveLinks({ path: kindOf('order.place').path, payload: order.payload, idMap: {} });
  assert.equal(out.ready, false);
  assert.ok(out.missing.some(isLocalId));
  // Nothing was invented: the unresolved value is still the local id, not a blank or a zero.
  assert.ok(isLocalId(out.payload.visit_id));
});

test('resolving reaches inside lists and nested objects', () => {
  const photo = local();
  const out = resolveLinks({
    path: 'reach/visits/:visit_id/check-out',
    payload: { visit_id: 'v-real', report: { answers: [{ file_id: photo }, { file_id: null }] } },
    idMap: { [photo]: 'file-9' },
  });
  assert.equal(out.ready, true);
  assert.equal(out.payload.report.answers[0].file_id, 'file-9');
  assert.equal(out.payload.report.answers[1].file_id, null);
});

// ---------------------------------------------------------------------------

test('a request that died in the air is tried again, not given up on', () => {
  const { items } = morning();
  const after = applyResult(items[0], { ok: false, status: 0 }, { now: 1000 });
  assert.equal(after.state, 'QUEUED');
  assert.equal(after.attempts, 1);
  assert.ok(after.retryAfter > 1000);
});

test('a refusal the server understood is not tried again', () => {
  const { items } = morning();
  const order = items.find((i) => i.kind === 'order.place');
  const after = applyResult(
    order,
    { ok: false, status: 400, code: 'NO_PRICE', message: 'Some items have no price today.' },
    { now: 1000 },
  );
  assert.equal(after.state, 'BLOCKED');
  assert.equal(after.lastCode, 'NO_PRICE');
  assert.match(after.lastError, /no price/);
});

test('a busy server and a rate limit are waited out, not blocked', () => {
  const { items } = morning();
  for (const status of [408, 429, 500, 502, 503]) {
    const after = applyResult(items[0], { ok: false, status }, { now: 0 });
    assert.equal(after.state, 'QUEUED', `status ${status}`);
  }
});

test('"you already did that" is success, because for a retry it is', () => {
  const { items } = morning();
  const after = applyResult(
    items[0],
    {
      ok: false,
      status: 409,
      code: 'ALREADY_STARTED',
      message: 'Your day has already been started.',
    },
    { now: 1000 },
  );
  assert.equal(after.state, 'SENT');
  assert.equal(after.settled, true);
  // And a 409 that is *not* one of the server's settled codes still stops.
  const stale = applyResult(items[0], { ok: false, status: 409, code: 'STALE_RECORD' }, { now: 1 });
  assert.equal(stale.state, 'BLOCKED');
});

test('being signed out costs the item nothing', () => {
  const { items } = morning();
  const after = applyResult(
    items[0],
    { ok: false, status: 401, code: 'LOGIN_REQUIRED' },
    { now: 5 },
  );
  assert.equal(after.state, 'QUEUED');
  // Not counted as an attempt, and no backoff: it was never this item's fault, and once the app
  // has signed in again the whole queue should go at once rather than trickle.
  assert.equal(after.attempts, 0);
  assert.equal(after.needsSignIn, true);
  assert.equal(after.retryAfter, 5);
});

test('"you may not do this" stops; "sign in again" does not', () => {
  // These two arrive as the same status and mean opposite things. A permission refusal will
  // never succeed however many times it is sent, and calling it a sign-in problem would send
  // the rep back to the login screen again and again without ever saying the real reason.
  const { items } = morning();
  const denied = applyResult(
    items[0],
    { ok: false, status: 403, code: 'PERMISSION_DENIED', message: 'You do not have permission.' },
    { now: 5 },
  );
  assert.equal(denied.state, 'BLOCKED');
  assert.equal(denied.needsSignIn, undefined);
  assert.match(denied.lastError, /do not have permission/);

  for (const code of ['MFA_NOT_SUPPORTED_ON_DEVICE', 'ACCOUNT_UNAVAILABLE']) {
    const after = applyResult(items[0], { ok: false, status: 403, code }, { now: 5 });
    assert.equal(after.state, 'QUEUED', code);
    assert.equal(after.needsSignIn, true, code);
  }
});

test('backoff grows and then stops growing', () => {
  assert.equal(retryDelayMs(1), 5000);
  assert.equal(retryDelayMs(2), 10000);
  assert.equal(retryDelayMs(3), 20000);
  // A rep walks in and out of coverage all day; an hour-long backoff would strand the work.
  assert.equal(retryDelayMs(40), 5 * 60 * 1000);
});

test('an item still inside its backoff is not picked up', () => {
  let { items } = morning();
  items = [applyResult(items[0], { ok: false, status: 0 }, { now: 1000 }), ...items.slice(1)];
  assert.equal(readyToSend(items, { now: 1001, limit: 10 }).length, 1); // only the photo
  assert.equal(readyToSend(items, { now: 1000 + 6000, limit: 10 }).length, 2);
});

// ---------------------------------------------------------------------------

test('work waiting on refused work is blocked too, and says what it is waiting on', () => {
  let { items, visit } = morning();
  items = items.map((i) =>
    i.localId === visit
      ? applyResult(i, { ok: false, status: 404, code: 'RECORD_NOT_FOUND' }, { now: 1 })
      : i,
  );
  const settled = cascadeBlocks(items);
  const order = settled.find((i) => i.kind === 'order.place');
  const checkout = settled.find((i) => i.kind === 'visit.checkout');
  assert.equal(order.state, 'BLOCKED');
  assert.equal(order.lastCode, 'PARENT_BLOCKED');
  assert.match(order.lastError, /Check-in/);
  assert.equal(checkout.state, 'BLOCKED');
  // The day-start had nothing to do with the visit and is untouched.
  assert.equal(settled.find((i) => i.kind === 'attendance.start').state, 'QUEUED');
});

test('a block cascades down a whole chain, not just one step', () => {
  // The selfie fails, so the check-in that carries it can never go, so neither can the order
  // that points at the check-in.
  let { items, selfie } = morning();
  items = items.map((i) =>
    i.localId === selfie
      ? applyResult(i, { ok: false, status: 415, code: 'UNSUPPORTED' }, { now: 1 })
      : i,
  );
  const settled = cascadeBlocks(items);
  assert.deepEqual(
    settled.filter((i) => i.state === 'BLOCKED').map((i) => i.kind),
    ['file.upload', 'visit.checkin', 'order.place', 'visit.checkout'],
  );
});

test('nothing is ever quietly dropped', () => {
  const { items } = morning();
  const settled = cascadeBlocks(items);
  assert.equal(settled.length, items.length);
  for (const i of settled) assert.ok(['QUEUED', 'SENT', 'BLOCKED'].includes(i.state));
});

// ---------------------------------------------------------------------------

test('the rep is told in one sentence whether the day is in', () => {
  let { items, visit } = morning();
  assert.equal(queueSummary(items).headline, '5 items waiting to send');
  assert.equal(queueSummary(items).settled, false);

  const allSent = items.map((i) => applyResult(i, { ok: true, body: { id: 'x' } }, { now: 1 }));
  assert.equal(queueSummary(allSent).headline, 'Everything is sent');
  assert.equal(queueSummary(allSent).settled, true);
  assert.equal(queueSummary(allSent).blocked, 0);

  const broken = cascadeBlocks(
    items.map((i) =>
      i.localId === visit
        ? applyResult(
            i,
            { ok: false, status: 404, code: 'RECORD_NOT_FOUND', message: 'No such shop.' },
            { now: 1 },
          )
        : i,
    ),
  );
  const view = queueSummary(broken);
  assert.equal(view.headline, '3 items need your attention');
  // And each problem names itself in words a rep can act on.
  assert.deepEqual(
    view.problems.map((p) => p.title),
    ['Check-in', 'Order', 'Check-out'],
  );
  assert.match(view.problems[0].why, /No such shop/);
});

test('one blocked item does not strand the rest of the day', () => {
  // The order is refused on price. The check-out is not its child, and must still go.
  let { items, order } = morning();
  items = items.map((i) =>
    i.localId === order
      ? applyResult(i, { ok: false, status: 400, code: 'NO_PRICE' }, { now: 1 })
      : i,
  );
  const settled = cascadeBlocks(items);
  assert.equal(settled.find((i) => i.kind === 'visit.checkout').state, 'QUEUED');
});

// ---------------------------------------------------------------------------

test('a parent is read from the request that is actually sent', () => {
  // Storing the dependency separately would let it disagree with the payload. It is derived.
  const { items, visit } = morning();
  assert.equal(parentOf(items.find((i) => i.kind === 'order.place')), visit);
  assert.equal(parentOf(items.find((i) => i.kind === 'attendance.start')), null);
  // A real server id in that field is not a dependency — only a local one is.
  const placed = { kind: 'order.place', payload: { visit_id: 'a-real-uuid' } };
  assert.equal(parentOf(placed), null);
});

test('the map of local ids to real ones is built only from what actually went up', () => {
  let { items, visit } = morning();
  items = items.map((i) =>
    i.localId === visit ? applyResult(i, { ok: true, body: { id: 'visit-real' } }, { now: 1 }) : i,
  );
  const map = idMapOf(items);
  assert.deepEqual(map, { [visit]: 'visit-real' });
});
