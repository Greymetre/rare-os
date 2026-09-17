// Pure plant-model rules and capacity arithmetic. No database access; unit tested directly.

const MINUTES_PER_DAY = 1440;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function parseTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(String(value ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// A shift whose end is at or before its start crosses midnight (00:00-00:00 is a full day).
export function shiftSpan(shift) {
  const start = parseTime(shift.start_time),
    end = parseTime(shift.end_time);
  if (start === null || end === null) return null;
  const length = end > start ? end - start : end + MINUTES_PER_DAY - start;
  return { start, end: start + length, length };
}

export function shiftNetMinutes(shift) {
  const span = shiftSpan(shift);
  return span ? span.length - Number(shift.break_minutes ?? 0) : 0;
}

export function validateShifts(shifts) {
  const errors = [];
  if (!shifts.length) errors.push('Add at least one shift.');
  if (shifts.length > 10) errors.push('A calendar can have at most 10 shifts.');
  const spans = [];
  for (const [i, shift] of shifts.entries()) {
    const label = shift.name ? `Shift ${shift.name}` : `Shift ${i + 1}`;
    const span = shiftSpan(shift);
    if (!span) {
      errors.push(`${label}: start and end must be times like 06:00.`);
      continue;
    }
    const breakMinutes = Number(shift.break_minutes ?? 0);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0)
      errors.push(`${label}: break must be whole minutes, 0 or more.`);
    else if (breakMinutes >= span.length)
      errors.push(
        `${label}: break (${breakMinutes} min) must be shorter than the shift (${span.length} min).`,
      );
    spans.push({ label, ...span });
  }
  // Compare on a two-day line so shifts crossing midnight overlap-check correctly.
  for (let a = 0; a < spans.length; a++)
    for (let b = a + 1; b < spans.length; b++) {
      const x = spans[a],
        y = spans[b];
      const overlap = [0, MINUTES_PER_DAY, -MINUTES_PER_DAY].some(
        (shift) => x.start < y.end + shift && y.start + shift < x.end,
      );
      if (overlap) errors.push(`${x.label} overlaps ${y.label}.`);
    }
  const total = spans.reduce((sum, s) => sum + s.length, 0);
  if (total > MINUTES_PER_DAY) errors.push('Shifts add up to more than 24 hours in a day.');
  return errors;
}

export function calendarDayMinutes(shifts) {
  return shifts.reduce((sum, s) => sum + Math.max(0, shiftNetMinutes(s)), 0);
}

// working_days: seven '0'/'1' characters, Monday first.
export function isWorkingDay(workingDays, isoDate, holidayDates = new Set()) {
  if (holidayDates.has(isoDate)) return false;
  const weekday = (new Date(isoDate + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return workingDays[weekday] === '1';
}

export function describeWorkingDays(workingDays) {
  return DAY_NAMES.filter((_, i) => workingDays[i] === '1')
    .map((d) => d.slice(0, 3))
    .join(', ');
}

// Effective capacity of a resource for one working day, in machine-minutes.
export function resourceDailyCapacity(resource, dayMinutes) {
  return (dayMinutes * Number(resource.machine_count) * Number(resource.efficiency_pct)) / 100;
}

// Ranges use ISO dates; a missing end means open-ended.
export function rangesOverlap(a, b) {
  const aEnd = a.effective_to ?? '9999-12-31',
    bEnd = b.effective_to ?? '9999-12-31';
  return a.effective_from <= bEnd && b.effective_from <= aEnd;
}

// Returns the first pair of active versions whose effective dates overlap, or null.
export function findOverlap(versions) {
  const active = versions.filter((v) => v.active !== false);
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++)
      if (rangesOverlap(active[i], active[j])) return [active[i], active[j]];
  return null;
}

// edges: Map<parentId, Iterable<componentId>>. Returns a cycle as a list of ids, or null.
export function findCycle(edges) {
  const state = new Map();
  const stack = [];
  function visit(node) {
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 'visiting') return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  }
  for (const node of edges.keys())
    if (!state.has(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  return null;
}

export function duplicates(values) {
  const seen = new Set(),
    dup = new Set();
  for (const v of values) {
    const key = String(v).toLowerCase();
    if (seen.has(key)) dup.add(v);
    seen.add(key);
  }
  return [...dup];
}
