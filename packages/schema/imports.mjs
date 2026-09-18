// Shared by the API (upload checks) and the worker (row validation) so both apply identical rules.
import { MASTER_KINDS, validateFields, validateMaster } from './masters.mjs';
import { GROUPED_IMPORTS, RESOURCE_FIELDS, validateResource } from './plant-model.mjs';
import { BUFFER_SETTING_FIELDS, validateBufferSetting } from './buffers.mjs';
import {
  DEMAND_HISTORY_FIELDS,
  MOVEMENT_FIELDS,
  ORDER_IMPORTS,
  STOCK_LOCATION_FIELDS,
  validateDemandHistory,
  validateMovement,
  validateStockLocation,
} from './demand-stock.mjs';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50000;

class CsvError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// RFC 4180 style: quoted fields, escaped quotes, commas/newlines inside quotes, CRLF, UTF-8 BOM.
export function parseCsv(input, { maxRows = MAX_IMPORT_ROWS } = {}) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records = [];
  let field = '',
    record = [],
    quoted = false,
    line = 1,
    recordLine = 1,
    i = 0;
  const pushRecord = () => {
    record.push(field);
    if (!(record.length === 1 && record[0] === ''))
      records.push({ line: recordLine, values: record });
    if (records.length > maxRows + 1)
      throw new CsvError(
        'TOO_MANY_ROWS',
        `The file has more than ${maxRows.toLocaleString('en-IN')} data rows. Split it into smaller files.`,
      );
    field = '';
    record = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"') {
      if (field !== '')
        throw new CsvError('INVALID_CSV', `Line ${line}: a quote can only start a field.`);
      quoted = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      pushRecord();
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++;
      recordLine = line;
    } else field += c;
    i++;
  }
  if (quoted)
    throw new CsvError('INVALID_CSV', `Line ${recordLine}: a quoted field is not closed.`);
  if (field !== '' || record.length) pushRecord();
  return records;
}

