import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_STATUSES,
  datesBetween,
  dayStatus,
  minutesOfDay,
  monthlyRegister,
  weekdayOf,
  workedMinutes,
} from '../packages/engines/attendance.mjs';
import { MASTER_KINDS, validateMaster } from '../packages/schema/masters.mjs';
import { IMPORT_KINDS, templateCsv } from '../packages/schema/imports.mjs';
import { permissions, requiredPermissions } from '../packages/schema/permissions.mjs';

const ATTENDANCE_KINDS = ['work_types', 'shifts'];

// The shift the milestone's own acceptance test is written against: 09:30 start, ten minutes of
// grace, half a day below four hours, and nothing at all below an hour.
const shift = {
  starts_at: '09:30',
  ends_at: '18:00',
  grace_minutes: 10,
  half_day_minutes: 240,
  min_minutes: 60,
  week_off: 'SUN',
};

const punch = (start, end) => ({ work_date: '2026-11-18', start_time: start, end_time: end });

test('the milestone acceptance: 09:45 is late, ending 13:00 is a half day, approved leave settles the day', () => {
  // 09:45 is past 09:30 plus ten minutes of grace, and a full day's work after it.
  const late = dayStatus({ date: '2026-11-18', punch: punch('09:45', '18:00'), shift });
  assert.equal(late.status, 'LATE');
  assert.equal(late.late, true);

  // The same arrival, ended at 13:00: three and a quarter hours is half a day, not a late day.
  const half = dayStatus({ date: '2026-11-18', punch: punch('09:45', '13:00'), shift });
  assert.equal(half.status, 'HALF_DAY');
  assert.equal(half.workedMinutes, 195);
  // The shortfall decides the day, but the arrival is still reported for the day board.
  assert.equal(half.late, true);

  // On an approved leave day the punch is not asked about at all.
  const onLeave = dayStatus({
    date: '2026-11-18',
    punch: punch('09:45', '13:00'),
    shift,
    leave: {
      status: 'APPROVED',
      leave_type: 'Casual',
      from_date: '2026-11-18',
      to_date: '2026-11-18',
    },
  });
  assert.equal(onLeave.status, 'LEAVE');
  assert.equal(onLeave.leave, 'Casual');
});

test('arriving inside the grace is not late, and the boundary minute itself is not late', () => {
  assert.equal(
    dayStatus({ date: '2026-11-18', punch: punch('09:29', '18:00'), shift }).status,
    'PRESENT',
  );
  // 09:40 is exactly start plus grace: still on time.
  const boundary = dayStatus({ date: '2026-11-18', punch: punch('09:40', '18:00'), shift });
  assert.equal(boundary.status, 'PRESENT');
  assert.equal(boundary.late, false);
  assert.equal(dayStatus({ date: '2026-11-18', punch: punch('09:41', '18:00'), shift }).late, true);
});

test('a day is ranked by what is most certain: holiday, then week-off, then leave, then the punch', () => {
  const leave = {
    status: 'APPROVED',
    leave_type: 'Casual',
    from_date: '2026-11-15',
    to_date: '2026-11-22',
  };
  const holiday = { holiday_date: '2026-11-18', name: 'Founders Day' };

  // A holiday outranks approved leave, so a rep does not spend leave on a day nobody worked.
  const onHoliday = dayStatus({
    date: '2026-11-18',
    punch: punch('09:00', '18:00'),
    shift,
    holiday,
    leave,
  });
  assert.equal(onHoliday.status, 'HOLIDAY');
  assert.equal(onHoliday.holiday, 'Founders Day');

  // 2026-11-15 is a Sunday, and this shift does not run on Sundays.
  assert.equal(weekdayOf('2026-11-15'), 'SUN');
  assert.equal(dayStatus({ date: '2026-11-15', shift, leave }).status, 'WEEK_OFF');

  // A weekday inside the same spell is leave.
  assert.equal(dayStatus({ date: '2026-11-16', shift, leave }).status, 'LEAVE');
});

