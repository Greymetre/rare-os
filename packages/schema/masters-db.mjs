// Database side of planning masters, shared by the API (single records) and the worker (imports).
// Every function receives a pg client already inside a company-scoped (RLS) transaction.
import { countRows, DEFAULT_PAGE_SIZE } from './paging.mjs';
import { MASTER_KINDS, masterKind } from './masters.mjs';
import { parseQuantity } from './quantity.mjs';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const CHUNK = 1000;
// NOT NULL text columns stored as '' when blank.
const TEXT_DEFAULTS = new Set(['family', 'email', 'phone', 'city', 'supplier_item_code']);
const lc = (v) => String(v).toLowerCase();
// numeric columns come back as strings with trailing zeros; compare canonical values.
const dec = (v) =>
  v === null || v === undefined ? null : parseQuantity(String(v), 6, { allowNegative: true }).value;

const REF_QUERIES = {
  units: 'SELECT id,code,active,decimals FROM units WHERE lower(code)=ANY($1::text[])',
  suppliers: 'SELECT id,code,active FROM suppliers WHERE lower(code)=ANY($1::text[])',
  items:
    'SELECT i.id,i.code,i.active,i.make_buy,i.base_unit_id,u.code AS base_unit_code,u.decimals AS base_unit_decimals FROM items i JOIN units u ON u.id=i.base_unit_id WHERE lower(i.code)=ANY($1::text[])',
  territories:
    'SELECT id,code,active,parent_id FROM territories WHERE lower(code)=ANY($1::text[]) AND deleted_at IS NULL',
  rep_grades:
    'SELECT id,code,active FROM rep_grades WHERE lower(code)=ANY($1::text[]) AND deleted_at IS NULL',
  // A login is addressed by the email it signs in with, which is what a rep list from a
  // spreadsheet carries. Deactivated logins are refused rather than linked.
  users: 'SELECT id,email AS code,active FROM app_users WHERE lower(email)=ANY($1::text[])',
  field_reps:
    'SELECT id,code,active FROM field_reps WHERE lower(code)=ANY($1::text[]) AND deleted_at IS NULL',
  customer_types:
    'SELECT id,code,active,on_beat_plan,needs_approval,geo_required FROM customer_types WHERE lower(code)=ANY($1::text[]) AND deleted_at IS NULL',
  // A form field is addressed by its key, which is already lowercase.
  customer_form_fields:
    'SELECT id,field_key AS code,active,input FROM customer_form_fields WHERE field_key=ANY($1::text[]) AND deleted_at IS NULL',
  beats:
    'SELECT id,code,active,territory_id FROM beats WHERE lower(code)=ANY($1::text[]) AND deleted_at IS NULL',
};

const REF_NOUNS = {
  units: 'Unit',
  items: 'Item',
  suppliers: 'Supplier',
  territories: 'Territory',
  rep_grades: 'Rep grade',
  users: 'Login',
  field_reps: 'Field rep',
  customer_types: 'Customer type',
  customer_form_fields: 'Form field',
  beats: 'Beat',
};
// What to do about a reference that is not there. For masters it is "create it first"; a login is
// not created here at all, it is invited on the Users screen.
const REF_MISSING = {
  users: (code) => `No login was found for ${code}. Invite the user first, or leave this blank.`,
};

async function lookup(db, table, codes) {
  const map = new Map();
  const list = [...new Set(codes.map(lc))];
  for (let i = 0; i < list.length; i += CHUNK)
    for (const r of (await db.query(REF_QUERIES[table], [list.slice(i, i + CHUNK)])).rows)
      map.set(lc(r.code), r);
  return map;
}

// Resolves reference codes to ids and applies rules that need current data.
// rows: [{ value, errors }] as returned by validateMaster; mutates value (adds *_id) and errors.
export async function resolveReferences(db, kind, rows) {
  const def = masterKind(kind);
  const refFields = def.fields.filter((f) => f.type === 'ref');
  const pending = rows.filter((r) => !r.errors.length);
  const maps = {};
  for (const table of new Set(refFields.map((f) => f.ref)))
    maps[table] = await lookup(
      db,
      table,
      pending.flatMap((r) =>
        refFields.filter((f) => f.ref === table && r.value[f.name]).map((f) => r.value[f.name]),
      ),
    );
  for (const row of pending)
    for (const f of refFields) {
      const code = row.value[f.name];
      if (!code) {
        row.value[f.name + '_id'] = null;
        continue;
      }
      const rec = maps[f.ref].get(lc(code));
      const noun = REF_NOUNS[f.ref];
      if (!rec)
        row.errors.push({
          column: f.name,
          message: REF_MISSING[f.ref]?.(code) ?? `${noun} ${code} was not found. Create it first.`,
        });
      else if (!rec.active)
        row.errors.push({
          column: f.name,
          message: `${noun} ${rec.code} is inactive. Activate it or choose another.`,
        });
      else {
        row.value[f.name] = rec.code;
        row.value[f.name + '_id'] = rec.id;
        row.refs = { ...(row.refs || {}), [f.name]: rec };
      }
    }
  if (kind === 'item_suppliers') await sourcingRules(db, rows);
  if (kind === 'unit_conversions') await conversionRules(db, rows);
  if (kind === 'territories') await territoryRules(db, rows);
  if (kind === 'beat_assignments') await beatAssignmentRules(db, rows);
  return rows;
}