// Neutralise spreadsheet formulas when users open exported files (CSV injection).
function cell(value) {
  let v = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v;
}
export function toCsv(rows) {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const controlChars = /[\x00-\x1f\x7f]/;

export const IMPORT_KINDS = {
  units: {
    label: 'Units of measure',
    permission: 'masters.manage',
    columns: ['code', 'name', 'decimals'],
    example: [
      ['NOS', 'Numbers', '0'],
      ['KG', 'Kilogram', '3'],
    ],
    // Returns normalised values plus field-level errors; never throws for bad user data.
    validate(raw) {
      const errors = [];
      const code = (raw.code ?? '').trim().toUpperCase();
      const name = (raw.name ?? '').trim();
      const decimalsText = (raw.decimals ?? '').trim();
      if (!code) errors.push({ column: 'code', message: 'Code is required.' });
      else if (!/^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(code))
        errors.push({
          column: 'code',
          message: 'Code must be 1-20 letters, numbers, dot, hyphen or underscore.',
        });
      if (!name) errors.push({ column: 'name', message: 'Name is required.' });
      else if (name.length > 60 || controlChars.test(name))
        errors.push({
          column: 'name',
          message: 'Name must be 1-60 characters without line breaks.',
        });
      let decimals = 0;
      if (decimalsText !== '') {
        decimals = Number(decimalsText);
        if (!/^\d$/.test(decimalsText) || decimals > 6)
          errors.push({
            column: 'decimals',
            message: 'Decimals must be a whole number from 0 to 6.',
          });
      }
      return { value: { code, name, decimals }, errors };
    },
    key: (value) => value.code.toLowerCase(),
  },
};

const EXAMPLES = {
  items: [
    ['RM-STEEL', 'Steel sheet 2mm', 'RM', 'BUY', 'KG', 'Metals', '82.50', 'runner'],
    ['FG-PUMP-01', 'Pump assembly', 'FG', 'MAKE', 'NOS', 'Pumps', '4200', 'runner'],
  ],
  suppliers: [['SUP-01', 'Shree Metals', '14', 'orders@example.com', '+91 98765 43210']],
  customers: [
    ['CUST-01', 'Prime Distributors', 'DISTRIBUTOR', 'buy@example.com', '022 4000 1000', 'Mumbai'],
  ],
  item_suppliers: [['RM-STEEL', 'SUP-01', 'SM-2MM', 'KG', '', '500', '50', 'yes']],
  unit_conversions: [['BOX', 'NOS', '12', '']],
};

for (const [kind, def] of Object.entries(MASTER_KINDS))
  IMPORT_KINDS[kind] = {
    label: def.label,
    permission: def.permission,
    columns: def.fields.map((f) => f.name),
    example: EXAMPLES[kind],
    validate: (raw) => validateMaster(kind, raw),
    key: def.key,
  };

IMPORT_KINDS.resources = {
  label: 'Resources',
  permission: 'masters.manage',
  plantScoped: true,
  columns: RESOURCE_FIELDS.map((f) => f.name),
  example: [
    ['PLANT-1', 'S1', 'Prep', 'MACHINE', '2', '100', '10', ''],
    ['PLANT-1', 'S3', 'Assembly', 'LINE', '1', '95', '20', ''],
  ],
  validate: validateResource,
  key: (v) => `${v.plant.toLowerCase()}|${v.code.toLowerCase()}`,
};

// One CSV row per BOM line / routing operation; rows of the same document are grouped by the worker.
for (const [kind, def] of Object.entries(GROUPED_IMPORTS)) {
  const fields = [...def.headerFields, ...def.lineFields];
  IMPORT_KINDS[kind] = {
    label: def.label,
    permission: 'masters.manage',
    plantScoped: kind === 'routings',
    grouped: true,
    columns: fields.map((f) => f.name),
    example: def.example,
    validate: (raw) => validateFields(fields, raw),
    key:
      kind === 'boms'
        ? (v) =>
            `${v.parent_item.toLowerCase()}|${v.revision.toLowerCase()}|${v.component_item.toLowerCase()}`
        : (v) =>
            `${v.plant.toLowerCase()}|${v.item.toLowerCase()}|${v.revision.toLowerCase()}|${v.sequence}`,
  };
}

IMPORT_KINDS.stock_locations = {
  label: 'Stock locations',
  permission: 'masters.manage',
  plantScoped: true,
  columns: STOCK_LOCATION_FIELDS.map((f) => f.name),
  example: [
    ['PLANT-1', 'RM-STORE', 'Raw material store', 'STORES', 'yes'],
    ['PLANT-1', 'QC-HOLD', 'Quality hold', 'QUARANTINE', 'no'],
  ],
  validate: validateStockLocation,
  key: (v) => `${v.plant.toLowerCase()}|${v.code.toLowerCase()}`,
  duplicate: (v) => `Duplicate location ${v.code} in plant ${v.plant}`,
};

// Movements are posted in file order; duplicates are caught by external reference in the database layer.
IMPORT_KINDS.stock_movements = {
  label: 'Stock movements',
  permission: 'inventory.move',
  // Opening stock and adjustments alone may be imported with the adjust permission.
  alsoAllowed: ['inventory.adjust'],
  plantScoped: true,
  columns: MOVEMENT_FIELDS.map((f) => f.name),
  example: [
    [
      'PLANT-1',
      'RM-STORE',
      'RM-STEEL',
      'OPENING',
      '1250.5',
      '',
      '2026-09-01',
      'Stock count',
      '',
      'OPEN-RM-STEEL',
    ],
    [
      'PLANT-1',
      'RM-STORE',
      'RM-STEEL',
      'ISSUE',
      '100',
      '',
      '2026-09-02',
      'WO-1001',
      '',
      'ISS-000451',
    ],
  ],
  validate: (raw) => validateMovement(raw, { requireExternalRef: true }),
  key: null,
};

IMPORT_KINDS.demand_history = {
  label: 'Demand history',
  permission: 'demand.import',
  plantScoped: true,
  columns: DEMAND_HISTORY_FIELDS.map((f) => f.name),
  example: [
    ['PLANT-1', 'FG-PUMP-01', '2026-09-01', '14'],
    ['PLANT-1', 'FG-PUMP-01', '2026-09-02', '9'],
  ],
  validate: validateDemandHistory,
  key: (v) => `${v.plant.toLowerCase()}|${v.item.toLowerCase()}|${v.demand_date}`,
  duplicate: (v) => `Duplicate row for ${v.item} on ${v.demand_date} in plant ${v.plant}`,
};

for (const [kind, def] of Object.entries(ORDER_IMPORTS)) {
  const fields = [...def.headerFields, ...def.lineFields];
  const number = kind === 'sales_orders' ? 'order_no' : 'po_no';
  IMPORT_KINDS[kind] = {
    label: def.label,
    permission: def.permission,
    plantScoped: true,
    grouped: true,
    columns: fields.map((f) => f.name),
    example: def.example,
    validate: (raw) => validateFields(fields, raw),
    key: (v) => `${v[number].toLowerCase()}|${v.line_no}`,
    duplicate: (v) => `Duplicate line ${v.line_no} for ${v[number]}`,
  };
}

IMPORT_KINDS.buffer_settings = {
  label: 'Buffer settings',
  permission: 'buffers.manage',
  plantScoped: true,
  columns: BUFFER_SETTING_FIELDS.map((f) => f.name),
  example: [
    ['PLANT-1', 'RM-STEEL', 'BUFFER', 'BP-RM-SHORT', '', ''],
    ['PLANT-1', 'FG-PUMP-01', 'BUFFER', 'BP-FG', '4', ''],
    ['PLANT-1', 'FG-SPECIAL', 'MTO', '', '', ''],
  ],
  validate: validateBufferSetting,
  key: (v) => `${v.plant.toLowerCase()}|${v.item.toLowerCase()}`,
  duplicate: (v) => `Duplicate row for ${v.item} in plant ${v.plant}`,
};

export function importKind(kind) {
  return Object.hasOwn(IMPORT_KINDS, kind) ? IMPORT_KINDS[kind] : null;
}

export function templateCsv(kind) {
  const def = importKind(kind);
  return toCsv([def.columns, ...def.example]);
}

// Header must match exactly (case/space-insensitive) so columns can never be silently shifted.
export function readImport(kind, text) {
  const def = importKind(kind);
  if (!def) throw new CsvError('UNKNOWN_IMPORT', 'This import type is not available.');
  if (typeof text !== 'string' || !text.trim())
    throw new CsvError('EMPTY_FILE', 'The file is empty. Download the template and add rows.');
  if (/[\u0000\uFFFD]/.test(text))
    throw new CsvError('INVALID_ENCODING', 'Save the file as CSV UTF-8 and upload again.');
  const records = parseCsv(text);
  const header = (records[0]?.values ?? []).map((h) => h.trim().toLowerCase());
  if (header.join(',') !== def.columns.join(','))
    throw new CsvError(
      'INVALID_HEADER',
      `The first row must be exactly: ${def.columns.join(', ')}. Download the template to start.`,
    );
  // Undo the apostrophe our own CSV export adds before =, +, - or @ so exported files round-trip.
  const unguard = (v) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);
  for (const r of records) r.values = r.values.map(unguard);
  const rows = records.slice(1).map((r) => {
    if (r.values.length !== def.columns.length)
      return {
        line: r.line,
        data: Object.fromEntries(def.columns.map((c, i) => [c, r.values[i] ?? ''])),
        columnCountError: `Expected ${def.columns.length} columns but found ${r.values.length}.`,
      };
    return { line: r.line, data: Object.fromEntries(def.columns.map((c, i) => [c, r.values[i]])) };
  });
  if (!rows.length)
    throw new CsvError(
      'NO_ROWS',
      'The file has a header but no data rows. Add rows and upload again.',
    );
  return rows;
}

// Row validation including in-file duplicate detection; pure so it is unit tested.
export function validateRows(kind, rows) {
  const def = importKind(kind);
  const seen = new Map();
  return rows.map((row) => {
    if (row.columnCountError)
      return {
        line: row.line,
        value: row.data,
        errors: [{ column: '*', message: row.columnCountError }],
      };
    const { value, errors } = def.validate(row.data);
    if (!errors.length && def.key) {
      const key = def.key(value);
      if (seen.has(key))
        errors.push({
          column: def.columns[0],
          message: `${def.duplicate ? def.duplicate(value) : `Duplicate ${def.columns[0]} ${value[def.columns[0]]}`}; first used on line ${seen.get(key)}.`,
        });
      else seen.set(key, row.line);
    }
    return { line: row.line, value, errors };
  });
}

export { CsvError };
