// Workbook reader (AV-12): the raw files an ERP export actually produces — .xlsx (a zip of XML)
// and the older .xls (an OLE2 compound file of BIFF8 records) — read with nothing but node:zlib.
// Reference: Nilkamal simulation handover (21-Sep-2026), "Import contracts and source traps":
// SAP headers repeat, so a column is located by its position; header whitespace is stripped but
// nothing else is normalised here; a blank cell stays blank (unknown), never zero; and every row
// carries the sheet and the row number it came from, so a number can always be traced back.
//
// Nothing in here interprets a column: this layer only turns bytes into rows of cell values.

import { inflateRawSync } from 'node:zlib';

const DEFAULT_MAX_ROWS = 300000;
const DEFAULT_MAX_COLUMNS = 256;

export class WorkbookError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new WorkbookError(code, message);
};

// ---------- what kind of file this is ----------

const ZIP_MAGIC = 0x04034b50;
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function workbookFormat(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length >= 4 && b.readUInt32LE(0) === ZIP_MAGIC) return 'xlsx';
  if (b.length >= 8 && CFB_MAGIC.every((byte, i) => b[i] === byte)) return 'xls';
  return null;
}

// ---------- zip (xlsx container) ----------

// Read the central directory rather than walking local headers: only the central directory is
// authoritative about where each entry starts, and SAP exports are written by many tools.
function zipEntries(buf) {
  const end = (() => {
    const from = Math.max(0, buf.length - 66560);
    for (let i = buf.length - 22; i >= from; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
    return -1;
  })();
  if (end < 0) fail('NOT_A_WORKBOOK', 'This file is not a readable .xlsx workbook.');
  let count = buf.readUInt16LE(end + 10),
    offset = buf.readUInt32LE(end + 16);
  // Zip64: the real count and offset live in the zip64 end record.
  if (count === 0xffff || offset === 0xffffffff) {
    for (let i = end - 20; i >= 0; i--)
      if (buf.readUInt32LE(i) === 0x07064b50) {
        const zip64 = Number(buf.readBigUInt64LE(i + 8));
        if (buf.readUInt32LE(zip64) !== 0x06064b50)
          fail('NOT_A_WORKBOOK', 'This .xlsx file is damaged (zip64 directory not found).');
        count = Number(buf.readBigUInt64LE(zip64 + 32));
        offset = Number(buf.readBigUInt64LE(zip64 + 48));
        break;
      }
  }
  const entries = new Map();
  let p = offset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10),
      compressed = buf.readUInt32LE(p + 20),
      size = buf.readUInt32LE(p + 24),
      nameLength = buf.readUInt16LE(p + 28),
      extraLength = buf.readUInt16LE(p + 30),
      commentLength = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    let compressedSize = compressed,
      size64 = size;
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      // Zip64 extra field: sizes first, then the local header offset, in that order.
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = buf.readUInt16LE(e),
          length = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size64 = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (compressed === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(q));
        }
        e += 4 + length;
      }
    }
    entries.set(name, { name, method, compressedSize, size: size64, local });
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (!entries.size) fail('NOT_A_WORKBOOK', 'This .xlsx file has no readable contents.');
  return entries;
}

function zipRead(buf, entry) {
  if (!entry) return null;
  const nameLength = buf.readUInt16LE(entry.local + 26),
    extraLength = buf.readUInt16LE(entry.local + 28);
  const start = entry.local + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8)
    fail('NOT_A_WORKBOOK', `This .xlsx file uses an unsupported compression method.`);
  try {
    return inflateRawSync(raw);
  } catch {
    return fail('NOT_A_WORKBOOK', 'This .xlsx file is damaged and cannot be read.');
  }
}

// ---------- small XML helpers ----------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export function decodeXml(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#')
      return String.fromCodePoint(
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1)),
      );
    return ENTITIES[body] ?? whole;
  });
}

const attribute = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
};

// ---------- dates ----------

