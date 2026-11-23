// RCH-6: what a rep spent on the road, and what the policy allows of it.
//
// Four ideas shape this file.
//
// **The amount is calculated, never stored** — the same rule the register, the plan, the visit
// and the outstanding are built on. What is kept is what the rep said: the date, the kilometres,
// the nights, the town and the money they are asking for. What the policy makes of that is worked
// out again every time anybody looks.
//
// That is only safe because of the second idea. **A policy version may only start in the future,
// and once it has started it cannot be edited.** Recalculating last fortnight's claim therefore
// always gives last fortnight's answer, and an amount somebody has already approved can never
// move under them. The future-dated rule is not bureaucracy; it is what lets the amount stay
// calculated.
//
// **Attendance and the tour plan decide, not the claim.** A day the register says the rep was not
// at work earns no daily allowance, whatever the claim says. And the town is taken from the plan
// the rep walked, falling back to what they typed only where the plan is silent — otherwise a rep
// could type a far-off town and earn the higher rate for a day spent at headquarters.
//
// **Over the limit is capped, not refused.** The client's answer to question 10. The line is kept
// with what was asked and what is allowed side by side, so an approver sees the difference rather
// than a number that quietly shrank.
//
// Pure: no database, no HTTP.

import { datesBetween } from './attendance.mjs';

// How a category turns a rep's line into money.
export const EXPENSE_BASES = ['KM', 'DAILY', 'NIGHTLY', 'ACTUAL'];
// Where the day was spent. The daily allowance is a different rate for each.
export const PLACE_CLASSES = ['HQ', 'EX_HQ', 'OUTSTATION'];
export const CLAIM_STATUSES = ['DRAFT', 'SUBMITTED', 'MANAGER_OK', 'APPROVED', 'REJECTED'];
// The two stages of approval. They are separate rights and, by rule, separate people.
export const APPROVAL_STAGES = ['MANAGER', 'FINANCE'];

// A day the register settles as "not at work". The plan's own acceptance case is the second of
// these: a day on leave earns no daily allowance.
//
// A week-off and a holiday are here because the register says the rep was not at work on them.
// Note that RCH-2 settles those two before it looks at a punch, so a rep who did work on their
// week-off still reads WEEK_OFF and earns nothing here. That is RCH-2's shape showing through,
// not a decision taken in this file.
export const NOT_AT_WORK = ['ABSENT', 'LEAVE', 'WEEK_OFF', 'HOLIDAY'];

// Why a line is not simply what was asked for. Each is a sentence a screen prints as it is.
export const LINE_REASONS = {
  NOT_AT_WORK: 'the register says the rep was not at work that day',
  NO_RATE: 'the policy sets no rate for this',
  NO_POLICY: 'no policy version was in force on that date',
  CAPPED: 'the policy caps this',
  PERIOD_CAPPED: 'the policy caps this over the whole claim',
  RECEIPT_MISSING: 'a receipt is needed above the policy limit',
};

export const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// Kilometres and nights are quantities, not money. Four places is more than any odometer gives
// and keeps a rate of 3.5 a kilometre exact.
const units = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
};

const sameTown = (a, b) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase();

// ---------- The policy in force ----------

// The policy version that governs one date: the latest one that had started by then.
//
// Later versions are ignored rather than blended. A company that raises the car rate from the
// first of next month has not raised what it owes for last month, and reading the newest version
// for every date is the mistake that makes an approved claim move.
export function policyFor({ policies = [], date }) {
  const started = policies
    .filter((p) => p.active !== false && String(p.effective_from ?? '') <= String(date ?? ''))
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
  return started[0] ?? null;
}

// Whether a policy version may still be edited. Once it governs a date that has arrived, its
// numbers are the numbers somebody was paid against.
export function policyIsOpen(policy, today) {
  if (!policy) return false;
  return String(policy.effective_from ?? '') > String(today ?? '');
}

// ---------- Where the day was spent ----------

