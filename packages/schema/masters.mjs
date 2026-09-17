// Field-level rules for planning masters. The API (forms) and the worker (CSV imports) both use these,
// so a record accepted on screen is accepted from a file and vice versa. Pure: no database access.
import { parseQuantity } from './quantity.mjs';

const control = /[\x00-\x1f\x7f]/;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

function textField(raw, f) {
  const v = blank(raw) ? '' : String(raw).trim();
  if (!v) return f.required ? { error: `${f.label} is required.` } : { value: f.default ?? '' };
  if (v.length > f.max || control.test(v))
    return { error: `${f.label} must be at most ${f.max} characters without line breaks.` };
  return { value: v };
}

const parsers = {
  code(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return { error: `${f.label} is required.` };
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/.test(v))
      return {
        error: `${f.label} must be 1-40 letters or numbers (dot, slash, hyphen, underscore allowed).`,
      };
    return { value: v };
  },
  text: textField,
  enum(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: f.default ?? null };
    const match = f.options.find((o) => o.toLowerCase() === v.toLowerCase());
    return match
      ? { value: match }
      : { error: `${f.label} must be one of: ${f.options.join(', ')}.` };
  },
  int(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: null };
    if (!/^\d+$/.test(v) || Number(v) < f.min || Number(v) > f.max)
      return { error: `${f.label} must be a whole number from ${f.min} to ${f.max}.` };
    return { value: Number(v) };
  },
  decimal(raw, f) {
    if (blank(raw))
      return f.required ? { error: `${f.label} is required.` } : { value: f.default ?? null };
    const r = parseQuantity(raw, f.decimals, { label: f.label });
    if (r.error) return r;
    if (f.positive && Number(r.value) <= 0) return { error: `${f.label} must be greater than 0.` };
    return r;
  },
  email(raw, f) {
    const r = textField(raw, { ...f, max: 254 });
    if (r.error || !r.value) return r;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.value)
      ? { value: r.value.toLowerCase() }
      : { error: `${f.label} must be a valid email address.` };
  },
  phone(raw, f) {
    const r = textField(raw, { ...f, max: 20 });
    if (r.error || !r.value) return r;
    return /^\+?[0-9][0-9 ()-]{5,19}$/.test(r.value)
      ? r
      : { error: `${f.label} must contain 6-20 digits (spaces, brackets, + and - allowed).` };
  },
  bool(raw, f) {
    if (typeof raw === 'boolean') return { value: raw };
    const v = blank(raw) ? '' : String(raw).trim().toLowerCase();
    if (!v) return { value: f.default ?? false };
    if (['true', 'yes', 'y', '1'].includes(v)) return { value: true };
    if (['false', 'no', 'n', '0'].includes(v)) return { value: false };
    return { error: `${f.label} must be yes or no.` };
  },
  // References are codes here; the database layer resolves them to ids and checks they are active.
  ref(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: null };
    if (v.length > 40 || control.test(v)) return { error: `${f.label} code is invalid.` };
    return { value: v };
  },
};

const code = (label) => ({ name: 'code', label, type: 'code', required: true, immutable: true });
const name = { name: 'name', label: 'Name', type: 'text', required: true, max: 120 };
const email = { name: 'email', label: 'Email', type: 'email' };
const phone = { name: 'phone', label: 'Phone', type: 'phone' };

