import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMaster, MASTER_KINDS } from '../packages/schema/masters.mjs';

const errorsOf = (kind, raw) =>
  validateMaster(kind, raw).errors.map((e) => `${e.column}: ${e.message}`);

test('items: codes, enums, references and costs are normalised or rejected with field messages', () => {
  const ok = validateMaster('items', {
    code: ' FGa ',
    name: 'Pump',
    item_type: 'fg',
    make_buy: 'make',
    base_unit: 'nos',
    standard_cost: '4200.5000',
    demand_class: 'Runner',
  });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, {
    code: 'FGa',
    name: 'Pump',
    item_type: 'FG',
    make_buy: 'MAKE',
    base_unit: 'nos',
    family: '',
    standard_cost: '4200.5',
    demand_class: 'runner',
  });
  const bad = errorsOf('items', {
    code: 'bad code',
    name: '',
    item_type: 'TOOL',
    make_buy: '',
    base_unit: '',
    standard_cost: '-1',
  });
  assert.deepEqual(
    bad.map((e) => e.split(':')[0]),
    ['code', 'name', 'item_type', 'make_buy', 'base_unit', 'standard_cost'],
  );
  assert.match(bad[2], /one of: RM, SFG, FG/);
  assert.match(
    errorsOf('items', {
      code: 'X',
      name: 'x',
      item_type: 'RM',
      make_buy: 'BUY',
      base_unit: 'KG',
      standard_cost: '1.12345',
    })[0],
    /at most 4 decimal/,
  );
});

test('suppliers and customers: lead time range, contact formats and defaults', () => {
  assert.match(
    errorsOf('suppliers', { code: 'S1', name: 'S', lead_time_days: '400' })[0],
    /0 to 365/,
  );
  assert.match(
    errorsOf('suppliers', { code: 'S1', name: 'S', lead_time_days: '2.5' })[0],
    /whole number/,
  );
  assert.match(
    errorsOf('suppliers', { code: 'S1', name: 'S', lead_time_days: '5', email: 'nope' })[0],
    /valid email/,
  );
  assert.match(
    errorsOf('suppliers', { code: 'S1', name: 'S', lead_time_days: '5', phone: 'call me' })[0],
    /6-20 digits/,
  );
  const c = validateMaster('customers', { code: 'C1', name: 'Cust', email: 'Buy@Example.COM' });
  assert.deepEqual(c.errors, []);
  assert.equal(c.value.customer_type, 'OTHER');
  assert.equal(c.value.email, 'buy@example.com');
});

test('item sourcing: MOQ must be a multiple of the order multiple; preferred accepts yes/no', () => {
  const base = { item: 'RMa', supplier: 'SUP-1' };
  const ok = validateMaster('item_suppliers', {
    ...base,
    moq: '500',
    lot_multiple: '50',
    preferred: 'Yes',
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.preferred, true);
  assert.equal(ok.value.moq, '500');
  const defaults = validateMaster('item_suppliers', base);
  assert.deepEqual(
    [defaults.value.moq, defaults.value.lot_multiple, defaults.value.preferred],
    ['0', '1', false],
  );
  assert.match(
    errorsOf('item_suppliers', { ...base, moq: '120', lot_multiple: '50' })[0],
    /multiple of the order multiple 50/,
  );
  assert.match(errorsOf('item_suppliers', { ...base, lot_multiple: '0' })[0], /greater than 0/);
  assert.match(errorsOf('item_suppliers', { ...base, preferred: 'maybe' })[0], /yes or no/);
});

test('unit conversions: positive factor and different units', () => {
  assert.deepEqual(
    validateMaster('unit_conversions', { from_unit: 'BOX', to_unit: 'NOS', factor: '12' }).errors,
    [],
  );
  assert.match(
    errorsOf('unit_conversions', { from_unit: 'NOS', to_unit: 'nos', factor: '1' })[0],
    /must be different/,
  );
  assert.match(
    errorsOf('unit_conversions', { from_unit: 'BOX', to_unit: 'NOS', factor: '0' })[0],
    /greater than 0/,
  );
});

test('every master kind maps to a permission, table and unique key', () => {
  for (const [kind, def] of Object.entries(MASTER_KINDS)) {
    assert.match(def.permission, /^(masters|suppliers|customers)\.manage$/, kind);
    assert.equal(def.table, kind);
    assert.equal(typeof def.key, 'function');
  }
});