async function sourcingRules(db, rows) {
  const preferredSeen = new Map();
  const needConversion = [];
  for (const row of rows.filter((r) => !r.errors.length)) {
    const v = row.value,
      item = row.refs.item;
    if (item.make_buy !== 'BUY') {
      row.errors.push({
        column: 'item',
        message: `Item ${item.code} is MAKE. Supplier sourcing applies to BUY items.`,
      });
      continue;
    }
    if (!v.purchase_unit) {
      v.purchase_unit = item.base_unit_code;
      v.purchase_unit_id = item.base_unit_id;
    }
    const decimals = row.refs.purchase_unit
      ? row.refs.purchase_unit.decimals
      : item.base_unit_decimals;
    for (const [field, label] of [
      ['moq', 'Minimum order quantity'],
      ['lot_multiple', 'Order multiple'],
    ]) {
      const r = parseQuantity(v[field], decimals, { label });
      if (r.error)
        row.errors.push({ column: field, message: `${r.error} (unit ${v.purchase_unit})` });
    }
    if (v.preferred) {
      const key = lc(item.code);
      if (preferredSeen.has(key))
        row.errors.push({
          column: 'preferred',
          message: `Item ${item.code} already has a preferred supplier on line ${preferredSeen.get(key)}. Mark only one.`,
        });
      else preferredSeen.set(key, row.line ?? 'this form');
    }
    if (v.purchase_unit_id !== item.base_unit_id) needConversion.push(row);
  }
  if (!needConversion.length) return;
  const known = new Set(
    (
      await db.query(
        'SELECT from_unit_id,to_unit_id,item_id FROM unit_conversions WHERE active AND (item_id IS NULL OR item_id=ANY($1::uuid[]))',
        [[...new Set(needConversion.map((r) => r.value.item_id))]],
      )
    ).rows.flatMap((c) => [
      `${c.from_unit_id}|${c.to_unit_id}|${c.item_id ?? ''}`,
      `${c.to_unit_id}|${c.from_unit_id}|${c.item_id ?? ''}`,
    ]),
  );
  for (const row of needConversion) {
    const v = row.value;
    const pair = `${v.purchase_unit_id}|${row.refs.item.base_unit_id}`;
    if (!known.has(pair + '|' + v.item_id) && !known.has(pair + '|'))
      row.errors.push({
        column: 'purchase_unit',
        message: `No conversion between ${v.purchase_unit} and ${row.refs.item.base_unit_code} for item ${v.item}. Add a unit conversion first.`,
      });
  }
}

// Territories are two levels at most: a zone and the territories under it. That keeps every
// rollup a single join, and makes a loop impossible without walking the tree on every save.
async function territoryRules(db, rows) {
  for (const row of rows.filter((r) => !r.errors.length)) {
    const parent = row.refs?.parent;
    if (!parent) continue;
    if (row.id && parent.id === row.id) {
      row.errors.push({
        column: 'parent',
        message: 'A territory cannot be its own parent.',
      });
      continue;
    }
    if (parent.parent_id)
      row.errors.push({
        column: 'parent',
        message: `Territory ${parent.code} already sits under another territory. Choose a top-level territory as the parent.`,
      });
    else if (row.id) {
      const children = await db.query(
        'SELECT code FROM territories WHERE parent_id=$1 AND deleted_at IS NULL LIMIT 1',
        [row.id],
      );
      if (children.rowCount)
        row.errors.push({
          column: 'parent',
          message: `This territory already has ${children.rows[0].code} under it, so it cannot sit under another one.`,
        });
    }
  }
}

// One rep holds a beat at a time. Spells may follow each other but never overlap, or a day's
// adherence would belong to two people at once.
async function beatAssignmentRules(db, rows) {
  for (const row of rows.filter((r) => !r.errors.length)) {
    const v = row.value;
    if (!v.beat_id || !v.from_date) continue;
    const clash = (
      await db.query(
        `SELECT to_char(a.from_date,'YYYY-MM-DD') AS from_date,
           to_char(a.to_date,'YYYY-MM-DD') AS to_date, r.code AS rep
         FROM beat_assignments a JOIN field_reps r ON r.id=a.rep_id
         WHERE a.beat_id=$1 AND a.deleted_at IS NULL
           AND ($4::uuid IS NULL OR a.id <> $4::uuid)
           AND daterange(a.from_date, a.to_date, '[]') && daterange($2::date, $3::date, '[]')
         ORDER BY a.from_date LIMIT 1`,
        [v.beat_id, v.from_date, v.to_date ?? null, row.id ?? null],
      )
    ).rows[0];
    if (clash)
      row.errors.push({
        column: 'from_date',
        message: `${clash.rep} already has this beat from ${clash.from_date}${
          clash.to_date ? ' to ' + clash.to_date : ' onwards'
        }. Close that spell first.`,
      });
  }
}

