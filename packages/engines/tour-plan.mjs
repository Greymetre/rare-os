// RCH-3: the month a rep intends to walk, and how that intention read afterwards.
//
// Two calculations live here and neither is ever stored.
//
// The first is the auto-fill: a beat already says which weekdays it runs on and, if it is
// fortnightly, which half of the fortnight it belongs to. A month of those rules is a month of
// planned days, so the rep is handed a filled calendar to correct rather than an empty one to
// type. Holidays and week-offs are left out of it, because Attendance already owns them and a
// company that keeps the same holiday in two places eventually disagrees with itself.
//
// The second is adherence: Followed, Partial, Deviated, Missed and Unplanned are read from the
// plan, the visits and the attendance register every time they are asked for. Writing them down
// would mean a visit recorded late, a corrected punch or leave approved after the plan was made
// leaving last month saying something the evidence no longer supports — which is exactly the
// case the milestone asks about: leave approved after a plan is built must not read as a day
// the rep missed.

import { datesBetween, weekdayOf, WEEK_DAYS } from './attendance.mjs';

export { WEEK_DAYS };

export const PLAN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'SENT_BACK'];

// Where a planned day came from. The distinction is kept so a re-run of the auto-fill can
// refresh what it wrote without silently overwriting what a rep typed by hand.
export const DAY_SOURCES = ['AUTO', 'MANUAL'];

export const CHANGE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

// Every verdict a date can carry. The first five are the milestone's own words; the last four
// say that the day was never a field day to begin with, so it is not held against anyone.
export const ADHERENCE_STATUSES = [
  'FOLLOWED',
  'PARTIAL',
  'DEVIATED',
  'MISSED',
  'UNPLANNED',
  'LEAVE',
  'HOLIDAY',
  'WEEK_OFF',
  'NOT_PLANNED',
];

// The four that say something about how a rep worked a planned field day. Adherence is scored
// out of these alone: a holiday is not a failure, and a day nobody planned is not a success.
export const COUNTED_STATUSES = ['FOLLOWED', 'PARTIAL', 'DEVIATED', 'MISSED'];

// An attendance verdict that settles a date before the plan is even consulted.
const SETTLED = { HOLIDAY: 'HOLIDAY', WEEK_OFF: 'WEEK_OFF', LEAVE: 'LEAVE' };

// An ISO date as UTC milliseconds, or null. Validity is borrowed from the attendance engine so
// there is one date parser in the system rather than two that disagree about 31 February.
function utcOf(date) {
  const value = String(date ?? '');
  return datesBetween(value, value).length === 1 ? Date.parse(`${value}T00:00:00Z`) : null;
}

// 'YYYY-MM' to the first and last date of that month.
export function monthSpan(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]),
    index = Number(m[2]);
  if (index < 1 || index > 12) return null;
  const from = `${m[1]}-${m[2]}-01`;
  // Day zero of the next month is the last day of this one, which handles February and leap
  // years without a table of month lengths.
  const last = new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
  return { from, to: last };
}

export function monthDates(month) {
  const span = monthSpan(month);
  return span ? datesBetween(span.from, span.to) : [];
}

// The ISO week number of a date: the week owning the Thursday. A fortnightly beat runs in the
// odd or the even weeks of that numbering, so a rep can tell which week they are in by looking
// at any calendar instead of by trusting this system's private arithmetic.
export function isoWeek(date) {
  const at = utcOf(date);
  if (at === null) return null;
  const d = new Date(at);
  const weekday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - weekday + 3);
  const firstOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - firstOfYear) / 86400000 + 1) / 7);
}

export function weekParityOf(date) {
  const week = isoWeek(date);
  return week === null ? null : week % 2 === 1 ? 'ODD' : 'EVEN';
}

const runDaysOf = (beat) =>
  String(beat?.run_days ?? '')
    .split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);

const offDaysOf = (weekOff) =>
  String(weekOff ?? '')
    .split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);

// Does this beat run on this date? A weekly beat runs on its days every week; a fortnightly one
// runs on them only in the half of the fortnight it was given. An assignment window, when the
// caller supplies one, keeps a beat out of the months before the rep took it over.
export function beatRunsOn(beat, date) {
  const weekday = weekdayOf(date);
  if (!weekday || !runDaysOf(beat).includes(weekday)) return false;
  if (beat.from_date && String(beat.from_date) > date) return false;
  if (beat.to_date && String(beat.to_date) < date) return false;
  if ((beat.frequency ?? 'WEEKLY') === 'WEEKLY') return true;
  return beat.week_parity === weekParityOf(date);
}

