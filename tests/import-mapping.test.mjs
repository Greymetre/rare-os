import test from 'node:test';
import assert from 'node:assert/strict';
import {
  columnScore,
  describeFilter,
  rowPasses,
  translate,
  headerFingerprint,
  isBlankRow,
  mapRow,
  normaliseUnit,
  parseDate,
  parseNumber,
  reconcile,
  resolveMapping,
  suggestMapping,
} from '../packages/engines/import-mapping.mjs';
import { headerColumns } from '../packages/engines/workbook.mjs';

// The header of a stock export, with the habits the handover warns about: short SAP names, a
// repeated column and a name that only differs by spacing.
const stockHeader = headerColumns([
  'Material',
  'Material Description',
  'Plnt',
  'SLoc',
  'BUn',
  'Unrestricted',
  'Value Unrestricted',
]);

test('a mapping is suggested by name but always lands on a position', () => {
  const suggestion = suggestMapping(
    ['plant', 'location', 'item', 'quantity', 'unit', 'movement_date'],
    stockHeader,
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(suggestion.columns).map(([f, c]) => [f, c.index])),
    { item: 0, plant: 2, location: 3, unit: 4, quantity: 5 },
  );
  assert.equal(suggestion.columns.plant.by, 'position');
  // Nothing sensible matches a posting date here, so it is left for a person.
  assert.deepEqual(suggestion.unmatched, ['movement_date']);
  assert.deepEqual(
    suggestion.unused.map((c) => c.index),
    [1, 6],
  );
  // An exact name beats an alias, and an unrelated header scores nothing at all.
  assert.ok(columnScore('quantity', 'Quantity') > columnScore('quantity', 'Unrestricted'));
  assert.equal(columnScore('quantity', 'Vendor'), 0);
});

test('a repeated header is only usable by position, and the mapping says so', () => {
  const header = headerColumns(['Order', 'Release', 'Release', 'Act.finish', 'Act.finish']);
  const byName = resolveMapping(
    {
      columns: {
        order_no: { by: 'name', name: 'Order' },
        start_date: { by: 'name', name: 'Release' },
      },
    },
    header,
  );
  assert.deepEqual(byName.columns.order_no.index, 0);
  assert.deepEqual(byName.problems, [
    { field: 'start_date', message: '"Release" appears 2 times: choose which one by position.' },
  ]);
  // Said which occurrence, or given the position outright, it resolves.
  const chosen = resolveMapping(
    {
      columns: {
        start_date: { by: 'name', name: 'Release', occurrence: 2 },
        due_date: { by: 'position', index: 4 },
      },
    },
    header,
  );
  assert.equal(chosen.columns.start_date.index, 2, 'the second Release, not the first');
  assert.equal(chosen.columns.due_date.index, 4);
  assert.deepEqual(chosen.problems, []);
  // A column that is not in this file is reported rather than shifting everything along.
  const missing = resolveMapping(
    { columns: { item: { by: 'name', name: 'Material' }, quantity: { by: 'position', index: 9 } } },
    header,
  );
  assert.deepEqual(missing.problems, [
    { field: 'item', message: 'This sheet has no column called "Material".' },
    { field: 'quantity', message: 'Column 10 is not in this sheet.' },
  ]);
  assert.equal(
    headerFingerprint(header),
    headerFingerprint(
      headerColumns([' Order ', 'release', 'RELEASE', 'Act. finish', 'act.finish']),
    ),
    'the same shape is recognised whatever the spacing and case',
  );
});

test('numbers, dates and units are converted only as far as the mapping says', () => {
  assert.deepEqual(parseNumber('1,234.50'), { value: '1234.5' });
  assert.deepEqual(parseNumber('1.234,50', { decimal: 'comma' }), { value: '1234.5' });
  assert.deepEqual(
    parseNumber('1.234,50'),
    { value: '1234.5' },
    'a trailing comma reads as the decimal',
  );
  assert.deepEqual(parseNumber('1,234.56-'), { value: '-1234.56' }, "SAP's trailing minus");
  assert.deepEqual(parseNumber('(500)'), { value: '-500' });
  assert.deepEqual(
    parseNumber('  '),
    { value: '', blank: true },
    'a blank stays blank, never zero',
  );
  assert.equal(parseNumber('12 pcs').issue, '"12 pcs" is not a number.');

  assert.deepEqual(parseDate('2026-07-31'), { value: '2026-07-31' });
  assert.deepEqual(
    parseDate('22.07.2026'),
    { value: '2026-07-22' },
    'the European dot is day-first',
  );
  assert.deepEqual(parseDate('20260731'), { value: '2026-07-31' });
  assert.deepEqual(parseDate('46234', { format: 'serial' }), { value: '2026-07-31' });
  assert.deepEqual(parseDate('31/07/2026'), { value: '2026-07-31' }, 'a day over 12 settles it');
  assert.deepEqual(parseDate('07/31/2026'), { value: '2026-07-31' }, 'so does a month over 12');
  assert.match(parseDate('03/04/2026').issue, /day-first or month-first/);
  assert.deepEqual(parseDate('03/04/2026', { format: 'mdy' }), { value: '2026-03-04' });
  assert.deepEqual(parseDate('03/04/2026', { format: 'dmy' }), { value: '2026-04-03' });
  assert.deepEqual(parseDate('31.02.2026').issue, '"31.02.2026" is not a date.');
  assert.deepEqual(parseDate(''), { value: '', blank: true });

  assert.deepEqual(normaliseUnit(' ea ', { EA: 'NOS' }), { value: 'NOS', alias: 'EA' });
  assert.deepEqual(normaliseUnit('KG', { EA: 'NOS' }), { value: 'KG' }, 'no alias, no change');
});

