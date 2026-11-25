// RCH-8: the dry run.
//
// The field app's payloads are checked against the routes that receive them, by reading the
// controllers. Nothing is mocked and nothing is assumed: the accepted field names come out of
// the same `body(req, [...])` call the server actually uses, so renaming a field on either side
// turns this red.
//
// Why this test exists in this shape: RCH-8 was first built without it, and four separate
// payload faults reached a full Docker regression run before anyone saw them — a field the
// receipt route does not accept, a report sent as a list instead of an object, `quantity` for
// `units`, and a column name that did not exist. Each cost a cycle of roughly half an hour.
// Every one of them is a string comparison, and this file makes them string comparisons.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { OUTBOX_KINDS, kindOf, queueItem } from '../packages/engines/sync-queue.mjs';
import { PAYLOAD_FOR } from '../packages/engines/field-payloads.mjs';
import { FILE_PURPOSES } from '../packages/engines/file-bytes.mjs';

const CONTROLLERS = [
  'apps/api/src/reach-attendance.controller.ts',
  'apps/api/src/reach-visit.controller.ts',
  'apps/api/src/reach-trade.controller.ts',
  'apps/api/src/reach.controller.ts',
];

// A route is matched on its shape, not on its parameter names: the engine calls the order route
// `reach/trade/customer/:customer_id/order` because that is the field it fills it from, while
// NestJS calls the same route `:id`. Normalising both to `:p` compares the thing that matters.
const shapeOf = (path) => String(path).replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');

