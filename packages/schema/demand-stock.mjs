// Field rules for demand and stock (AV-3). Pure: forms and CSV imports share them.
import { validateFields } from './masters.mjs';
import { parseQuantity } from './quantity.mjs';

const plant = {
  name: 'plant',
  label: 'Plant code',
  type: 'ref',
  ref: 'sites',
  required: true,
  immutable: true,
};
const duplicates = (values) => {
  const seen = new Set(),
    dup = new Set();
  for (const v of values) {
    const k = String(v).toLowerCase();
    if (seen.has(k)) dup.add(v);
    seen.add(k);
  }
  return [...dup];
};

export const STOCK_LOCATION_FIELDS = [
  plant,
  { name: 'code', label: 'Location code', type: 'code', required: true, immutable: true },
  { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
  {
    name: 'location_type',
    label: 'Location type',
    type: 'enum',
    options: ['STORES', 'PRODUCTION', 'FINISHED', 'QUARANTINE'],
    default: 'STORES',
  },
  { name: 'nettable', label: 'Counts as available stock', type: 'bool', default: true },
];

export const MOVEMENT_TYPES = ['OPENING', 'RECEIPT', 'ISSUE', 'ADJUSTMENT'];
// Receipts and issues are routine store work; opening stock and adjustments need authority.
export const MOVEMENT_PERMISSIONS = {
  OPENING: 'inventory.adjust',
  RECEIPT: 'inventory.move',
  ISSUE: 'inventory.move',
  ADJUSTMENT: 'inventory.adjust',
};

export const MOVEMENT_FIELDS = [
  plant,
  { name: 'location', label: 'Location code', type: 'ref', ref: 'locations', required: true },
  { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true },
  {
    name: 'movement_type',
    label: 'Movement type',
    type: 'enum',
    required: true,
    options: MOVEMENT_TYPES,
  },
  // Signed only for adjustments; checked against unit decimals in the database layer.
  { name: 'quantity', label: 'Quantity', type: 'text', required: true, max: 20 },
  // Blank unit means the item's base unit.
  { name: 'unit', label: 'Unit', type: 'ref', ref: 'units' },
  { name: 'movement_date', label: 'Movement date', type: 'date', required: true },
  { name: 'reference', label: 'Reference', type: 'text', max: 60 },
  { name: 'reason', label: 'Reason', type: 'text', max: 200 },
  { name: 'external_ref', label: 'External reference', type: 'text', max: 60 },
];

export function validateStockLocation(raw) {
  return validateFields(STOCK_LOCATION_FIELDS, raw);
}

// requireExternalRef: files must carry a unique source reference so re-imports never double-post.
export function validateMovement(raw, { requireExternalRef = false } = {}) {
  const { value, errors } = validateFields(MOVEMENT_FIELDS, raw);
  if (value.quantity) {
    const q = parseQuantity(value.quantity, 6, {
      allowNegative: value.movement_type === 'ADJUSTMENT',
      label: 'Quantity',
    });
    if (q.error)
      errors.push({
        column: 'quantity',
        message:
          q.error.includes('negative') && value.movement_type !== 'ADJUSTMENT'
            ? 'Quantity cannot be negative. Use an ISSUE to take stock out.'
            : q.error,
      });
    else if (Number(q.value) === 0)
      errors.push({ column: 'quantity', message: 'Quantity must not be zero.' });
    else value.quantity = q.value;
  }
  if (value.movement_type === 'ADJUSTMENT' && !value.reason)
    errors.push({ column: 'reason', message: 'Reason is required for an adjustment.' });
  if (value.external_ref && !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,59}$/.test(value.external_ref))
    errors.push({
      column: 'external_ref',
      message:
        'External reference must be 1-60 letters or numbers (dot, slash, hyphen, underscore allowed).',
    });
  if (requireExternalRef && !value.external_ref && !errors.some((e) => e.column === 'external_ref'))
    errors.push({
      column: 'external_ref',
      message:
        'External reference is required in files so the same movement is never posted twice.',
    });
  if (!value.external_ref) value.external_ref = null;
  return { value, errors };
}

