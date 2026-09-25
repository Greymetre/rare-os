import test from 'node:test';
import assert from 'node:assert/strict';
import { xlsxFixture } from './helpers/workbook-fixture.mjs';
import {
  columnIndex,
  excelDate,
  headerColumns,
  isDateFormat,
  openWorkbook,
  workbookFormat,
} from '../packages/engines/workbook.mjs';

// Both fixtures are written here rather than committed as files: the real exports are client data,
// and a fixture built by hand is the only way to know exactly what the reader is being asked to do.

// ---------- a minimal .xlsx (zip of XML parts) ----------

// ---------- a minimal .xls (OLE2 compound file of BIFF8 records) ----------

const record = (code, body) => {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(code, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
};
const u16 = (...values) => {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return b;
};
// A BIFF8 string: 16-bit length, a flags byte, then latin1 bytes.
const shortString = (text, lengthBytes = 2) => {
  const bytes = Buffer.from(text, 'latin1');
  const head = Buffer.alloc(lengthBytes + 1);
  if (lengthBytes === 2) head.writeUInt16LE(text.length, 0);
  else head.writeUInt8(text.length, 0);
  head.writeUInt8(0, lengthBytes); // not wide, not rich
  return Buffer.concat([head, bytes]);
};

function xlsFixture() {
  const strings = ['Material', 'Plnt', 'Release', 'SPRINGMATRZ'];
  const sst = Buffer.concat([
    (() => {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(strings.length, 0);
      b.writeUInt32LE(strings.length, 4);
      return b;
    })(),
    ...strings.map((s) => shortString(s)),
  ]);
  const cell = (row, column, style) => u16(row, column, style);
  const number = (row, column, style, value) => {
    const b = Buffer.alloc(14);
    b.writeUInt16LE(row, 0);
    b.writeUInt16LE(column, 2);
    b.writeUInt16LE(style, 4);
    b.writeDoubleLE(value, 6);
    return b;
  };
  const labelSst = (row, column, index) => {
    const b = Buffer.alloc(10);
    b.writeUInt16LE(row, 0);
    b.writeUInt16LE(column, 2);
    b.writeUInt16LE(0, 4);
    b.writeUInt32LE(index, 6);
    return b;
  };
  const rk = (row, column, style, raw) => {
    const b = Buffer.alloc(10);
    b.writeUInt16LE(row, 0);
    b.writeUInt16LE(column, 2);
    b.writeUInt16LE(style, 4);
    b.writeInt32LE(raw, 6);
    return b;
  };
  // Globals: BOF, two XFs (the second is a date format), the shared strings, one sheet.
  const sheetName = 'Sheet1';
  const globalsWithoutSheet = Buffer.concat([
    record(0x0809, u16(0x0600, 0x0005)),
    record(0x00e0, u16(0, 0, 0, 0)), // XF 0: general
    record(0x00e0, u16(0, 14, 0, 0)), // XF 1: built-in date format
    record(0x00fc, sst),
  ]);
  // BOUNDSHEET carries the byte position of the sheet's own records, which is only known once the
  // globals are laid out: write it with a placeholder, then patch it in place.
  const boundsheet = Buffer.alloc(6);
  const globals = Buffer.concat([
    globalsWithoutSheet,
    record(0x0085, Buffer.concat([boundsheet, shortString(sheetName, 1)])),
    record(0x000a, Buffer.alloc(0)),
  ]);
  globals.writeUInt32LE(globals.length, globalsWithoutSheet.length + 4);
  const sheet = Buffer.concat([
    record(0x0809, u16(0x0600, 0x0010)),
    // Row 1 (header) then row 2 with a shared string, a date, an RK number and a formula string.
    record(0x00fd, labelSst(0, 0, 0)),
    record(0x00fd, labelSst(0, 1, 1)),
    record(0x00fd, labelSst(0, 2, 2)),
    record(0x00fd, labelSst(1, 0, 3)),
    record(0x0203, number(1, 1, 0, 1116)),
    record(0x0203, number(1, 2, 1, 46234)),
    record(0x027e, rk(2, 0, 0, (250 << 2) | 0x02)),
    record(0x027e, rk(2, 1, 0, (12345 << 2) | 0x03)), // integer, divided by 100
    record(
      0x0006,
      Buffer.concat([
        cell(2, 2, 0),
        Buffer.from([0x00, 0, 0, 0, 0, 0, 0xff, 0xff]),
        Buffer.alloc(6),
      ]),
    ),
    record(0x0207, shortString('CALCULATED')),
    record(0x0205, Buffer.concat([cell(3, 0, 0), Buffer.from([1, 0])])),
    record(0x000a, Buffer.alloc(0)),
  ]);
  const stream = Buffer.concat([globals, sheet]);
  // The compound file around it: 512-byte sectors, one FAT sector, one directory sector. The
  // stream is padded past the 4,096-byte cutoff so it uses the normal sectors, not the mini ones.
  const sectorSize = 512;
  const target = Math.max(5120, Math.ceil(stream.length / sectorSize) * sectorSize);
  const padded = Buffer.concat([stream, Buffer.alloc(target - stream.length)]);
  const streamSectors = padded.length / sectorSize;
  const directorySector = streamSectors,
    fatSector = streamSectors + 1;
  const fat = Buffer.alloc(sectorSize, 0xff);
  for (let i = 0; i < streamSectors; i++)
    fat.writeUInt32LE(i === streamSectors - 1 ? 0xfffffffe : i + 1, i * 4);
  fat.writeUInt32LE(0xfffffffe, directorySector * 4);
  fat.writeUInt32LE(0xfffffffd, fatSector * 4);
  const directory = Buffer.alloc(sectorSize);
  const entry = (at, name, type, start, size) => {
    const bytes = Buffer.from(name + '\0', 'utf16le');
    bytes.copy(directory, at);
    directory.writeUInt16LE(bytes.length, at + 64);
    directory.writeUInt8(type, at + 66);
    directory.writeUInt32LE(start, at + 116);
    directory.writeBigUInt64LE(BigInt(size), at + 120);
  };
  entry(0, 'Root Entry', 5, 0xfffffffe, 0);
  entry(128, 'Workbook', 2, 0, stream.length);
  const header = Buffer.alloc(sectorSize, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(9, 30); // 512-byte sectors
  header.writeUInt16LE(6, 32); // 64-byte mini sectors
  header.writeUInt32LE(1, 44); // one FAT sector
  header.writeUInt32LE(directorySector, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(0xfffffffe, 60); // no mini FAT
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(0xfffffffe, 68); // no extra DIFAT sectors
  header.writeUInt32LE(0, 72);
  header.fill(0xff, 76, sectorSize);
  header.writeUInt32LE(fatSector, 76);
  return Buffer.concat([header, padded, directory, fat]);
}

// ---------- the tests ----------

test('an .xlsx export is read as the file has it: positions, blanks, dates and repeated headers', () => {
  const buffer = xlsxFixture();
  assert.equal(workbookFormat(buffer), 'xlsx');
  const wb = openWorkbook(buffer);
  assert.deepEqual(
    wb.sheets,
    [
      { name: 'MB52', hidden: false },
      { name: 'CT', hidden: true },
    ],
    'both sheets, with the hidden one marked',
  );
  const rows = [...wb.rows('MB52')];
  assert.deepEqual(
    rows.map((r) => r.row),
    [1, 2, 3],
  );
  // Header: whitespace collapsed, repeated names kept at their own positions.
  const header = headerColumns(rows[0].cells);
  assert.deepEqual(
    header.map((h) => [h.index, h.name, h.duplicate]),
    [
      [0, 'Material', false],
      [1, 'Release', false],
      [2, 'Release', true],
      [3, 'Qty', false],
      [4, 'Value Unrestricted', false],
    ],
  );
  assert.equal(header[2].occurrence, 2);
  // Row 2: rich text joined, the styled number read as a date, the missing cell left blank.
  assert.deepEqual(rows[1].cells, ['SPRINGMATRZ', '2026-07-31', '', '12.5', 'TRUE']);
  // Row 3: XML entities decoded, an unstyled decimal left alone, an error kept as its code.
  assert.deepEqual(rows[2].cells, ['R&D <2>', '', '', '1000.5', '#N/A']);
  assert.deepEqual([...wb.rows('CT')][0].cells, ['7']);
  assert.throws(() => [...wb.rows('Nope')], /no sheet called "Nope"/);
  assert.throws(() => [...wb.rows('MB52', { maxRows: 2 })], /more than 2 rows/);
});

test('an .xls export is read through its compound file and BIFF records', () => {
  const buffer = xlsFixture();
  assert.equal(workbookFormat(buffer), 'xls');
  const wb = openWorkbook(buffer);
  assert.deepEqual(wb.sheets, [{ name: 'Sheet1', hidden: false }]);
  const rows = [...wb.rows('Sheet1')];
  assert.deepEqual(rows[0].cells, ['Material', 'Plnt', 'Release']);
  // A shared string, a plain number and the same date serial the .xlsx fixture uses.
  assert.deepEqual(rows[1].cells, ['SPRINGMATRZ', '1116', '2026-07-31']);
  // RK numbers: one whole, one scaled by 100; then the string a formula produced.
  assert.deepEqual(rows[2].cells, ['250', '123.45', 'CALCULATED']);
  assert.deepEqual(rows[3].cells, ['TRUE']);
});

test('a file that is neither is refused, and the pieces behave on their own', () => {
  assert.equal(workbookFormat(Buffer.from('plant,item\n1,2\n')), null);
  assert.throws(() => openWorkbook(Buffer.from('plant,item\n')), /not an .xlsx or .xls workbook/);
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('D2'), 3);
  assert.equal(columnIndex('AA10'), 26);
  // Day 1 is 1-Jan-1900, and the 1900 leap-year bug means day 60 is skipped in the same way Excel
  // skips it: 61 is 1-Mar-1900.
  assert.equal(excelDate(1), '1900-01-01');
  assert.equal(excelDate(61), '1900-03-01');
  assert.equal(excelDate(46234), '2026-07-31');
  assert.equal(excelDate(46234.5), '2026-07-31 12:00:00');
  assert.equal(excelDate(0, true), '1904-01-01');
  assert.equal(excelDate(''), null);
  assert.equal(isDateFormat(14, null), true);
  assert.equal(isDateFormat(166, 'dd.mm.yyyy'), true);
  assert.equal(isDateFormat(167, '#,##0.00'), false);
  assert.equal(isDateFormat(168, '0.00" days"'), false);
  // A name that only differs by case or spacing is still the same repeated header.
  assert.deepEqual(
    headerColumns([' Min. Lot  Size ', 'MIN. LOT SIZE']).map((h) => [h.name, h.duplicate]),
    [
      ['Min. Lot Size', false],
      ['MIN. LOT SIZE', true],
    ],
  );
});