// Excel keeps a date as a day number. 1900 is the usual epoch, and the 1900 leap-year bug means
// day 60 does not exist; 1904 is the old Mac epoch, which SAP exports sometimes carry.
export function excelDate(serial, epoch1904 = false) {
  if (serial === null || serial === undefined || String(serial).trim() === '') return null;
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 0) return null;
  // 1900: day 1 is 1-Jan-1900, and day 60 does not exist, so anything past it counts one less.
  // 1904: day 0 is 1-Jan-1904, with no such gap.
  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const days = epoch1904 ? n : n < 61 ? n : n - 1;
  const ms = Math.round(days * 86400000);
  const d = new Date(base + ms);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19);
  return time === '00:00:00' ? date : `${date} ${time}`;
}

// A number format only says "this is a date" through its date tokens; the built-in formats that
// SAP exports use are listed by number so a file without a styles part still reads correctly.
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57,
]);
export function isDateFormat(code, formatText) {
  if (BUILTIN_DATE_FORMATS.has(Number(code))) return true;
  if (!formatText) return false;
  // Strip quoted text, escaped characters and colour/condition blocks before looking for tokens.
  const cleaned = formatText
    .replace(/\[[^\]]*\]/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '');
  return /[dmyh]/i.test(cleaned) && !/^[#0.,%\s]*$/.test(cleaned);
}

// ---------- xlsx ----------

function xlsxParts(buf) {
  const entries = zipEntries(buf);
  const workbook = zipRead(buf, entries.get('xl/workbook.xml'));
  if (!workbook) fail('NOT_A_WORKBOOK', 'This .xlsx file has no workbook part.');
  const relsXml = zipRead(buf, entries.get('xl/_rels/workbook.xml.rels'))?.toString('utf8') ?? '';
  const rels = new Map();
  for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attribute(tag, 'Id'),
      target = attribute(tag, 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const text = workbook.toString('utf8');
  const epoch1904 = /date1904="(1|true)"/i.test(text);
  const sheets = [];
  for (const tag of text.match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = attribute(tag, 'name');
    const id = attribute(tag, 'r:id') ?? attribute(tag, 'relationship:id');
    const state = attribute(tag, 'state') ?? 'visible';
    const target = id ? rels.get(id) : null;
    const path = target
      ? target.startsWith('xl/')
        ? target
        : 'xl/' + target
      : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name: name ?? `Sheet${sheets.length + 1}`, path, hidden: state !== 'visible' });
  }
  if (!sheets.length) fail('NOT_A_WORKBOOK', 'This workbook has no sheets.');
  return { entries, sheets, epoch1904 };
}

function xlsxSharedStrings(buf, entries) {
  const part = zipRead(buf, entries.get('xl/sharedStrings.xml'));
  if (!part) return [];
  const text = part.toString('utf8');
  const strings = [];
  // A shared string is one <si>; its text is every <t> inside it (rich text splits a word up).
  const si = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = si.exec(text))) {
    const body = m[1] ?? '';
    let value = '';
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let piece;
    while ((piece = t.exec(body))) value += decodeXml(piece[1] ?? '');
    strings.push(value);
  }
  return strings;
}

// Which style index means "this cell is a date": styles.xml maps a cell format to a number format.
function xlsxDateStyles(buf, entries) {
  const part = zipRead(buf, entries.get('xl/styles.xml'));
  const dateStyles = new Set();
  if (!part) return dateStyles;
  const text = part.toString('utf8');
  const formats = new Map();
  for (const tag of text.match(/<numFmt\b[^>]*\/?>/g) ?? []) {
    const id = attribute(tag, 'numFmtId'),
      code = attribute(tag, 'formatCode');
    if (id !== null) formats.set(Number(id), code ?? '');
  }
  const cellXfs = text.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  const body = cellXfs ? cellXfs[1] : '';
  let index = 0;
  for (const tag of body.match(/<xf\b[^>]*\/?>/g) ?? []) {
    const id = Number(attribute(tag, 'numFmtId') ?? 0);
    if (isDateFormat(id, formats.get(id))) dateStyles.add(index);
    index++;
  }
  return dateStyles;
}

// A1 -> 0, B1 -> 1, AA1 -> 26. Cells can be sparse and out of order, so the column comes from the
// reference, never from the order the cells appear in.
export function columnIndex(reference) {
  let n = 0;
  for (const ch of String(reference ?? '')) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) n = n * 26 + (code - 64);
    else if (code >= 97 && code <= 122) n = n * 26 + (code - 96);
    else break;
  }
  return n - 1;
}