async function conversionRules(db, rows) {
  const valid = rows.filter((r) => !r.errors.length);
  const inBatch = new Map(
    valid.map((r) => [
      `${r.value.from_unit_id}|${r.value.to_unit_id}|${r.value.item_id ?? ''}`,
      r.line ?? 'this form',
    ]),
  );
  const existing = new Set(
    (
      await db.query('SELECT from_unit_id,to_unit_id,item_id FROM unit_conversions WHERE active')
    ).rows.map((c) => `${c.from_unit_id}|${c.to_unit_id}|${c.item_id ?? ''}`),
  );
  for (const row of valid) {
    const v = row.value;
    const inverse = `${v.to_unit_id}|${v.from_unit_id}|${v.item_id ?? ''}`;
    if (existing.has(inverse) || inBatch.has(inverse))
      row.errors.push({
        column: 'from_unit',
        message: `A conversion between ${v.to_unit} and ${v.from_unit} already exists${
          inBatch.has(inverse) ? ` (line ${inBatch.get(inverse)})` : ''
        }. Keep one direction; the reverse is derived.`,
      });
  }
}

// Kind-specific SQL. Columns are fixed identifiers, never user input.
const SQL = {
  items: {
    select:
      'SELECT x.id,x.code,x.name,x.item_type,x.make_buy,u.code AS base_unit,x.base_unit_id,x.family,x.standard_cost,x.demand_class,x.active,x.version,x.updated_at FROM items x JOIN units u ON u.id=x.base_unit_id',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) =>
      v.name === r.name &&
      v.item_type === r.item_type &&
      v.make_buy === r.make_buy &&
      v.base_unit_id === r.base_unit_id &&
      (v.family ?? '') === r.family &&
      dec(v.standard_cost) === dec(r.standard_cost) &&
      (v.demand_class ?? null) === r.demand_class,
    columns: [
      'code',
      'name',
      'item_type',
      'make_buy',
      'base_unit_id',
      'family',
      'standard_cost',
      'demand_class',
    ],
    types: ['text', 'text', 'text', 'text', 'uuid', 'text', 'numeric', 'text'],
    conflict: '(tenant_id,lower(code))',
    mutable: [
      'name',
      'item_type',
      'make_buy',
      'base_unit_id',
      'family',
      'standard_cost',
      'demand_class',
    ],
  },
  suppliers: {
    select:
      'SELECT x.id,x.code,x.name,x.lead_time_days,x.email,x.phone,x.active,x.version,x.updated_at FROM suppliers x',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) =>
      v.name === r.name &&
      v.lead_time_days === r.lead_time_days &&
      v.email === r.email &&
      v.phone === r.phone,
    columns: ['code', 'name', 'lead_time_days', 'email', 'phone'],
    types: ['text', 'text', 'int', 'text', 'text'],
    conflict: '(tenant_id,lower(code))',
    mutable: ['name', 'lead_time_days', 'email', 'phone'],
  },
  customers: {
    select:
      'SELECT x.id,x.code,x.name,x.customer_type,x.email,x.phone,x.city,x.active,x.version,x.updated_at FROM customers x',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) =>
      v.name === r.name &&
      v.customer_type === r.customer_type &&
      v.email === r.email &&
      v.phone === r.phone &&
      v.city === r.city,
    columns: ['code', 'name', 'customer_type', 'email', 'phone', 'city'],
    types: ['text', 'text', 'text', 'text', 'text', 'text'],
    conflict: '(tenant_id,lower(code))',
    mutable: ['name', 'customer_type', 'email', 'phone', 'city'],
  },
  item_suppliers: {
    select:
      'SELECT x.id,i.code AS item,s.code AS supplier,x.item_id,x.supplier_id,x.supplier_item_code,pu.code AS purchase_unit,x.purchase_unit_id,x.lead_time_days,x.moq,x.lot_multiple,x.preferred,x.active,x.version,x.updated_at FROM item_suppliers x JOIN items i ON i.id=x.item_id JOIN suppliers s ON s.id=x.supplier_id JOIN units pu ON pu.id=x.purchase_unit_id',
    sort: ['lower(i.code)', 'lower(s.code)'],
    search: '(starts_with(lower(i.code),$q) OR starts_with(lower(s.code),$q))',
    keyWhere:
      '(x.item_id,x.supplier_id) IN (SELECT a::uuid,b::uuid FROM unnest($1::text[],$2::text[]) AS k(a,b))',
    keyArgs: (rows) => [rows.map((r) => r.value.item_id), rows.map((r) => r.value.supplier_id)],
    keyOf: (r) => `${lc(r.item)}|${lc(r.supplier)}`,
    same: (v, r) =>
      v.supplier_item_code === r.supplier_item_code &&
      v.purchase_unit_id === r.purchase_unit_id &&
      (v.lead_time_days ?? null) === r.lead_time_days &&
      dec(v.moq) === dec(r.moq) &&
      dec(v.lot_multiple) === dec(r.lot_multiple) &&
      v.preferred === r.preferred,
    columns: [
      'item_id',
      'supplier_id',
      'supplier_item_code',
      'purchase_unit_id',
      'lead_time_days',
      'moq',
      'lot_multiple',
      'preferred',
    ],
    types: ['uuid', 'uuid', 'text', 'uuid', 'int', 'numeric', 'numeric', 'boolean'],
    conflict: '(tenant_id,item_id,supplier_id)',
    mutable: [
      'supplier_item_code',
      'purchase_unit_id',
      'lead_time_days',
      'moq',
      'lot_multiple',
      'preferred',
    ],
  },
  unit_conversions: {
    select:
      "SELECT x.id,fu.code AS from_unit,tu.code AS to_unit,coalesce(i.code,'') AS item,x.from_unit_id,x.to_unit_id,x.item_id,x.factor,x.active,x.version,x.updated_at FROM unit_conversions x JOIN units fu ON fu.id=x.from_unit_id JOIN units tu ON tu.id=x.to_unit_id LEFT JOIN items i ON i.id=x.item_id",
    sort: ['lower(fu.code)', 'lower(tu.code)', "lower(coalesce(i.code,''))"],
    search:
      "(starts_with(lower(fu.code),$q) OR starts_with(lower(tu.code),$q) OR starts_with(lower(coalesce(i.code,'')),$q))",
    keyWhere: `(x.from_unit_id,x.to_unit_id,coalesce(x.item_id,'${ZERO_UUID}'::uuid)) IN (SELECT a::uuid,b::uuid,c::uuid FROM unnest($1::text[],$2::text[],$3::text[]) AS k(a,b,c))`,
    keyArgs: (rows) => [
      rows.map((r) => r.value.from_unit_id),
      rows.map((r) => r.value.to_unit_id),
      rows.map((r) => r.value.item_id ?? ZERO_UUID),
    ],
    keyOf: (r) => `${lc(r.from_unit)}|${lc(r.to_unit)}|${lc(r.item ?? '')}`,
    same: (v, r) => dec(v.factor) === dec(r.factor),
    columns: ['from_unit_id', 'to_unit_id', 'item_id', 'factor'],
    types: ['uuid', 'uuid', 'uuid', 'numeric'],
    conflict: `(tenant_id,from_unit_id,to_unit_id,coalesce(item_id,'${ZERO_UUID}'::uuid))`,
    mutable: ['factor'],
  },
  // Reach field masters. softDelete tells every read here to skip removed rows, and makes the
  // uniqueness rule a partial index, so a removed code can be used again.
  territories: {
    select:
      "SELECT x.id,x.code,x.name,coalesce(p.code,'') AS parent,x.parent_id,x.active,x.version,x.updated_at FROM territories x LEFT JOIN territories p ON p.id=x.parent_id",
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) => v.name === r.name && (v.parent_id ?? null) === r.parent_id,
    columns: ['code', 'name', 'parent_id'],
    types: ['text', 'text', 'uuid'],
    conflict: '(tenant_id,lower(code)) WHERE deleted_at IS NULL',
    mutable: ['name', 'parent_id'],
    softDelete: true,
  },
  rep_grades: {
    select: 'SELECT x.id,x.code,x.name,x.rank,x.active,x.version,x.updated_at FROM rep_grades x',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) => v.name === r.name && v.rank === r.rank,
    columns: ['code', 'name', 'rank'],
    types: ['text', 'text', 'smallint'],
    conflict: '(tenant_id,lower(code)) WHERE deleted_at IS NULL',
    mutable: ['name', 'rank'],
    softDelete: true,
  },
  field_reps: {
    select:
      'SELECT x.id,x.code,x.name,g.code AS grade,x.grade_id,t.code AS territory,x.territory_id,' +
      'coalesce(u.email,\'\') AS "user",x.user_id,x.photo_file_id,x.email,x.phone,' +
      "to_char(x.joined_on,'YYYY-MM-DD') AS joined_on,x.active,x.version,x.updated_at " +
      'FROM field_reps x JOIN rep_grades g ON g.id=x.grade_id ' +
      'JOIN territories t ON t.id=x.territory_id LEFT JOIN app_users u ON u.id=x.user_id',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) =>
      v.name === r.name &&
      v.grade_id === r.grade_id &&
      v.territory_id === r.territory_id &&
      (v.user_id ?? null) === r.user_id &&
      v.email === r.email &&
      v.phone === r.phone &&
      (v.joined_on ?? null) === r.joined_on,
    columns: ['code', 'name', 'grade_id', 'territory_id', 'user_id', 'email', 'phone', 'joined_on'],
    types: ['text', 'text', 'uuid', 'uuid', 'uuid', 'text', 'text', 'date'],
    conflict: '(tenant_id,lower(code)) WHERE deleted_at IS NULL',
    mutable: ['name', 'grade_id', 'territory_id', 'user_id', 'email', 'phone', 'joined_on'],
    softDelete: true,
  },
  leave_types: {
    select:
      'SELECT x.id,x.code,x.name,x.paid,x.annual_quota,x.carry_forward,x.requires_approval,x.active,x.version,x.updated_at FROM leave_types x',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) =>
      v.name === r.name &&
      v.paid === r.paid &&
      dec(v.annual_quota) === dec(r.annual_quota) &&
      v.carry_forward === r.carry_forward &&
      v.requires_approval === r.requires_approval,
    columns: ['code', 'name', 'paid', 'annual_quota', 'carry_forward', 'requires_approval'],
    types: ['text', 'text', 'boolean', 'numeric', 'boolean', 'boolean'],
    conflict: '(tenant_id,lower(code)) WHERE deleted_at IS NULL',
    mutable: ['name', 'paid', 'annual_quota', 'carry_forward', 'requires_approval'],
    softDelete: true,
  },
  holidays: {
    select:
      "SELECT x.id,to_char(x.holiday_date,'YYYY-MM-DD') AS holiday_date,x.name,x.holiday_type," +
      "coalesce(t.code,'') AS territory,x.territory_id,x.active,x.version,x.updated_at " +
      'FROM holidays x LEFT JOIN territories t ON t.id=x.territory_id',
    // Sorted as text, because the cursor that carries the last row forward is text.
    sort: ["to_char(x.holiday_date,'YYYY-MM-DD')"],
    search:
      "(starts_with(lower(x.name),$q) OR starts_with(to_char(x.holiday_date,'YYYY-MM-DD'),$q))",
    keyWhere: `(x.holiday_date,coalesce(x.territory_id,'${ZERO_UUID}'::uuid)) IN (SELECT a::date,b::uuid FROM unnest($1::text[],$2::text[]) AS k(a,b))`,
    keyArgs: (rows) => [
      rows.map((r) => r.value.holiday_date),
      rows.map((r) => r.value.territory_id ?? ZERO_UUID),
    ],
    keyOf: (r) => `${r.holiday_date}|${lc(r.territory ?? '')}`,
    same: (v, r) => v.name === r.name && v.holiday_type === r.holiday_type,
    columns: ['holiday_date', 'name', 'holiday_type', 'territory_id'],
    types: ['date', 'text', 'text', 'uuid'],
    conflict: `(tenant_id,holiday_date,coalesce(territory_id,'${ZERO_UUID}'::uuid)) WHERE deleted_at IS NULL`,
    mutable: ['name', 'holiday_type'],
    softDelete: true,
  },
  // Reach customers and beats (RCH-1).
  customer_types: {
    select:
      'SELECT x.id,x.code,x.name,x.tier,x.prefix,x.geo_required,x.checkin_radius_m,' +
      'x.min_visit_minutes,x.visit_norm_per_month,x.on_beat_plan,x.needs_approval,' +
      'x.kyc_before_order,x.order_route,x.credit_limit,x.credit_days,x.hold_days,x.loyalty,' +
      'x.active,x.version,x.updated_at FROM customer_types x',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) =>
      v.name === r.name &&
      v.tier === r.tier &&
      v.prefix === r.prefix &&
      v.geo_required === r.geo_required &&
      v.checkin_radius_m === r.checkin_radius_m &&
      v.min_visit_minutes === r.min_visit_minutes &&
      v.visit_norm_per_month === r.visit_norm_per_month &&
      v.on_beat_plan === r.on_beat_plan &&
      v.needs_approval === r.needs_approval &&
      v.kyc_before_order === r.kyc_before_order &&
      v.order_route === r.order_route &&
      dec(v.credit_limit) === dec(r.credit_limit) &&
      (v.credit_days ?? null) === r.credit_days &&
      (v.hold_days ?? null) === r.hold_days &&
      v.loyalty === r.loyalty,
    columns: [
      'code',
      'name',
      'tier',
      'prefix',
      'geo_required',
      'checkin_radius_m',
      'min_visit_minutes',
      'visit_norm_per_month',
      'on_beat_plan',
      'needs_approval',
      'kyc_before_order',
      'order_route',
      'credit_limit',
      'credit_days',
      'hold_days',
      'loyalty',
    ],
    types: [
      'text',
      'text',
      'smallint',
      'text',
      'boolean',
      'int',
      'int',
      'int',
      'boolean',
      'boolean',
      'boolean',
      'text',
      'numeric',
      'int',
      'int',
      'boolean',
    ],
    conflict: '(tenant_id,lower(code)) WHERE deleted_at IS NULL',
    mutable: [
      'name',
      'tier',
      'prefix',
      'geo_required',
      'checkin_radius_m',
      'min_visit_minutes',
      'visit_norm_per_month',
      'on_beat_plan',
      'needs_approval',
      'kyc_before_order',
      'order_route',
      'credit_limit',
      'credit_days',
      'hold_days',
      'loyalty',
    ],
    softDelete: true,
  },
  customer_form_fields: {
    select:
      'SELECT x.id,x.field_key,x.name,x.input,x.section,x.display_order,x.options,x.help,' +
      'x.default_value,x.locked,x.active,x.version,x.updated_at FROM customer_form_fields x',
    sort: ['x.field_key'],
    search: '(starts_with(x.field_key,$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'x.field_key=ANY($1::text[])',
    keyArgs: (rows) => [rows.map((r) => r.value.field_key)],
    keyOf: (r) => r.field_key,
    same: (v, r) =>
      v.name === r.name &&
      v.input === r.input &&
      v.section === r.section &&
      v.display_order === r.display_order &&
      v.options === r.options &&
      v.help === r.help &&
      v.default_value === r.default_value,
    columns: [
      'field_key',
      'name',
      'input',
      'section',
      'display_order',
      'options',
      'help',
      'default_value',
    ],
    types: ['text', 'text', 'text', 'text', 'int', 'text', 'text', 'text'],
    conflict: '(tenant_id,field_key) WHERE deleted_at IS NULL',
    mutable: ['name', 'input', 'section', 'display_order', 'options', 'help', 'default_value'],
    softDelete: true,
  },
  customer_form_rules: {
    select:
      'SELECT x.id,t.code AS type,f.field_key AS field,x.type_id,x.field_id,x.requirement,' +
      'x.label_override,x.active,x.version,x.updated_at FROM customer_form_rules x ' +
      'JOIN customer_types t ON t.id=x.type_id JOIN customer_form_fields f ON f.id=x.field_id',
    sort: ['lower(t.code)', 'f.field_key'],
    search: '(starts_with(lower(t.code),$q) OR starts_with(f.field_key,$q))',
    keyWhere:
      '(x.type_id,x.field_id) IN (SELECT a::uuid,b::uuid FROM unnest($1::text[],$2::text[]) AS k(a,b))',
    keyArgs: (rows) => [rows.map((r) => r.value.type_id), rows.map((r) => r.value.field_id)],
    keyOf: (r) => `${lc(r.type)}|${lc(r.field)}`,
    same: (v, r) => v.requirement === r.requirement && v.label_override === r.label_override,
    columns: ['type_id', 'field_id', 'requirement', 'label_override'],
    types: ['uuid', 'uuid', 'text', 'text'],
    conflict: '(tenant_id,type_id,field_id) WHERE deleted_at IS NULL',
    mutable: ['requirement', 'label_override'],
    softDelete: true,
  },
  beats: {
    select:
      'SELECT x.id,x.code,x.name,t.code AS territory,x.territory_id,x.frequency,x.run_days,' +
      'x.week_parity,x.active,x.version,x.updated_at FROM beats x ' +
      'JOIN territories t ON t.id=x.territory_id',
    sort: ['lower(x.code)'],
    search: '(starts_with(lower(x.code),$q) OR starts_with(lower(x.name),$q))',
    keyWhere: 'lower(x.code)=ANY($1::text[])',
    keyOf: (r) => lc(r.code),
    same: (v, r) =>
      v.name === r.name &&
      v.territory_id === r.territory_id &&
      v.frequency === r.frequency &&
      v.run_days === r.run_days &&
      v.week_parity === r.week_parity,
    columns: ['code', 'name', 'territory_id', 'frequency', 'run_days', 'week_parity'],
    types: ['text', 'text', 'uuid', 'text', 'text', 'text'],
    conflict: '(tenant_id,lower(code)) WHERE deleted_at IS NULL',
    mutable: ['name', 'territory_id', 'frequency', 'run_days', 'week_parity'],
    softDelete: true,
  },
  beat_assignments: {
    select:
      'SELECT x.id,b.code AS beat,r.code AS rep,x.beat_id,x.rep_id,' +
      "to_char(x.from_date,'YYYY-MM-DD') AS from_date,to_char(x.to_date,'YYYY-MM-DD') AS to_date," +
      'x.active,x.version,x.updated_at FROM beat_assignments x ' +
      'JOIN beats b ON b.id=x.beat_id JOIN field_reps r ON r.id=x.rep_id',
    sort: ['lower(b.code)', "to_char(x.from_date,'YYYY-MM-DD')"],
    search: '(starts_with(lower(b.code),$q) OR starts_with(lower(r.code),$q))',
    keyWhere:
      '(x.beat_id,x.from_date) IN (SELECT a::uuid,b::date FROM unnest($1::text[],$2::text[]) AS k(a,b))',
    keyArgs: (rows) => [rows.map((r) => r.value.beat_id), rows.map((r) => r.value.from_date)],
    keyOf: (r) => `${lc(r.beat)}|${r.from_date}`,
    same: (v, r) => v.rep_id === r.rep_id && (v.to_date ?? null) === r.to_date,
    columns: ['beat_id', 'rep_id', 'from_date', 'to_date'],
    types: ['uuid', 'uuid', 'date', 'date'],
    conflict: '(tenant_id,beat_id,from_date) WHERE deleted_at IS NULL',
    mutable: ['rep_id', 'to_date'],
    softDelete: true,
  },
};