test('short, missing and uncounted days', () => {
  // Under the hour floor: the day does not count at all.
  assert.equal(
    dayStatus({ date: '2026-11-18', punch: punch('09:00', '09:30'), shift }).status,
    'ABSENT',
  );
  // Started and never ended: nobody can judge it until it is corrected.
  const open = dayStatus({ date: '2026-11-18', punch: punch('09:45', null), shift });
  assert.equal(open.status, 'OPEN');
  assert.equal(open.late, true);
  // No punch at all on a working day.
  assert.equal(dayStatus({ date: '2026-11-18', shift }).status, 'ABSENT');
  // A work type that does not count as attendance records the day without crediting it.
  const personal = dayStatus({
    date: '2026-11-18',
    punch: { ...punch('09:00', '18:00'), counts_present: false },
    shift,
  });
  assert.equal(personal.status, 'ABSENT');
  assert.equal(personal.workedMinutes, 540);
});

test('without a shift nothing is guessed: no week-off, no lateness, no shortfall', () => {
  const noShift = dayStatus({ date: '2026-11-15', punch: punch('11:00', '12:00') });
  assert.equal(noShift.status, 'PRESENT');
  assert.equal(noShift.late, null, 'lateness cannot be known without a shift');
  assert.equal(noShift.workedMinutes, 60);
});

test('a shift running past midnight is read as a long day, not a negative one', () => {
  assert.equal(workedMinutes('22:00', '06:00'), 480);
  assert.equal(workedMinutes('09:00', '17:30'), 510);
  assert.equal(workedMinutes('09:00', null), null);
});

test('clock and date parsing refuse what they cannot read', () => {
  assert.equal(minutesOfDay('09:45'), 585);
  assert.equal(minutesOfDay('09:45:00'), 585, 'Postgres hands a time back with seconds');
  for (const bad of ['24:00', '09:60', 'half nine', '', null, undefined, 945])
    assert.equal(minutesOfDay(bad), null, `${bad} is not a clock time`);
  for (const bad of ['2026-13-01', 'yesterday', '', null]) assert.equal(weekdayOf(bad), null);
  assert.deepEqual(datesBetween('2026-11-18', '2026-11-16'), [], 'a backwards span is empty');
  assert.equal(datesBetween('2026-11-01', '2026-11-30').length, 30);
});

test('the register counts the month and the days payroll owes', () => {
  const register = monthlyRegister({
    from: '2026-11-16', // Monday
    to: '2026-11-22', // Sunday
    shift,
    punches: [
      { work_date: '2026-11-16', start_time: '09:20', end_time: '18:00' }, // present
      { work_date: '2026-11-17', start_time: '09:45', end_time: '18:00' }, // late
      { work_date: '2026-11-18', start_time: '09:45', end_time: '13:00' }, // half day
      { work_date: '2026-11-19', start_time: '09:30', end_time: null }, // open
      // 2026-11-20 has no punch at all: absent
    ],
    holidays: [{ holiday_date: '2026-11-21', name: 'Founders Day' }],
  });

  assert.deepEqual(
    register.rows.map((r) => r.status),
    ['PRESENT', 'LATE', 'HALF_DAY', 'OPEN', 'ABSENT', 'HOLIDAY', 'WEEK_OFF'],
  );
  assert.equal(register.totals.PRESENT, 1);
  assert.equal(register.totals.ABSENT, 1);
  assert.deepEqual(register.open, ['2026-11-19']);
  // present 1 + late 1 + half 0.5 = 2.5; the open, absent, holiday and week-off days pay nothing.
  assert.equal(register.paidDays, 2.5);
  // Every status the engine can return is a key, so a caller can render the totals blind.
  assert.deepEqual(Object.keys(register.totals).sort(), [...DAY_STATUSES].sort());
});