function* xlsxRows(buf, parts, sheet, { maxRows, maxColumns }) {
  const data = zipRead(buf, parts.entries.get(sheet.path));
  if (!data) fail('SHEET_NOT_FOUND', `Sheet "${sheet.name}" is missing from the workbook.`);
  const text = data.toString('utf8');
  const strings = xlsxSharedStrings(buf, parts.entries);
  const dateStyles = xlsxDateStyles(buf, parts.entries);
  const rowTag = /<row\b([^>]*)(\/>|>([\s\S]*?)<\/row>)/g;
  let match,
    emitted = 0,
    expected = 0;
  while ((match = rowTag.exec(text))) {
    expected++;
    const number = Number(attribute('<row ' + match[1] + '>', 'r') ?? expected);
    const body = match[3] ?? '';
    const cells = [];
    const cellTag = /<c\b([^>]*)(\/>|>([\s\S]*?)<\/c>)/g;
    let cell;
    while ((cell = cellTag.exec(body))) {
      const head = '<c ' + cell[1] + '>';
      const reference = attribute(head, 'r');
      const type = attribute(head, 't') ?? 'n';
      const style = Number(attribute(head, 's') ?? -1);
      const inner = cell[3] ?? '';
      let value = '';
      if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let piece;
        while ((piece = t.exec(inner))) value += decodeXml(piece[1] ?? '');
      } else {
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? decodeXml(v[1]) : '';
        if (type === 's') value = strings[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
        else if (type === 'e') value = raw;
        else if (raw !== '' && dateStyles.has(style))
          value = excelDate(raw, parts.epoch1904) ?? raw;
        else value = raw;
      }
      const index = reference ? columnIndex(reference) : cells.length;
      if (index >= 0 && index < maxColumns) cells[index] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    emitted++;
    if (emitted > maxRows)
      fail(
        'TOO_MANY_ROWS',
        `Sheet "${sheet.name}" has more than ${maxRows.toLocaleString('en-IN')} rows.`,
      );
    yield { row: number, cells };
  }
}

// ---------- xls (OLE2 compound file, BIFF8 records) ----------

function cfbStreams(buf) {
  const sectorShift = buf.readUInt16LE(30),
    miniShift = buf.readUInt16LE(32);
  const size = 1 << sectorShift,
    miniSize = 1 << miniShift;
  const miniCutoff = buf.readUInt32LE(56) || 4096;
  const sectorOffset = (sector) => (sector + 1) * size;
  // Header: FAT sector count at 44, first directory sector at 48, first mini FAT at 60, and the
  // DIFAT (the list of FAT sectors) starts inline at 76 and continues from the sector named at 68.
  const fatCount = buf.readUInt32LE(44),
    firstDifat = buf.readUInt32LE(68),
    difatCount = buf.readUInt32LE(72);
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) {
    const sector = buf.readUInt32LE(76 + i * 4);
    if (sector === 0xffffffff) break;
    fatSectors.push(sector);
  }
  let next = firstDifat;
  for (let i = 0; i < difatCount && next !== 0xffffffff && next !== 0xfffffffe; i++) {
    const start = sectorOffset(next);
    if (start + size > buf.length) break;
    for (let j = 0; j < size / 4 - 1 && fatSectors.length < fatCount; j++) {
      const sector = buf.readUInt32LE(start + j * 4);
      if (sector !== 0xffffffff) fatSectors.push(sector);
    }
    next = buf.readUInt32LE(start + size - 4);
  }
  const fat = [];
  for (const sector of fatSectors) {
    const start = sectorOffset(sector);
    if (start + size > buf.length) break;
    for (let i = 0; i < size / 4; i++) fat.push(buf.readUInt32LE(start + i * 4));
  }
  const chain = (start, table) => {
    const out = [];
    let sector = start,
      guard = 0;
    while (sector !== 0xfffffffe && sector !== 0xffffffff && guard++ < table.length + 8) {
      out.push(sector);
      sector = table[sector] ?? 0xfffffffe;
    }
    return out;
  };
  const readChain = (start, table, offsetOf, unit, length) => {
    const parts = [];
    for (const sector of chain(start, table)) {
      const at = offsetOf(sector);
      if (at >= buf.length) break;
      parts.push(buf.subarray(at, Math.min(at + unit, buf.length)));
    }
    const all = Buffer.concat(parts);
    return length >= 0 ? all.subarray(0, length) : all;
  };
  // Directory entries: name, type, start sector and size, 128 bytes each.
  const directory = readChain(buf.readUInt32LE(48), fat, sectorOffset, size, -1);
  const entries = [];
  for (let i = 0; i + 128 <= directory.length; i += 128) {
    const nameLength = directory.readUInt16LE(i + 64);
    if (nameLength < 2) continue;
    const name = directory.toString('utf16le', i, i + nameLength - 2).replace(/\0/g, '');
    entries.push({
      name,
      type: directory[i + 66],
      start: directory.readUInt32LE(i + 116),
      size: Number(directory.readBigUInt64LE(i + 120)),
    });
  }
  const root = entries.find((e) => e.type === 5);
  const miniFat = root
    ? readChain(buf.readUInt32LE(60), fat, sectorOffset, size, -1)
    : Buffer.alloc(0);
  const miniTable = [];
  for (let i = 0; i + 4 <= miniFat.length; i += 4) miniTable.push(miniFat.readUInt32LE(i));
  const miniStore = root ? readChain(root.start, fat, sectorOffset, size, -1) : Buffer.alloc(0);
  const streams = new Map();
  for (const entry of entries) {
    if (entry.type !== 2) continue;
    const data =
      entry.size < miniCutoff && miniStore.length
        ? (() => {
            const parts = [];
            for (const sector of chain(entry.start, miniTable))
              parts.push(miniStore.subarray(sector * miniSize, (sector + 1) * miniSize));
            return Buffer.concat(parts).subarray(0, entry.size);
          })()
        : readChain(entry.start, fat, sectorOffset, size, entry.size);
    streams.set(entry.name, data);
  }
  return streams;
}

