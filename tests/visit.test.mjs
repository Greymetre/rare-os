import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISIT_STATUSES,
  daySummary,
  duplicateOf,
  fenceVerdict,
  fieldDay,
  missingAnswers,
  stayMinutes,
  visitVerdict,
} from '../packages/engines/visit.mjs';
import { customerForm } from '../packages/engines/customer-form.mjs';
import { MASTER_KINDS, validateMaster } from '../packages/schema/masters.mjs';
import { IMPORT_KINDS, templateCsv } from '../packages/schema/imports.mjs';
import { permissions, requiredPermissions } from '../packages/schema/permissions.mjs';

// A shop in Rohtak, tagged. The retailer type asks a check-in to be within 75 metres.
const shop = { latitude: 28.8955, longitude: 76.6066 };

// Roughly 800 metres north of it: the milestone's own second acceptance case.
const farAway = { latitude: 28.9027, longitude: 76.6066 };
const atTheDoor = { latitude: 28.8955, longitude: 76.6067 };

const report = (rows) =>
  customerForm(
    rows ?? [
      {
        field_key: 'shelf_share',
        name: 'Shelf share',
        input: 'number',
        section: 'Shelf',
        display_order: 10,
        requirement: 'R',
      },
      {
        field_key: 'competitor',
        name: 'Competitor seen',
        input: 'text',
        section: 'Shelf',
        display_order: 20,
        requirement: 'O',
      },
    ],
  );

test('the milestone acceptance: 800 metres away still becomes a visit, and it is flagged', () => {
  const far = fenceVerdict({ customer: shop, at: farAway, radius: 75 });
  // The distance is measured and kept. Nothing here refuses the check-in: refusing it would
  // lose a real visit and teach the salesman to distrust the app.
  assert.equal(far.known, true);
  assert.ok(far.distance_m > 700 && far.distance_m < 900, `800m, got ${far.distance_m}`);
  assert.equal(far.out_of_fence, true);

  // At the door it is inside the radius and carries no flag.
  const near = fenceVerdict({ customer: shop, at: atTheDoor, radius: 75 });
  assert.equal(near.out_of_fence, false);
  assert.ok(near.distance_m < 75);

  // The same spot judged by a distributor's wider radius is not out of its fence.
  assert.equal(fenceVerdict({ customer: shop, at: farAway, radius: 5000 }).out_of_fence, false);
});

test('an untagged shop or a device with no fix leaves the distance unknown, never a breach', () => {
  for (const [customer, at] of [
    [{ latitude: null, longitude: null }, atTheDoor],
    [shop, { latitude: null, longitude: null }],
    [null, atTheDoor],
    [shop, null],
  ]) {
    const verdict = fenceVerdict({ customer, at, radius: 75 });
    assert.deepEqual(verdict, { distance_m: null, out_of_fence: false, known: false });
  }
});

test('the milestone acceptance: the same check-in sent three times is one visit', () => {
  const at = '2026-03-09T11:00:00.000Z';
  const existing = {
    id: 'visit-1',
    customer_id: 'shop-1',
    checked_in_at: at,
    checked_out_at: null,
    client_ref: '',
  };
  // The second and third attempt both find the visit that is already open.
  for (const attempt of [1, 2]) {
    const found = duplicateOf({ candidates: [existing], at, withinMinutes: 10 });
    assert.equal(found?.id, 'visit-1', `attempt ${attempt} made a second visit`);
  }
  // A retry that arrives after the check-out, but inside the retry window, is still the same
  // call — that is the dropped connection, not a second visit to the shop.
  const closed = { ...existing, checked_out_at: '2026-03-09T11:12:00.000Z' };
  assert.equal(
    duplicateOf({ candidates: [closed], at: '2026-03-09T11:05:00.000Z', withinMinutes: 10 })?.id,
    'visit-1',
  );
  // Beyond the window it is a genuine second call and gets its own row.
  assert.equal(
    duplicateOf({ candidates: [closed], at: '2026-03-09T16:00:00.000Z', withinMinutes: 10 }),
    null,
  );
});