// HQ, out of headquarters, or away overnight.
//
// The plan's town wins where there is one. A rep types the town on their claim, and if that were
// what decided the rate, a day at headquarters could be claimed as a day in the next district.
// Where no plan day exists — an unplanned day is a real thing — what the rep typed is used, and
// the answer says which it was so an approver can see the difference.
export function placeClass({ hqTown, plannedTown = '', claimedTown = '', nights = 0 }) {
  const fromPlan = String(plannedTown ?? '').trim() !== '';
  const town = fromPlan ? plannedTown : claimedTown;
  const away = Number(nights ?? 0) >= 1;
  const place = away ? 'OUTSTATION' : sameTown(town, hqTown) ? 'HQ' : 'EX_HQ';
  return { place, town: String(town ?? '').trim(), source: fromPlan ? 'PLAN' : 'CLAIM' };
}

// ---------- One line ----------

// The rate row a line is measured against. Which dimension the key carries depends on the basis:
// the vehicle for kilometres, where the day was spent for a daily allowance, the rep's grade for
// a night's lodging, and nothing at all for a category claimed at actuals.
export function rateKeyFor({ basis, vehicle = '', place = '', grade = '' }) {
  if (basis === 'KM') return String(vehicle ?? '').toUpperCase();
  if (basis === 'DAILY') return String(place ?? '').toUpperCase();
  if (basis === 'NIGHTLY') return String(grade ?? '').toUpperCase();
  return '';
}

export function rateFor({ rates = [], categoryId, key }) {
  const wanted = String(key ?? '').toUpperCase();
  return (
    rates.find(
      (r) =>
        String(r.category_id) === String(categoryId) &&
        String(r.key ?? '').toUpperCase() === wanted,
    ) ?? null
  );
}

// What one line of a claim comes to.
//
// Three numbers come out of it and all three are shown. `claimed` is what the rep asked for.
// `computed` is what the policy makes of the units before any limit. `allowed` is what survives
// the limits. Showing only the last of the three is how a rep ends up arguing with a total.
export function lineAmount({
  line = {},
  category = null,
  rate = null,
  dayStatus = null,
  place = null,
  hasReceipt = false,
}) {
  const reasons = [];
  const claimed = money(line.claimed_amount);
  const basis = category?.basis ?? 'ACTUAL';
  const km = units(line.km);
  const nights = units(line.nights);

  const result = {
    basis,
    place: place?.place ?? '',
    town: place?.town ?? '',
    town_source: place?.source ?? '',
    key: rate?.key ?? '',
    rate: rate ? money(rate.rate) : null,
    units: 0,
    claimed,
    computed: 0,
    allowed: 0,
    capped: false,
    reasons,
  };

  if (!category) {
    reasons.push('NO_RATE');
    return result;
  }

  // A daily allowance is for a day spent working away. The register settles that, and it settles
  // it before this line is read: this is the milestone's own acceptance case.
  if (basis === 'DAILY' && dayStatus && NOT_AT_WORK.includes(dayStatus)) {
    reasons.push('NOT_AT_WORK');
    return result;
  }

  if (basis === 'KM') result.units = km;
  else if (basis === 'DAILY') result.units = 1;
  else if (basis === 'NIGHTLY') result.units = nights;
  else result.units = 1;

  if (basis === 'ACTUAL') {
    result.computed = claimed;
  } else if (!rate) {
    // No rate is not nought. Nobody can be told what they earn until the company has said so.
    reasons.push('NO_RATE');
    return result;
  } else {
    result.computed = money(result.units * money(rate.rate));
  }

  let allowed = result.computed;

  // Over the limit is capped, not refused — the client's answer to question 10.
  const cap = rate && rate.cap !== null && rate.cap !== undefined ? money(rate.cap) : null;
  if (cap !== null && allowed > cap) {
    allowed = cap;
    result.capped = true;
    reasons.push('CAPPED');
  }

  // A category claimed at actuals is never paid more than was asked for, whatever the rate says.
  if (basis !== 'ACTUAL' && claimed > 0 && allowed > claimed) allowed = claimed;

  // A receipt that the policy insists on does not reduce the line; it stops the claim going in.
  // Zeroing it instead would hide a real expense behind a missing piece of paper.
  const above = category.receipt_above === null ? null : money(category.receipt_above);
  if (above !== null && claimed > above && !hasReceipt) reasons.push('RECEIPT_MISSING');

  result.allowed = money(allowed);
  return result;
}