test('paid leave is worth a day, unpaid leave is worth nothing, and half-day leave follows its type', () => {
  const spell = (from, to, paid, half = false) => ({
    status: 'APPROVED',
    leave_type: paid ? 'Casual' : 'Unpaid',
    from_date: from,
    to_date: to,
    paid,
    half_day: half,
  });

  const paid = monthlyRegister({
    from: '2026-11-16',
    to: '2026-11-17',
    shift,
    leaves: [spell('2026-11-16', '2026-11-17', true)],
  });
  assert.equal(paid.paidDays, 2);

  const unpaid = monthlyRegister({
    from: '2026-11-16',
    to: '2026-11-17',
    shift,
    leaves: [spell('2026-11-16', '2026-11-17', false)],
  });
  assert.equal(unpaid.totals.LEAVE, 2);
  assert.equal(unpaid.paidDays, 0, 'unpaid leave is still leave, but it pays nothing');

  const halfPaid = monthlyRegister({
    from: '2026-11-16',
    to: '2026-11-16',
    shift,
    leaves: [spell('2026-11-16', '2026-11-16', true, true)],
  });
  assert.equal(halfPaid.totals.HALF_DAY, 1);
  assert.equal(halfPaid.paidDays, 0.5);
});

// ---------------------------------------------------------------------------
// The two masters RCH-2 registers, and the permissions it adds.
// ---------------------------------------------------------------------------

test('the attendance masters are registered like every other Reach master', () => {
  for (const kind of ATTENDANCE_KINDS) {
    const def = MASTER_KINDS[kind];
    assert.ok(def, `${kind} is not registered`);
    assert.equal(def.module, 'Reach', kind);
    assert.equal(def.permission, 'reach.manage', kind);
    assert.equal(def.readPermission, 'reach.read', kind);
    assert.equal(def.deletePermission, 'reach.delete', kind);
    assert.equal(def.softDelete, true, kind);
    // Registering the kind is all it takes to get an import; the template has to be usable.
    assert.ok(IMPORT_KINDS[kind], `${kind} has no import`);
    assert.match(templateCsv(kind), /^code,/, kind);
  }
});

test('a shift reads back the way the register needs it, and refuses what it cannot judge', () => {
  const ok = validateMaster('shifts', {
    code: 'DAY',
    name: 'General shift',
    starts_at: '9:30',
    ends_at: '18:00',
    grace_minutes: '10',
    half_day_minutes: '240',
    min_minutes: '60',
    week_off: 'sun',
  });
  assert.deepEqual(ok.errors, []);
  // Written loosely, stored strictly: the engine compares these as text.
  assert.equal(ok.value.starts_at, '09:30');
  assert.equal(ok.value.week_off, 'SUN');
  assert.equal(MASTER_KINDS.shifts.key(ok.value), 'day');

  const bad = (over) =>
    validateMaster('shifts', {
      code: 'DAY',
      name: 'General shift',
      starts_at: '09:30',
      ends_at: '18:00',
      ...over,
    }).errors.map((e) => e.column);
  assert.deepEqual(bad({ starts_at: '25:00' }), ['starts_at'], 'there is no 25th hour');
  assert.deepEqual(bad({ starts_at: '09:60' }), ['starts_at'], 'there is no 60th minute');
  assert.deepEqual(bad({ week_off: 'FUNDAY' }), ['week_off']);
  // The same rule the table holds: counting cannot start after the half-day mark.
  assert.deepEqual(bad({ half_day_minutes: '120', min_minutes: '300' }), ['min_minutes']);
});

test('a shift may run past midnight, because night shifts exist', () => {
  const night = validateMaster('shifts', {
    code: 'NIGHT',
    name: 'Night shift',
    starts_at: '22:00',
    ends_at: '06:00',
  });
  assert.deepEqual(night.errors, [], 'an end before the start is a night shift, not an error');
  assert.equal(workedMinutes(night.value.starts_at, night.value.ends_at), 480);
});

test('the attendance permissions exist and rest only on permissions that exist', () => {
  const codes = new Set(permissions.map(([code]) => code));
  for (const code of ['reach.attend', 'reach.leave']) assert.ok(codes.has(code), code);
  for (const code of ['reach.attend', 'reach.leave'])
    for (const need of requiredPermissions[code] ?? [])
      assert.ok(codes.has(need), `${code} needs ${need}, which does not exist`);
  // Marking your own day is not a management right, so it must not drag one in: a rep with
  // reach.read would also get the day board, everyone else's register and the payroll export.
  assert.equal(requiredPermissions['reach.attend'], undefined);
  // Deciding someone else's leave means reading the module and reaching the queue, which
  // lives among the attendance screens.
  assert.deepEqual(requiredPermissions['reach.leave'], ['reach.read', 'reach.attend']);
});