function documentLines(list, fields, label, max) {
  const errors = [];
  if (!Array.isArray(list) || !list.length)
    return { values: [], errors: [{ column: 'lines', message: 'Add at least one line.' }] };
  if (list.length > max)
    errors.push({ column: 'lines', message: `A document can have at most ${max} lines.` });
  const values = list.map((raw) => {
    const r = validateFields(fields, raw);
    const n = r.value.line_no ?? raw?.line_no ?? '?';
    for (const e of r.errors)
      errors.push({ column: e.column, message: `${label} ${n}: ${e.message}` });
    return r.value;
  });
  for (const n of duplicates(
    values.map((l) => l.line_no).filter((n) => n !== null && n !== undefined),
  ))
    errors.push({ column: 'lines', message: `${label} number ${n} is used more than once.` });
  values.sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0));
  return { values, errors };
}

export const SALES_ORDER_HEADER_FIELDS = [
  plant,
  { name: 'order_no', label: 'Order number', type: 'code' },
  { name: 'customer', label: 'Customer code', type: 'ref', ref: 'customers', required: true },
  { name: 'order_date', label: 'Order date', type: 'date', required: true },
  { name: 'promise_date', label: 'Promise date', type: 'date', required: true },
  { name: 'allow_partial', label: 'Partial delivery allowed', type: 'bool', default: true },
  { name: 'customer_ref', label: 'Customer PO reference', type: 'text', max: 60 },
];
export const SALES_ORDER_LINE_FIELDS = [
  { name: 'line_no', label: 'Line number', type: 'int', required: true, min: 1, max: 9999 },
  { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true },
  {
    name: 'quantity',
    label: 'Quantity',
    type: 'decimal',
    decimals: 6,
    positive: true,
    required: true,
  },
  // Blank means the order's promise date.
  { name: 'line_promise_date', label: 'Line promise date', type: 'date' },
];

export function validateSalesOrder(raw, { requireNumber = false } = {}) {
  // Forms may leave the number blank to get the next number; files must always carry it.
  const generated = !requireNumber && !String(raw?.order_no ?? '').trim();
  const { value, errors } = validateFields(
    SALES_ORDER_HEADER_FIELDS.filter((f) => !(generated && f.name === 'order_no')),
    raw,
  );
  if (generated) value.order_no = null;
  if (value.order_date && value.promise_date && value.promise_date < value.order_date)
    errors.push({
      column: 'promise_date',
      message: 'Promise date must be on or after the order date.',
    });
  const l = documentLines(raw?.lines, SALES_ORDER_LINE_FIELDS, 'Line', 999);
  errors.push(...l.errors);
  for (const line of l.values) {
    if (!line.line_promise_date) line.line_promise_date = value.promise_date ?? null;
    else if (value.order_date && line.line_promise_date < value.order_date)
      errors.push({
        column: 'lines',
        message: `Line ${line.line_no}: promise date must be on or after the order date.`,
      });
  }
  value.lines = l.values;
  return { value, errors };
}

export const PURCHASE_ORDER_HEADER_FIELDS = [
  plant,
  { name: 'po_no', label: 'PO number', type: 'code' },
  { name: 'supplier', label: 'Supplier code', type: 'ref', ref: 'suppliers', required: true },
  { name: 'order_date', label: 'Order date', type: 'date', required: true },
];
export const PURCHASE_ORDER_LINE_FIELDS = [
  { name: 'line_no', label: 'Line number', type: 'int', required: true, min: 1, max: 9999 },
  { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true },
  {
    name: 'quantity',
    label: 'Quantity',
    type: 'decimal',
    decimals: 6,
    positive: true,
    required: true,
  },
  // Blank unit means the item's base unit.
  { name: 'unit', label: 'Unit', type: 'ref', ref: 'units' },
  { name: 'due_date', label: 'Due date', type: 'date', required: true },
  {
    name: 'received_quantity',
    label: 'Received quantity',
    type: 'decimal',
    decimals: 6,
    default: '0',
  },
];

export function validatePurchaseOrder(raw, { requireNumber = false } = {}) {
  // Forms may leave the number blank to get the next number; files must always carry it.
  const generated = !requireNumber && !String(raw?.po_no ?? '').trim();
  const { value, errors } = validateFields(
    PURCHASE_ORDER_HEADER_FIELDS.filter((f) => !(generated && f.name === 'po_no')),
    raw,
  );
  if (generated) value.po_no = null;
  const l = documentLines(raw?.lines, PURCHASE_ORDER_LINE_FIELDS, 'Line', 999);
  errors.push(...l.errors);
  for (const line of l.values) {
    if (line.received_quantity === null) line.received_quantity = '0';
    if (line.quantity && Number(line.received_quantity) > Number(line.quantity))
      errors.push({
        column: 'lines',
        message: `Line ${line.line_no}: received quantity cannot be more than the ordered quantity.`,
      });
    if (value.order_date && line.due_date && line.due_date < value.order_date)
      errors.push({
        column: 'lines',
        message: `Line ${line.line_no}: due date must be on or after the order date.`,
      });
  }
  value.lines = l.values;
  return { value, errors };
}

