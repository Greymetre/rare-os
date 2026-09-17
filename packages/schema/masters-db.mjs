// Database side of planning masters, shared by the API (single records) and the worker (imports).
// Every function receives a pg client already inside a company-scoped (RLS) transaction.
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
      const noun = { units: 'Unit', items: 'Item', suppliers: 'Supplier' }[f.ref];
      if (!rec)
        row.errors.push({
          column: f.name,
          message: `${noun} ${code} was not found. Create it first.`,
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
};

function sqlFor(kind) {
  if (!Object.hasOwn(SQL, kind) || !Object.hasOwn(MASTER_KINDS, kind))
    throw Error('Unsupported master kind');
  return SQL[kind];
}

// Existing records keyed like MASTER_KINDS[kind].key, for create/update/unchanged decisions.
export async function existingRecords(db, kind, rows) {
  const s = sqlFor(kind);
  const map = new Map();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const args = s.keyArgs ? s.keyArgs(part) : [part.map((r) => lc(r.value.code))];
    for (const r of (await db.query(`${s.select} WHERE ${s.keyWhere}`, args)).rows)
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
export async function listMasters(db, kind, { q = '', cursor = null, limit = 25 }) {
  const s = sqlFor(kind);
  const sortKeys = [...s.sort, 'x.id'];
  const params = [q];
  let where = s.search.replaceAll('$q', '$1');
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
  return { items, nextCursor };
}

function sortValue(kind, expr, row) {
  const map = {
    'lower(x.code)': row.code,
    'lower(i.code)': row.item,
    'lower(s.code)': row.supplier,
    'lower(fu.code)': row.from_unit,
    'lower(tu.code)': row.to_unit,
    "lower(coalesce(i.code,''))": row.item ?? '',
  };
  return lc(map[expr] ?? '');
}

export async function findMaster(db, kind, id) {
  const s = sqlFor(kind);
  return (await db.query(`${s.select} WHERE x.id=$1`, [id])).rows[0] ?? null;
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
