// RCH-1 Customers and Beats. The rules a customer type, a form question, a beat and a beat
// assignment must pass, whether they arrive from a form or from a spreadsheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_KINDS, validateFields, validateMaster } from '../packages/schema/masters.mjs';
import { IMPORT_KINDS, readImport, templateCsv } from '../packages/schema/imports.mjs';
import { permissions, requiredPermissions } from '../packages/schema/permissions.mjs';
import { choicesOf, customerForm, formSections } from '../packages/engines/customer-form.mjs';

const SETUP_KINDS = ['customer_types', 'customer_form_fields', 'customer_form_rules'];
const BEAT_KINDS = ['beats', 'beat_assignments'];
const errorsOf = (kind, raw) =>
  validateMaster(kind, raw).errors.map((e) => `${e.column}: ${e.message}`);

test('a day list is read in any order and any case, and kept in week order', () => {
  const field = [{ name: 'run_days', label: 'Days', type: 'weekdays', required: true }];
  const read = (v) => validateFields(field, { run_days: v });
  assert.equal(read(' thu , mon ').value.run_days, 'MON,THU');
  assert.equal(read('sunday saturday').value.run_days, 'SAT,SUN');
  // The same round written two ways is one value, so a replayed import changes nothing.
  assert.equal(read('FRI,TUE').value.run_days, read('tue fri').value.run_days);
  assert.match(read('MON,FUNDAY').errors[0].message, /FUN is not a day/);
  assert.match(read('').errors[0].message, /required/);
});

test('a form field key is lowercased and kept to letters, numbers and underscores', () => {
  const field = [{ name: 'field_key', label: 'Field key', type: 'key', required: true }];
  const read = (v) => validateFields(field, { field_key: v });
  assert.equal(read(' Trade_Name ').value.field_key, 'trade_name');
  for (const bad of ['1first', 'has space', 'has-dash', 'has.dot', ''])
    assert.ok(read(bad).errors.length, bad);
});

test('customer types: the handover defaults load, and every bound is enforced', () => {
  const ok = validateMaster('customer_types', { code: 'DIST', name: 'Distributor' });
  assert.deepEqual(ok.errors, []);
  // What a type is when nothing is said about it: visited, tagged, on a beat, no approval.
  assert.deepEqual(
    [
      ok.value.tier,
      ok.value.geo_required,
      ok.value.checkin_radius_m,
      ok.value.visit_norm_per_month,
      ok.value.on_beat_plan,
      ok.value.needs_approval,
      ok.value.order_route,
      ok.value.loyalty,
    ],
    [1, true, 100, 4, true, false, 'NONE', false],
  );
  assert.match(
    errorsOf('customer_types', { code: 'X', name: 'X', checkin_radius_m: '5' })[0],
    /10 to 5000/,
  );
  assert.match(
    errorsOf('customer_types', { code: 'X', name: 'X', order_route: 'POST' })[0],
    /one of: ERP, DISTRIBUTOR, NONE/,
  );
  assert.match(
    errorsOf('customer_types', { code: 'X', name: 'X', hold_days: '400' })[0],
    /0 to 365/,
  );
  assert.match(
    errorsOf('customer_types', { code: 'X', name: 'X', prefix: 'way too long a prefix' })[0],
    /at most 10/,
  );
});

test('a choice question has to carry its choices', () => {
  const base = { field_key: 'shop_type', name: 'Shop type', input: 'select' };
  assert.match(errorsOf('customer_form_fields', base)[0], /needs its choices/);
  assert.deepEqual(
    validateMaster('customer_form_fields', { ...base, options: 'Exclusive|General' }).errors,
    [],
  );
  // Any other input is fine without them.
  assert.deepEqual(validateMaster('customer_form_fields', { ...base, input: 'text' }).errors, []);
  const defaults = validateMaster('customer_form_fields', {
    field_key: 'trade_name',
    name: 'Trade name',
    input: 'text',
  }).value;
  assert.deepEqual([defaults.section, defaults.display_order], ['Details', 100]);
  assert.match(
    errorsOf('customer_form_fields', { field_key: 'x', name: 'X', input: 'colour' })[0],
    /must be one of/,
  );
});