function sqlFor(kind) {
  if (!Object.hasOwn(SQL, kind) || !Object.hasOwn(MASTER_KINDS, kind))
    throw Error('Unsupported master kind');
  return SQL[kind];
}

// Removed rows stay in the table, so every read of a soft-deleting kind has to say so.
const inUse = (kind) => (sqlFor(kind).softDelete ? ' AND x.deleted_at IS NULL' : '');

// Existing records keyed like MASTER_KINDS[kind].key, for create/update/unchanged decisions.
export async function existingRecords(db, kind, rows) {
  const s = sqlFor(kind);
  const map = new Map();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const args = s.keyArgs ? s.keyArgs(part) : [part.map((r) => lc(r.value.code))];
    for (const r of (await db.query(`${s.select} WHERE ${s.keyWhere}${inUse(kind)}`, args)).rows)
      map.set(s.keyOf(r), r);
  }
  return map;
}

export function decideAction(kind, value, existing) {
  if (!existing) return 'create';
  return sqlFor(kind).same(value, existing) ? 'unchanged' : 'update';
}

// Bulk upsert of validated values; unchanged rows are skipped so replays add nothing.
export async function upsertMasters(db, kind, tenantId, values) {
  const s = sqlFor(kind);
  let created = 0,
    updated = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK);
    if (kind === 'item_suppliers') {
      const preferred = part.filter((v) => v.preferred);
      if (preferred.length)
        await db.query(
          'UPDATE item_suppliers x SET preferred=false,version=version+1,updated_at=now() FROM unnest($1::uuid[],$2::uuid[]) AS p(item_id,supplier_id) WHERE x.item_id=p.item_id AND x.supplier_id<>p.supplier_id AND x.preferred',
          [preferred.map((v) => v.item_id), preferred.map((v) => v.supplier_id)],
        );
    }
    const params = [
      tenantId,
      ...s.columns.map((c) => part.map((v) => v[c] ?? (TEXT_DEFAULTS.has(c) ? '' : null))),
    ];
    const unnest = s.columns.map((c, n) => `$${n + 2}::${s.types[n]}[]`).join(',');
    const rows = (
      await db.query(
        `INSERT INTO ${kind}(id,tenant_id,${s.columns.join(',')})
         SELECT gen_random_uuid(),$1,${s.columns.map((c) => 'v.' + c).join(',')} FROM unnest(${unnest}) AS v(${s.columns.join(',')})
         ON CONFLICT ${s.conflict} DO UPDATE SET ${s.mutable.map((c) => `${c}=excluded.${c}`).join(',')},version=${kind}.version+1,updated_at=now()
         WHERE (${s.mutable.map((c) => `${kind}.${c}`).join(',')}) IS DISTINCT FROM (${s.mutable.map((c) => `excluded.${c}`).join(',')})
         RETURNING (xmax=0) AS inserted`,
        params,
      )
    ).rows;
    created += rows.filter((r) => r.inserted).length;
    updated += rows.filter((r) => !r.inserted).length;
  }
  return { created, updated, unchanged: values.length - created - updated };
}