test('an app that sends the same reference twice means the same visit, whatever the clock says', () => {
  const closed = {
    id: 'visit-9',
    checked_in_at: '2026-03-09T09:00:00.000Z',
    checked_out_at: '2026-03-09T09:20:00.000Z',
    client_ref: 'phone-abc',
  };
  assert.equal(
    duplicateOf({
      candidates: [closed],
      clientRef: 'phone-abc',
      at: '2026-03-09T18:00:00.000Z',
      withinMinutes: 10,
    })?.id,
    'visit-9',
  );
  // A different reference is a different visit, even at the same moment.
  assert.equal(
    duplicateOf({
      candidates: [closed],
      clientRef: 'phone-xyz',
      at: '2026-03-09T18:00:00.000Z',
      withinMinutes: 10,
    }),
    null,
  );
  // No window at all means no time-based matching; only an open visit or a reference counts.
  assert.equal(
    duplicateOf({ candidates: [closed], at: '2026-03-09T09:01:00.000Z', withinMinutes: 0 }),
    null,
  );
});

test('how long the rep stayed is read from the two timestamps, not stored', () => {
  assert.equal(stayMinutes('2026-03-09T11:00:00Z', '2026-03-09T11:18:00Z'), 18);
  assert.equal(stayMinutes('2026-03-09T11:00:00Z', null), null, 'an open visit has no duration');
  assert.equal(
    stayMinutes('2026-03-09T11:00:00Z', '2026-03-09T10:00:00Z'),
    null,
    'time does not run backwards',
  );
  assert.equal(stayMinutes('not a time', '2026-03-09T11:18:00Z'), null);
});

test('a report is judged against the form as it stands now', () => {
  const form = report();
  assert.deepEqual(missingAnswers(form, { shelf_share: 40 }), []);
  assert.deepEqual(missingAnswers(form, {}), ['shelf_share']);
  // An optional question left blank is not missing; a required one left blank is.
  assert.deepEqual(missingAnswers(form, { shelf_share: 40, competitor: '' }), []);
  assert.deepEqual(missingAnswers(form, { shelf_share: '   ' }), ['shelf_share']);
  // `false` is an answer to a yes/no question, and must not read as a blank.
  const yesNo = customerForm([
    { field_key: 'stock_out', name: 'Stock out', input: 'bool', requirement: 'R' },
  ]);
  assert.deepEqual(missingAnswers(yesNo, { stock_out: false }), []);

  // Adding a required question tomorrow makes today's report say it is missing it, rather than
  // a stored "complete" that has stopped being true.
  const tightened = report([
    {
      field_key: 'shelf_share',
      name: 'Shelf share',
      input: 'number',
      requirement: 'R',
    },
    { field_key: 'competitor', name: 'Competitor seen', input: 'text', requirement: 'R' },
  ]);
  assert.deepEqual(missingAnswers(tightened, { shelf_share: 40 }), ['competitor']);
});

test('a visit reads as open, short or done, and says why', () => {
  const form = report();
  const base = {
    checked_in_at: '2026-03-09T11:00:00Z',
    report: { shelf_share: 40 },
    out_of_fence: false,
    distance_m: 20,
  };

  const open = visitVerdict({ visit: { ...base, checked_out_at: null }, form, minMinutes: 5 });
  assert.equal(open.status, 'OPEN');
  assert.equal(open.minutes, null);

  // Two minutes in a shop whose type says a real call takes five.
  const short = visitVerdict({
    visit: { ...base, checked_out_at: '2026-03-09T11:02:00Z' },
    form,
    minMinutes: 5,
  });
  assert.equal(short.status, 'SHORT');
  assert.equal(short.minutes, 2);

  const done = visitVerdict({
    visit: { ...base, checked_out_at: '2026-03-09T11:20:00Z' },
    form,
    minMinutes: 5,
  });
  assert.deepEqual(
    [done.status, done.minutes, done.report_complete, done.out_of_fence, done.distance_m],
    ['DONE', 20, true, false, 20],
  );

  // A visit with a flag and a gap in its report says both.
  const flagged = visitVerdict({
    visit: {
      ...base,
      checked_out_at: '2026-03-09T11:20:00Z',
      report: {},
      out_of_fence: true,
      distance_m: 812,
    },
    form,
    minMinutes: 5,
  });
  assert.deepEqual(
    [flagged.report_complete, flagged.missing, flagged.out_of_fence, flagged.distance_m],
    [false, ['shelf_share'], true, 812],
  );
  // Every status a screen can be handed is one the engine declares.
  for (const v of [open, short, done, flagged]) assert.ok(VISIT_STATUSES.includes(v.status));
});