// An RK number packs a float or a scaled integer into four bytes.
function rkValue(raw) {
  const isInteger = (raw & 0x02) !== 0,
    divide = (raw & 0x01) !== 0;
  let value;
  if (isInteger) value = raw >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeInt32LE(raw & 0xfffffffc, 4);
    value = b.readDoubleLE(0);
  }
  return divide ? value / 100 : value;
}

function biffString(buf, at, lengthBytes = 2) {
  const length = lengthBytes === 2 ? buf.readUInt16LE(at) : buf.readUInt8(at);
  const flags = buf.readUInt8(at + lengthBytes);
  let p = at + lengthBytes + 1;
  const wide = (flags & 0x01) !== 0,
    rich = (flags & 0x08) !== 0,
    farEast = (flags & 0x04) !== 0;
  let runs = 0,
    extra = 0;
  if (rich) {
    runs = buf.readUInt16LE(p);
    p += 2;
  }
  if (farEast) {
    extra = buf.readUInt32LE(p);
    p += 4;
  }
  const bytes = length * (wide ? 2 : 1);
  const text = wide
    ? buf.toString('utf16le', p, p + bytes)
    : Buffer.from(buf.subarray(p, p + bytes)).toString('latin1');
  return { text, end: p + bytes + runs * 4 + extra };
}

function* biffRecords(stream) {
  let p = 0;
  while (p + 4 <= stream.length) {
    const code = stream.readUInt16LE(p),
      length = stream.readUInt16LE(p + 2);
    const body = stream.subarray(p + 4, p + 4 + length);
    p += 4 + length;
    yield { code, body, at: p };
  }
}

// CONTINUE records carry the rest of a long SST; the string that straddles the join restarts with
// its own flags byte, which is what makes the shared string table fiddly to read.
function biffSharedStrings(stream) {
  const strings = [];
  let collecting = null;
  for (const record of biffRecords(stream)) {
    if (record.code === 0x00fc) {
      collecting = Buffer.from(record.body);
      continue;
    }
    if (collecting && record.code === 0x003c) {
      collecting = Buffer.concat([collecting, Buffer.from(record.body)]);
      continue;
    }
    if (collecting) break;
  }
  if (!collecting) return strings;
  const total = collecting.readUInt32LE(4);
  let p = 8;
  for (let i = 0; i < total && p + 3 <= collecting.length; i++) {
    const read = biffString(collecting, p, 2);
    strings.push(read.text);
    p = read.end;
  }
  return strings;
}

