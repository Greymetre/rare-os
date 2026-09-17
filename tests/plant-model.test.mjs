import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDayMinutes,
  describeWorkingDays,
  duplicates,
  findCycle,
  findOverlap,
  isWorkingDay,
  resourceDailyCapacity,
  shiftNetMinutes,
  validateShifts,
} from '../packages/engines/plant-model.mjs';

const shift = (name, start_time, end_time, break_minutes = 0) => ({
  name,
  start_time,
  end_time,
  break_minutes,
});

test('shift minutes handle breaks and shifts crossing midnight', () => {
  assert.equal(shiftNetMinutes(shift('A', '06:00', '14:00', 30)), 450);
  assert.equal(shiftNetMinutes(shift('Night', '22:00', '06:00')), 480);
  assert.equal(shiftNetMinutes(shift('Full', '00:00', '00:00')), 1440);
  // Prototype SEG-D: three 480-minute shifts, one crew each = 1,440 minutes per machine-day.
  const threeShifts = [
    shift('A', '06:00', '14:00'),
    shift('B', '14:00', '22:00'),
    shift('C', '22:00', '06:00'),
  ];
  assert.deepEqual(validateShifts(threeShifts), []);
  assert.equal(calendarDayMinutes(threeShifts), 1440);
});

test('shift validation reports bad times, long breaks, overlaps and more than 24 hours', () => {
  assert.deepEqual(validateShifts([]), ['Add at least one shift.']);
  assert.match(validateShifts([shift('A', '25:00', '06:00')])[0], /times like 06:00/);
  assert.match(
    validateShifts([shift('A', '06:00', '07:00', 60)])[0],
    /break \(60 min\) must be shorter/,
  );
  assert.match(
    validateShifts([shift('Day', '06:00', '15:00'), shift('Evening', '14:00', '22:00')]).join(' '),
    /Shift Day overlaps Shift Evening/,
  );
  // Night shift 22:00-06:00 overlaps an early shift starting 05:00 the next morning.
  assert.match(
    validateShifts([shift('Night', '22:00', '06:00'), shift('Early', '05:00', '09:00')]).join(' '),
    /overlaps/,
  );
  assert.deepEqual(
    validateShifts([shift('Night', '22:00', '06:00'), shift('Day', '06:00', '14:00')]),
    [],
  );
});

test('working days, holidays and capacity divide by machines only once', () => {
  assert.equal(describeWorkingDays('1111110'), 'Mon, Tue, Wed, Thu, Fri, Sat');
  assert.equal(isWorkingDay('1111110', '2026-09-20'), false); // Sunday
  assert.equal(isWorkingDay('1111110', '2026-09-21'), true); // Monday
  assert.equal(isWorkingDay('1111110', '2026-09-21', new Set(['2026-09-21'])), false);
  // Prototype P2-S4 Testing: 1 machine, 1,440 min/day, 60% efficiency.
  assert.equal(resourceDailyCapacity({ machine_count: 1, efficiency_pct: '60.00' }, 1440), 864);
  assert.equal(resourceDailyCapacity({ machine_count: 3, efficiency_pct: 100 }, 1440), 4320);
  // Linear scaling guard: doubling machines doubles capacity exactly.
  assert.equal(
    resourceDailyCapacity({ machine_count: 4, efficiency_pct: 85 }, 450),
    2 * resourceDailyCapacity({ machine_count: 2, efficiency_pct: 85 }, 450),
  );
});

test('effective date overlaps ignore inactive versions and treat a blank end as open', () => {
  const v1 = { revision: 'V1', effective_from: '2026-01-01', effective_to: '2026-06-30' };
  const v2 = { revision: 'V2', effective_from: '2026-07-01', effective_to: null };
  assert.equal(findOverlap([v1, v2]), null);
  const v3 = { revision: 'V3', effective_from: '2026-09-01', effective_to: null };
  assert.deepEqual(
    findOverlap([v1, v2, v3]).map((v) => v.revision),
    ['V2', 'V3'],
  );
  assert.equal(findOverlap([v1, { ...v2, active: false }, v3]), null);
});

test('BOM cycles are found through indirect components; duplicates are case-insensitive', () => {
  const edges = new Map([
    ['FG', ['SFG1', 'RM1']],
    ['SFG1', ['SFG2']],
    ['SFG2', ['RM2']],
  ]);
  assert.equal(findCycle(edges), null);
  edges.set('SFG2', ['RM2', 'FG']);
  assert.deepEqual(findCycle(edges), ['FG', 'SFG1', 'SFG2', 'FG']);
  assert.deepEqual(findCycle(new Map([['A', ['A']]])), ['A', 'A']);
  assert.deepEqual(duplicates(['OP10', 'op20', 'Op10']), ['Op10']);
});
