// RCH-2: what a day of work counts as.
//
// The register is never stored. Present, Late, Half day, Leave, Absent, Week-off and Holiday are
// worked out here from the evidence every time they are asked for, so correcting a punch, moving
// a holiday or changing a shift re-reads history correctly instead of leaving last month saying
// something the evidence no longer supports.
//
// Clock times arrive as 'HH:MM' in the company's own time, already converted by the caller. The
// engine never touches a timezone: given UTC timestamps it would have to guess whose midnight a
// working day belongs to, and that guess is the caller's to make once, in SQL.

export const WEEK_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export const DAY_STATUSES = [
  'HOLIDAY',
  'WEEK_OFF',
  'LEAVE',
  'PRESENT',
  'LATE',
  'HALF_DAY',
  'OPEN',
  'ABSENT',
];

// Minutes since midnight. Accepts 'HH:MM' and the 'HH:MM:SS' Postgres hands back for a time.
export function minutesOfDay(clock) {
  if (typeof clock !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(clock.trim());
  if (!m) return null;
  const hours = Number(m[1]),
    minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// How long was worked. An end before the start is read as a shift running past midnight rather
// than as bad data, because a rep who ends at 00:30 did not work a negative day.
export function workedMinutes(start, end) {
  const from = minutesOfDay(start),
    to = minutesOfDay(end);
  if (from === null || to === null) return null;
  return to >= from ? to - from : 1440 - from + to;
}

// An ISO date as UTC milliseconds, or null. Read in UTC so the answer never depends on where
// this runs, and round-tripped back to text because Date.UTC silently rolls a bad date forward:
// month 13 would otherwise become next January, and 31 February would become March.
function parseDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(at)) return null;
  return new Date(at).toISOString().slice(0, 10) === m[0] ? at : null;
}

// MON..SUN for an ISO date.
export function weekdayOf(date) {
  const at = parseDate(date);
  if (at === null) return null;
  // getUTCDay is 0 for Sunday; the week here starts on Monday.
  return WEEK_DAYS[(new Date(at).getUTCDay() + 6) % 7];
}

const offDays = (shift) =>
  String(shift?.week_off ?? '')
    .split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);

// What one date counts as for one rep.
//
// Order matters, and it runs most-certain first: a holiday is a holiday whoever turned up, a
// week-off is not an absence, approved leave settles the day without asking about a punch, and
// only then does the punch decide. A rep who is both late and short is marked for the shortfall,
// the more serious of the two, but `late` still reports the arrival so the day board can say so.
export function dayStatus({ date, punch = null, shift = null, holiday = null, leave = null }) {
  const base = {
    date,
    status: 'ABSENT',
    late: null,
    workedMinutes: null,
    holiday: null,
    leave: null,
  };

  if (holiday) return { ...base, status: 'HOLIDAY', holiday: holiday.name ?? '' };

  const weekday = weekdayOf(date);
  if (weekday && offDays(shift).includes(weekday)) return { ...base, status: 'WEEK_OFF' };

  if (leave && leave.status === 'APPROVED')
    return {
      ...base,
      status: leave.half_day ? 'HALF_DAY' : 'LEAVE',
      leave: leave.leave_type ?? '',
    };

  if (!punch || !punch.start_time) return base;

  // A work type that does not count as attendance records the day without crediting it.
  if (punch.counts_present === false)
    return {
      ...base,
      status: 'ABSENT',
      workedMinutes: workedMinutes(punch.start_time, punch.end_time),
    };

  const graceAt =
    shift && minutesOfDay(shift.starts_at) !== null
      ? minutesOfDay(shift.starts_at) + Number(shift.grace_minutes ?? 0)
      : null;
  const startedAt = minutesOfDay(punch.start_time);
  const late = graceAt === null ? null : startedAt > graceAt;

  // Started but never ended. The day cannot be judged until someone corrects it.
  if (!punch.end_time) return { ...base, status: 'OPEN', late };

  const worked = workedMinutes(punch.start_time, punch.end_time);
  const floor = Number(shift?.min_minutes ?? 0);
  const half = Number(shift?.half_day_minutes ?? 0);

  let status = 'PRESENT';
  if (shift && worked < floor) status = 'ABSENT';
  else if (shift && worked < half) status = 'HALF_DAY';
  else if (late) status = 'LATE';

  return { ...base, status, late, workedMinutes: worked };
}

// Every ISO date from `from` to `to`, inclusive.
export function datesBetween(from, to) {
  const start = parseDate(from),
    end = parseDate(to);
  if (start === null || end === null || end < start) return [];
  const out = [];
  for (let at = start; at <= end; at += 86400000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

const byDate = (rows, key = 'work_date') => {
  const map = new Map();
  for (const row of rows ?? []) map.set(String(row[key]), row);
  return map;
};

// Approved leave is held as spells, so a date is looked up by range rather than by key.
const leaveOn = (leaves, date) =>
  (leaves ?? []).find(
    (l) => String(l.from_date) <= date && date <= String(l.to_date) && l.status === 'APPROVED',
  ) ?? null;

// The register for one rep over a span of dates, plus the counts a payroll run needs.
//
// `paidDays` is the number this exists to produce: a full day for present and late, half for a
// half day, and leave only when the leave type is paid. Week-offs and holidays are not counted
// as worked days here; what a company pays for those is a payroll rule, not an attendance one.
export function monthlyRegister({
  from,
  to,
  punches = [],
  shift = null,
  holidays = [],
  leaves = [],
}) {
  const punchOn = byDate(punches);
  const holidayOn = byDate(holidays, 'holiday_date');

  const rows = datesBetween(from, to).map((date) =>
    dayStatus({
      date,
      punch: punchOn.get(date) ?? null,
      shift,
      holiday: holidayOn.get(date) ?? null,
      leave: leaveOn(leaves, date),
    }),
  );

  const totals = Object.fromEntries(DAY_STATUSES.map((s) => [s, 0]));
  for (const row of rows) totals[row.status] += 1;

  // What one day is worth to a payroll run. A present or late day is whole, a half day is half,
  // and leave is worth a day only when its type is paid. Week-offs and holidays are worth nothing
  // here on purpose: whether a company pays for those is a payroll rule, not an attendance one.
  const credit = (row) => {
    if (row.status === 'PRESENT' || row.status === 'LATE') return 1;
    const spell = row.leave ? leaveOn(leaves, row.date) : null;
    if (row.status === 'LEAVE') return spell && spell.paid !== false ? 1 : 0;
    if (row.status === 'HALF_DAY') return spell && spell.paid === false ? 0 : 0.5;
    return 0;
  };

  return {
    rows,
    totals,
    // Days with a punch that nobody has closed; the regularisation queue is built from these.
    open: rows.filter((r) => r.status === 'OPEN').map((r) => r.date),
    paidDays: Math.round(rows.reduce((sum, row) => sum + credit(row), 0) * 2) / 2,
  };
}