export const MASTER_KINDS = {
  items: {
    label: 'Items',
    singular: 'item',
    permission: 'masters.manage',
    table: 'items',
    fields: [
      code('Item code'),
      name,
      {
        name: 'item_type',
        label: 'Item type',
        type: 'enum',
        required: true,
        options: ['RM', 'SFG', 'FG'],
      },
      {
        name: 'make_buy',
        label: 'Make or buy',
        type: 'enum',
        required: true,
        options: ['MAKE', 'BUY'],
      },
      { name: 'base_unit', label: 'Base unit', type: 'ref', ref: 'units', required: true },
      { name: 'family', label: 'Family', type: 'text', max: 60 },
      { name: 'standard_cost', label: 'Standard cost', type: 'decimal', decimals: 4 },
      {
        name: 'demand_class',
        label: 'Demand class',
        type: 'enum',
        options: ['runner', 'repeater', 'stranger'],
      },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Item ${v.code}`,
  },
  suppliers: {
    label: 'Suppliers',
    singular: 'supplier',
    permission: 'suppliers.manage',
    table: 'suppliers',
    fields: [
      code('Supplier code'),
      name,
      {
        name: 'lead_time_days',
        label: 'Lead time (days)',
        type: 'int',
        required: true,
        min: 0,
        max: 365,
      },
      email,
      phone,
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Supplier ${v.code}`,
  },
  customers: {
    label: 'Customers',
    singular: 'customer',
    permission: 'customers.manage',
    table: 'customers',
    fields: [
      code('Customer code'),
      name,
      {
        name: 'customer_type',
        label: 'Customer type',
        type: 'enum',
        options: ['OEM', 'DISTRIBUTOR', 'RETAILER', 'DIRECT', 'OTHER'],
        default: 'OTHER',
      },
      email,
      phone,
      { name: 'city', label: 'City', type: 'text', max: 80 },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Customer ${v.code}`,
  },
  item_suppliers: {
    label: 'Item sourcing',
    singular: 'item source',
    permission: 'suppliers.manage',
    table: 'item_suppliers',
    fields: [
      {
        name: 'item',
        label: 'Item code',
        type: 'ref',
        ref: 'items',
        required: true,
        immutable: true,
      },
      {
        name: 'supplier',
        label: 'Supplier code',
        type: 'ref',
        ref: 'suppliers',
        required: true,
        immutable: true,
      },
      { name: 'supplier_item_code', label: 'Supplier item code', type: 'text', max: 60 },
      // Blank purchase unit means the item's base unit.
      { name: 'purchase_unit', label: 'Purchase unit', type: 'ref', ref: 'units' },
      { name: 'lead_time_days', label: 'Lead time override (days)', type: 'int', min: 0, max: 365 },
      { name: 'moq', label: 'Minimum order quantity', type: 'decimal', decimals: 6, default: '0' },
      {
        name: 'lot_multiple',
        label: 'Order multiple',
        type: 'decimal',
        decimals: 6,
        positive: true,
        default: '1',
      },
      { name: 'preferred', label: 'Preferred supplier', type: 'bool', default: false },
    ],
    key: (v) => `${v.item.toLowerCase()}|${v.supplier.toLowerCase()}`,
    title: (v) => `${v.item} from ${v.supplier}`,
  },
  unit_conversions: {
    label: 'Unit conversions',
    singular: 'unit conversion',
    permission: 'masters.manage',
    table: 'unit_conversions',
    fields: [
      {
        name: 'from_unit',
        label: 'From unit',
        type: 'ref',
        ref: 'units',
        required: true,
        immutable: true,
      },
      {
        name: 'to_unit',
        label: 'To unit',
        type: 'ref',
        ref: 'units',
        required: true,
        immutable: true,
      },
      {
        name: 'factor',
        label: 'Factor',
        type: 'decimal',
        decimals: 6,
        positive: true,
        required: true,
      },
      // Blank item means the conversion applies to every item.
      { name: 'item', label: 'Item code (optional)', type: 'ref', ref: 'items', immutable: true },
    ],
    key: (v) =>
      `${v.from_unit.toLowerCase()}|${v.to_unit.toLowerCase()}|${(v.item ?? '').toLowerCase()}`,
    title: (v) => `1 ${v.from_unit} = ${v.factor} ${v.to_unit}${v.item ? ' for ' + v.item : ''}`,
  },
};

export function masterKind(kind) {
  return Object.hasOwn(MASTER_KINDS, kind) ? MASTER_KINDS[kind] : null;
}

// Validates every field; returns normalised values and field errors (never throws on user data).
export function validateMaster(kind, raw) {
  const def = masterKind(kind);
  const value = {};
  const errors = [];
  for (const f of def.fields) {
    const r = parsers[f.type](raw?.[f.name], f);
    if (r.error) errors.push({ column: f.name, message: r.error });
    else value[f.name] = r.value;
  }
  if (!errors.length) {
    if (
      kind === 'unit_conversions' &&
      value.from_unit.toLowerCase() === value.to_unit.toLowerCase()
    )
      errors.push({ column: 'to_unit', message: 'From unit and to unit must be different.' });
    if (kind === 'item_suppliers' && value.moq !== null && value.lot_multiple !== null) {
      // MOQ must itself be orderable: a whole number of order multiples.
      const moq = Number(value.moq),
        lot = Number(value.lot_multiple);
      if (moq > 0 && Math.abs(moq / lot - Math.round(moq / lot)) > 1e-9)
        errors.push({
          column: 'moq',
          message: `Minimum order quantity ${value.moq} must be a multiple of the order multiple ${value.lot_multiple}.`,
        });
    }
  }
  return { value, errors };
}
