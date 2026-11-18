// RCH-4: what a visit to a shop counts as.
//
// This is the path the milestone plan calls the heart of Reach, and the handover is explicit
// that it has to be solid on the server before a mobile app is written against it. Three rules
// shape everything here.
//
// **A check-in is never refused.** A rep standing 800 metres from the shop is recorded and
// flagged, not turned away: refusing it loses a real visit and teaches the salesman to distrust
// the app. The distance is evidence; what a company does about it is a decision taken later, by
// a person, with the evidence in front of them.
//
// **The same check-in sent three times is one visit.** A field connection drops and the app
// retries. A visit is identified by the rep, the shop and the moment — not by how many times the
// network managed to deliver it — so a repeat is answered with the visit that already exists.
//
// **How a visit reads is calculated, never stored.** Whether the report is complete is judged
// against the form as it stands now, so adding a required question makes the older reports say
// they are missing it instead of quietly passing. The duration is read from the two timestamps
// for the same reason.
// Pure: no database, no HTTP.

import { metresBetween } from './geo.mjs';

// OPEN is checked in and not yet out. SHORT is a visit that ended sooner than the customer type
// says a real call takes. DONE is the rest.
export const VISIT_STATUSES = ['OPEN', 'SHORT', 'DONE'];

// Where a check-in happened, measured against the shop's own tagged location.
//
// A shop that has never been tagged, or a device that gave no fix, leaves the distance unknown.
// Unknown is not a breach: it is reported as unknown and the visit stands. Only a measured
// distance beyond the type's own radius is flagged.
export function fenceVerdict({ customer, at, radius }) {
  const tagged =
    customer &&
    customer.latitude !== null &&
    customer.latitude !== undefined &&
    customer.longitude !== null &&
    customer.longitude !== undefined;
  const fixed = at && at.latitude !== null && at.latitude !== undefined;
  if (!tagged || !fixed) return { distance_m: null, out_of_fence: false, known: false };

  const away = metresBetween(
    { latitude: Number(customer.latitude), longitude: Number(customer.longitude) },
    { latitude: Number(at.latitude), longitude: Number(at.longitude) },
  );
  if (away === null) return { distance_m: null, out_of_fence: false, known: false };
  const limit = Number(radius);
  return {
    distance_m: Math.round(away),
    out_of_fence: Number.isFinite(limit) ? Math.round(away) > limit : false,
    known: true,
  };
}

// Is this check-in the one that is already recorded?
//
// A visit still open for the same shop is always the same visit: a rep cannot be inside one shop
// twice. After check-out, a repeat that arrives within the company's retry window is still the
// same visit — that is the dropped connection, not a second call. Beyond the window it is a
// genuine second visit and gets its own row.
//
// `clientRef` short-circuits all of it: an app that sends the same reference twice means the same
// visit, whatever the clock says. That is what makes a retry safe on a bad line.
export function duplicateOf({ candidates = [], clientRef = '', at, withinMinutes = 10 }) {
  const ref = String(clientRef ?? '').trim();
  if (ref) {
    const byRef = candidates.find((v) => String(v.client_ref ?? '') === ref);
    if (byRef) return byRef;
  }
  const open = candidates.find((v) => !v.checked_out_at);
  if (open) return open;

  const now = Date.parse(at ?? '');
  if (Number.isNaN(now)) return null;
  const window = Math.max(0, Number(withinMinutes)) * 60000;
  if (!window) return null;
  return (
    candidates.find((v) => {
      const started = Date.parse(v.checked_in_at ?? '');
      return !Number.isNaN(started) && Math.abs(now - started) <= window;
    }) ?? null
  );
}

// How long the rep stayed, in whole minutes, or null while the visit is still open.
export function stayMinutes(checkedIn, checkedOut) {
  if (!checkedOut) return null;
  const from = Date.parse(checkedIn ?? ''),
    to = Date.parse(checkedOut);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.round((to - from) / 60000);
}

// Which of the form's questions this report has not answered.
//
// Judged against the form as it stands now, which is the point: a company that adds a required
// question tomorrow sees today's reports say they are missing it, instead of a stored "complete"
// that stopped being true.
export function missingAnswers(form = [], report = {}) {
  return form
    .filter((field) => field.required)
    .filter((field) => {
      const given = (report ?? {})[field.field_key];
      if (given === undefined || given === null) return true;
      // `false` is an answer to a yes/no question; an empty string is not an answer to anything.
      if (typeof given === 'boolean') return false;
      return String(given).trim() === '';
    })
    .map((field) => field.field_key);
}

// Everything about one visit that is read rather than stored.
export function visitVerdict({ visit, form = [], minMinutes = 0 }) {
  const minutes = stayMinutes(visit.checked_in_at, visit.checked_out_at);
  const missing = missingAnswers(form, visit.report);
  const floor = Number(minMinutes) || 0;
  const status = !visit.checked_out_at
    ? 'OPEN'
    : minutes !== null && minutes < floor
      ? 'SHORT'
      : 'DONE';
  return {
    status,
    minutes,
    missing,
    report_complete: missing.length === 0,
    out_of_fence: visit.out_of_fence === true,
    distance_m:
      visit.distance_m === null || visit.distance_m === undefined ? null : Number(visit.distance_m),
  };
}

// A day of calls, as the day list and the field app read it.
export function daySummary(rows = []) {
  const totals = Object.fromEntries(VISIT_STATUSES.map((s) => [s, 0]));
  let outOfFence = 0,
    incomplete = 0,
    minutes = 0,
    timed = 0;
  for (const row of rows) {
    totals[row.status] = (totals[row.status] ?? 0) + 1;
    if (row.out_of_fence) outOfFence += 1;
    if (!row.report_complete) incomplete += 1;
    if (row.minutes !== null) {
      minutes += row.minutes;
      timed += 1;
    }
  }
  return {
    visits: rows.length,
    totals,
    outOfFence,
    incomplete,
    minutes,
    averageMinutes: timed ? Math.round(minutes / timed) : null,
  };
}

// The round as the field app draws it: every stop the plan asked for, each carrying whatever has
// happened at it today, and then any shop called on that the plan never named.
//
// A stop nobody planned is never dropped. The plan is what was intended; the visit is what
// happened, and RCH-3 reads the difference without either one editing the other.
export function fieldDay({ stops = [], visits = [] }) {
  const byCustomer = new Map();
  for (const visit of visits) {
    const key = String(visit.customer_id);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(visit);
  }

  const planned = stops.map((stop) => {
    const made = byCustomer.get(String(stop.customer_id)) ?? [];
    byCustomer.delete(String(stop.customer_id));
    return { ...stop, planned: true, visits: made, status: made[0]?.status ?? 'PENDING' };
  });

  const extra = [...byCustomer.values()].map((made) => ({
    customer_id: made[0].customer_id,
    code: made[0].customer ?? '',
    name: made[0].customer_name ?? '',
    sequence: null,
    planned: false,
    visits: made,
    status: made[0].status,
  }));

  return {
    stops: [...planned, ...extra],
    done: planned.filter((s) => s.visits.length).length,
    planned: planned.length,
    unplanned: extra.length,
    open: visits.find((v) => v.status === 'OPEN') ?? null,
  };
}
