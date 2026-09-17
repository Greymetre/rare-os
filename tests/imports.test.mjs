import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  readImport,
  templateCsv,
  toCsv,
  validateRows,
} from '../packages/schema/imports.mjs';

test('CSV parser handles quotes, embedded commas/newlines, CRLF, BOM and blank lines', () => {
  const rows = parseCsv('﻿code,name\r\n"A,1","Line ""one""\nnext"\r\n\r\nB,plain\n');
  assert.deepEqual(rows, [
    { line: 1, values: ['code', 'name'] },
    { line: 2, values: ['A,1', 'Line "one"\nnext'] },
    { line: 5, values: ['B', 'plain'] },
  ]);
  assert.throws(() => parseCsv('a,"open\n'), /not closed/);
  assert.throws(() => parseCsv('a,b"c\n'), /quote can only start/);
  assert.throws(() => parseCsv('h\n1\n2\n3\n', { maxRows: 2 }), /more than 2 data rows/);
});

test('import header must match the template exactly and files must contain rows', () => {
  assert.throws(() => readImport('units', ''), /empty/);
  assert.throws(
    () => readImport('units', 'name,code,decimals\nKG,Kilogram,3\n'),
    /exactly: code, name, decimals/,
  );
  assert.throws(() => readImport('units', 'code,name,decimals\n'), /no data rows/);
  assert.throws(() => readImport('nope', 'a\n1\n'), /not available/);
  assert.throws(
    () => readImport('units', 'code,name,decimals\nKG,Kilo' + String.fromCharCode(0xfffd) + ',3\n'),
    /UTF-8/,
  );
  const template = readImport('units', templateCsv('units'));
  assert.equal(template.length, 2);
  assert.deepEqual(
    validateRows('units', template).map((r) => r.errors),
    [[], []],
  );
});

test('unit rows are normalised, validated and in-file duplicates are reported by line', () => {
  const rows = readImport(
    'units',
    ' Code , NAME ,decimals\nkg,Kilogram,3\nKG,Kilo again,2\n,No code,1\nM,Metre,7\nBAD CODE,x,\nPCS,Pieces\nNOS,Numbers,\n',
  );
  const result = validateRows('units', rows);
  assert.deepEqual(result[0], {
    line: 2,
    value: { code: 'KG', name: 'Kilogram', decimals: 3 },
    errors: [],
  });
  assert.match(result[1].errors[0].message, /Duplicate code KG; first used on line 2/);
  assert.equal(result[2].errors[0].column, 'code');
  assert.equal(result[3].errors[0].column, 'decimals');
  assert.match(result[4].errors[0].message, /letters, numbers/);
  assert.match(result[5].errors[0].message, /Expected 3 columns but found 2/);
  assert.deepEqual(result[6], {
    line: 8,
    value: { code: 'NOS', name: 'Numbers', decimals: 0 },
    errors: [],
  });
});

test('exported CSV quotes safely and neutralises spreadsheet formulas', () => {
  assert.equal(
    toCsv([
      ['a', 'b,c', 'say "hi"'],
      ['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', 'plain'],
    ]),
    'a,"b,c","say ""hi"""\r\n"\'=HYPERLINK(""x"")",\'+1,\'-2,\'@SUM(A1),plain\r\n',
  );
});

test('files exported with formula guards import back unchanged, and every template validates', async () => {
  const { IMPORT_KINDS } = await import('../packages/schema/imports.mjs');
  const exported = toCsv([
    ['code', 'name', 'lead_time_days', 'email', 'phone'],
    ['SUP-9', '-Minus Metals', '7', '', '+91 98765 43210'],
  ]);
  assert.match(exported, /'\+91/);
  const [row] = validateRows('suppliers', readImport('suppliers', exported));
  assert.deepEqual(row.errors, []);
  assert.equal(row.value.phone, '+91 98765 43210');
  assert.equal(row.value.name, '-Minus Metals');
  for (const kind of Object.keys(IMPORT_KINDS))
    for (const r of validateRows(kind, readImport(kind, templateCsv(kind))))
      assert.deepEqual(r.errors, [], kind);
});
