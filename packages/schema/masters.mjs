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
    // SAP material codes can carry an inch mark, e.g. TP12GM40"WPOLYMRN (items only).
    const pattern = f.quote
      ? /^[A-Za-z0-9][A-Za-z0-9_./"-]{0,39}$/
      : /^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/;
    if (!pattern.test(v))
      return {
        error: `${f.label} must be 1-40 letters or numbers (dot, slash, hyphen, underscore${f.quote ? ', inch mark "' : ''} allowed).`,
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
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: f.default ?? null };
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
    if (f.maxValue !== undefined && Number(r.value) > f.maxValue)
      return { error: `${f.label} must be at most ${f.maxValue}.` };
    if (f.belowValue !== undefined && Number(r.value) >= f.belowValue)
      return { error: `${f.label} must be less than ${f.belowValue}.` };
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
  date(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: null };
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (!d || d.toISOString().slice(0, 10) !== v || Number(m[1]) < 2000 || Number(m[1]) > 2100)
      return { error: `${f.label} must be a date like 2026-09-17.` };
    return { value: v };
  },
  revision(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return { error: `${f.label} is required.` };
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/.test(v)
      ? { value: v }
      : { error: `${f.label} must be 1-20 letters or numbers (dot, hyphen, underscore allowed).` };
  },
  // A PAN: five letters, four digits, one letter. The fourth letter says what kind of holder it
  // is, so it is checked too — a typo there is a different taxpayer, not a formatting slip.
  pan(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim().toUpperCase().replace(/\s/g, '');
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: '' };
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v))
      return { error: `${f.label} must be ten characters like ABCDE1234F.` };
    if (!'ABCFGHJLPT'.includes(v[3]))
      return {
        error: `${f.label}: the fourth letter is ${v[3]}, which is not a kind of PAN holder.`,
      };
    return { value: v };
  },
  // A GSTIN: a state code, a PAN, an entity number, a Z, and a check digit over the other 14.
  gstin(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim().toUpperCase().replace(/\s/g, '');
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: '' };
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(v))
      return { error: `${f.label} must be fifteen characters like 27AAPFU0939F1ZV.` };
    const state = Number(v.slice(0, 2));
    if (state < 1 || state > 38)
      return { error: `${f.label}: ${v.slice(0, 2)} is not a state code (01 to 38).` };
    const codes = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const product = codes.indexOf(v[i]) * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(product / 36) + (product % 36);
    }
    if (codes[(36 - (sum % 36)) % 36] !== v[14])
      return { error: `${f.label}: the last character does not check out. Read it again.` };
    return { value: v };
  },
  // A storage key: lowercase, starts with a letter, underscores only. Used for the key an answer
  // to a customer form question is stored under, which a company chooses and we then live with.
  key(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim().toLowerCase();
    if (!v) return { error: `${f.label} is required.` };
    return /^[a-z][a-z0-9_]{0,39}$/.test(v)
      ? { value: v }
      : {
          error: `${f.label} must be 1-40 characters: a lowercase letter first, then letters, numbers or underscores.`,
        };
  },
  // The days of the week something runs on, in any order and any case, kept in week order so two
  // ways of writing the same round read the same: "thu, mon" becomes MON,THU.
  // A time of day on its own, with no date attached: a shift starts at 09:30 every day.
  time(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: f.default ?? null };
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
      return { error: `${f.label} must be a time of day written as HH:MM, for example 09:30.` };
    return { value: `${m[1].padStart(2, '0')}:${m[2]}` };
  },
  weekdays(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: f.default ?? '' };
    const week = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    const given = v
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((d) => d.toUpperCase().slice(0, 3));
    const unknown = given.filter((d) => !week.includes(d));
    if (unknown.length)
      return { error: `${f.label}: ${unknown[0]} is not a day. Use MON TUE WED THU FRI SAT SUN.` };
    const days = week.filter((d) => given.includes(d));
    return { value: days.join(',') };
  },
  // References are codes here; the database layer resolves them to ids and checks they are active.
  ref(raw, f) {
    const v = blank(raw) ? '' : String(raw).trim();
    if (!v) return f.required ? { error: `${f.label} is required.` } : { value: null };
    if (v.length > (f.max ?? 40) || control.test(v))
      return { error: `${f.label} code is invalid.` };
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
    module: 'Availability',
    permission: 'masters.manage',
    table: 'items',
    fields: [
      { ...code('Item code'), quote: true },
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
    module: 'Availability',
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
    module: 'Availability',
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
    module: 'Availability',
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
    module: 'Availability',
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
  // ---------- Reach field masters (RCH-0) ----------
  // Read and maintained under the Reach permissions rather than the planning ones, and removable:
  // a record taken off a list keeps its row in the database.
  territories: {
    label: 'Territories',
    singular: 'territory',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'territories',
    fields: [
      code('Territory code'),
      name,
      // A zone holds territories. Blank means this is a zone, or the company has one level only.
      { name: 'parent', label: 'Parent territory', type: 'ref', ref: 'territories' },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Territory ${v.code}`,
  },
  rep_grades: {
    label: 'Rep grades',
    singular: 'rep grade',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'rep_grades',
    fields: [
      code('Grade code'),
      name,
      { name: 'rank', label: 'Seniority rank', type: 'int', min: 1, max: 99, default: 1 },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Rep grade ${v.code}`,
  },
  field_reps: {
    label: 'Field reps',
    singular: 'field rep',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'field_reps',
    fields: [
      code('Rep code'),
      name,
      { name: 'grade', label: 'Grade code', type: 'ref', ref: 'rep_grades', required: true },
      {
        name: 'territory',
        label: 'Territory code',
        type: 'ref',
        ref: 'territories',
        required: true,
      },
      // The rep's login, when there is one. A rep list arrives from a spreadsheet long before
      // anyone issues logins, so this is addressed by the login's email and may stay blank.
      { name: 'user', label: 'Login email', type: 'ref', ref: 'users', max: 254 },
      email,
      phone,
      { name: 'joined_on', label: 'Joined on', type: 'date' },
      // RCH-6: where this rep is based. The daily allowance is a different rate at headquarters,
      // out of it and away overnight, so the town has to be known. Blank means the company has
      // not said, and every day then reads as out of headquarters rather than being guessed at.
      { name: 'hq_town', label: 'Headquarters town', type: 'text', max: 80 },
      // Which shift decides this rep's lateness and week-offs. Blank until the company sets
      // one, and the register then says so rather than assuming office hours on their behalf.
      { name: 'shift', label: 'Shift code', type: 'ref', ref: 'shifts' },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Field rep ${v.code}`,
  },
  work_types: {
    label: 'Work types',
    singular: 'work type',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'work_types',
    fields: [
      code('Work code'),
      name,
      { name: 'needs_location', label: 'Needs a location', type: 'bool', default: true },
      // Training counts as attended; a day marked personal is recorded but not credited.
      { name: 'counts_present', label: 'Counts as attended', type: 'bool', default: true },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Work type ${v.code}`,
  },
  shifts: {
    label: 'Shifts',
    singular: 'shift',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'shifts',
    fields: [
      code('Shift code'),
      name,
      { name: 'starts_at', label: 'Starts at', type: 'time', required: true },
      { name: 'ends_at', label: 'Ends at', type: 'time', required: true },
      // Arrive within the grace and the day is still on time.
      {
        name: 'grace_minutes',
        label: 'Grace in minutes',
        type: 'int',
        min: 0,
        max: 240,
        default: 15,
      },
      {
        name: 'half_day_minutes',
        label: 'Half day under minutes',
        type: 'int',
        min: 30,
        max: 1440,
        default: 240,
      },
      // Work shorter than this does not count as a day at all.
      {
        name: 'min_minutes',
        label: 'Counts from minutes',
        type: 'int',
        min: 0,
        max: 1440,
        default: 60,
      },
      { name: 'week_off', label: 'Week off', type: 'weekdays', default: 'SUN' },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Shift ${v.code}`,
  },
  leave_types: {
    label: 'Leave types',
    singular: 'leave type',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'leave_types',
    fields: [
      code('Leave code'),
      name,
      { name: 'paid', label: 'Paid leave', type: 'bool', default: true },
      // Half days are why this is not a whole number.
      {
        name: 'annual_quota',
        label: 'Days a year',
        type: 'decimal',
        decimals: 1,
        maxValue: 999,
        default: '0',
      },
      { name: 'carry_forward', label: 'Carries forward', type: 'bool', default: false },
      { name: 'requires_approval', label: 'Needs approval', type: 'bool', default: true },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Leave type ${v.code}`,
  },
  holidays: {
    label: 'Holidays',
    singular: 'holiday',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'holidays',
    fields: [
      { name: 'holiday_date', label: 'Date', type: 'date', required: true, immutable: true },
      name,
      {
        name: 'holiday_type',
        label: 'Holiday type',
        type: 'enum',
        options: ['NATIONAL', 'REGIONAL', 'OPTIONAL'],
        default: 'NATIONAL',
      },
      // Blank territory means the whole company is off that day.
      {
        name: 'territory',
        label: 'Territory code',
        type: 'ref',
        ref: 'territories',
        immutable: true,
      },
    ],
    key: (v) => `${v.holiday_date}|${(v.territory ?? '').toLowerCase()}`,
    title: (v) => `${v.name} on ${v.holiday_date}`,
  },
  // ---------- Reach customers and beats (RCH-1) ----------
  // The shape of a customer is config, not code: a type decides which questions are asked, how
  // close a check-in must be, whether it sits on a beat plan and whether a new account waits for
  // approval. Setup owns all of it, under its own permission.
  customer_types: {
    label: 'Customer types',
    singular: 'customer type',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'customer_types',
    fields: [
      code('Type code'),
      name,
      { name: 'tier', label: 'Tier', type: 'int', min: 1, max: 20, default: 1 },
      { name: 'prefix', label: 'Code prefix', type: 'text', max: 10 },
      { name: 'geo_required', label: 'Needs a location tag', type: 'bool', default: true },
      {
        name: 'checkin_radius_m',
        label: 'Check-in radius (m)',
        type: 'int',
        min: 10,
        max: 5000,
        default: 100,
      },
      {
        name: 'min_visit_minutes',
        label: 'Shortest useful visit (minutes)',
        type: 'int',
        min: 0,
        max: 480,
        default: 5,
      },
      {
        name: 'visit_norm_per_month',
        label: 'Visits a month',
        type: 'int',
        min: 0,
        max: 60,
        default: 4,
      },
      { name: 'on_beat_plan', label: 'Sits on a beat plan', type: 'bool', default: true },
      { name: 'needs_approval', label: 'New account needs approval', type: 'bool', default: false },
      { name: 'kyc_before_order', label: 'KYC before ordering', type: 'bool', default: false },
      {
        name: 'order_route',
        label: 'Order route',
        type: 'enum',
        options: ['ERP', 'DISTRIBUTOR', 'NONE'],
        default: 'NONE',
      },
      { name: 'credit_limit', label: 'Credit limit', type: 'decimal', decimals: 2 },
      { name: 'credit_days', label: 'Credit days', type: 'int', min: 0, max: 365 },
      { name: 'hold_days', label: 'Hold orders after overdue days', type: 'int', min: 0, max: 365 },
      { name: 'loyalty', label: 'Earns loyalty points', type: 'bool', default: false },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Customer type ${v.code}`,
  },
  customer_form_fields: {
    label: 'Customer form fields',
    singular: 'form field',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'customer_form_fields',
    fields: [
      // The key an answer is stored under. It cannot change later: answers already carry it.
      { name: 'field_key', label: 'Field key', type: 'key', required: true, immutable: true },
      { ...name, label: 'Label on the form', max: 120 },
      {
        name: 'input',
        label: 'Input',
        type: 'enum',
        required: true,
        options: [
          'text',
          'textarea',
          'number',
          'select',
          'date',
          'phone',
          'email',
          'gstin',
          'pan',
          'bool',
        ],
      },
      { name: 'section', label: 'Section', type: 'text', max: 60, default: 'Details' },
      { name: 'display_order', label: 'Order', type: 'int', min: 1, max: 9999, default: 100 },
      // One choice per line in the form; stored and imported pipe-separated.
      { name: 'options', label: 'Choices (a | between each)', type: 'text', max: 1000 },
      { name: 'help', label: 'Help text', type: 'text', max: 200 },
      { name: 'default_value', label: 'Default answer', type: 'text', max: 200 },
    ],
    key: (v) => v.field_key,
    title: (v) => `Form field ${v.field_key}`,
  },
  customer_form_rules: {
    label: 'Customer form by type',
    singular: 'form rule',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'customer_form_rules',
    fields: [
      {
        name: 'type',
        label: 'Type code',
        type: 'ref',
        ref: 'customer_types',
        required: true,
        immutable: true,
      },
      {
        name: 'field',
        label: 'Field key',
        type: 'ref',
        ref: 'customer_form_fields',
        required: true,
        immutable: true,
      },
      // R asked and required, O asked and optional, X not asked of this type.
      {
        name: 'requirement',
        label: 'Asked',
        type: 'enum',
        options: ['R', 'O', 'X'],
        default: 'O',
      },
      { name: 'label_override', label: 'Wording for this type', type: 'text', max: 120 },
    ],
    key: (v) => `${v.type.toLowerCase()}|${v.field.toLowerCase()}`,
    title: (v) => `${v.field} on ${v.type}`,
  },
  // RCH-4: the check-out report. The same matrix the customer form uses — fields, and a rule
  // per customer type saying whether each one is asked — so one engine drives both.
  // RCH-5: Customer 360's setup. The documents a type asks for, the rate it pays, and the slabs
  // a quantity earns — all maintained as masters, so each one arrives with a CSV template and an
  // import. A price list is exactly the thing a company already keeps in a spreadsheet.
  // RCH-6: what may be claimed, and how a line turns into money. How *much* lives on a policy
  // version, because that is the part that changes and has to be dated.
  expense_categories: {
    label: 'Expense categories',
    singular: 'expense category',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'expense_categories',
    fields: [
      code('Category code'),
      name,
      {
        name: 'basis',
        label: 'Worked out from',
        type: 'enum',
        required: true,
        // KM reads the kilometres and the vehicle; DAILY is one day's allowance at a rate that
        // depends on where the day was spent; NIGHTLY reads the nights and the rep's grade;
        // ACTUAL is what was really spent, up to a cap.
        options: ['KM', 'DAILY', 'NIGHTLY', 'ACTUAL'],
        default: 'ACTUAL',
      },
      // Above this the policy insists on a receipt. Blank means it never does.
      {
        name: 'receipt_above',
        label: 'Receipt needed above',
        type: 'decimal',
        decimals: 2,
        min: 0,
      },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Expense category ${v.code}`,
  },
  kyc_types: {
    label: 'KYC documents',
    singular: 'KYC document',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'kyc_types',
    fields: [
      code('Document code'),
      name,
      // How the number on the document is checked. GSTIN and PAN go through the same validators
      // the customer form uses, so one idea of a valid GSTIN exists in the system.
      {
        name: 'number_check',
        label: 'Number check',
        type: 'enum',
        options: ['none', 'gstin', 'pan', 'text'],
        default: 'none',
      },
      // Blank where the document never expires.
      { name: 'valid_months', label: 'Valid for months', type: 'int', min: 1, max: 600 },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `KYC document ${v.code}`,
  },
  kyc_rules: {
    label: 'KYC by type',
    singular: 'KYC rule',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'kyc_rules',
    fields: [
      {
        name: 'type',
        label: 'Customer type',
        type: 'ref',
        ref: 'customer_types',
        required: true,
        immutable: true,
      },
      {
        name: 'kyc_type',
        label: 'KYC document',
        type: 'ref',
        ref: 'kyc_types',
        required: true,
        immutable: true,
      },
      // R asked and required before an order, O asked but not blocking, X not asked at all.
      {
        name: 'requirement',
        label: 'Asked',
        type: 'enum',
        options: ['R', 'O', 'X'],
        default: 'O',
      },
    ],
    key: (v) => `${v.type.toLowerCase()}|${v.kyc_type.toLowerCase()}`,
    title: (v) => `${v.kyc_type} on ${v.type}`,
  },
  price_list_items: {
    label: 'Price list',
    singular: 'price',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'price_list_items',
    fields: [
      {
        name: 'type',
        label: 'Customer type',
        type: 'ref',
        ref: 'customer_types',
        required: true,
        immutable: true,
      },
      {
        name: 'item',
        label: 'Item code',
        type: 'ref',
        ref: 'items',
        required: true,
        immutable: true,
      },
      // Money per unit, to four places: a bulk list may quote a piece at 0.3333.
      { name: 'rate', label: 'Rate', type: 'decimal', decimals: 4, required: true, min: 0 },
      {
        name: 'gst_pct',
        label: 'GST %',
        type: 'decimal',
        decimals: 2,
        min: 0,
        max: 100,
        default: 0,
      },
      { name: 'from_date', label: 'From', type: 'date', required: true, immutable: true },
      // Left blank, the rate stands until a later list opens over it.
      { name: 'to_date', label: 'Until', type: 'date' },
    ],
    key: (v) => `${v.type.toLowerCase()}|${v.item.toLowerCase()}|${v.from_date}`,
    title: (v) => `${v.item} for ${v.type} from ${v.from_date}`,
  },
  trade_schemes: {
    label: 'Schemes',
    singular: 'scheme',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'trade_schemes',
    fields: [
      code('Scheme code'),
      name,
      { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true },
      // Read as "from this quantity upwards"; the highest slab a line reaches is what it earns.
      {
        name: 'min_quantity',
        label: 'From quantity',
        type: 'decimal',
        decimals: 6,
        required: true,
        min: 0,
      },
      {
        name: 'discount_pct',
        label: 'Discount %',
        type: 'decimal',
        decimals: 2,
        min: 0,
        max: 100,
        default: 0,
      },
      {
        name: 'free_quantity',
        label: 'Free units',
        type: 'decimal',
        decimals: 6,
        min: 0,
        default: 0,
      },
      { name: 'from_date', label: 'From', type: 'date', required: true },
      { name: 'to_date', label: 'Until', type: 'date' },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Scheme ${v.code}`,
  },
  visit_form_fields: {
    label: 'Visit report fields',
    singular: 'report field',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'visit_form_fields',
    fields: [
      // The key an answer is stored under on the visit. It cannot change later: reports
      // already written carry it.
      { name: 'field_key', label: 'Field key', type: 'key', required: true, immutable: true },
      { ...name, label: 'Label on the form', max: 120 },
      {
        name: 'input',
        label: 'Input',
        type: 'enum',
        required: true,
        options: [
          'text',
          'textarea',
          'number',
          'select',
          'date',
          'phone',
          'email',
          'gstin',
          'pan',
          'bool',
        ],
      },
      { name: 'section', label: 'Section', type: 'text', max: 60, default: 'Details' },
      { name: 'display_order', label: 'Order', type: 'int', min: 1, max: 9999, default: 100 },
      // One choice per line in the form; stored and imported pipe-separated.
      { name: 'options', label: 'Choices (a | between each)', type: 'text', max: 1000 },
      { name: 'help', label: 'Help text', type: 'text', max: 200 },
      { name: 'default_value', label: 'Default answer', type: 'text', max: 200 },
    ],
    key: (v) => v.field_key,
    title: (v) => `Report field ${v.field_key}`,
  },
  visit_form_rules: {
    label: 'Visit report by type',
    singular: 'report rule',
    module: 'Reach',
    permission: 'reach.setup',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'visit_form_rules',
    fields: [
      {
        name: 'type',
        label: 'Type code',
        type: 'ref',
        ref: 'customer_types',
        required: true,
        immutable: true,
      },
      {
        name: 'field',
        label: 'Field key',
        type: 'ref',
        ref: 'visit_form_fields',
        required: true,
        immutable: true,
      },
      // R asked and required, O asked and optional, X not asked of this type.
      {
        name: 'requirement',
        label: 'Asked',
        type: 'enum',
        options: ['R', 'O', 'X'],
        default: 'O',
      },
      { name: 'label_override', label: 'Wording for this type', type: 'text', max: 120 },
    ],
    key: (v) => `${v.type.toLowerCase()}|${v.field.toLowerCase()}`,
    title: (v) => `${v.field} on ${v.type}`,
  },
  beats: {
    label: 'Beats',
    singular: 'beat',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'beats',
    fields: [
      code('Beat code'),
      name,
      {
        name: 'territory',
        label: 'Territory code',
        type: 'ref',
        ref: 'territories',
        required: true,
      },
      {
        name: 'frequency',
        label: 'How often',
        type: 'enum',
        options: ['WEEKLY', 'FORTNIGHTLY'],
        default: 'WEEKLY',
      },
      { name: 'run_days', label: 'Days it runs', type: 'weekdays', required: true },
      // A fortnightly beat runs in one half of the fortnight; a weekly beat runs in both.
      {
        name: 'week_parity',
        label: 'Which week',
        type: 'enum',
        options: ['ALL', 'ODD', 'EVEN'],
        default: 'ALL',
      },
    ],
    key: (v) => v.code.toLowerCase(),
    title: (v) => `Beat ${v.code}`,
  },
  beat_assignments: {
    label: 'Beat assignments',
    singular: 'beat assignment',
    module: 'Reach',
    permission: 'reach.manage',
    readPermission: 'reach.read',
    deletePermission: 'reach.delete',
    softDelete: true,
    table: 'beat_assignments',
    fields: [
      {
        name: 'beat',
        label: 'Beat code',
        type: 'ref',
        ref: 'beats',
        required: true,
        immutable: true,
      },
      {
        name: 'rep',
        label: 'Rep code',
        type: 'ref',
        ref: 'field_reps',
        required: true,
        immutable: true,
      },
      { name: 'from_date', label: 'From', type: 'date', required: true, immutable: true },
      // Left blank, the rep holds the beat until someone else takes it over.
      { name: 'to_date', label: 'Until', type: 'date' },
    ],
    key: (v) => `${v.beat.toLowerCase()}|${v.from_date}`,
    title: (v) => `${v.beat} to ${v.rep} from ${v.from_date}`,
  },
};

// Validates any field list with the same parsers (used by the plant model rulebook too).
export function validateFields(fields, raw) {
  const value = {};
  const errors = [];
  for (const f of fields) {
    const r = parsers[f.type](raw?.[f.name], f);
    if (r.error) errors.push({ column: f.name, message: r.error });
    else value[f.name] = r.value;
  }
  return { value, errors };
}

export function masterKind(kind) {
  return Object.hasOwn(MASTER_KINDS, kind) ? MASTER_KINDS[kind] : null;
}

// Validates every field; returns normalised values and field errors (never throws on user data).
export function validateMaster(kind, raw) {
  const def = masterKind(kind);
  const { value, errors } = validateFields(def.fields, raw);
  if (!errors.length) {
    if (
      kind === 'unit_conversions' &&
      value.from_unit.toLowerCase() === value.to_unit.toLowerCase()
    )
      errors.push({ column: 'to_unit', message: 'From unit and to unit must be different.' });
    if (kind === 'beats') {
      // A weekly beat has no half of the fortnight to choose; a fortnightly one must choose.
      if (value.frequency === 'WEEKLY' && value.week_parity !== 'ALL')
        errors.push({
          column: 'week_parity',
          message: 'A weekly beat runs every week. Choose ALL, or make it fortnightly.',
        });
      if (value.frequency === 'FORTNIGHTLY' && value.week_parity === 'ALL')
        errors.push({
          column: 'week_parity',
          message:
            'A fortnightly beat runs in one half of the fortnight. Choose ODD or EVEN weeks.',
        });
    }
    // A choice list with no choices would leave an unanswerable question on the form.
    // The DB holds the same rule; saying it here means the form explains itself before the save.
    if (
      kind === 'shifts' &&
      value.min_minutes !== null &&
      value.half_day_minutes !== null &&
      Number(value.min_minutes) > Number(value.half_day_minutes)
    )
      errors.push({
        column: 'min_minutes',
        message: 'A day cannot start counting after the point it would already be half a day.',
      });
    // The customer form and the visit report form are the same machinery, so a choice question
    // with no choices is unanswerable on either of them.
    if (
      (kind === 'customer_form_fields' || kind === 'visit_form_fields') &&
      value.input === 'select' &&
      !value.options
    )
      errors.push({
        column: 'options',
        message: 'A choice list needs its choices. Separate them with a | between each.',
      });
    // RCH-5: a dated price or scheme cannot end before it starts, and a slab that gives nothing
    // is a slab somebody forgot to fill in. The table holds both rules; saying them here lets the
    // screen name the field instead of showing a constraint name.
    if (
      (kind === 'price_list_items' || kind === 'trade_schemes') &&
      value.to_date &&
      value.from_date &&
      value.to_date < value.from_date
    )
      errors.push({ column: 'to_date', message: 'Until cannot be earlier than From.' });
    if (
      kind === 'trade_schemes' &&
      !Number(value.discount_pct ?? 0) &&
      !Number(value.free_quantity ?? 0)
    )
      errors.push({
        column: 'discount_pct',
        message: 'A slab has to give something: a discount, free units, or both.',
      });
    if (kind === 'beat_assignments' && value.to_date && value.to_date < value.from_date)
      errors.push({ column: 'to_date', message: 'Until cannot be earlier than From.' });
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
