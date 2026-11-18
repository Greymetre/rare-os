import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADHERENCE_STATUSES,
  autoFill,
  beatRunsOn,
  dayAdherence,
  isoWeek,
  monthDates,
  monthSpan,
  planAdherence,
  planChecks,
  weekParityOf,
} from '../packages/engines/tour-plan.mjs';
import { permissions, requiredPermissions } from '../packages/schema/permissions.mjs';

// A weekly beat of ten outlets walked on Mondays and Thursdays, and a fortnightly one walked on
// Wednesdays in the odd weeks. Both sit in towns the plan names.
const weekly = {
  id: 'beat-weekly',
  code: 'B-NORTH',
  town: 'Rohtak',
  outlet_count: 10,
  frequency: 'WEEKLY',
  run_days: 'MON,THU',
  week_parity: 'ALL',
};

const fortnightly = {
  id: 'beat-fortnight',
  code: 'B-SOUTH',
  town: 'Jhajjar',
  outlet_count: 6,
  frequency: 'FORTNIGHTLY',
  run_days: 'WED',
  week_parity: 'ODD',
};

// Ten stops on the weekly round, which is what a day on it asks for.
const stops = Array.from({ length: 10 }, (_, i) => `shop-${i + 1}`);

const visitsTo = (date, ids) => ids.map((customer_id) => ({ customer_id, visit_date: date }));

const plannedDay = (date) => ({
  work_date: date,
  beat_id: weekly.id,
  beat: weekly.code,
  town: weekly.town,
  outlet_count: 10,
  objective: 'Order and shelf check',
  source: 'AUTO',
  outlets: stops,
});

test('the milestone acceptance: 60% of the planned round is Followed, and leave approved later is not a miss', () => {
  // Six of the ten planned stops is 60%, which is exactly what this company calls Followed.
  const followed = dayAdherence({
    date: '2026-12-07',
    planned: plannedDay('2026-12-07'),
    visits: visitsTo('2026-12-07', stops.slice(0, 6)),
    followedPct: 60,
  });
  assert.equal(followed.status, 'FOLLOWED');
  assert.equal(followed.percent, 60);
  assert.equal(followed.visited, 6);
  assert.equal(followed.planned, 10);

  // One stop short of the bar is Partial, not Followed. The day is still counted, and still says
  // how much of the round was walked.
  const partial = dayAdherence({
    date: '2026-12-07',
    planned: plannedDay('2026-12-07'),
    visits: visitsTo('2026-12-07', stops.slice(0, 5)),
    followedPct: 60,
  });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.percent, 50);

  // The second half of the acceptance test: the plan was built, then leave was approved for that
  // day. The day must not read as missed. Nothing was stored, so the register simply answers
  // again and the plan is never consulted.
  const onLeave = dayAdherence({
    date: '2026-12-07',
    planned: plannedDay('2026-12-07'),
    visits: [],
    verdict: { date: '2026-12-07', status: 'LEAVE', leave: 'CL' },
    followedPct: 60,
  });
  assert.equal(onLeave.status, 'LEAVE');
  assert.equal(onLeave.leave, 'CL');
});

test('a planned day with no visits is missed, and a day spent elsewhere is a deviation', () => {
  const missed = dayAdherence({
    date: '2026-12-07',
    planned: plannedDay('2026-12-07'),
    visits: [],
    followedPct: 60,
  });
  assert.equal(missed.status, 'MISSED');
  assert.equal(missed.percent, 0);

  // Eight visits, none of them on the planned round: the rep worked, somewhere else.
  const deviated = dayAdherence({
    date: '2026-12-07',
    planned: plannedDay('2026-12-07'),
    visits: visitsTo('2026-12-07', ['other-1', 'other-2', 'other-3']),
    followedPct: 60,
  });
  assert.equal(deviated.status, 'DEVIATED');
  assert.equal(deviated.visited, 0);
  assert.equal(deviated.offPlan, 3);
});

test('work on a day nobody planned is recorded as unplanned, never discarded', () => {
  const unplanned = dayAdherence({
    date: '2026-12-08',
    planned: null,
    visits: visitsTo('2026-12-08', ['shop-1', 'shop-2']),
    followedPct: 60,
  });
  assert.equal(unplanned.status, 'UNPLANNED');
  assert.equal(unplanned.offPlan, 2);

  // A quiet day that was never planned is simply not a planned day; it is not a failure.
  const quiet = dayAdherence({ date: '2026-12-08', planned: null, visits: [], followedPct: 60 });
  assert.equal(quiet.status, 'NOT_PLANNED');
});

test('a holiday and a week-off settle the day before the plan is consulted', () => {
  for (const status of ['HOLIDAY', 'WEEK_OFF']) {
    const row = dayAdherence({
      date: '2026-12-25',
      planned: plannedDay('2026-12-25'),
      visits: [],
      verdict: { date: '2026-12-25', status },
      followedPct: 60,
    });
    assert.equal(row.status, status, `${status} must not read as a missed day`);
  }
});