// A month of planned days, proposed from the beats a rep holds.
//
// Holidays and week-offs are skipped rather than planned around: Attendance owns both, and the
// adherence read consults it again later, so a holiday moved after the plan was built still
// takes the day out of the count.
//
// A day two beats both claim is given to the first by code, and the loser is reported as a
// clash. Choosing silently would hide a real conflict in the beat calendar from the only person
// who can fix it.
export function autoFill({ month, beats = [], holidays = [], weekOff = '' }) {
  const dates = monthDates(month);
  if (!dates.length) return { days: [], clashes: [], skipped: [] };

  const holidayOn = new Map((holidays ?? []).map((h) => [String(h.holiday_date), h]));
  const off = offDaysOf(weekOff);
  const ordered = [...beats].sort((a, b) =>
    String(a.code ?? '').toLowerCase() < String(b.code ?? '').toLowerCase() ? -1 : 1,
  );

  const days = [];
  const clashes = [];
  const skipped = [];

  for (const date of dates) {
    if (holidayOn.has(date)) {
      skipped.push({ date, reason: 'HOLIDAY', name: holidayOn.get(date).name ?? '' });
      continue;
    }
    if (off.includes(weekdayOf(date))) {
      skipped.push({ date, reason: 'WEEK_OFF', name: '' });
      continue;
    }
    const due = ordered.filter((beat) => beatRunsOn(beat, date));
    if (!due.length) continue;
    const [chosen, ...rest] = due;
    days.push({
      work_date: date,
      beat_id: chosen.id,
      beat: chosen.code ?? '',
      town: chosen.town ?? '',
      outlet_count: Number(chosen.outlet_count ?? 0),
      objective: chosen.objective ?? '',
      source: 'AUTO',
    });
    for (const other of rest)
      clashes.push({ date, kept: chosen.code ?? '', dropped: other.code ?? '' });
  }

  return { days, clashes, skipped };
}

// What the company asks of a month before it will accept it. Each check carries its own
// sentence, because a rep who is told "the plan is not acceptable" learns nothing.
//
// These are limits, not laws: every number comes from the Reach settings screen, so a company
// that works a six-day week or walks twenty outlets a day changes them without a release.
export function planChecks({ month, days = [], holidays = [], weekOff = '', settings = {} }) {
  const dates = monthDates(month);
  const holidayOn = new Set((holidays ?? []).map((h) => String(h.holiday_date)));
  const off = offDaysOf(weekOff);
  const working = dates.filter((d) => !holidayOn.has(d) && !off.includes(weekdayOf(d)));

  const planned = (days ?? []).filter((d) => d.beat_id);
  const maxOutlets = Number(settings.plan_max_outlets ?? 0);
  const minPct = Number(settings.plan_field_days_pct ?? 0);
  const fieldPct = working.length ? Math.round((planned.length / working.length) * 100) : 0;
  const over = planned.filter((d) => maxOutlets > 0 && Number(d.outlet_count ?? 0) > maxOutlets);

  const checks = [
    {
      code: 'HAS_DAYS',
      ok: planned.length > 0,
      message: planned.length
        ? `${planned.length} field ${planned.length === 1 ? 'day' : 'days'} planned.`
        : 'This month has no field day on it yet.',
    },
    {
      code: 'FIELD_DAYS',
      ok: fieldPct >= minPct,
      message:
        fieldPct >= minPct
          ? `${fieldPct}% of the working days are field days.`
          : `${fieldPct}% of the ${working.length} working days are field days; this company asks for ${minPct}%.`,
    },
    {
      code: 'OUTLET_CAP',
      ok: over.length === 0,
      message: over.length
        ? `${over.length} ${over.length === 1 ? 'day goes' : 'days go'} past ${maxOutlets} outlets: ${over
            .slice(0, 5)
            .map((d) => d.work_date)
            .join(', ')}.`
        : `No day asks for more than ${maxOutlets} outlets.`,
    },
  ];

  return {
    checks,
    ready: checks.every((c) => c.ok),
    workingDays: working.length,
    fieldDays: planned.length,
    fieldPct,
  };
}

