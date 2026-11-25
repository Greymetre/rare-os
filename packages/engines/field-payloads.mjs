// RCH-8: exactly what the field app sends, for each kind of work a rep can do.
//
// This file exists because of a specific kind of bug that nothing else in the system catches.
// Every write route builds its body with `body(req, [...])`, which **refuses a field it does not
// know**. That is a good rule — a mistyped field name becomes a visible refusal instead of a
// silently ignored value — but it means a payload that is one field too generous does not
// degrade, it fails outright. On a phone, where the failure surfaces at six in the evening as a
// blocked item, that costs a rep their day's orders.
//
// And the routes are not uniform, for real reasons:
//
//   * a receipt takes `latitude` and `longitude` but **no `accuracy_m`**, so the obvious
//     `{ ...fix }` is wrong in exactly one place out of five;
//   * a receipt carries **no visit**, because `trade_receipts` has no column for one;
//   * an order's shop is in the path, not the body, and its lines are `units`, not `quantity`;
//   * a check-out's report is an **object keyed by field**, which is what `validateAnswers`
//     reads, not a list of pairs;
//   * `source` is `DEVICE`, from the set `DEVICE|TYPED|PIN` — that column records how much the
//     location can be trusted, not what hardware produced it, so there is no `MOBILE`.
//
// Keeping the shapes here, pure, means `tests/field-payloads.test.mjs` can check every one of
// them against the route that receives it without a phone, a database or a container. That test
// is the dry run, and it runs in milliseconds.
//
// `client_ref` is deliberately absent from every payload below: `queueItem` in
// `sync-queue.mjs` attaches it, and only for the kinds whose route reads it.

// A fix as the location routes want it. Three fields, named the way the server names them.
function place(fix = {}) {
  return {
    latitude: fix.latitude ?? null,
    longitude: fix.longitude ?? null,
    accuracy_m: fix.accuracy_m ?? null,
  };
}

// The same fix for the one route that takes only two of the three.
function placeNoAccuracy(fix = {}) {
  return { latitude: fix.latitude ?? null, longitude: fix.longitude ?? null };
}

export const SOURCE = 'DEVICE';

export function dayStart({ workTypeId, fix, fileId = null, note } = {}) {
  const payload = { work_type_id: workTypeId, ...place(fix), source: SOURCE, file_id: fileId };
  if (note) payload.note = note;
  return payload;
}

export function dayEnd({ fix, version = 1 } = {}) {
  return { ...place(fix), source: SOURCE, version };
}

// Not a body at all: the photo's bytes are the body, and these two travel in the query string.
// `purpose` has to be one of the set `packages/engines/file-bytes.mjs` allows.
export function photo({ purpose = 'other', name = 'photo.jpg' } = {}) {
  return { purpose, name };
}

export function checkIn({ customerId, fix, fileId = null, note } = {}) {
  const payload = { customer_id: customerId, ...place(fix), source: SOURCE, file_id: fileId };
  if (note) payload.note = note;
  return payload;
}

// `customer_id` is here so that `resolveLinks` can fill `:customer_id` in the path; it deletes
// any field it used in the path, so it never reaches the body.
export function order({ customerId, visitId = null, lines = [], note } = {}) {
  const payload = {
    customer_id: customerId,
    visit_id: visitId,
    // `units`, not `quantity`. The basket reader names them units because an order line is a
    // count of selling units, and a line with `quantity` is refused.
    lines: lines.map((l) => ({ item_id: l.item_id, units: Number(l.units) })),
  };
  if (note) payload.note = note;
  return payload;
}

// A collection records no visit, and no accuracy. See the note at the top of this file.
export function receipt({
  customerId,
  amount,
  mode,
  reference = '',
  fix,
  invoiceId = null,
  receivedOn,
  fileId = null,
} = {}) {
  const payload = {
    customer_id: customerId,
    amount: Number(amount),
    mode,
    reference,
    invoice_id: invoiceId,
    file_id: fileId,
    ...placeNoAccuracy(fix),
  };
  if (receivedOn) payload.received_on = receivedOn;
  return payload;
}

export function checkOut({ visitId, version = 1, answers = {}, fix } = {}) {
  return {
    visit_id: visitId,
    version,
    // Keyed by field, which is the shape `validateAnswers` reads. A list of `{field_key, value}`
    // pairs is refused field by field and the rep never learns why.
    report: { ...answers },
    ...place(fix),
    source: SOURCE,
  };
}

// One place that maps a kind to its builder, so the test can walk every kind and be sure none
// was added to `OUTBOX_KINDS` without a shape and a check.
export const PAYLOAD_FOR = {
  'attendance.start': dayStart,
  'attendance.end': dayEnd,
  'file.upload': photo,
  'visit.checkin': checkIn,
  'order.place': order,
  'receipt.collect': receipt,
  'visit.checkout': checkOut,
};
