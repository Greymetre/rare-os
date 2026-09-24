// Import mapping (AV-12): how a raw export's columns become our fields, and what can be said
// honestly about the result. Pure — it never touches the database and never guesses silently.
// Reference: Nilkamal simulation handover (21-Sep-2026), "Import contracts and source traps".
//
// Three rules run through all of it:
// * A column is addressed by its position. A name is only a way to find that position once, which
//   is why a repeated SAP header (Release, Act.finish, Min. Lot Size) can still be told apart.
// * A blank cell is unknown, not zero. Nothing is invented to fill it.
// * Only what the mapping says is converted: an explicit UOM alias, a chosen date format, a chosen
//   decimal convention. Anything doubtful is reported as an issue instead of being assumed.

const TRIM = (v) => String(v ?? '').trim();

// ---------- finding a column ----------

// Header names an ERP export tends to use for each of our fields. These only order the
// suggestions a person then confirms; nothing is mapped without a decision.
export const SOURCE_ALIASES = {
  plant: ['plant', 'plnt', 'planning plant', 'werks', 'site', 'plant code'],
  item: ['material', 'material number', 'matnr', 'item', 'item code', 'component', 'sku'],
  parent_item: ['material', 'parent', 'parent material', 'bom material', 'header material'],
  component_item: ['component', 'component material', 'child material', 'bom component'],
  name: ['material description', 'description', 'material desc', 'item name', 'name', 'text'],
  quantity: [
    'quantity',
    'qty',
    'order quantity',
    'unrestricted',
    'balance quantity',
    'requirement quantity',
    'component quantity',
    'billing qty',
  ],
  unit: ['bun', 'base unit', 'uom', 'unit', 'unit of measure', 'meins', 'gmein', 'buom'],
  demand_date: ['billing date', 'invoice date', 'document date', 'date', 'posting date'],
  due_date: ['due date', 'delivery date', 'finish date', 'basic finish', 'latest finish'],
  start_date: ['start date', 'basic start', 'release', 'release date', 'scheduled start'],
  order_date: ['created on', 'order date', 'document date', 'po date'],
  order_no: ['order', 'order number', 'production order', 'process order'],
  po_no: ['purchasing document', 'po', 'po number', 'purchase order'],
  supplier: ['vendor', 'supplier', 'lifnr', 'vendor code'],
  customer: ['customer', 'sold-to party', 'kunnr', 'customer code'],
  location: ['sloc', 'storage location', 'lgort', 'location'],
  item_type: ['material type', 'mtart', 'type'],
  base_unit: ['bun', 'base unit', 'base uom', 'meins', 'buom'],
  standard_cost: ['standard price', 'moving price', 'value', 'price', 'cost'],
  line_no: ['item', 'line', 'line item', 'po item', 'sales order item'],
  sequence: ['counter', 'sequence', 'operation', 'op no'],
  operation_code: ['operation', 'activity', 'op code', 'work centre', 'work center'],
  resource: ['work centre', 'work center', 'resource', 'machine', 'arbpl'],
  run_minutes_per_unit: ['standard value', 'cycle time', 'run time', 'machine time'],
  setup_minutes: ['setup', 'setup time', 'set-up time'],
  revision: ['alternative bom', 'altbom', 'group counter', 'revision', 'version'],
  effective_from: ['valid from', 'effective from', 'from date'],
  effective_to: ['valid to', 'effective to', 'to date'],
  reference: ['reference', 'sales order', 'order reason', 'ref'],
  movement_type: ['movement type', 'mvt', 'bwart'],
  movement_date: ['posting date', 'document date', 'entry date', 'date'],
};

const normalise = (name) =>
  TRIM(name)
    .toLowerCase()
    .replace(/[\s_.]+/g, ' ');

