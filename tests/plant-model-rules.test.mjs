import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupRows,
  validateBom,
  validateCalendar,
  validateResource,
  validateRouting,
} from '../packages/schema/plant-model.mjs';

const messages = (r) => r.errors.map((e) => e.message).join(' | ');

test('calendar: working days from checkboxes or text, shift rules and duplicate holidays', () => {
  const ok = validateCalendar({
    code: 'CAL',
    name: 'Day shift',
    working_days: [true, true, true, true, true, true, false],
    shifts: [{ name: 'General', start_time: '09:00', end_time: '17:30', break_minutes: '30' }],
    holidays: [{ holiday_date: '2026-10-02', name: 'Gandhi Jayanti' }],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.working_days, '1111110');
  assert.match(
    messages(validateCalendar({ code: 'C', name: 'x', working_days: '0000000', shifts: [] })),
    /at least one working day.*Add at least one shift/,
  );
  assert.match(
    messages(
      validateCalendar({
        code: 'C',
        name: 'x',
        working_days: '1111100',
        shifts: [
          { name: 'Day', start_time: '06:00', end_time: '15:00' },
          { name: 'Evening', start_time: '14:00', end_time: '22:00' },
        ],
        holidays: [
          { holiday_date: '2026-11-01', name: 'A' },
          { holiday_date: '2026-11-01', name: 'B' },
          { holiday_date: '2026-02-30', name: 'Bad' },
        ],
      }),
    ),
    /Shift Day overlaps Shift Evening.*Holiday 3: Holiday date must be a date.*Holiday 2026-11-01 is listed more than once/,
  );
});

test('resource: machine count, efficiency and changeover ranges', () => {
  assert.deepEqual(
    validateResource({ plant: 'P1', code: 'S1', name: 'Prep', machine_count: '2' }).value,
    {
      plant: 'P1',
      code: 'S1',
      name: 'Prep',
      resource_type: 'MACHINE',
      machine_count: 2,
      efficiency_pct: '100',
      changeover_minutes: '0',
      calendar: null,
    },
  );
  assert.match(
    messages(
      validateResource({
        plant: 'P1',
        code: 'S1',
        name: 'x',
        machine_count: '0',
        efficiency_pct: '120',
        changeover_minutes: '2000',
      }),
    ),
    /Machines must be a whole number from 1 to 999.*Efficiency % must be at most 100.*Changeover minutes must be at most 1440/,
  );
});

test('BOM: duplicate components, self reference, dates and scrap limits', () => {
  const base = { parent_item: 'FGa', revision: 'V1', effective_from: '2026-10-01' };
  assert.deepEqual(
    validateBom({ ...base, lines: [{ component_item: 'RMa', quantity: '2' }] }).errors,
    [],
  );
  assert.match(messages(validateBom({ ...base, lines: [] })), /at least one component/);
  assert.match(
    messages(
      validateBom({
        ...base,
        effective_to: '2026-09-01',
        lines: [
          { component_item: 'RMa', quantity: '2' },
          { component_item: 'rma', quantity: '1', scrap_pct: '100' },
          { component_item: 'fga', quantity: '1' },
        ],
      }),
    ),
    /Effective to must be on or after.*Line 2: Scrap % must be less than 100.*Component rma is listed more than once.*cannot be a component of itself/,
  );
});

test('routing: operations sorted by sequence with unique sequences and operation codes', () => {
  const r = validateRouting({
    plant: 'P1',
    item: 'FGa',
    revision: 'V1',
    effective_from: '2026-10-01',
    operations: [
      { sequence: '20', operation_code: 'ASSY', resource: 'S3', run_minutes_per_unit: '7' },
      { sequence: '10', operation_code: 'PREP', resource: 'S1', run_minutes_per_unit: '3' },
    ],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(
    r.value.operations.map((o) => o.operation_code),
    ['PREP', 'ASSY'],
  );
  assert.match(
    messages(
      validateRouting({
        plant: 'P1',
        item: 'FGa',
        revision: 'V1',
        effective_from: '2026-10-01',
        operations: [
          { sequence: '10', operation_code: 'PREP', resource: 'S1', run_minutes_per_unit: '0' },
          { sequence: '10', operation_code: 'prep', resource: 'S1', run_minutes_per_unit: '3' },
        ],
      }),
    ),
    /Run minutes per unit must be greater than 0.*Sequence 10 is used more than once.*Operation code prep is used more than once/,
  );
});

test('CSV grouping builds one document per parent/revision and flags header mismatches', () => {
  const rows = [
    {
      line: 2,
      data: {
        parent_item: 'FGa',
        revision: 'V1',
        effective_from: '2026-10-01',
        effective_to: '',
        base_quantity: '1',
        component_item: 'RMa',
        quantity: '2',
        unit: '',
        scrap_pct: '',
      },
    },
    {
      line: 3,
      data: {
        parent_item: 'fga',
        revision: 'v1',
        effective_from: '2026-10-01',
        effective_to: '',
        base_quantity: '1',
        component_item: 'RMb',
        quantity: '1',
        unit: '',
        scrap_pct: '',
      },
    },
    {
      line: 4,
      data: {
        parent_item: 'FGb',
        revision: 'V1',
        effective_from: '2026-10-01',
        effective_to: '',
        base_quantity: '1',
        component_item: 'RMa',
        quantity: '1',
        unit: '',
        scrap_pct: '',
      },
    },
  ];
  const groups = groupRows('boms', rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0].raw.lines.map((l) => l.component_item),
    ['RMa', 'RMb'],
  );
  assert.equal(groups[0].mismatch.size, 0, 'a differently cased code is the same document');
  rows[1].data.effective_from = '2026-11-01';
  assert.equal(
    groupRows('boms', rows)[0].mismatch.get(3),
    'Effective from differs from line 2 for the same document.',
  );
  assert.equal(groups[1].mismatch.size, 0);
});
