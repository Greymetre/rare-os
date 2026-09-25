// Workbooks built byte by byte for the tests: the real ERP exports are client data and never
// enter the repository. This writes the smallest .xlsx a reader can be held to — shared strings,
// a date style, cells addressed by reference — so a test can state exactly what a file contains.
import { deflateRawSync } from 'node:zlib';

function zip(files) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const deflated = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 14); // crc, not checked by the reader
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, deflated);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + deflated.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

// A workbook of plain text rows: sheets({ Sheet1: [['Material','Plnt'], ['X', '1116']] }).
export function workbook(sheets) {
  const names = Object.keys(sheets);
  const escape = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const column = (i) => {
    let n = i + 1,
      out = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      out = String.fromCharCode(65 + r) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };
  return zip([
    [
      'xl/workbook.xml',
      `<workbook xmlns:r="x"><sheets>${names
        .map((n, i) => `<sheet name="${escape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships>${names
        .map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    ],
    ...names.map((name, index) => [
      `xl/worksheets/sheet${index + 1}.xml`,
      `<worksheet><sheetData>${sheets[name]
        .map(
          (row, r) =>
            `<row r="${r + 1}">${row
              .map((cell, c) =>
                cell === null || cell === undefined || cell === ''
                  ? ''
                  : `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${escape(cell)}</t></is></c>`,
              )
              .join('')}</row>`,
        )
        .join('')}</sheetData></worksheet>`,
    ]),
  ]);
}

// The fixture the reader's own tests use: SAP's habits in one sheet.
export const xlsxFixture = () =>
  zip([
    [
      'xl/workbook.xml',
      `<workbook xmlns:r="x"><sheets><sheet name="MB52" sheetId="1" r:id="rId1"/>` +
        `<sheet name="CT" sheetId="2" r:id="rId2" state="hidden"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    ],
    [
      'xl/sharedStrings.xml',
      `<sst count="4"><si><t>Material</t></si><si><t>Qty</t></si>` +
        `<si><r><t>SPRING</t></r><r><t>MATRZ</t></r></si><si><t>Release</t></si></sst>`,
    ],
    [
      'xl/styles.xml',
      `<styleSheet><numFmts><numFmt numFmtId="166" formatCode="dd.mm.yyyy"/></numFmts>` +
        `<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="166"/><xf numFmtId="4"/></cellXfs></styleSheet>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData>` +
        // Header: Material, Release, Release again (SAP repeats), Qty, and a name with spaces.
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>3</v></c>` +
        `<c r="C1" t="s"><v>3</v></c><c r="D1" t="s"><v>1</v></c>` +
        `<c r="E1" t="inlineStr"><is><t>  Value  Unrestricted </t></is></c></row>` +
        // Cells out of order, one missing (C), a styled date, a plain number and a boolean.
        `<row r="2"><c r="D2"><v>12.5</v></c><c r="A2" t="s"><v>2</v></c>` +
        `<c r="B2" s="1"><v>46234</v></c><c r="E2" t="b"><v>1</v></c></row>` +
        `<row r="3"><c r="A3" t="inlineStr"><is><t>R&amp;D &lt;2&gt;</t></is></c>` +
        `<c r="D3" s="2"><v>1000.5</v></c><c r="E3" t="e"><v>#N/A</v></c></row>` +
        `</sheetData></worksheet>`,
    ],
    [
      'xl/worksheets/sheet2.xml',
      `<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
    ],
  ]);