test('the form-by-type matrix says asked-and-required, asked, or not asked', () => {
  const ok = validateMaster('customer_form_rules', { type: 'DIST', field: 'gstin' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.requirement, 'O');
  assert.equal(MASTER_KINDS.customer_form_rules.key(ok.value), 'dist|gstin');
  for (const requirement of ['R', 'O', 'X'])
    assert.deepEqual(
      validateMaster('customer_form_rules', { type: 'DIST', field: 'gstin', requirement }).errors,
      [],
    );
  assert.match(
    errorsOf('customer_form_rules', { type: 'DIST', field: 'gstin', requirement: 'MAYBE' })[0],
    /one of: R, O, X/,
  );
  assert.deepEqual(
    errorsOf('customer_form_rules', {}).map((e) => e.split(':')[0]),
    ['type', 'field'],
  );
});

test('a beat runs weekly on its days, or fortnightly in one half of the fortnight', () => {
  const weekly = validateMaster('beats', {
    code: 'EAST-B1',
    name: 'North round',
    territory: 'EAST-T1',
    run_days: 'mon,thu',
  });
  assert.deepEqual(weekly.errors, []);
  assert.deepEqual(
    [weekly.value.frequency, weekly.value.week_parity, weekly.value.run_days],
    ['WEEKLY', 'ALL', 'MON,THU'],
  );
  // A weekly beat has no half of the fortnight to choose.
  assert.match(
    errorsOf('beats', {
      code: 'B',
      name: 'B',
      territory: 'T',
      run_days: 'MON',
      week_parity: 'ODD',
    })[0],
    /runs every week/,
  );
  // And a fortnightly one must choose.
  assert.match(
    errorsOf('beats', {
      code: 'B',
      name: 'B',
      territory: 'T',
      run_days: 'MON',
      frequency: 'FORTNIGHTLY',
    })[0],
    /Choose ODD or EVEN/,
  );
  assert.deepEqual(
    validateMaster('beats', {
      code: 'B',
      name: 'B',
      territory: 'T',
      run_days: 'TUE',
      frequency: 'FORTNIGHTLY',
      week_parity: 'EVEN',
    }).errors,
    [],
  );
  assert.deepEqual(
    errorsOf('beats', { code: 'B', name: 'B' }).map((e) => e.split(':')[0]),
    ['territory', 'run_days'],
  );
});

test('a beat assignment is dated, and may be left open', () => {
  const open = validateMaster('beat_assignments', {
    beat: 'EAST-B1',
    rep: 'FS-1',
    from_date: '2026-04-01',
  });
  assert.deepEqual(open.errors, []);
  assert.equal(open.value.to_date, null, 'an open spell runs until someone takes it over');
  assert.equal(MASTER_KINDS.beat_assignments.key(open.value), 'east-b1|2026-04-01');
  assert.match(
    errorsOf('beat_assignments', {
      beat: 'B',
      rep: 'R',
      from_date: '2026-04-01',
      to_date: '2026-03-31',
    })[0],
    /Until cannot be earlier than From/,
  );
  assert.deepEqual(
    errorsOf('beat_assignments', {}).map((e) => e.split(':')[0]),
    ['beat', 'rep', 'from_date'],
  );
});

test('Setup owns the customer shape; the field team owns the beats', () => {
  for (const kind of SETUP_KINDS) {
    assert.equal(MASTER_KINDS[kind].permission, 'reach.setup', kind);
    assert.equal(MASTER_KINDS[kind].module, 'Reach', kind);
  }
  for (const kind of BEAT_KINDS) {
    assert.equal(MASTER_KINDS[kind].permission, 'reach.manage', kind);
    assert.equal(MASTER_KINDS[kind].module, 'Reach', kind);
  }
  for (const kind of [...SETUP_KINDS, ...BEAT_KINDS]) {
    assert.equal(MASTER_KINDS[kind].readPermission, 'reach.read', kind);
    assert.equal(MASTER_KINDS[kind].softDelete, true, kind);
  }
});

test("each new master's own template imports cleanly, six customer types included", () => {
  for (const kind of [...SETUP_KINDS, ...BEAT_KINDS]) {
    const rows = readImport(kind, templateCsv(kind));
    assert.equal(rows.length, IMPORT_KINDS[kind].example.length, kind);
    for (const row of rows)
      assert.deepEqual(
        IMPORT_KINDS[kind].validate(row.data).errors,
        [],
        `${kind} line ${row.line}`,
      );
  }
  // The customer-types template is the handover's own six, with its radius and hold values.
  const types = readImport('customer_types', templateCsv('customer_types')).map(
    (r) => IMPORT_KINDS.customer_types.validate(r.data).value,
  );
  assert.deepEqual(
    types.map((t) => t.code),
    ['DIST', 'KEY', 'DLR', 'RET', 'INST', 'INF'],
  );
  assert.deepEqual(
    types.map((t) => t.checkin_radius_m),
    [100, 150, 75, 75, 200, 200],
  );
  assert.deepEqual(
    types.map((t) => t.hold_days),
    [30, 15, null, null, 60, null],
  );
  // Only the channel types walk a beat; key accounts, institutions and influencers do not.
  assert.deepEqual(
    types.filter((t) => t.on_beat_plan).map((t) => t.code),
    ['DIST', 'DLR', 'RET'],
  );
});

test('the RCH-1 permissions exist and rest on the ones they need', () => {
  const codes = new Set(permissions.map(([code]) => code));
  for (const code of ['reach.approve', 'reach.setup']) assert.ok(codes.has(code), code);
  assert.deepEqual(requiredPermissions['reach.approve'], ['reach.read']);
  // Changing the shape of every customer form is more than maintaining one record.
  assert.deepEqual(requiredPermissions['reach.setup'], ['reach.read', 'reach.manage']);
});

// The questions a type asks, turned into the descriptors the shared validators understand.
const FIELDS = [
  { field_key: 'gstin', name: 'GSTIN', input: 'gstin', section: 'Statutory', display_order: 20 },
  {
    field_key: 'trade_name',
    name: 'Trade name',
    input: 'text',
    section: 'Identity',
    display_order: 10,
  },
  {
    field_key: 'shop_type',
    name: 'Shop type',
    input: 'select',
    section: 'Identity',
    display_order: 30,
    options: ' Exclusive | Multi-brand |General ',
    default_value: 'general',
  },
  {
    field_key: 'has_godown',
    name: 'Has a godown',
    input: 'bool',
    section: 'Identity',
    display_order: 40,
    default_value: 'yes',
  },
];
const asked = (requirements) =>
  customerForm(FIELDS.map((f) => ({ ...f, requirement: requirements[f.field_key] ?? 'X' })));

test('a question is asked of nobody until it is placed on a type', () => {
  assert.deepEqual(asked({}), [], 'no rule means not asked');
  assert.deepEqual(
    asked({ trade_name: 'R', gstin: 'X' }).map((f) => f.field_key),
    ['trade_name'],
    'a field marked X is not asked',
  );
});

test('the form reads by section, then by the order the company gave', () => {
  const form = asked({ trade_name: 'O', shop_type: 'O', has_godown: 'O', gstin: 'R' });
  assert.deepEqual(
    form.map((f) => `${f.section}/${f.field_key}`),
    ['Identity/trade_name', 'Identity/shop_type', 'Identity/has_godown', 'Statutory/gstin'],
  );
  assert.deepEqual(
    formSections(form).map((s) => [s.section, s.fields.length]),
    [
      ['Identity', 3],
      ['Statutory', 1],
    ],
  );
  // R marks the question required; everything else is optional.
  assert.deepEqual(
    form.filter((f) => f.required).map((f) => f.field_key),
    ['gstin'],
  );
});

test('a type may word a shared question its own way', () => {
  const [field] = customerForm([
    { ...FIELDS[1], requirement: 'R', label_override: 'Name on the board' },
  ]);
  assert.equal(field.label, 'Name on the board');
  assert.equal(field.descriptor.label, 'Name on the board', 'the error message uses it too');
});

test('choices are trimmed, and a default answer is matched against them', () => {
  assert.deepEqual(choicesOf(FIELDS[2]), ['Exclusive', 'Multi-brand', 'General']);
  assert.deepEqual(choicesOf({ options: '' }), []);
  const [, shopType, godown] = asked({ trade_name: 'O', shop_type: 'O', has_godown: 'O' });
  // 'general' was written in lower case; the real choice is used, so the stored answer is valid.
  assert.equal(shopType.descriptor.default, 'General');
  assert.equal(godown.descriptor.default, true, 'yes becomes a real boolean');
  // A default that is no longer on the list is dropped rather than stored as a stale choice.
  const [stale] = customerForm([{ ...FIELDS[2], requirement: 'O', default_value: 'Franchise' }]);
  assert.equal('default' in stale.descriptor, false);
});

test('every input a form offers has a validator behind it', () => {
  const inputs = MASTER_KINDS.customer_form_fields.fields.find((f) => f.name === 'input').options;
  for (const input of inputs) {
    const [field] = customerForm([
      {
        field_key: 'probe',
        name: 'Probe',
        input,
        section: 'Details',
        display_order: 1,
        options: 'A|B',
        requirement: 'O',
      },
    ]);
    assert.ok(field.descriptor.type, `${input} has no validator`);
    // The descriptor has to be something validateFields can actually run.
    assert.deepEqual(validateFields([field.descriptor], {}).errors, [], input);
  }
});