// Every write route in the controllers, as { shape, method, keys }. Read straight from the
// source, including the multi-line `body(req, [...])` lists.
function routesFromControllers() {
  const routes = [];
  for (const file of CONTROLLERS) {
    const source = readFileSync(file, 'utf8');
    const decorator = /@(Post|Put|Patch)\('([^']+)'\)/g;
    let match;
    while ((match = decorator.exec(source))) {
      const [, verb, path] = match;
      // The body list belongs to this route if it is the first one after the decorator and
      // before the next decorator.
      const rest = source.slice(match.index);
      const nextDecorator = rest.slice(1).search(/@(Post|Put|Patch|Get|Delete)\('/);
      const block = nextDecorator === -1 ? rest : rest.slice(0, nextDecorator + 1);
      const bodyCall = /body\(\s*req\s*,\s*\[([\s\S]*?)\]/.exec(block);
      const keys = bodyCall ? [...bodyCall[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : null;
      routes.push({ shape: shapeOf(path), method: verb.toUpperCase(), keys, path, file });
    }
  }
  return routes;
}

const ROUTES = routesFromControllers();

function routeFor(spec) {
  const shape = shapeOf(spec.path);
  const found = ROUTES.filter((r) => r.shape === shape && r.method === spec.method);
  assert.equal(
    found.length,
    1,
    `${spec.kind}: expected exactly one ${spec.method} route shaped ${shape}, found ${found.length}`,
  );
  return found[0];
}

// A payload with every optional field filled in, so the check is against the widest thing the
// app can send rather than the narrowest.
const SAMPLE = {
  'attendance.start': () =>
    PAYLOAD_FOR['attendance.start']({
      workTypeId: 'w1',
      fix: { latitude: 1, longitude: 2, accuracy_m: 3 },
      fileId: 'f1',
      note: 'a note',
    }),
  'attendance.end': () =>
    PAYLOAD_FOR['attendance.end']({
      fix: { latitude: 1, longitude: 2, accuracy_m: 3 },
      version: 2,
    }),
  'file.upload': () => PAYLOAD_FOR['file.upload']({ purpose: 'shelf', name: 'shelf.jpg' }),
  'visit.checkin': () =>
    PAYLOAD_FOR['visit.checkin']({
      customerId: 'c1',
      fix: { latitude: 1, longitude: 2, accuracy_m: 3 },
      fileId: 'f1',
      note: 'a note',
    }),
  'order.place': () =>
    PAYLOAD_FOR['order.place']({
      customerId: 'c1',
      visitId: 'v1',
      lines: [{ item_id: 'i1', units: 2 }],
      note: 'a note',
    }),
  'receipt.collect': () =>
    PAYLOAD_FOR['receipt.collect']({
      customerId: 'c1',
      amount: 100,
      mode: 'CASH',
      reference: 'r1',
      fix: { latitude: 1, longitude: 2, accuracy_m: 3 },
      invoiceId: 'inv1',
      receivedOn: '2026-11-25',
      fileId: 'f1',
    }),
  'visit.checkout': () =>
    PAYLOAD_FOR['visit.checkout']({
      visitId: 'v1',
      version: 2,
      answers: { shelf_share: '20' },
      fix: { latitude: 1, longitude: 2, accuracy_m: 3 },
    }),
};

describe('RCH-8 the field app sends only fields its routes accept', () => {
  it('every kind of work has a payload shape, and every shape has a kind', () => {
    const kinds = OUTBOX_KINDS.map((k) => k.kind).sort();
    assert.deepEqual(Object.keys(PAYLOAD_FOR).sort(), kinds);
    assert.deepEqual(Object.keys(SAMPLE).sort(), kinds);
  });

  for (const spec of OUTBOX_KINDS) {
    it(`${spec.kind} → ${spec.method} ${spec.path}`, () => {
      const route = routeFor(spec);
      const payload = SAMPLE[spec.kind]();

      // A photo is not a body: its bytes are. Its two fields go in the query string, and what
      // matters is that the purpose is one the file engine allows.
      if (spec.binary) {
        assert.equal(route.keys, null, `${spec.kind}: the upload route should read no JSON body`);
        assert.ok(
          FILE_PURPOSES.includes(payload.purpose),
          `${spec.kind}: purpose ${payload.purpose} is not one of ${FILE_PURPOSES.join(', ')}`,
        );
        return;
      }

      assert.ok(route.keys, `${spec.kind}: no body(req, [...]) found in ${route.file}`);

      // Fields the path consumes never reach the body, so they are not expected in the list.
      const inPath = [...String(spec.path).matchAll(/:([a-z_]+)/g)].map((m) => m[1]);
      const sent = Object.keys(payload).filter((k) => !inPath.includes(k));

      for (const field of sent)
        assert.ok(
          route.keys.includes(field),
          `${spec.kind} sends "${field}", which ${route.method} ${route.path} does not accept ` +
            `(it reads ${route.keys.join(', ')}). body() refuses unknown fields, so this would ` +
            `block the item instead of ignoring the value.`,
        );

      // Every field the path needs must be somewhere in the payload, or the item can never be
      // addressed at all.
      for (const field of inPath)
        assert.ok(
          Object.hasOwn(payload, field),
          `${spec.kind}: the path needs :${field} and the payload has no such field`,
        );
    });
  }

  it('the reference is attached only where the route reads it', () => {
    for (const spec of OUTBOX_KINDS) {
      const item = queueItem({
        kind: spec.kind,
        payload: SAMPLE[spec.kind](),
        localId: 'local:1',
        clientRef: 'ref-1',
      });
      const route = routeFor(spec);
      if (spec.ref && route.keys)
        assert.ok(
          route.keys.includes('client_ref'),
          `${spec.kind} is marked as carrying a reference, but ${route.path} does not read one`,
        );
      if (!spec.ref)
        assert.equal(
          item.payload.client_ref,
          undefined,
          `${spec.kind} must not carry client_ref: ${route.path} would refuse it`,
        );
    }
  });

  it('a collection carries no visit and no accuracy, because its table has neither', () => {
    const payload = SAMPLE['receipt.collect']();
    assert.equal(payload.visit_id, undefined);
    assert.equal(payload.accuracy_m, undefined);
    assert.equal(kindOf('receipt.collect').dependsOn, undefined);
  });

  it('an order line is units, and the check-out report is keyed by field', () => {
    const order = SAMPLE['order.place']();
    assert.deepEqual(Object.keys(order.lines[0]).sort(), ['item_id', 'units']);
    const out = SAMPLE['visit.checkout']();
    assert.equal(typeof out.report, 'object');
    assert.ok(!Array.isArray(out.report));
  });

  it('the location source is one the server allows', () => {
    const allowed = ['DEVICE', 'TYPED', 'PIN'];
    for (const kind of ['attendance.start', 'attendance.end', 'visit.checkin', 'visit.checkout'])
      assert.ok(allowed.includes(SAMPLE[kind]().source), `${kind}: bad source`);
  });
});