test('a round whose stops are not listed yet falls back to the number the plan promised', () => {
  const noStops = { ...plannedDay('2026-12-07'), outlets: [] };
  // No stop list and no visits is still a missed day.
  assert.equal(
    dayAdherence({ date: '2026-12-07', planned: noStops, visits: [], followedPct: 60 }).status,
    'MISSED',
  );
  // Six visits against a promised ten is 60%, read from the typed count.
  const row = dayAdherence({
    date: '2026-12-07',
    planned: noStops,
    visits: visitsTo('2026-12-07', stops.slice(0, 6)),
    followedPct: 60,
  });
  // With no stop list, none of those visits can be matched to the round.
  assert.equal(row.status, 'DEVIATED');
  assert.equal(row.planned, 10);
});

test('the auto-fill lays a month out from the beats a rep already holds', () => {
  // December 2026: 1 Dec is a Tuesday, so Mondays fall on the 7th, 14th, 21st and 28th and
  // Thursdays on the 3rd, 10th, 17th, 24th and 31st.
  const { days, skipped } = autoFill({
    month: '2026-12',
    beats: [weekly],
    holidays: [{ holiday_date: '2026-12-25', name: 'Christmas' }],
    weekOff: 'SUN',
  });
  const dates = days.map((d) => d.work_date);
  assert.deepEqual(dates, [
    '2026-12-03',
    '2026-12-07',
    '2026-12-10',
    '2026-12-14',
    '2026-12-17',
    '2026-12-21',
    '2026-12-24',
    '2026-12-28',
    '2026-12-31',
  ]);
  // Every proposed day carries the beat's town and size, so the rep corrects rather than types.
  assert.equal(days[0].town, 'Rohtak');
  assert.equal(days[0].outlet_count, 10);
  assert.equal(days[0].source, 'AUTO');
  // The holiday and the Sundays are left out, and said so.
  assert.ok(skipped.some((s) => s.date === '2026-12-25' && s.reason === 'HOLIDAY'));
  assert.equal(skipped.filter((s) => s.reason === 'WEEK_OFF').length, 4);
});

test('a fortnightly beat runs only in its own half of the fortnight', () => {
  const { days } = autoFill({ month: '2026-12', beats: [fortnightly], weekOff: 'SUN' });
  const dates = days.map((d) => d.work_date);
  // Only the Wednesdays whose ISO week is odd.
  for (const date of dates) assert.equal(weekParityOf(date), 'ODD', date);
  assert.ok(
    dates.length > 0 && dates.length < 5,
    'a fortnightly beat runs on about half the Wednesdays',
  );
  assert.equal(beatRunsOn(fortnightly, '2026-12-02'), weekParityOf('2026-12-02') === 'ODD');
  // The same beat read as weekly would run on every Wednesday.
  const everyWeek = autoFill({
    month: '2026-12',
    beats: [{ ...fortnightly, frequency: 'WEEKLY', week_parity: 'ALL' }],
  }).days;
  assert.equal(everyWeek.length, 5, 'December 2026 has five Wednesdays');
});

test('a beat is not planned outside the window the rep holds it for', () => {
  const handedOver = { ...weekly, from_date: '2026-12-15' };
  const { days } = autoFill({ month: '2026-12', beats: [handedOver] });
  assert.ok(
    days.every((d) => d.work_date >= '2026-12-15'),
    'a beat taken over mid-month is not planned for the days before',
  );
  const handedOn = { ...weekly, to_date: '2026-12-10' };
  assert.ok(
    autoFill({ month: '2026-12', beats: [handedOn] }).days.every(
      (d) => d.work_date <= '2026-12-10',
    ),
  );
});

test('two beats claiming one day is reported, not silently resolved', () => {
  const clashing = {
    ...fortnightly,
    id: 'beat-clash',
    code: 'B-WEST',
    run_days: 'MON,THU',
    frequency: 'WEEKLY',
    week_parity: 'ALL',
  };
  const { days, clashes } = autoFill({
    month: '2026-12',
    beats: [weekly, clashing],
    weekOff: 'SUN',
  });
  // One day keeps one beat. The first by code wins, which is B-NORTH.
  assert.equal(new Set(days.map((d) => d.work_date)).size, days.length);
  assert.equal(days[0].beat, 'B-NORTH');
  assert.ok(clashes.length > 0);
  assert.equal(clashes[0].kept, 'B-NORTH');
  assert.equal(clashes[0].dropped, 'B-WEST');
});