// How well a source header matches one of our fields: an exact name beats an alias, an alias beats
// a partial, and nothing else counts at all.
export function columnScore(field, header) {
  const source = normalise(header);
  if (!source) return 0;
  const target = normalise(field);
  if (source === target) return 100;
  const aliases = SOURCE_ALIASES[field] ?? [];
  const index = aliases.findIndex((a) => normalise(a) === source);
  if (index >= 0) return 90 - index;
  if (source.replace(/\s/g, '') === target.replace(/\s/g, '')) return 80;
  if (aliases.some((a) => source.startsWith(normalise(a)) || normalise(a).startsWith(source)))
    return 60;
  if (source.includes(target) || target.includes(source)) return 40;
  return 0;
}

// A first mapping for a sheet: each field takes the best column that no better field has claimed.
// Everything below the threshold is left for a person to decide.
export function suggestMapping(fields, header, { threshold = 40 } = {}) {
  const columns = (header ?? []).map((h, index) => ({
    index,
    name: typeof h === 'string' ? h : (h?.name ?? ''),
  }));
  const candidates = [];
  for (const field of fields)
    for (const column of columns) {
      const score = columnScore(field, column.name);
      if (score >= threshold) candidates.push({ field, column, score });
    }
  candidates.sort((a, b) => b.score - a.score || a.column.index - b.column.index);
  const mapped = {},
    usedColumns = new Set();
  for (const c of candidates) {
    if (mapped[c.field] || usedColumns.has(c.column.index)) continue;
    mapped[c.field] = {
      by: 'position',
      index: c.column.index,
      name: c.column.name,
      confidence: c.score,
    };
    usedColumns.add(c.column.index);
  }
  return {
    columns: mapped,
    unmatched: fields.filter((f) => !mapped[f]),
    unused: columns.filter((c) => !usedColumns.has(c.index)),
  };
}

// The header as a signature, so the same export shape can be recognised next month.
export function headerFingerprint(header) {
  return (header ?? [])
    .map((h) => normalise(typeof h === 'string' ? h : (h?.name ?? '')))
    .join('|');
}

// Turn a saved mapping into column positions against this file's header. A mapping saved by name
// is re-found here; a mapping saved by position is used as it is, which is what a repeated header
// needs.
export function resolveMapping(mapping, header) {
  const names = (header ?? []).map((h) => normalise(typeof h === 'string' ? h : (h?.name ?? '')));
  const resolved = {},
    problems = [];
  for (const [field, source] of Object.entries(mapping?.columns ?? {})) {
    if (!source || source.by === 'constant') {
      resolved[field] = { ...source, by: 'constant' };
      continue;
    }
    if (source.by === 'position') {
      const index = Number(source.index);
      if (!Number.isInteger(index) || index < 0 || index >= names.length)
        problems.push({
          field,
          message: `Column ${Number.isInteger(index) ? index + 1 : '?'} is not in this sheet.`,
        });
      else
        resolved[field] = {
          by: 'position',
          index,
          name: header[index]?.name ?? header[index] ?? '',
          ...(source.transform ? { transform: source.transform } : {}),
          ...(source.format ? { format: source.format } : {}),
        };
      continue;
    }
    // by name, with the occurrence when the name repeats
    const wanted = normalise(source.name);
    const matches = names.flatMap((n, index) => (n === wanted ? [index] : []));
    const occurrence = Number(source.occurrence ?? 1);
    if (!matches.length)
      problems.push({ field, message: `This sheet has no column called "${source.name}".` });
    else if (matches.length > 1 && !source.occurrence)
      problems.push({
        field,
        message: `"${source.name}" appears ${matches.length} times: choose which one by position.`,
      });
    else if (matches[occurrence - 1] === undefined)
      problems.push({
        field,
        message: `"${source.name}" appears ${matches.length} time(s), not ${occurrence}.`,
      });
    else
      resolved[field] = {
        by: 'position',
        index: matches[occurrence - 1],
        name: source.name,
        ...(source.transform ? { transform: source.transform } : {}),
        ...(source.format ? { format: source.format } : {}),
      };
  }
  return { columns: resolved, problems };
}

// ---------- the conversions a mapping is allowed to make ----------

