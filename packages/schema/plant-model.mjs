// Field rules for the plant model (AV-2). Pure: forms and CSV imports share them.
import { validateFields } from './masters.mjs';
import { duplicates, validateShifts } from '../engines/plant-model.mjs';

const code = (label) => ({ name: 'code', label, type: 'code', required: true, immutable: true });
const plant = { name: 'plant', label: 'Plant code', type: 'ref', ref: 'sites', required: true };

export const RESOURCE_FIELDS = [
  plant,
  code('Resource code'),
  { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
  {
    name: 'resource_type',
    label: 'Resource type',
    type: 'enum',
    options: ['MACHINE', 'LINE', 'MANUAL'],
    default: 'MACHINE',
  },
  { name: 'machine_count', label: 'Machines', type: 'int', required: true, min: 1, max: 999 },
  {
    name: 'efficiency_pct',
    label: 'Efficiency %',
    type: 'decimal',
    decimals: 2,
    positive: true,
    maxValue: 100,
    default: '100',
  },
  {
    name: 'changeover_minutes',
    label: 'Changeover minutes',
    type: 'decimal',
    decimals: 2,
    maxValue: 1440,
    default: '0',
  },
  // Blank calendar means the plant's default calendar.
  { name: 'calendar', label: 'Calendar code', type: 'ref', ref: 'calendars' },
];

export const CALENDAR_FIELDS = [
  code('Calendar code'),
  { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
  { name: 'is_default', label: 'Default calendar for the plant', type: 'bool', default: false },
];
const SHIFT_FIELDS = [
  { name: 'name', label: 'Shift name', type: 'text', required: true, max: 40 },
  { name: 'start_time', label: 'Start', type: 'text', required: true, max: 8 },
  { name: 'end_time', label: 'End', type: 'text', required: true, max: 8 },
  { name: 'break_minutes', label: 'Break minutes', type: 'int', min: 0, max: 600 },
];
const HOLIDAY_FIELDS = [
  { name: 'holiday_date', label: 'Holiday date', type: 'date', required: true },
  { name: 'name', label: 'Holiday name', type: 'text', required: true, max: 80 },
];

export const BOM_HEADER_FIELDS = [
  {
    name: 'parent_item',
    label: 'Parent item code',
    type: 'ref',
    ref: 'items',
    required: true,
    immutable: true,
  },
  { name: 'revision', label: 'BOM revision', type: 'revision', required: true, immutable: true },
  { name: 'effective_from', label: 'Effective from', type: 'date', required: true },
  { name: 'effective_to', label: 'Effective to', type: 'date' },
  {
    name: 'base_quantity',
    label: 'Base quantity',
    type: 'decimal',
    decimals: 6,
    positive: true,
    default: '1',
  },
];
export const BOM_LINE_FIELDS = [
  {
    name: 'component_item',
    label: 'Component item code',
    type: 'ref',
    ref: 'items',
    required: true,
  },
  {
    name: 'quantity',
    label: 'Quantity',
    type: 'decimal',
    decimals: 6,
    positive: true,
    required: true,
  },
  // Blank unit means the component's base unit.
  { name: 'unit', label: 'Unit', type: 'ref', ref: 'units' },
  {
    name: 'scrap_pct',
    label: 'Scrap %',
    type: 'decimal',
    decimals: 2,
    belowValue: 100,
    default: '0',
  },
];

export const ROUTING_HEADER_FIELDS = [
  { ...plant, immutable: true },
  { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true, immutable: true },
  {
    name: 'revision',
    label: 'Routing revision',
    type: 'revision',
    required: true,
    immutable: true,
  },
  { name: 'effective_from', label: 'Effective from', type: 'date', required: true },
  { name: 'effective_to', label: 'Effective to', type: 'date' },
];
export const ROUTING_OPERATION_FIELDS = [
  { name: 'sequence', label: 'Sequence', type: 'int', required: true, min: 1, max: 9999 },
  { name: 'operation_code', label: 'Operation code', type: 'revision', required: true },
  { name: 'description', label: 'Description', type: 'text', max: 120 },
  { name: 'resource', label: 'Resource code', type: 'ref', ref: 'resources', required: true },
  {
    name: 'setup_minutes',
    label: 'Setup minutes',
    type: 'decimal',
    decimals: 2,
    maxValue: 1440,
    default: '0',
  },
  {
    name: 'run_minutes_per_unit',
    label: 'Run minutes per unit',
    type: 'decimal',
    decimals: 6,
    positive: true,
    required: true,
  },
];

function datesInOrder(value, errors) {
  if (value.effective_to && value.effective_from && value.effective_to < value.effective_from)
    errors.push({
      column: 'effective_to',
      message: 'Effective to must be on or after effective from.',
    });
}

function lines(list, fields, label) {
  if (!Array.isArray(list))
    return { values: [], errors: [{ column: label, message: `Add at least one ${label}.` }] };
  const errors = [];
  const values = list.map((raw, i) => {
    const r = validateFields(fields, raw);
    for (const e of r.errors)
      errors.push({ column: e.column, line: i + 1, message: `${label} ${i + 1}: ${e.message}` });
    return r.value;
  });
  return { values, errors };
}

export function validateResource(raw) {
  return validateFields(RESOURCE_FIELDS, raw);
}

// working_days arrives as seven booleans (form) or a seven-character 0/1 string.
export function validateCalendar(raw) {
  const { value, errors } = validateFields(CALENDAR_FIELDS, raw);
  const days = Array.isArray(raw?.working_days)
    ? raw.working_days.map((d) => (d === true ? '1' : '0')).join('')
    : String(raw?.working_days ?? '');
  if (!/^[01]{7}$/.test(days) || days === '0000000')
    errors.push({ column: 'working_days', message: 'Choose at least one working day.' });
  else value.working_days = days;
  const shifts = lines(raw?.shifts, SHIFT_FIELDS, 'Shift');
  errors.push(...shifts.errors);
  if (!shifts.errors.length)
    for (const message of validateShifts(shifts.values)) errors.push({ column: 'shifts', message });
  value.shifts = shifts.values.map((s) => ({ ...s, break_minutes: s.break_minutes ?? 0 }));
  const holidays = lines(raw?.holidays ?? [], HOLIDAY_FIELDS, 'Holiday');
  errors.push(...holidays.errors);
  for (const d of duplicates(holidays.values.map((h) => h.holiday_date).filter(Boolean)))
    errors.push({ column: 'holidays', message: `Holiday ${d} is listed more than once.` });
  value.holidays = holidays.values;
  return { value, errors };
}

export function validateBom(raw) {
  const { value, errors } = validateFields(BOM_HEADER_FIELDS, raw);
  datesInOrder(value, errors);
  const l = lines(raw?.lines, BOM_LINE_FIELDS, 'Line');
  if (Array.isArray(raw?.lines) && !raw.lines.length)
    errors.push({ column: 'lines', message: 'Add at least one component line.' });
  if (Array.isArray(raw?.lines) && raw.lines.length > 999)
    errors.push({ column: 'lines', message: 'A BOM can have at most 999 lines.' });
  errors.push(...l.errors);
  for (const c of duplicates(l.values.map((x) => x.component_item).filter(Boolean)))
    errors.push({
      column: 'lines',
      message: `Component ${c} is listed more than once. Combine the quantities on one line.`,
    });
  if (value.parent_item)
    for (const x of l.values)
      if (x.component_item && x.component_item.toLowerCase() === value.parent_item.toLowerCase())
        errors.push({
          column: 'lines',
          message: `Item ${value.parent_item} cannot be a component of itself.`,
        });
  value.lines = l.values;
  return { value, errors };
}

export function validateRouting(raw) {
  const { value, errors } = validateFields(ROUTING_HEADER_FIELDS, raw);
  datesInOrder(value, errors);
  const ops = lines(raw?.operations, ROUTING_OPERATION_FIELDS, 'Operation');
  if (Array.isArray(raw?.operations) && !raw.operations.length)
    errors.push({ column: 'operations', message: 'Add at least one operation.' });
  errors.push(...ops.errors);
  for (const s of duplicates(ops.values.map((o) => o.sequence).filter((x) => x !== undefined)))
    errors.push({ column: 'operations', message: `Sequence ${s} is used more than once.` });
  for (const c of duplicates(ops.values.map((o) => o.operation_code).filter(Boolean)))
    errors.push({ column: 'operations', message: `Operation code ${c} is used more than once.` });
  value.operations = [...ops.values].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return { value, errors };
}

// CSV import shapes: one row per BOM line / routing operation, grouped into documents.
export const GROUPED_IMPORTS = {
  boms: {
    label: 'BOM lines',
    headerFields: BOM_HEADER_FIELDS,
    lineFields: BOM_LINE_FIELDS,
    linesKey: 'lines',
    groupKey: (raw) =>
      `${String(raw.parent_item ?? '')
        .trim()
        .toLowerCase()}|${String(raw.revision ?? '')
        .trim()
        .toLowerCase()}`,
    validate: validateBom,
    example: [
      ['FG-PUMP-01', 'V1', '2026-10-01', '', '1', 'RM-STEEL', '2.5', 'KG', '2'],
      ['FG-PUMP-01', 'V1', '2026-10-01', '', '1', 'RM-MOTOR', '1', '', '0'],
    ],
  },
  routings: {
    label: 'Routing operations',
    headerFields: ROUTING_HEADER_FIELDS,
    lineFields: ROUTING_OPERATION_FIELDS,
    linesKey: 'operations',
    groupKey: (raw) =>
      ['plant', 'item', 'revision']
        .map((k) =>
          String(raw[k] ?? '')
            .trim()
            .toLowerCase(),
        )
        .join('|'),
    validate: validateRouting,
    example: [
      [
        'PLANT-1',
        'FG-PUMP-01',
        'V1',
        '2026-10-01',
        '',
        '10',
        'PREP',
        'Cut and prepare',
        'S1',
        '10',
        '3',
      ],
      ['PLANT-1', 'FG-PUMP-01', 'V1', '2026-10-01', '', '20', 'ASSY', 'Assemble', 'S3', '20', '7'],
    ],
  },
};

// Groups staged CSV rows into documents; header columns must match on every row of a group.
// Codes and revisions are case-insensitive, so `fga` and `FGa` name the same document.
const sameHeader = (field, value) => {
  const text = String(value ?? '').trim();
  return ['ref', 'revision', 'code'].includes(field.type) ? text.toLowerCase() : text;
};

// def: a GROUPED_IMPORTS entry, or its kind name.
export function groupRows(kind, rows) {
  const def = typeof kind === 'string' ? GROUPED_IMPORTS[kind] : kind;
  const groups = new Map();
  for (const row of rows) {
    const key = def.groupKey(row.data);
    if (!groups.has(key)) groups.set(key, { key, lines: [], rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map((g) => {
    const first = g.rows[0].data;
    const header = Object.fromEntries(def.headerFields.map((f) => [f.name, first[f.name]]));
    const mismatch = new Map();
    for (const row of g.rows)
      for (const f of def.headerFields)
        if (sameHeader(f, row.data[f.name]) !== sameHeader(f, first[f.name]))
          mismatch.set(
            row.line,
            `${f.label} differs from line ${g.rows[0].line} for the same document.`,
          );
    const raw = {
      ...header,
      [def.linesKey]: g.rows.map((r) =>
        Object.fromEntries(def.lineFields.map((f) => [f.name, r.data[f.name]])),
      ),
    };
    return { key: g.key, rows: g.rows, raw, mismatch };
  });
}