test('the checks a month must pass before it is submitted each say why', () => {
  const settings = { plan_max_outlets: 12, plan_field_days_pct: 75, plan_followed_pct: 60 };
  const weekOff = 'SUN';
  const holidays = [{ holiday_date: '2026-12-25', name: 'Christmas' }];

  const empty = planChecks({ month: '2026-12', days: [], holidays, weekOff, settings });
  assert.equal(empty.ready, false);
  assert.equal(empty.checks.find((c) => c.code === 'HAS_DAYS').ok, false);
  // December 2026 has 31 days, four Sundays and one holiday: 26 working days.
  assert.equal(empty.workingDays, 26);

  // Nine auto-filled days out of 26 is 35%, well under the 75% this company asks for.
  const thin = planChecks({
    month: '2026-12',
    days: autoFill({ month: '2026-12', beats: [weekly], holidays, weekOff }).days,
    holidays,
    weekOff,
    settings,
  });
  assert.equal(thin.fieldPct, 35);
  assert.equal(thin.checks.find((c) => c.code === 'FIELD_DAYS').ok, false);
  assert.match(thin.checks.find((c) => c.code === 'FIELD_DAYS').message, /75%/);

  // A day asking for more outlets than the cap is named, with its date.
  const over = planChecks({
    month: '2026-12',
    days: [{ ...plannedDay('2026-12-07'), outlet_count: 20 }],
    holidays,
    weekOff,
    settings,
  });
  const cap = over.checks.find((c) => c.code === 'OUTLET_CAP');
  assert.equal(cap.ok, false);
  assert.match(cap.message, /2026-12-07/);

  // Twenty field days out of 26 is 77%, which passes, and every check is then green.
  const full = planChecks({
    month: '2026-12',
    days: monthDates('2026-12')
      .filter(
        (d) =>
          d !== '2026-12-25' &&
          !['2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27'].includes(d),
      )
      .slice(0, 20)
      .map(plannedDay),
    holidays,
    weekOff,
    settings,
  });
  assert.equal(full.fieldDays, 20);
  assert.equal(full.fieldPct, 77);
  assert.equal(full.ready, true);
});

test('a month reads as a whole: totals, the score and outlet coverage', () => {
  const days = ['2026-12-03', '2026-12-07', '2026-12-10', '2026-12-14'].map(plannedDay);
  const visits = [
    ...visitsTo('2026-12-03', stops.slice(0, 8)), // followed
    ...visitsTo('2026-12-07', stops.slice(0, 3)), // partial
    ...visitsTo('2026-12-09', ['walk-in']), // unplanned
  ];
  const register = [
    { date: '2026-12-10', status: 'LEAVE', leave: 'CL' },
    { date: '2026-12-06', status: 'WEEK_OFF' },
    { date: '2026-12-13', status: 'WEEK_OFF' },
  ];

  const out = planAdherence({
    from: '2026-12-01',
    to: '2026-12-14',
    days,
    visits,
    register,
    followedPct: 60,
  });

  assert.equal(out.rows.length, 14);
  assert.equal(out.totals.FOLLOWED, 1);
  assert.equal(out.totals.PARTIAL, 1);
  assert.equal(out.totals.LEAVE, 1);
  assert.equal(out.totals.UNPLANNED, 1);
  assert.equal(out.totals.MISSED, 1, 'the 14th was planned and not worked');
  assert.equal(out.totals.WEEK_OFF, 2);
  // Four countable days, one of them followed.
  assert.equal(out.countedDays, 3);
  assert.equal(out.score, 33);
  // Three planned days carrying ten stops each; the day taken as leave is out of the count.
  assert.equal(out.plannedOutlets, 30);
  assert.equal(out.visitedOutlets, 11);
  assert.equal(out.coverage, 37);
  // Every status the screens can be handed is one the engine declares.
  for (const row of out.rows) assert.ok(ADHERENCE_STATUSES.includes(row.status), row.status);
});

test('a span with nothing countable scores nothing rather than zero', () => {
  const out = planAdherence({
    from: '2026-12-06',
    to: '2026-12-06',
    register: [{ date: '2026-12-06', status: 'WEEK_OFF' }],
  });
  assert.equal(out.countedDays, 0);
  assert.equal(out.score, null, 'a week of holidays is not a month a rep failed');
  assert.equal(out.coverage, null);
});

test('months and weeks are read, never guessed', () => {
  assert.deepEqual(monthSpan('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(
    monthSpan('2028-02'),
    { from: '2028-02-01', to: '2028-02-29' },
    'a leap February',
  );
  assert.equal(monthSpan('2026-13'), null, 'there is no thirteenth month');
  assert.equal(monthSpan('2026-00'), null);
  assert.equal(monthSpan('not-a-month'), null);
  assert.deepEqual(monthDates('2026-13'), []);
  assert.equal(monthDates('2026-12').length, 31);

  // The Thursday rule, checked at the one place it is easy to get wrong.
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(isoWeek('2026-12-31'), 53);
  assert.equal(isoWeek('bad-date'), null);
  assert.equal(weekParityOf('2026-01-01'), 'ODD');
});

test('the tour plan permissions exist and rest only on permissions that exist', () => {
  const codes = new Set(permissions.map(([code]) => code));
  for (const code of ['reach.plan', 'reach.plan_approve']) assert.ok(codes.has(code), code);
  for (const code of ['reach.plan', 'reach.plan_approve'])
    for (const need of requiredPermissions[code] ?? [])
      assert.ok(codes.has(need), `${code} needs ${need}, which does not exist`);
  // Building your own month is not a management right, so it drags nothing in with it.
  assert.equal(requiredPermissions['reach.plan'], undefined);
  // Deciding someone else's month means reading the module the beats and reps live in, and
  // standing inside the plan screens where the queue is.
  assert.deepEqual(requiredPermissions['reach.plan_approve'], ['reach.read', 'reach.plan']);
});