// A number as an ERP writes it: thousands separators, a trailing minus, blanks left blank.
export function parseNumber(text, { decimal = 'auto' } = {}) {
  const raw = TRIM(text);
  if (raw === '') return { value: '', blank: true };
  let s = raw.replace(/\s/g, '');
  let negative = false;
  if (/-$/.test(s)) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Which separator is the decimal one: when both appear, the last one is; when only a comma
  // appears, three digits after it read as thousands and one or two as a decimal.
  const auto = () => {
    const lastDot = s.lastIndexOf('.'),
      lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) return lastComma > lastDot ? 'comma' : 'dot';
    if (lastComma >= 0) return /,\d{1,2}$/.test(s) ? 'comma' : 'dot';
    return 'dot';
  };
  const style = decimal === 'auto' || !decimal ? auto() : decimal;
  s = style === 'comma' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^[+-]?\d*\.?\d+([eE][+-]?\d+)?$/.test(s))
    return { value: raw, issue: `"${raw}" is not a number.` };
  const value = (negative ? '-' : '') + s.replace(/^\+/, '');
  return { value: String(Number(value)) };
}

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => {
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  const date = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  )
    return null;
  return `${year}-${pad(m)}-${pad(d)}`;
};

// A date as an ERP writes it. 'auto' reads what cannot be misread and refuses what can: with a
// slash or a hyphen and both parts under 13, day-first and month-first look the same, so the
// mapping has to say which. The handover warns that dates differ by sheet, so this asks.
export function parseDate(text, { format = 'auto' } = {}) {
  const raw = TRIM(text).replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '');
  if (raw === '') return { value: '', blank: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { value: raw };
  if (format === 'serial' || (/^\d+(\.\d+)?$/.test(raw) && format === 'auto' && raw.length <= 6)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return { value: raw, issue: `"${raw}" is not a date.` };
    const d = new Date(Date.UTC(1899, 11, 31) + Math.round((n < 61 ? n : n - 1) * 86400000));
    return { value: d.toISOString().slice(0, 10) };
  }
  if (/^\d{8}$/.test(raw)) {
    const iso = isoOf(raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8));
    return iso ? { value: iso } : { value: raw, issue: `"${raw}" is not a date.` };
  }
  const parts = raw.match(/^(\d{1,4})([./-])(\d{1,2})\2(\d{2,4})$/);
  if (!parts) return { value: raw, issue: `"${raw}" is not a date.` };
  const [, a, separator, b, c] = parts;
  const order =
    format !== 'auto'
      ? format
      : a.length === 4
        ? 'ymd'
        : separator === '.'
          ? 'dmy'
          : Number(a) > 12
            ? 'dmy'
            : Number(b) > 12
              ? 'mdy'
              : null;
  if (!order)
    return {
      value: raw,
      issue: `"${raw}" could be day-first or month-first: choose the date format for this column.`,
    };
  const iso = order === 'ymd' ? isoOf(a, b, c) : order === 'mdy' ? isoOf(c, a, b) : isoOf(c, b, a);
  return iso ? { value: iso } : { value: raw, issue: `"${raw}" is not a date.` };
}

// A unit is only ever renamed through an alias the mapping states; an unknown unit stays as it is.
export function normaliseUnit(text, aliases = {}) {
  const raw = TRIM(text).toUpperCase();
  if (raw === '') return { value: '', blank: true };
  const map = new Map(Object.entries(aliases).map(([from, to]) => [TRIM(from).toUpperCase(), to]));
  return map.has(raw) ? { value: TRIM(map.get(raw)).toUpperCase(), alias: raw } : { value: raw };
}

// ---------- one row ----------

// Produce our fields from one source row, and say for every value where it came from. Issues are
// reported, never repaired: a row with an issue is still shown, with its reason.
export function mapRow(resolved, cells, options = {}) {
  const values = {},
    sources = {},
    issues = [];
  for (const [field, source] of Object.entries(resolved.columns ?? {})) {
    if (source.by === 'constant') {
      values[field] = TRIM(source.value);
      sources[field] = { constant: true };
      continue;
    }
    const cell = cells?.[source.index];
    const transform = source.transform ?? options.transforms?.[field] ?? 'text';
    let result;
    if (transform === 'number') result = parseNumber(cell, { decimal: options.decimal });
    else if (transform === 'date')
      result = parseDate(cell, { format: source.format ?? options.dateFormat ?? 'auto' });
    else if (transform === 'unit') result = normaliseUnit(cell, options.uomAliases);
    else if (transform === 'upper') result = { value: TRIM(cell).toUpperCase() };
    else result = { value: TRIM(cell) };
    values[field] = result.value;
    sources[field] = {
      column: source.index + 1,
      header: source.name,
      ...(result.alias ? { alias: result.alias } : {}),
    };
    if (result.issue) issues.push({ field, column: source.index + 1, message: result.issue });
  }
  return { values, sources, issues };
}