// ---------- The whole claim ----------

// A claim's lines, priced, with the limits that only make sense across the whole claim applied
// afterwards. A phone bill capped at 500 a fortnight cannot be judged one line at a time.
export function claimTotals({ lines = [], periodCaps = {} }) {
  const priced = lines.map((l) => ({ ...l }));

  const byCategory = new Map();
  for (const line of priced) {
    const key = String(line.category_id ?? '');
    byCategory.set(key, [...(byCategory.get(key) ?? []), line]);
  }

  for (const [categoryId, rows] of byCategory) {
    const cap = periodCaps[categoryId];
    if (cap === null || cap === undefined) continue;
    const limit = money(cap);
    let spent = 0;
    // Oldest line first, so the cap bites the last expense rather than an arbitrary one.
    for (const line of [...rows].sort((a, b) =>
      String(a.spend_date ?? '').localeCompare(String(b.spend_date ?? '')),
    )) {
      const room = money(Math.max(limit - spent, 0));
      if (line.allowed > room) {
        line.allowed = room;
        line.capped = true;
        if (!line.reasons.includes('PERIOD_CAPPED')) line.reasons.push('PERIOD_CAPPED');
      }
      spent = money(spent + line.allowed);
    }
  }

  const sum = (key) => money(priced.reduce((total, l) => total + Number(l[key] ?? 0), 0));
  return {
    lines: priced,
    count: priced.length,
    claimed: sum('claimed'),
    allowed: sum('allowed'),
    // What the policy took off. An approver reads this one number first.
    disallowed: money(sum('claimed') - sum('allowed')),
    capped: priced.filter((l) => l.capped).length,
    blocked: priced.filter((l) => l.reasons.includes('RECEIPT_MISSING')).length,
  };
}

// ---------- The claim period ----------

// Which fortnight a date falls in. The client's answer to question 10: claims come in fortnightly,
// the first through the fifteenth and the sixteenth through the end of the month.
export function periodOf(date, { fortnightly = true } = {}) {
  const iso = String(date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !datesBetween(iso, iso).length) return null;
  const month = iso.slice(0, 7);
  const day = Number(iso.slice(8, 10));
  const last = lastDayOf(month);
  if (!fortnightly) return { from: `${month}-01`, to: last };
  return day <= 15 ? { from: `${month}-01`, to: `${month}-15` } : { from: `${month}-16`, to: last };
}

function lastDayOf(month) {
  const [year, m] = month.split('-').map(Number);
  const next = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`;
  const days = datesBetween(`${month}-01`, next);
  return days[days.length - 2];
}

// ---------- Who may act next ----------

// A claim walks one way: the rep submits it, a manager passes it, finance approves it.
//
// The rule the milestone names is the last line of this function. One person may hold both
// rights — a small company often has one person who is both — but they may not use both on the
// same claim. The check is on the person, not on the right, because that is where the risk is.
export function nextStage(status) {
  if (status === 'SUBMITTED') return 'MANAGER';
  if (status === 'MANAGER_OK') return 'FINANCE';
  return null;
}

export function canDecide({ claim = {}, stage, actorId, repUserId = null }) {
  const want = nextStage(claim.status);
  if (!want) return { allowed: false, reason: 'This claim is not waiting for a decision.' };
  if (want !== stage)
    return {
      allowed: false,
      reason:
        want === 'MANAGER'
          ? 'A manager has to pass this claim before finance sees it.'
          : 'This claim is waiting for finance, not for a manager.',
    };
  // Nobody approves their own spending, at either stage.
  if (repUserId && String(repUserId) === String(actorId))
    return { allowed: false, reason: 'A claim cannot be approved by the person who made it.' };
  if (stage === 'FINANCE' && claim.manager_by && String(claim.manager_by) === String(actorId))
    return {
      allowed: false,
      reason: 'You passed this claim as its manager, so somebody else has to approve it.',
    };
  return { allowed: true, reason: '' };
}