function xlsSheets(streams) {
  const stream = streams.get('Workbook') ?? streams.get('Book');
  if (!stream) fail('NOT_A_WORKBOOK', 'This .xls file has no workbook stream.');
  const sheets = [];
  let epoch1904 = false;
  for (const record of biffRecords(stream)) {
    if (record.code === 0x0085) {
      const position = record.body.readUInt32LE(0);
      const hidden = (record.body.readUInt8(4) & 0x03) !== 0;
      const read = biffString(record.body, 6, 1);
      sheets.push({ name: read.text, position, hidden });
    } else if (record.code === 0x0022) epoch1904 = record.body.readUInt16LE(0) === 1;
    else if (record.code === 0x000a && sheets.length) break;
  }
  return { stream, sheets, epoch1904 };
}

// Which formats are dates, by cell format index (the XF records, in order).
function xlsDateStyles(stream) {
  const formats = new Map();
  const dateStyles = new Set();
  let index = 0;
  for (const record of biffRecords(stream)) {
    if (record.code === 0x041e) {
      const id = record.body.readUInt16LE(0);
      formats.set(id, biffString(record.body, 2, 2).text);
    } else if (record.code === 0x00e0) {
      const id = record.body.readUInt16LE(2);
      if (isDateFormat(id, formats.get(id))) dateStyles.add(index);
      index++;
    } else if (record.code === 0x000a && index) break;
  }
  return dateStyles;
}

function* xlsRows(streams, sheet, { maxRows, maxColumns }) {
  const { stream, epoch1904 } = xlsSheets(streams);
  const strings = biffSharedStrings(stream);
  const dateStyles = xlsDateStyles(stream);
  const body = stream.subarray(sheet.position);
  let current = null,
    emitted = 0,
    lastString = null;
  // Records arrive row by row: when the row number changes the row before it is complete. The
  // value is stored first, so the cell that starts a new row is never the one that is lost.
  const push = (rowNumber, column, value) => {
    if (column >= maxColumns) return null;
    let finished = null;
    if (!current || current.row !== rowNumber) {
      finished = current;
      current = { row: rowNumber, cells: [] };
    }
    while (current.cells.length <= column) current.cells.push('');
    current.cells[column] = value;
    return finished;
  };
  const number = (raw, style) =>
    dateStyles.has(style) ? (excelDate(raw, epoch1904) ?? String(raw)) : String(raw);
  for (const record of biffRecords(body)) {
    let finished = null;
    if (record.code === 0x00fd) {
      // LABELSST
      const row = record.body.readUInt16LE(0),
        column = record.body.readUInt16LE(2);
      finished = push(row + 1, column, strings[record.body.readUInt32LE(6)] ?? '');
    } else if (record.code === 0x0204) {
      // LABEL (BIFF8 without the shared table)
      const row = record.body.readUInt16LE(0),
        column = record.body.readUInt16LE(2);
      finished = push(row + 1, column, biffString(record.body, 6, 2).text);
    } else if (record.code === 0x0203) {
      // NUMBER
      const row = record.body.readUInt16LE(0),
        column = record.body.readUInt16LE(2),
        style = record.body.readUInt16LE(4);
      finished = push(row + 1, column, number(record.body.readDoubleLE(6), style));
    } else if (record.code === 0x027e) {
      // RK
      const row = record.body.readUInt16LE(0),
        column = record.body.readUInt16LE(2),
        style = record.body.readUInt16LE(4);
      finished = push(row + 1, column, number(rkValue(record.body.readInt32LE(6)), style));
    } else if (record.code === 0x00bd) {
      // MULRK: one record, many columns
      const row = record.body.readUInt16LE(0),
        first = record.body.readUInt16LE(2);
      const count = (record.body.length - 6) / 6;
      for (let i = 0; i < count; i++) {
        const style = record.body.readUInt16LE(4 + i * 6);
        const value = rkValue(record.body.readInt32LE(6 + i * 6));
        const out = push(row + 1, first + i, number(value, style));
        finished = finished ?? out;
      }
    } else if (record.code === 0x0006) {
      // FORMULA: a cached number here, or a string in the STRING record that follows.
      const row = record.body.readUInt16LE(0),
        column = record.body.readUInt16LE(2),
        style = record.body.readUInt16LE(4);
      const marker = record.body.readUInt16LE(12);
      if (marker === 0xffff && record.body.readUInt8(6) === 0) lastString = { row, column };
      else finished = push(row + 1, column, number(record.body.readDoubleLE(6), style));
    } else if (record.code === 0x0207 && lastString) {
      // STRING: the text of the formula above.
      finished = push(lastString.row + 1, lastString.column, biffString(record.body, 0, 2).text);
      lastString = null;
    } else if (record.code === 0x0205) {
      // BOOLERR
      const row = record.body.readUInt16LE(0),
        column = record.body.readUInt16LE(2);
      const value = record.body.readUInt8(7)
        ? 'ERROR'
        : record.body.readUInt8(6)
          ? 'TRUE'
          : 'FALSE';
      finished = push(row + 1, column, value);
    } else if (record.code === 0x000a) {
      // EOF: this sheet is done.
      break;
    }
    if (finished) {
      emitted++;
      if (emitted > maxRows)
        fail(
          'TOO_MANY_ROWS',
          `Sheet "${sheet.name}" has more than ${maxRows.toLocaleString('en-IN')} rows.`,
        );
      yield finished;
    }
  }
  if (current) yield current;
}