// A row with nothing in it at all is not an error: SAP exports pad their sheets.
export const isBlankRow = (cells) => !(cells ?? []).some((c) => TRIM(c) !== '');

// ---------- rows a mapping deliberately leaves out ----------

// A real export carries rows this import does not want: another plant's rows, subtotal lines, or
// stock rows at zero. A filter states that in the mapping, and every row it removes is counted
// against the rule that removed it, so nothing disappears quietly.
export const FILTER_OPERATORS = ['equals', 'not_equals', 'blank', 'not_blank', 'zero', 'not_zero'];

export function describeFilter({ field, op, value }) {
  const what = `${field} ${String(op).replace('_', ' ')}`;
  return ['equals', 'not_equals'].includes(op) ? `${what} "${value}"` : what;
}

export function rowPasses(values, filters = []) {
  for (const filter of filters ?? []) {
    const raw = TRIM(values?.[filter.field]);
    const wanted = TRIM(filter.value);
    const number = Number(raw);
    const ok =
      filter.op === 'equals'
        ? raw.toLowerCase() === wanted.toLowerCase()
        : filter.op === 'not_equals'
          ? raw.toLowerCase() !== wanted.toLowerCase()
          : filter.op === 'blank'
            ? raw === ''
            : filter.op === 'not_blank'
              ? raw !== ''
              : filter.op === 'zero'
                ? raw !== '' && Number.isFinite(number) && number === 0
                : // not_zero: a blank is unknown, not zero, so it is not removed by this rule
                  raw === '' || !Number.isFinite(number) || number !== 0;
    if (!ok) return { ok: false, rule: describeFilter(filter) };
  }
  return { ok: true };
}

// ---------- what can be said about the whole file ----------

// The reconciliation a person reads before committing: what the file had, what was mapped, what
// was left out and why. Quantities are totalled per unit and never added across units, because
// KG, NOS, M and L in one number mean nothing.
export function reconcile({
  sourceRows = 0,
  rows = [],
  blankSkipped = 0,
  filtered = [],
  quantityField = 'quantity',
  unitField = 'unit',
} = {}) {
  const reasons = new Map();
  const perUnit = new Map();
  let mapped = 0,
    blank = blankSkipped,
    failed = 0;
  for (const row of rows) {
    if (row.blank) {
      blank++;
      continue;
    }
    if (row.errors?.length) {
      failed++;
      for (const e of row.errors) {
        const key = e.message ?? String(e);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      continue;
    }
    mapped++;
    const quantity = Number(row.values?.[quantityField]);
    if (Number.isFinite(quantity)) {
      const unit = TRIM(row.values?.[unitField]) || '(no unit)';
      const seen = perUnit.get(unit) ?? { unit, rows: 0, quantity: 0 };
      seen.rows++;
      seen.quantity += quantity;
      perUnit.set(unit, seen);
    }
  }
  const removed = (filtered ?? []).reduce((n, f) => n + Number(f.count ?? 0), 0);
  return {
    sourceRows,
    staged: rows.length,
    mapped,
    blank,
    failed,
    filtered: (filtered ?? []).slice().sort((a, b) => b.count - a.count),
    removed,
    // Every data row is accounted for: mapped + blank + removed by a rule + failed.
    unaccounted: Math.max(0, sourceRows - rows.length - blankSkipped - removed),
    reasons: [...reasons.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    totals: [...perUnit.values()]
      .map((t) => ({ ...t, quantity: +t.quantity.toFixed(6) }))
      .sort((a, b) => b.rows - a.rows),
  };
}