export const DEMAND_HISTORY_FIELDS = [
  plant,
  { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true },
  { name: 'demand_date', label: 'Demand date', type: 'date', required: true },
  // Net of returns: a day with more returns than sales is negative.
  { name: 'quantity', label: 'Quantity', type: 'text', required: true, max: 20 },
];

export function validateDemandHistory(raw) {
  const r = validateFields(DEMAND_HISTORY_FIELDS, raw);
  if (r.value.quantity) {
    const q = parseQuantity(r.value.quantity, 6, { allowNegative: true, label: 'Quantity' });
    if (q.error) r.errors.push({ column: 'quantity', message: q.error });
    else r.value.quantity = q.value;
  }
  return r;
}

// Open production (work) orders: supply of the item they make, demand on its components.
export const PRODUCTION_ORDER_FIELDS = [
  plant,
  { name: 'order_no', label: 'Production order number', type: 'code', required: true },
  { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true },
  {
    name: 'quantity',
    label: 'Open quantity',
    type: 'decimal',
    decimals: 6,
    positive: true,
    required: true,
  },
  { name: 'start_date', label: 'Start date', type: 'date' },
  { name: 'due_date', label: 'Finish date', type: 'date', required: true },
  { name: 'order_type', label: 'Order type', type: 'text', max: 20 },
  { name: 'reference', label: 'Reference', type: 'text', max: 120 },
];

export function validateProductionOrder(raw) {
  const r = validateFields(PRODUCTION_ORDER_FIELDS, raw);
  if (r.value.start_date && r.value.due_date && r.value.start_date > r.value.due_date)
    r.errors.push({
      column: 'start_date',
      message: 'Start date must be on or before the finish date.',
    });
  return r;
}

const lower = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase();

// CSV shapes: one row per order line, grouped into documents by order number.
export const ORDER_IMPORTS = {
  sales_orders: {
    label: 'Customer order lines',
    permission: 'orders.create',
    headerFields: SALES_ORDER_HEADER_FIELDS.map((f) =>
      f.name === 'order_no' ? { ...f, required: true } : f,
    ),
    lineFields: SALES_ORDER_LINE_FIELDS,
    linesKey: 'lines',
    groupKey: (raw) => lower(raw.order_no),
    validate: (raw) => validateSalesOrder(raw, { requireNumber: true }),
    example: [
      [
        'PLANT-1',
        'SO-1001',
        'CUST-01',
        '2026-09-17',
        '2026-10-05',
        'yes',
        'PO-7781',
        '1',
        'FG-PUMP-01',
        '20',
        '',
      ],
      [
        'PLANT-1',
        'SO-1001',
        'CUST-01',
        '2026-09-17',
        '2026-10-05',
        'yes',
        'PO-7781',
        '2',
        'FG-PUMP-02',
        '5',
        '2026-10-12',
      ],
    ],
  },
  purchase_orders: {
    label: 'Purchase order lines',
    permission: 'purchase.create',
    headerFields: PURCHASE_ORDER_HEADER_FIELDS.map((f) =>
      f.name === 'po_no' ? { ...f, required: true } : f,
    ),
    lineFields: PURCHASE_ORDER_LINE_FIELDS,
    linesKey: 'lines',
    groupKey: (raw) => lower(raw.po_no),
    validate: (raw) => validatePurchaseOrder(raw, { requireNumber: true }),
    example: [
      [
        'PLANT-1',
        'PO-5001',
        'SUP-01',
        '2026-09-10',
        '1',
        'RM-STEEL',
        '500',
        'KG',
        '2026-09-30',
        '0',
      ],
      [
        'PLANT-1',
        'PO-5001',
        'SUP-01',
        '2026-09-10',
        '2',
        'RM-BOLT',
        '20',
        'BOX',
        '2026-10-05',
        '5',
      ],
    ],
  },
};