test('a row keeps the column every value came from, and reports what it could not read', () => {
  const resolved = resolveMapping(
    {
      columns: {
        item: { by: 'position', index: 0 },
        plant: { by: 'position', index: 2 },
        unit: { by: 'position', index: 4, transform: 'unit' },
        quantity: { by: 'position', index: 5, transform: 'number' },
        movement_type: { by: 'constant', value: 'OPENING' },
      },
    },
    stockHeader,
  );
  const good = mapRow(resolved, ['101244', 'BEARING 6002 ZZ', '1116', 'MT01', 'ea', '1,440.14'], {
    uomAliases: { EA: 'NOS' },
  });
  assert.deepEqual(good.values, {
    item: '101244',
    plant: '1116',
    unit: 'NOS',
    quantity: '1440.14',
    movement_type: 'OPENING',
  });
  assert.deepEqual(good.sources.quantity, { column: 6, header: 'Unrestricted' });
  assert.deepEqual(good.sources.unit, { column: 5, header: 'BUn', alias: 'EA' });
  assert.deepEqual(good.sources.movement_type, { constant: true });
  assert.deepEqual(good.issues, []);
  // A stock row with no quantity is unknown, not zero, and an unreadable one says which column.
  const blank = mapRow(resolved, ['101244', '', '1116', 'MT01', 'NOS', '']);
  assert.equal(blank.values.quantity, '');
  assert.deepEqual(blank.issues, []);
  const bad = mapRow(resolved, ['101244', '', '1116', 'MT01', 'NOS', 'n/a']);
  assert.deepEqual(bad.issues, [
    { field: 'quantity', column: 6, message: '"n/a" is not a number.' },
  ]);
  assert.equal(isBlankRow(['', '  ', '']), true);
  assert.equal(isBlankRow(['', '0']), false);
});

test('a mapping can leave rows out, and says which rule did it', () => {
  const filters = [{ field: 'plant', op: 'equals', value: '1116' }];
  assert.deepEqual(rowPasses({ plant: '1116', quantity: '5' }, filters), { ok: true });
  assert.deepEqual(rowPasses({ plant: '1111', quantity: '5' }, filters), {
    ok: false,
    rule: 'plant equals "1116"',
  });
  // Stock at zero can be left out; a blank quantity is unknown, so it is not "zero".
  const nonZero = [{ field: 'quantity', op: 'not_zero' }];
  assert.equal(rowPasses({ quantity: '0' }, nonZero).ok, false);
  assert.equal(rowPasses({ quantity: '0.00' }, nonZero).ok, false);
  assert.equal(rowPasses({ quantity: '' }, nonZero).ok, true);
  assert.equal(rowPasses({ quantity: '4' }, nonZero).ok, true);
  assert.equal(rowPasses({ item: '' }, [{ field: 'item', op: 'not_blank' }]).ok, false);
  assert.equal(describeFilter({ field: 'quantity', op: 'not_zero' }), 'quantity not zero');
  assert.deepEqual(rowPasses({ plant: '1116' }), { ok: true }, 'no rules, nothing removed');
});

test('a value the source writes its own way is translated only when the mapping says so', () => {
  const types = { FERT: 'FG', HALB: 'SFG', ROH: 'RM' };
  assert.deepEqual(translate('FERT', types), { value: 'FG', from: 'FERT' });
  assert.deepEqual(translate('fert', types), { value: 'FG', from: 'fert' }, 'case does not matter');
  assert.deepEqual(translate(' HALB ', types), { value: 'SFG', from: 'HALB' });
  // A value with no pair keeps what the file said, so nothing is quietly renamed.
  assert.deepEqual(translate('HIBE', types), { value: 'HIBE' });
  assert.deepEqual(translate('', types), { value: '' });
  assert.deepEqual(translate('FERT'), { value: 'FERT' }, 'no map, no translation');
});

test('reconciliation accounts for every source row and never adds units together', () => {
  const report = reconcile({
    sourceRows: 10,
    blankSkipped: 1,
    filtered: [{ rule: 'plant equals "1116"', count: 2 }],
    rows: [
      { values: { quantity: '10', unit: 'NOS' } },
      { values: { quantity: '2.5', unit: 'KG' } },
      { values: { quantity: '4', unit: 'NOS' } },
      { values: { quantity: '1', unit: '' } },
      { errors: [{ message: 'Item ABC is not in the catalogue.' }] },
      { errors: [{ message: 'Item ABC is not in the catalogue.' }] },
    ],
  });
  assert.equal(report.staged, 6, 'rows that reached validation');
  assert.equal(report.mapped, 4);
  assert.equal(report.blank, 1, 'the blank row the reader skipped');
  assert.equal(report.removed, 2, 'the rows a rule left out');
  assert.equal(report.failed, 2);
  assert.equal(report.unaccounted, 1, 'one data row never reached the mapping');
  assert.deepEqual(report.filtered, [{ rule: 'plant equals "1116"', count: 2 }]);
  assert.deepEqual(report.reasons, [{ message: 'Item ABC is not in the catalogue.', count: 2 }]);
  assert.deepEqual(report.totals, [
    { unit: 'NOS', rows: 2, quantity: 14 },
    { unit: 'KG', rows: 1, quantity: 2.5 },
    { unit: '(no unit)', rows: 1, quantity: 1 },
  ]);
});