test('a day of calls adds up, and an unfinished one is counted as unfinished', () => {
  const rows = [
    { status: 'DONE', minutes: 20, report_complete: true, out_of_fence: false },
    { status: 'DONE', minutes: 10, report_complete: false, out_of_fence: true },
    { status: 'SHORT', minutes: 2, report_complete: true, out_of_fence: false },
    { status: 'OPEN', minutes: null, report_complete: false, out_of_fence: false },
  ];
  const day = daySummary(rows);
  assert.equal(day.visits, 4);
  assert.deepEqual([day.totals.DONE, day.totals.SHORT, day.totals.OPEN], [2, 1, 1]);
  assert.equal(day.outOfFence, 1);
  assert.equal(day.incomplete, 2);
  // The open visit has no duration, so it is not in the average.
  assert.equal(day.minutes, 32);
  assert.equal(day.averageMinutes, 11);
  assert.equal(daySummary([]).averageMinutes, null);
});

test('the field app draws the planned round and never drops a call nobody planned', () => {
  const stops = [
    { customer_id: 'c1', code: 'C01', name: 'Shop 1', sequence: 1 },
    { customer_id: 'c2', code: 'C02', name: 'Shop 2', sequence: 2 },
    { customer_id: 'c3', code: 'C03', name: 'Shop 3', sequence: 3 },
  ];
  const visits = [
    { customer_id: 'c1', status: 'DONE', customer: 'C01', customer_name: 'Shop 1' },
    { customer_id: 'c9', status: 'OPEN', customer: 'C09', customer_name: 'Walk-in' },
  ];
  const day = fieldDay({ stops, visits });
  assert.equal(day.planned, 3);
  assert.equal(day.done, 1);
  assert.equal(day.unplanned, 1);
  // The round keeps its order, and a stop with nothing at it yet is pending, not missing.
  assert.deepEqual(
    day.stops.slice(0, 3).map((s) => s.status),
    ['DONE', 'PENDING', 'PENDING'],
  );
  // The shop nobody planned is on the list, marked as unplanned rather than discarded.
  const extra = day.stops[3];
  assert.equal(extra.planned, false);
  assert.equal(extra.code, 'C09');
  // The visit still open is handed to the screen so it can offer the check-out.
  assert.equal(day.open.customer_id, 'c9');
  assert.equal(fieldDay({ stops, visits: [] }).open, null);
});

test('the visit report form is a master like any other, and imports through the same engine', () => {
  for (const kind of ['visit_form_fields', 'visit_form_rules']) {
    const def = MASTER_KINDS[kind];
    assert.ok(def, `${kind} is not registered`);
    assert.equal(def.module, 'Reach', kind);
    assert.equal(def.permission, 'reach.setup', kind);
    assert.equal(def.softDelete, true, kind);
    assert.ok(templateCsv(kind).includes('\r\n'), `${kind} has no CSV template`);
    assert.equal(IMPORT_KINDS[kind].permission, 'reach.setup', kind);
  }
  // A choice question with no choices is unanswerable, the same rule the customer form holds.
  assert.deepEqual(
    validateMaster('visit_form_fields', {
      field_key: 'mood',
      name: 'Mood',
      input: 'select',
    }).errors.map((e) => e.column),
    ['options'],
  );
  const ok = validateMaster('visit_form_fields', {
    field_key: 'shelf_share',
    name: 'Shelf share',
    input: 'number',
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(MASTER_KINDS.visit_form_fields.key(ok.value), 'shelf_share');
});

test('the visit permissions exist and rest only on permissions that exist', () => {
  const codes = new Set(permissions.map(([code]) => code));
  assert.ok(codes.has('reach.visit'));
  for (const need of requiredPermissions['reach.visit'] ?? [])
    assert.ok(codes.has(need), `reach.visit needs ${need}, which does not exist`);
  // Calling on your own shops is not a management right, so it drags nothing in with it: a rep
  // with reach.read would also get every other rep's visits.
  assert.equal(requiredPermissions['reach.visit'], undefined);
});