// ---------- the reader ----------

// openWorkbook(buffer) -> { format, sheets: [{name, hidden}], rows(sheetName, options) }
// rows() is a generator so a 300,000-row export is read a row at a time rather than held whole.
export function openWorkbook(
  buffer,
  { maxRows = DEFAULT_MAX_ROWS, maxColumns = DEFAULT_MAX_COLUMNS } = {},
) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const format = workbookFormat(buf);
  if (!format)
    fail(
      'NOT_A_WORKBOOK',
      'This file is not an .xlsx or .xls workbook. Save it as .xlsx and try again.',
    );
  if (format === 'xlsx') {
    const parts = xlsxParts(buf);
    return {
      format,
      sheets: parts.sheets.map((s) => ({ name: s.name, hidden: s.hidden })),
      rows(sheetName, options = {}) {
        const sheet = parts.sheets.find((s) => s.name === sheetName) ?? parts.sheets[0];
        if (sheetName && !parts.sheets.some((s) => s.name === sheetName))
          fail('SHEET_NOT_FOUND', `This workbook has no sheet called "${sheetName}".`);
        return xlsxRows(buf, parts, sheet, {
          maxRows: options.maxRows ?? maxRows,
          maxColumns: options.maxColumns ?? maxColumns,
        });
      },
    };
  }
  const streams = cfbStreams(buf);
  const { sheets } = xlsSheets(streams);
  return {
    format,
    sheets: sheets.map((s) => ({ name: s.name, hidden: s.hidden })),
    rows(sheetName, options = {}) {
      const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0];
      if (sheetName && !sheets.some((s) => s.name === sheetName))
        fail('SHEET_NOT_FOUND', `This workbook has no sheet called "${sheetName}".`);
      if (!sheet) fail('NOT_A_WORKBOOK', 'This .xls file has no sheets.');
      return xlsRows(streams, sheet, {
        maxRows: options.maxRows ?? maxRows,
        maxColumns: options.maxColumns ?? maxColumns,
      });
    },
  };
}

// The header row as the file has it: whitespace stripped, nothing else changed, and every column
// kept at its own position even when SAP repeats a name (Release, Act.finish, Min. Lot Size).
export function headerColumns(cells) {
  const seen = new Map();
  return (cells ?? []).map((cell, index) => {
    const name = String(cell ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const occurrence = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), occurrence);
    return { index, name, occurrence, duplicate: occurrence > 1 };
  });
}
