// RCH-0: the field masters every Reach screen stands on. These are the rules a record must pass
// whether it arrives from a form or from a spreadsheet, so both paths are checked here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_KINDS, validateMaster } from '../packages/schema/masters.mjs';
import { IMPORT_KINDS, readImport, templateCsv } from '../packages/schema/imports.mjs';
import { removalBlockers, resolveReferences } from '../packages/schema/masters-db.mjs';
import { permissions, requiredPermissions } from '../packages/schema/permissions.mjs';

// The RCH-0 field masters. The RCH-1 ones have their own file.
const REACH_KINDS = ['territories', 'rep_grades', 'field_reps', 'leave_types', 'holidays'];
const errorsOf = (kind, raw) =>
  validateMaster(kind, raw).errors.map((e) => `${e.column}: ${e.message}`);

test('territories: a code, a name and an optional parent', () => {
  const ok = validateMaster('territories', { code: ' east-t1 ', name: ' Kolkata city ' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { code: 'east-t1', name: 'Kolkata city', parent: null });
  assert.equal(
    validateMaster('territories', { code: 'T1', name: 'T', parent: 'EAST' }).value.parent,
    'EAST',
  );
  assert.deepEqual(
    errorsOf('territories', { code: 'has space', name: '' }).map((e) => e.split(':')[0]),
    ['code', 'name'],
  );
});

test('rep grades: seniority is a whole number 1-99 and defaults to 1', () => {
  assert.equal(validateMaster('rep_grades', { code: 'SO', name: 'Sales Officer' }).value.rank, 1);
  assert.equal(validateMaster('rep_grades', { code: 'ASM', name: 'ASM', rank: '3' }).value.rank, 3);
  assert.match(errorsOf('rep_grades', { code: 'X', name: 'X', rank: '0' })[0], /1 to 99/);
  assert.match(errorsOf('rep_grades', { code: 'X', name: 'X', rank: '2.5' })[0], /whole number/);
});

test('field reps: grade and territory are required, the login is optional and joined_on is a date', () => {
  const ok = validateMaster('field_reps', {
    code: 'FS-1',
    name: 'Kiran Patil',
    grade: 'SO',
    territory: 'EAST-T1',
    email: 'KIRAN@Example.com',
    phone: '+91 98765 43210',
    joined_on: '2024-04-01',
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.email, 'kiran@example.com');
  assert.equal(ok.value.user, null, 'a rep without a login is valid');
  assert.equal(ok.value.joined_on, '2024-04-01');
  assert.deepEqual(
    errorsOf('field_reps', { code: 'FS-2', name: 'X' }).map((e) => e.split(':')[0]),
    ['grade', 'territory'],
  );
  assert.match(
    errorsOf('field_reps', {
      code: 'F',
      name: 'X',
      grade: 'SO',
      territory: 'T',
      joined_on: '01-04-2024',
    })[0],
    /date like 2026-09-17/,
  );
  // A login is addressed by email, which is longer than the 40 characters a code may be.
  const longEmail = 'a'.repeat(40) + '@example.com';
  assert.deepEqual(
    validateMaster('field_reps', {
      code: 'F',
      name: 'X',
      grade: 'SO',
      territory: 'T',
      user: longEmail,
    }).errors,
    [],
  );
});

test('leave types: quota allows half days, and the three switches have sensible defaults', () => {
  const ok = validateMaster('leave_types', { code: 'CL', name: 'Casual leave' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.paid, true);
  assert.equal(ok.value.annual_quota, '0');
  assert.equal(ok.value.carry_forward, false);
  assert.equal(ok.value.requires_approval, true);
  assert.equal(
    validateMaster('leave_types', { code: 'SL', name: 'Sick', annual_quota: '7.5' }).value
      .annual_quota,
    '7.5',
  );
  assert.match(
    errorsOf('leave_types', { code: 'X', name: 'X', annual_quota: '7.55' })[0],
    /decimal/,
  );
  assert.match(
    errorsOf('leave_types', { code: 'X', name: 'X', annual_quota: '1000' })[0],
    /at most 999/,
  );
  assert.match(errorsOf('leave_types', { code: 'X', name: 'X', paid: 'maybe' })[0], /yes or no/);
});

test('holidays: the date is required and the key is the day plus the territory', () => {
  const ok = validateMaster('holidays', { holiday_date: '2026-01-26', name: 'Republic Day' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.holiday_type, 'NATIONAL');
  assert.equal(MASTER_KINDS.holidays.key(ok.value), '2026-01-26|');
  const regional = validateMaster('holidays', {
    holiday_date: '2026-04-15',
    name: 'Poila Boishakh',
    holiday_type: 'regional',
    territory: 'East-T1',
  });
  assert.equal(regional.value.holiday_type, 'REGIONAL');
  assert.equal(MASTER_KINDS.holidays.key(regional.value), '2026-04-15|east-t1');
  assert.match(errorsOf('holidays', { holiday_date: '', name: 'X' })[0], /required/);
  assert.match(errorsOf('holidays', { holiday_date: '2026-02-30', name: 'X' })[0], /date like/);
});

test('territories are two levels deep: no self parent, no parent that has a parent, no new level', async () => {
  const row = (value, id) => ({ id, value, errors: [], refs: {} });
  const underZone = row({ code: 'T1', name: 'T1', parent: 'EAST' }, 'id-t1');
  // resolveReferences does its own lookup, so hand it a database that answers the ref query and
  // reports no children for the record being saved.
  const refDb = (parent) => ({
    query: async (sql) =>
      sql.startsWith('SELECT id,code,active,parent_id FROM territories')
        ? { rows: parent ? [parent] : [], rowCount: parent ? 1 : 0 }
        : { rows: [], rowCount: 0 },
  });
  const zone = { id: 'id-east', code: 'EAST', active: true, parent_id: null };
  const nested = { id: 'id-t2', code: 'EAST-T2', active: true, parent_id: 'id-east' };

  let [r] = await resolveReferences(refDb(zone), 'territories', [underZone]);
  assert.deepEqual(r.errors, [], 'a top-level territory is a valid parent');

  [r] = await resolveReferences(refDb(nested), 'territories', [
    row({ code: 'T3', name: 'T3', parent: 'EAST-T2' }),
  ]);
  assert.match(r.errors[0].message, /already sits under another territory/);

  [r] = await resolveReferences(refDb(zone), 'territories', [
    row({ code: 'EAST', name: 'East', parent: 'EAST' }, 'id-east'),
  ]);
  assert.match(r.errors[0].message, /cannot be its own parent/);

  // EAST-T1 already has a territory under it, so it may not be moved under another one.
  const withChild = {
    query: async (sql) =>
      sql.startsWith('SELECT id,code,active,parent_id FROM territories')
        ? { rows: [zone], rowCount: 1 }
        : { rows: [{ code: 'EAST-T1-A' }], rowCount: 1 },
  };
  [r] = await resolveReferences(withChild, 'territories', [
    row({ code: 'EAST-T1', name: 'T1', parent: 'EAST' }, 'id-t1'),
  ]);
  assert.match(r.errors[0].message, /already has EAST-T1-A under it/);
});

test('removal names what still points at the record, and only for the kinds that have dependants', async () => {
  const counting = (n) => ({ query: async () => ({ rows: [{ n }], rowCount: 1 }) });
  assert.deepEqual(await removalBlockers(counting(0), 'territories', 'x'), []);
  assert.deepEqual(await removalBlockers(counting(1), 'rep_grades', 'x'), [
    '1 field rep still uses it',
  ]);
  assert.deepEqual(await removalBlockers(counting(3), 'territories', 'x'), [
    '3 field reps still use it',
    '3 territories still use it',
    '3 holidays still use it',
    '3 beats still use it',
    '3 customers still use it',
  ]);
  // Checked by name rather than as a whole list: every later milestone adds something that
  // points at a customer type, a beat or a rep, and a milestone's test must not break the next
  // one's.
  const holds = (got, wanted) => {
    for (const one of wanted)
      assert.ok(got.includes(one), `${one} missing from ${JSON.stringify(got)}`);
  };
  // RCH-1: a customer type, a form field and a beat all have things pointing at them too.
  holds(await removalBlockers(counting(2), 'customer_types', 'x'), [
    '2 customers still use it',
    '2 form rules still use it',
  ]);
  assert.deepEqual(await removalBlockers(counting(1), 'customer_form_fields', 'x'), [
    '1 form rule still uses it',
  ]);
  holds(await removalBlockers(counting(1), 'beats', 'x'), [
    '1 customer still uses it',
    '1 beat assignment still uses it',
  ]);
  // RCH-2: attendance points back at the reps, shifts, work types and leave types it cites, and
  // it keeps every row it writes, so even a cancelled request still blocks a removal. A register
  // read months later cannot name a shift or a leave type that has been taken away.
  assert.deepEqual(await removalBlockers(counting(9), 'leave_types', 'x'), [
    '9 leave requests still use it',
  ]);
  assert.deepEqual(await removalBlockers(counting(1), 'shifts', 'x'), [
    '1 field rep still uses it',
  ]);
  assert.deepEqual(await removalBlockers(counting(4), 'work_types', 'x'), [
    '4 attendance days still use it',
  ]);
  holds(await removalBlockers(counting(2), 'field_reps', 'x'), [
    '2 beat assignments still use it',
    '2 customers still use it',
    '2 attendance days still use it',
    '2 leave requests still use it',
    '2 attendance corrections still use it',
  ]);
  // RCH-3: a month that was planned, a change asked for on it and a visit that was made all
  // point back at the rep and the round they name.
  holds(await removalBlockers(counting(2), 'field_reps', 'x'), [
    '2 tour plans still use it',
    '2 plan change requests still use it',
    '2 visits still use it',
  ]);
  holds(await removalBlockers(counting(3), 'beats', 'x'), [
    '3 planned days still use it',
    '3 plan change requests still use it',
  ]);
  // RCH-4: the visit report form is the same matrix, so a question a type still asks holds both
  // the question and the type.
  holds(await removalBlockers(counting(2), 'customer_types', 'x'), ['2 report rules still use it']);
  holds(await removalBlockers(counting(1), 'visit_form_fields', 'x'), [
    '1 report rule still uses it',
  ]);
  // Still nothing points at a holiday, so removing one is never blocked.
  assert.deepEqual(await removalBlockers(counting(9), 'holidays', 'x'), []);
});

test('every Reach master is removable, permission-gated and importable through the same engine', () => {
  for (const kind of REACH_KINDS) {
    const def = MASTER_KINDS[kind];
    assert.equal(def.permission, 'reach.manage', kind);
    assert.equal(def.readPermission, 'reach.read', kind);
    assert.equal(def.deletePermission, 'reach.delete', kind);
    assert.equal(def.softDelete, true, kind);
    // The import engine picks the kind up automatically; the template has to be usable.
    const csv = templateCsv(kind);
    assert.equal(IMPORT_KINDS[kind].permission, 'reach.manage', kind);
    assert.deepEqual(
      IMPORT_KINDS[kind].columns,
      def.fields.map((f) => f.name),
      kind,
    );
    const rows = readImport(kind, csv);
    assert.equal(rows.length, IMPORT_KINDS[kind].example.length, kind);
    // Its own template must import cleanly, apostrophe-guarded phone numbers included.
    for (const row of rows)
      assert.deepEqual(
        IMPORT_KINDS[kind].validate(row.data).errors,
        [],
        `${kind} line ${row.line}`,
      );
  }
});

test('the Reach permissions are in the catalogue and depend only on permissions that exist', () => {
  const codes = new Set(permissions.map(([code]) => code));
  for (const code of ['reach.read', 'reach.manage', 'reach.delete', 'files.read', 'files.upload'])
    assert.ok(codes.has(code), code);
  for (const [code, needs] of Object.entries(requiredPermissions))
    for (const need of needs) assert.ok(codes.has(need), `${code} needs ${need}`);
  assert.deepEqual(requiredPermissions['reach.delete'], ['reach.read', 'reach.manage']);
  assert.deepEqual(requiredPermissions['files.upload'], ['files.read']);
});