const idsOf = (list) => new Set((list ?? []).map((v) => String(v)));

// How one date read against what was planned for it.
//
// The attendance verdict is consulted first and settles the day on its own when it can: a
// holiday, a week-off or approved leave is not a day anybody missed. This is the rule the
// milestone names — leave approved after the plan was built takes the day out of the count,
// because nothing was written down to contradict it.
//
// After that the visits decide. Visiting enough of the planned round is Followed; visiting some
// of it is Partial; spending the day somewhere else entirely is Deviated; not working it at all
// is Missed. A day with visits and no plan is Unplanned — recorded, never discarded.
export function dayAdherence({ date, planned = null, visits = [], verdict = null, followedPct }) {
  const settled = verdict ? SETTLED[verdict.status] : null;
  const base = {
    date,
    status: 'NOT_PLANNED',
    beat: planned?.beat ?? '',
    town: planned?.town ?? '',
    planned: 0,
    visited: 0,
    offPlan: 0,
    percent: null,
  };

  const wanted = idsOf(planned?.outlets);
  const onPlan = (visits ?? []).filter((v) => wanted.has(String(v.customer_id)));
  const offPlan = (visits ?? []).length - onPlan.length;

  if (settled)
    return {
      ...base,
      status: settled,
      visited: onPlan.length,
      offPlan,
      leave: verdict.leave ?? '',
    };

  if (!planned || !planned.beat_id)
    return {
      ...base,
      status: (visits ?? []).length ? 'UNPLANNED' : 'NOT_PLANNED',
      offPlan,
    };

  // What the round asked for. The stop list is the truth; the number typed into the plan is the
  // fallback for a beat whose outlets have not been listed yet.
  const target = wanted.size || Number(planned.outlet_count ?? 0);
  const row = { ...base, planned: target, visited: onPlan.length, offPlan };

  if (!(visits ?? []).length) return { ...row, status: 'MISSED', percent: 0 };
  if (!onPlan.length) return { ...row, status: 'DEVIATED', percent: 0 };
  if (!target) return { ...row, status: 'FOLLOWED', percent: 100 };

  const percent = Math.round((onPlan.length / target) * 100);
  return { ...row, status: percent >= Number(followedPct) ? 'FOLLOWED' : 'PARTIAL', percent };
}

// The whole span, day by day, with the one number a manager actually asks for.
//
// `score` is the share of countable days that were followed. Days the company never asked
// anyone to work are not in the denominator, so a month with eight holidays does not read as a
// month a rep half-worked.
export function planAdherence({
  from,
  to,
  days = [],
  visits = [],
  register = [],
  settings = {},
  followedPct,
}) {
  const threshold = Number(followedPct ?? settings.plan_followed_pct ?? 60);
  const plannedOn = new Map((days ?? []).map((d) => [String(d.work_date), d]));
  const verdictOn = new Map((register ?? []).map((r) => [String(r.date), r]));

  const visitsOn = new Map();
  for (const visit of visits ?? []) {
    const key = String(visit.visit_date);
    if (!visitsOn.has(key)) visitsOn.set(key, []);
    visitsOn.get(key).push(visit);
  }

  const rows = datesBetween(from, to).map((date) =>
    dayAdherence({
      date,
      planned: plannedOn.get(date) ?? null,
      visits: visitsOn.get(date) ?? [],
      verdict: verdictOn.get(date) ?? null,
      followedPct: threshold,
    }),
  );

  const totals = Object.fromEntries(ADHERENCE_STATUSES.map((s) => [s, 0]));
  for (const row of rows) totals[row.status] += 1;

  const counted = COUNTED_STATUSES.reduce((sum, s) => sum + totals[s], 0);
  const plannedOutlets = rows.reduce((sum, r) => sum + r.planned, 0);
  const visitedOutlets = rows.reduce((sum, r) => sum + r.visited, 0);

  return {
    rows,
    totals,
    countedDays: counted,
    score: counted ? Math.round((totals.FOLLOWED / counted) * 100) : null,
    plannedOutlets,
    visitedOutlets,
    coverage: plannedOutlets ? Math.round((visitedOutlets / plannedOutlets) * 100) : null,
    followedPct: threshold,
  };
}