// Keyset pagination in code order: cursor is the last row's sort values plus its id.
export async function listMasters(db, kind, { q = '', cursor = null, limit = DEFAULT_PAGE_SIZE }) {
  const s = sqlFor(kind);
  const sortKeys = [...s.sort, 'x.id'];
  const params = [q];
  let where = s.search.replaceAll('$q', '$1') + inUse(kind);
  // Counted before the cursor narrows anything: the reader wants the size of the whole list.
  const total = await countRows(db, s.select.slice(s.select.indexOf(' FROM ') + 6), where, params);
  if (cursor) {
    params.push(...cursor);
    where += ` AND (${sortKeys.map((k, n) => (n < s.sort.length ? `${k}` : 'x.id::text')).join(',')}) > (${cursor
      .map((_, n) => `$${n + 2}::text`)
      .join(',')})`;
  }
  params.push(limit + 1);
  const result = (
    await db.query(
      `${s.select} WHERE ${where} ORDER BY ${sortKeys.map((k, n) => (n < s.sort.length ? k : 'x.id::text')).join(',')} LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = result.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    result.length > limit
      ? [...s.sort.map((k) => sortValue(kind, k, last)), String(last.id)]
      : null;
  return { items, nextCursor, total };
}

function sortValue(kind, expr, row) {
  const map = {
    'lower(x.code)': row.code,
    'lower(i.code)': row.item,
    'lower(s.code)': row.supplier,
    'lower(fu.code)': row.from_unit,
    'lower(tu.code)': row.to_unit,
    "lower(coalesce(i.code,''))": row.item ?? '',
    "to_char(x.holiday_date,'YYYY-MM-DD')": row.holiday_date,
    'x.field_key': row.field_key,
    'lower(t.code)': row.type ?? row.territory,
    'f.field_key': row.field,
    'lower(b.code)': row.beat,
    "to_char(x.from_date,'YYYY-MM-DD')": row.from_date,
  };
  return lc(map[expr] ?? '');
}

export async function findMaster(db, kind, id) {
  const s = sqlFor(kind);
  return (await db.query(`${s.select} WHERE x.id=$1${inUse(kind)}`, [id])).rows[0] ?? null;
}

// Single-record update of mutable fields plus active flag, with optimistic version check done by caller.
export async function updateMaster(db, kind, id, value, active) {
  const s = sqlFor(kind);
  if (kind === 'item_suppliers' && value.preferred && active)
    await db.query(
      'UPDATE item_suppliers SET preferred=false,version=version+1,updated_at=now() WHERE item_id=$1 AND id<>$2 AND preferred',
      [value.item_id, id],
    );
  await db.query(
    `UPDATE ${kind} SET ${s.mutable.map((c, n) => `${c}=$${n + 3}`).join(',')},active=$2,version=version+1,updated_at=now() WHERE id=$1`,
    [id, active, ...s.mutable.map((c) => value[c] ?? (TEXT_DEFAULTS.has(c) ? '' : null))],
  );
}

// ---------- Removal (soft delete) ----------

// What still points at a record, so a removal cannot leave another row pointing at nothing. The
// foreign keys would stop a real DELETE; a stamp needs the same question asked in code.
const DEPENDANTS = {
  territories: [
    ['field_reps', 'territory_id', 'field rep', 'field reps'],
    ['territories', 'parent_id', 'territory', 'territories'],
    ['holidays', 'territory_id', 'holiday', 'holidays'],
    ['beats', 'territory_id', 'beat', 'beats'],
    ['trade_customers', 'territory_id', 'customer', 'customers'],
  ],
  rep_grades: [['field_reps', 'grade_id', 'field rep', 'field reps']],
  field_reps: [
    ['beat_assignments', 'rep_id', 'beat assignment', 'beat assignments'],
    ['trade_customers', 'rep_id', 'customer', 'customers'],
  ],
  customer_types: [
    ['trade_customers', 'type_id', 'customer', 'customers'],
    ['customer_form_rules', 'type_id', 'form rule', 'form rules'],
  ],
  customer_form_fields: [['customer_form_rules', 'field_id', 'form rule', 'form rules']],
  beats: [
    ['trade_customers', 'beat_id', 'customer', 'customers'],
    ['beat_assignments', 'beat_id', 'beat assignment', 'beat assignments'],
  ],
};

export async function removalBlockers(db, kind, id) {
  const blockers = [];
  for (const [table, column, one, many] of DEPENDANTS[kind] ?? []) {
    const n = (
      await db.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1 AND deleted_at IS NULL`,
        [id],
      )
    ).rows[0].n;
    if (n) blockers.push(`${n} ${n === 1 ? one : many} still ${n === 1 ? 'uses' : 'use'} it`);
  }
  return blockers;
}

// Removal is a stamp, not a DELETE: the row stays in the table and the code it held is free again.
// Returns false when the record was already removed, which is how a double submit is caught.
export async function removeMaster(db, kind, id, actorId, reason) {
  const s = sqlFor(kind);
  if (!s.softDelete) throw Error('This master kind cannot be removed');
  const r = await db.query(
    `UPDATE ${kind} SET deleted_at=now(),deleted_by=$2,delete_reason=$3,active=false,
       version=version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`,
    [id, actorId, reason],
  );
  return r.rowCount === 1;
}
