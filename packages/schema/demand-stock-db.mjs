// Database side of demand and stock (AV-3), shared by the API (forms) and the worker (imports).
// Every function receives a pg client inside a company-scoped (RLS) transaction.
import { addDecimal, divideDecimal, multiplyDecimal, parseQuantity } from './quantity.mjs';
import { itemsByCode, plantsByCode, resolvePlant } from './plant-model-db.mjs';

const CHUNK = 1000;
const lc = (v) => String(v ?? '').toLowerCase();
const dec = (v) =>
  v === null || v === undefined ? null : parseQuantity(String(v), 6, { allowNegative: true }).value;
const err = (column, message) => ({ column, message });
const negative = (v) => String(v).startsWith('-');
const abs = (v) => (negative(v) ? String(v).slice(1) : String(v));

async function unitsByCode(db, codes) {
  const rows = (
    await db.query('SELECT id,code,active,decimals FROM units WHERE lower(code)=ANY($1::text[])', [
      [...new Set(codes.filter(Boolean).map(lc))],
    ])
  ).rows;
  return new Map(rows.map((u) => [lc(u.code), u]));
}

// Returns factor(fromUnitId, baseUnitId, itemId): how many base units one entered unit is, or null.
export async function conversionFactors(db, itemIds) {
  const map = new Map();
  for (const c of (
    await db.query(
      'SELECT from_unit_id,to_unit_id,item_id,factor FROM unit_conversions WHERE active AND (item_id IS NULL OR item_id=ANY($1::uuid[]))',
      [[...new Set(itemIds)]],
    )
  ).rows)
    map.set(`${c.from_unit_id}|${c.to_unit_id}|${c.item_id ?? ''}`, dec(c.factor));
  return (from, to, itemId) => {
    if (from === to) return '1';
    for (const scope of [itemId, '']) {
      const direct = map.get(`${from}|${to}|${scope}`);
      if (direct) return direct;
      const inverse = map.get(`${to}|${from}|${scope}`);
      if (inverse) return divideDecimal('1', inverse, 12);
    }
    return null;
  };
}

// Resolves an entered quantity + unit to the item base unit; pushes errors and returns null on failure.
function toBaseUnit({ quantity, unitCode, item, units, factor, label, errors, column }) {
  const refuse = (message) => {
    errors.push(err(column, label + message));
    return null;
  };
  let unit = { id: item.base_unit_id, code: item.base_unit, decimals: item.base_decimals };
  if (unitCode) {
    const u = units.get(lc(unitCode));
    if (!u) return refuse(`unit ${unitCode} was not found.`);
    if (!u.active) return refuse(`unit ${u.code} is inactive.`);
    unit = u;
  }
  const entered = parseQuantity(abs(quantity), unit.decimals, { label: 'quantity' });
  if (entered.error) return refuse(`${entered.error} (unit ${unit.code})`);
  const f = factor(unit.id, item.base_unit_id, item.id);
  if (f === null)
    return refuse(
      `no conversion between ${unit.code} and ${item.base_unit} for item ${item.code}. Add a unit conversion first.`,
    );
  const base = multiplyDecimal(abs(quantity), f);
  if (parseQuantity(base, item.base_decimals).error)
    return refuse(
      `${abs(quantity)} ${unit.code} is ${base} ${item.base_unit}, but ${item.base_unit} allows ${item.base_decimals} decimal place(s).`,
    );
  return { unit, factor: f, base };
}

function resolveItem(items, code, label, errors, column = 'item') {
  const item = items.get(lc(code));
  if (!item) errors.push(err(column, `${label}item ${code} was not found.`));
  else if (!item.active) errors.push(err(column, `${label}item ${item.code} is inactive.`));
  else return item;
  return null;
}

// ---------- Stock locations ----------

export async function listStockLocations(db, siteId) {
  return (
    await db.query(
      `SELECT l.id,l.code,l.name,l.location_type,l.nettable,l.active,l.version,
        (SELECT count(*) FROM stock_balances b WHERE b.location_id=l.id AND b.quantity<>0)::int AS items_in_stock
       FROM stock_locations l WHERE l.site_id=$1 ORDER BY lower(l.code) LIMIT 500`,
      [siteId],
    )
  ).rows;
}

export async function checkStockLocations(db, rows, scope) {
  const plants = await plantsByCode(
    db,
    rows.map((r) => r.value.plant),
  );
  const existing = new Map(
    (
      await db.query('SELECT * FROM stock_locations WHERE lower(code)=ANY($1::text[])', [
        [...new Set(rows.map((r) => lc(r.value.code)))],
      ])
    ).rows.map((l) => [`${l.site_id}|${lc(l.code)}`, l]),
  );
  for (const row of rows) {
    const plant = resolvePlant(plants, row.value.plant, scope, row.errors);
    if (!plant) continue;
    row.value.plant = plant.code;
    row.value.site_id = plant.id;
    row.existing = existing.get(`${plant.id}|${lc(row.value.code)}`) ?? null;
  }
  return rows;
}

export function stockLocationAction(value, old) {
  if (!old) return 'create';
  return old.name === value.name &&
    old.location_type === value.location_type &&
    old.nettable === value.nettable
    ? 'unchanged'
    : 'update';
}

export async function writeStockLocation(db, tenantId, value, old, active = true) {
  if (old) {
    await db.query(
      'UPDATE stock_locations SET name=$2,location_type=$3,nettable=$4,active=$5,version=version+1,updated_at=now() WHERE id=$1',
      [old.id, value.name, value.location_type, value.nettable, active],
    );
    return old.id;
  }
  return (
    await db.query(
      'INSERT INTO stock_locations(id,tenant_id,site_id,code,name,location_type,nettable) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) RETURNING id',
      [tenantId, value.site_id, value.code, value.name, value.location_type, value.nettable],
    )
  ).rows[0].id;
}

export async function stockInLocation(db, locationId) {
  return Number(
    (
      await db.query('SELECT count(*) FROM stock_balances WHERE location_id=$1 AND quantity<>0', [
        locationId,
      ])
    ).rows[0].count,
  );
}

// ---------- Stock movements ----------

const pairKey = (locationId, itemId) => `${locationId}|${itemId}`;

// rows: [{ line?, value, errors }] from validateMovement, in posting order.
// Resolves ids and base quantities, then checks opening stock rules and that no row takes stock below zero.
export async function checkMovements(db, rows, scope, { today }) {
  const pending = rows.filter((r) => !r.errors.length);
  const plants = await plantsByCode(
    db,
    pending.map((r) => r.value.plant),
  );
  const locations = new Map(
    (
      await db.query(
        'SELECT id,site_id,code,active FROM stock_locations WHERE lower(code)=ANY($1::text[])',
        [[...new Set(pending.map((r) => lc(r.value.location)))]],
      )
    ).rows.map((l) => [`${l.site_id}|${lc(l.code)}`, l]),
  );
  const items = await itemsByCode(
    db,
    pending.map((r) => r.value.item),
  );
  const units = await unitsByCode(
    db,
    pending.map((r) => r.value.unit),
  );
  const factor = await conversionFactors(
    db,
    [...items.values()].map((i) => i.id),
  );
  const refs = [
    ...new Set(
      pending
        .map((r) => r.value.external_ref)
        .filter(Boolean)
        .map(lc),
    ),
  ];
  const posted = new Map(
    (
      await db.query(
        `SELECT m.id,m.movement_no,m.site_id,m.location_id,m.item_id,m.movement_type,m.entered_quantity,m.entered_unit_id,m.quantity,
          to_char(m.movement_date,'YYYY-MM-DD') AS movement_date,m.reference,m.reason,m.external_ref
         FROM stock_movements m WHERE lower(m.external_ref)=ANY($1::text[])`,
        [refs],
      )
    ).rows.map((m) => [lc(m.external_ref), m]),
  );
  const refLines = new Map();
  for (const row of pending) {
    const v = row.value,
      e = row.errors;
    const plant = resolvePlant(plants, v.plant, scope, e);
    if (plant) {
      v.plant = plant.code;
      v.site_id = plant.id;
      const loc = locations.get(`${plant.id}|${lc(v.location)}`);
      if (!loc)
        e.push(err('location', `Location ${v.location} was not found in plant ${plant.code}.`));
      else if (!loc.active) e.push(err('location', `Location ${loc.code} is inactive.`));
      else {
        v.location = loc.code;
        v.location_id = loc.id;
      }
    }
    const item = resolveItem(items, v.item, '', e);
    if (item) {
      v.item = item.code;
      v.item_id = item.id;
      v.base_unit = item.base_unit;
      const r = toBaseUnit({
        quantity: v.quantity,
        unitCode: v.unit,
        item,
        units,
        factor,
        label: '',
        errors: e,
        column: 'quantity',
      });
      if (r) {
        v.unit = r.unit.code;
        v.entered_unit_id = r.unit.id;
        v.entered_quantity = abs(v.quantity);
        const out = v.movement_type === 'ISSUE' || negative(v.quantity);
        v.base_quantity = out ? '-' + r.base : r.base;
      }
    }
    if (v.movement_date > today)
      e.push(err('movement_date', 'Movement date cannot be in the future.'));
    if (v.external_ref) {
      const key = lc(v.external_ref);
      if (refLines.has(key))
        e.push(
          err(
            'external_ref',
            `External reference ${v.external_ref} is repeated on line ${refLines.get(key)}.`,
          ),
        );
      refLines.set(key, row.line ?? 'this form');
      const old = posted.get(key);
      if (old && !e.length) {
        const same =
          old.site_id === v.site_id &&
          old.location_id === v.location_id &&
          old.item_id === v.item_id &&
          old.movement_type === v.movement_type &&
          dec(old.entered_quantity) === dec(v.entered_quantity) &&
          old.entered_unit_id === v.entered_unit_id &&
          dec(old.quantity) === dec(v.base_quantity) &&
          old.movement_date === v.movement_date &&
          old.reference === v.reference &&
          old.reason === v.reason;
        if (same) row.existing = old;
        else
          e.push(
            err(
              'external_ref',
              `External reference ${old.external_ref} was already posted as movement #${old.movement_no} with different values. Posted movements cannot be changed: reverse it and post again with a new reference.`,
            ),
          );
      }
    }
  }
  const fresh = pending.filter((r) => !r.errors.length && !r.existing);
  const pairs = [
    ...new Map(fresh.map((r) => [pairKey(r.value.location_id, r.value.item_id), r.value])).values(),
  ];
  if (!pairs.length) return rows;
  const pairArgs = [pairs.map((p) => p.location_id), pairs.map((p) => p.item_id)];
  const openings = new Map(
    (
      await db.query(
        `SELECT m.location_id,m.item_id,m.movement_no FROM stock_movements m
         JOIN unnest($1::uuid[],$2::uuid[]) AS p(location_id,item_id) ON p.location_id=m.location_id AND p.item_id=m.item_id
         WHERE m.movement_type='OPENING' AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id=m.id)`,
        pairArgs,
      )
    ).rows.map((m) => [pairKey(m.location_id, m.item_id), m.movement_no]),
  );
  const balance = new Map(
    (
      await db.query(
        `SELECT b.location_id,b.item_id,b.quantity FROM stock_balances b
         JOIN unnest($1::uuid[],$2::uuid[]) AS p(location_id,item_id) ON p.location_id=b.location_id AND p.item_id=b.item_id`,
        pairArgs,
      )
    ).rows.map((b) => [pairKey(b.location_id, b.item_id), dec(b.quantity)]),
  );
  const openingLines = new Map();
  for (const row of fresh) {
    const v = row.value,
      key = pairKey(v.location_id, v.item_id);
    if (v.movement_type === 'OPENING') {
      if (openings.has(key))
        row.errors.push(
          err(
            'movement_type',
            `Opening stock for ${v.item} at ${v.location} was already posted (movement #${openings.get(key)}). Use an adjustment to correct it.`,
          ),
        );
      else if (openingLines.has(key))
        row.errors.push(
          err(
            'movement_type',
            `Opening stock for ${v.item} at ${v.location} is repeated on line ${openingLines.get(key)}.`,
          ),
        );
      openingLines.set(key, row.line ?? 'this form');
    }
    if (row.errors.length) continue;
    const before = balance.get(key) ?? '0';
    const after = addDecimal(before, v.base_quantity);
    if (negative(after))
      row.errors.push(
        err(
          'quantity',
          `Not enough stock: ${v.item} at ${v.location} has ${before} ${v.base_unit} available, this movement takes out ${abs(v.base_quantity)} ${v.base_unit}.`,
        ),
      );
    else balance.set(key, after);
  }
  return rows;
}

// Inserts movements in the given order; balances follow through the ledger trigger.
export async function postMovements(db, tenantId, actor, values, batchId = null) {
  const posted = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK);
    const numbers = (
      await db.query(
        "SELECT next_number('stock_movement') AS n FROM generate_series(1,$1) ORDER BY 1",
        [part.length],
      )
    ).rows.map((r) => r.n);
    const rows = (
      await db.query(
        `INSERT INTO stock_movements(id,tenant_id,movement_no,site_id,location_id,item_id,movement_type,quantity,entered_quantity,entered_unit_id,movement_date,reference,reason,external_ref,reverses_id,import_batch_id,created_by,created_by_subject)
         SELECT gen_random_uuid(),$1,m.no,m.site,m.location,m.item,m.type,m.qty,m.entered,m.unit,m.day,m.reference,m.reason,m.ref,m.reverses,$2,$3,$4
         FROM unnest($5::bigint[],$6::uuid[],$7::uuid[],$8::uuid[],$9::text[],$10::numeric[],$11::numeric[],$12::uuid[],$13::date[],$14::text[],$15::text[],$16::text[],$17::uuid[])
           WITH ORDINALITY AS m(no,site,location,item,type,qty,entered,unit,day,reference,reason,ref,reverses,ord)
         ORDER BY m.ord
         RETURNING id,movement_no`,
        [
          tenantId,
          batchId,
          actor?.id ?? null,
          actor?.subject ?? null,
          numbers,
          part.map((v) => v.site_id),
          part.map((v) => v.location_id),
          part.map((v) => v.item_id),
          part.map((v) => v.movement_type),
          part.map((v) => v.base_quantity),
          part.map((v) => v.entered_quantity),
          part.map((v) => v.entered_unit_id),
          part.map((v) => v.movement_date),
          part.map((v) => v.reference ?? ''),
          part.map((v) => v.reason ?? ''),
          part.map((v) => v.external_ref ?? null),
          part.map((v) => v.reverses_id ?? null),
        ],
      )
    ).rows;
    posted.push(...rows);
  }
  return posted.sort((a, b) => Number(a.movement_no) - Number(b.movement_no));
}

export async function movementDetail(db, id) {
  return (
    (
      await db.query(
        `SELECT m.id,m.movement_no,m.site_id,s.code AS plant,m.location_id,l.code AS location,m.item_id,i.code AS item,u.code AS base_unit,
          m.movement_type,m.quantity,m.entered_quantity,eu.code AS unit,m.entered_unit_id,to_char(m.movement_date,'YYYY-MM-DD') AS movement_date,
          m.reference,m.reason,m.external_ref,m.reverses_id,
          (SELECT r.movement_no FROM stock_movements r WHERE r.reverses_id=m.id) AS reversed_by
         FROM stock_movements m JOIN sites s ON s.id=m.site_id JOIN stock_locations l ON l.id=m.location_id
         JOIN items i ON i.id=m.item_id JOIN units u ON u.id=i.base_unit_id JOIN units eu ON eu.id=m.entered_unit_id
         WHERE m.id=$1`,
        [id],
      )
    ).rows[0] ?? null
  );
}

// Returns { value } ready for postMovements, or { error } when the reversal is not allowed.
export async function reversalFor(db, original, reason, today) {
  if (original.movement_type === 'REVERSAL')
    return { error: 'A reversal cannot be reversed. Post a new movement instead.' };
  if (original.reversed_by)
    return {
      error: `Movement #${original.movement_no} was already reversed by movement #${original.reversed_by}.`,
    };
  const quantity = dec(original.quantity);
  if (!negative(quantity)) {
    const available =
      dec(
        (
          await db.query(
            'SELECT quantity FROM stock_balances WHERE location_id=$1 AND item_id=$2',
            [original.location_id, original.item_id],
          )
        ).rows[0]?.quantity,
      ) ?? '0';
    if (negative(addDecimal(available, '-' + quantity)))
      return {
        error: `Cannot reverse movement #${original.movement_no}: only ${available} ${original.base_unit} of ${original.item} is left at ${original.location}. Some of it was already used.`,
      };
  }
  return {
    value: {
      site_id: original.site_id,
      location_id: original.location_id,
      item_id: original.item_id,
      movement_type: 'REVERSAL',
      base_quantity: negative(quantity) ? abs(quantity) : '-' + quantity,
      entered_quantity: dec(original.entered_quantity),
      entered_unit_id: original.entered_unit_id,
      movement_date: today,
      reference: `Reversal of #${original.movement_no}`,
      reason,
      external_ref: null,
      reverses_id: original.id,
    },
  };
}

export async function listBalances(
  db,
  siteId,
  { q = '', locationId = null, cursor = null, limit = 25 },
) {
  const params = [siteId, q, locationId];
  let where =
    'b.site_id=$1 AND b.quantity<>0 AND (starts_with(lower(i.code),$2) OR starts_with(lower(i.name),$2)) AND ($3::uuid IS NULL OR b.location_id=$3)';
  if (cursor) {
    params.push(...cursor);
    where += ' AND (lower(i.code),lower(l.code)) > ($4,$5)';
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT b.location_id,l.code AS location,l.nettable,b.item_id,i.code AS item,i.name AS item_name,u.code AS unit,b.quantity,b.last_movement_no
       FROM stock_balances b JOIN items i ON i.id=b.item_id JOIN units u ON u.id=i.base_unit_id JOIN stock_locations l ON l.id=b.location_id
       WHERE ${where} ORDER BY lower(i.code),lower(l.code) LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit ? [lc(last.item), lc(last.location)] : null };
}

export async function listMovements(db, siteId, { q = '', cursor = null, limit = 25 }) {
  const rows = (
    await db.query(
      `SELECT m.id,m.movement_no,to_char(m.movement_date,'YYYY-MM-DD') AS movement_date,m.movement_type,l.code AS location,i.code AS item,
          u.code AS base_unit,m.quantity,m.entered_quantity,eu.code AS unit,m.reference,m.reason,m.external_ref,m.created_at,
          (SELECT o.movement_no FROM stock_movements o WHERE o.id=m.reverses_id) AS reverses_no,
          (SELECT r.movement_no FROM stock_movements r WHERE r.reverses_id=m.id) AS reversed_by
       FROM stock_movements m JOIN items i ON i.id=m.item_id JOIN units u ON u.id=i.base_unit_id
       JOIN units eu ON eu.id=m.entered_unit_id JOIN stock_locations l ON l.id=m.location_id
       WHERE m.site_id=$1 AND ($2='' OR starts_with(lower(i.code),$2)) AND ($3::bigint IS NULL OR m.movement_no<$3)
       ORDER BY m.movement_no DESC LIMIT $4`,
      [siteId, q, cursor, limit + 1],
    )
  ).rows;
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? String(items[items.length - 1].movement_no) : null,
  };
}

// ---------- Customer and purchase orders ----------

export const ORDER_TABLES = {
  sales_orders: {
    table: 'sales_orders',
    lines: 'sales_order_lines',
    fk: 'order_id',
    no: 'order_no',
    party: { field: 'customer', table: 'customers', column: 'customer_id', noun: 'Customer' },
    series: 'sales_order',
    prefix: 'SO-',
    noun: 'Order',
  },
  purchase_orders: {
    table: 'purchase_orders',
    lines: 'purchase_order_lines',
    fk: 'po_id',
    no: 'po_no',
    party: { field: 'supplier', table: 'suppliers', column: 'supplier_id', noun: 'Supplier' },
    series: 'purchase_order',
    prefix: 'PO-',
    noun: 'Purchase order',
  },
};

export async function nextOrderNo(db, kind) {
  const t = ORDER_TABLES[kind];
  for (;;) {
    const n = (await db.query('SELECT next_number($1) AS n', [t.series])).rows[0].n;
    const no = t.prefix + String(n).padStart(6, '0');
    if (!(await db.query(`SELECT 1 FROM ${t.table} WHERE lower(${t.no})=lower($1)`, [no])).rowCount)
      return no;
  }
}

// docs: [{ id?, line?, value, errors }] from validateSalesOrder / validatePurchaseOrder.
export async function checkOrders(db, kind, docs, scope) {
  const t = ORDER_TABLES[kind];
  const pending = docs.filter((d) => !d.errors.length);
  const plants = await plantsByCode(
    db,
    pending.map((d) => d.value.plant),
  );
  const parties = new Map(
    (
      await db.query(
        `SELECT id,code,active FROM ${t.party.table} WHERE lower(code)=ANY($1::text[])`,
        [[...new Set(pending.map((d) => lc(d.value[t.party.field])))]],
      )
    ).rows.map((p) => [lc(p.code), p]),
  );
  const items = await itemsByCode(
    db,
    pending.flatMap((d) => d.value.lines.map((l) => l.item)),
  );
  const units = await unitsByCode(
    db,
    pending.flatMap((d) => d.value.lines.map((l) => l.unit)),
  );
  const factor =
    kind === 'purchase_orders'
      ? await conversionFactors(
          db,
          [...items.values()].map((i) => i.id),
        )
      : null;
  const existing = new Map(
    (
      await db.query(
        `SELECT o.id,o.${t.no} AS no,o.site_id,s.code AS plant,o.status,o.version FROM ${t.table} o JOIN sites s ON s.id=o.site_id WHERE lower(o.${t.no})=ANY($1::text[])`,
        [
          pending
            .map((d) => d.value[t.no])
            .filter(Boolean)
            .map(lc),
        ],
      )
    ).rows.map((o) => [lc(o.no), o]),
  );
  for (const doc of pending) {
    const v = doc.value,
      e = doc.errors;
    const plant = resolvePlant(plants, v.plant, scope, e);
    if (plant) {
      v.plant = plant.code;
      v.site_id = plant.id;
    }
    const party = parties.get(lc(v[t.party.field]));
    if (!party) e.push(err(t.party.field, `${t.party.noun} ${v[t.party.field]} was not found.`));
    else if (!party.active)
      e.push(err(t.party.field, `${t.party.noun} ${party.code} is inactive.`));
    else {
      v[t.party.field] = party.code;
      v[t.party.column] = party.id;
    }
    const old = v[t.no] ? (existing.get(lc(v[t.no])) ?? null) : null;
    if (doc.id && old?.id !== doc.id)
      e.push(
        err(t.no, `This ${t.noun.toLowerCase()} number does not match the record being edited.`),
      );
    if (old) {
      v[t.no] = old.no;
      if (plant && old.site_id !== plant.id)
        e.push(
          err(
            'plant',
            `${t.noun} ${old.no} belongs to plant ${old.plant}. The plant cannot be changed.`,
          ),
        );
      if (old.status === 'CANCELLED')
        e.push(err(t.no, `${t.noun} ${old.no} is cancelled and cannot be changed.`));
    }
    doc.existing = old;
    for (const line of v.lines) {
      const label = `Line ${line.line_no}: `;
      const item = resolveItem(items, line.item, label, e, 'lines');
      if (!item) continue;
      line.item = item.code;
      line.item_id = item.id;
      if (kind === 'sales_orders') {
        const q = parseQuantity(line.quantity, item.base_decimals, { label: `${label}quantity` });
        if (q.error) e.push(err('lines', `${q.error} (unit ${item.base_unit})`));
        line.unit = item.base_unit;
        continue;
      }
      if (item.make_buy !== 'BUY') {
        e.push(
          err('lines', `${label}item ${item.code} is MAKE. Purchase orders are for BUY items.`),
        );
        continue;
      }
      const r = toBaseUnit({
        quantity: line.quantity,
        unitCode: line.unit,
        item,
        units,
        factor,
        label,
        errors: e,
        column: 'lines',
      });
      if (!r) continue;
      line.unit = r.unit.code;
      line.unit_id = r.unit.id;
      line.unit_factor = r.factor;
      const received = parseQuantity(line.received_quantity, r.unit.decimals, {
        label: `${label}received quantity`,
      });
      if (received.error) e.push(err('lines', `${received.error} (unit ${r.unit.code})`));
    }
  }
  return docs;
}

export async function orderDetail(db, kind, id) {
  const t = ORDER_TABLES[kind];
  const header = (
    await db.query(
      `SELECT o.*,o.${t.no} AS no,s.code AS plant,p.code AS ${t.party.field},p.name AS party_name,
        to_char(o.order_date,'YYYY-MM-DD') AS order_date${kind === 'sales_orders' ? ",to_char(o.promise_date,'YYYY-MM-DD') AS promise_date" : ''}
       FROM ${t.table} o JOIN sites s ON s.id=o.site_id JOIN ${t.party.table} p ON p.id=o.${t.party.column} WHERE o.id=$1`,
      [id],
    )
  ).rows[0];
  if (!header) return null;
  header.lines = (
    await db.query(
      kind === 'sales_orders'
        ? `SELECT l.line_no,i.code AS item,i.name AS item_name,l.item_id,l.quantity,u.code AS unit,to_char(l.promise_date,'YYYY-MM-DD') AS line_promise_date,l.status
           FROM sales_order_lines l JOIN items i ON i.id=l.item_id JOIN units u ON u.id=i.base_unit_id WHERE l.order_id=$1 ORDER BY l.line_no`
        : `SELECT l.line_no,i.code AS item,i.name AS item_name,l.item_id,l.quantity,u.code AS unit,l.unit_id,l.unit_factor,l.received_quantity,
             to_char(l.due_date,'YYYY-MM-DD') AS due_date,l.status,bu.code AS base_unit
           FROM purchase_order_lines l JOIN items i ON i.id=l.item_id JOIN units u ON u.id=l.unit_id JOIN units bu ON bu.id=i.base_unit_id
           WHERE l.po_id=$1 ORDER BY l.line_no`,
      [id],
    )
  ).rows;
  return header;
}

export async function orderAction(db, kind, doc) {
  if (!doc.existing) return 'create';
  const t = ORDER_TABLES[kind];
  const old = await orderDetail(db, kind, doc.existing.id);
  const v = doc.value;
  const headerSame =
    old[t.party.column] === v[t.party.column] &&
    old.order_date === v.order_date &&
    (kind === 'purchase_orders' ||
      (old.promise_date === v.promise_date &&
        old.allow_partial === v.allow_partial &&
        old.customer_ref === v.customer_ref));
  const open = old.lines.filter((l) => l.status === 'OPEN');
  const linesSame =
    open.length === v.lines.length &&
    v.lines.every((n) => {
      const o = open.find((l) => l.line_no === n.line_no);
      if (!o || o.item_id !== n.item_id || dec(o.quantity) !== dec(n.quantity)) return false;
      return kind === 'sales_orders'
        ? o.line_promise_date === n.line_promise_date
        : o.unit_id === n.unit_id &&
            o.due_date === n.due_date &&
            dec(o.received_quantity) === dec(n.received_quantity);
    });
  return headerSame && linesSame ? 'unchanged' : 'update';
}

// Header insert/update; lines are upserted by line number and lines left out are cancelled.
export async function writeOrder(db, kind, tenantId, doc) {
  const t = ORDER_TABLES[kind];
  const v = doc.value;
  let id = doc.existing?.id;
  if (kind === 'sales_orders') {
    const args = [v.customer_id, v.order_date, v.promise_date, v.allow_partial, v.customer_ref];
    if (id)
      await db.query(
        'UPDATE sales_orders SET customer_id=$2,order_date=$3,promise_date=$4,allow_partial=$5,customer_ref=$6,version=version+1,updated_at=now() WHERE id=$1',
        [id, ...args],
      );
    else
      id = (
        await db.query(
          'INSERT INTO sales_orders(id,tenant_id,site_id,order_no,customer_id,order_date,promise_date,allow_partial,customer_ref) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [tenantId, v.site_id, v.order_no, ...args],
        )
      ).rows[0].id;
    await db.query(
      `INSERT INTO sales_order_lines(id,tenant_id,order_id,line_no,item_id,quantity,promise_date)
       SELECT gen_random_uuid(),$1,$2,l.n,l.item,l.qty,l.day FROM unnest($3::int[],$4::uuid[],$5::numeric[],$6::date[]) AS l(n,item,qty,day)
       ON CONFLICT (tenant_id,order_id,line_no) DO UPDATE SET item_id=excluded.item_id,quantity=excluded.quantity,promise_date=excluded.promise_date,status='OPEN'`,
      [
        tenantId,
        id,
        v.lines.map((l) => l.line_no),
        v.lines.map((l) => l.item_id),
        v.lines.map((l) => l.quantity),
        v.lines.map((l) => l.line_promise_date),
      ],
    );
  } else {
    if (id)
      await db.query(
        'UPDATE purchase_orders SET supplier_id=$2,order_date=$3,version=version+1,updated_at=now() WHERE id=$1',
        [id, v.supplier_id, v.order_date],
      );
    else
      id = (
        await db.query(
          'INSERT INTO purchase_orders(id,tenant_id,site_id,po_no,supplier_id,order_date) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id',
          [tenantId, v.site_id, v.po_no, v.supplier_id, v.order_date],
        )
      ).rows[0].id;
    await db.query(
      `INSERT INTO purchase_order_lines(id,tenant_id,po_id,line_no,item_id,unit_id,unit_factor,quantity,received_quantity,due_date)
       SELECT gen_random_uuid(),$1,$2,l.n,l.item,l.unit,l.factor,l.qty,l.received,l.day
       FROM unnest($3::int[],$4::uuid[],$5::uuid[],$6::numeric[],$7::numeric[],$8::numeric[],$9::date[]) AS l(n,item,unit,factor,qty,received,day)
       ON CONFLICT (tenant_id,po_id,line_no) DO UPDATE SET item_id=excluded.item_id,unit_id=excluded.unit_id,unit_factor=excluded.unit_factor,
         quantity=excluded.quantity,received_quantity=excluded.received_quantity,due_date=excluded.due_date,status='OPEN'`,
      [
        tenantId,
        id,
        v.lines.map((l) => l.line_no),
        v.lines.map((l) => l.item_id),
        v.lines.map((l) => l.unit_id),
        v.lines.map((l) => l.unit_factor),
        v.lines.map((l) => l.quantity),
        v.lines.map((l) => l.received_quantity),
        v.lines.map((l) => l.due_date),
      ],
    );
  }
  await db.query(
    `UPDATE ${t.lines} SET status='CANCELLED' WHERE ${t.fk}=$1 AND status='OPEN' AND NOT (line_no=ANY($2::int[]))`,
    [id, v.lines.map((l) => l.line_no)],
  );
  return id;
}

export async function cancelOrder(db, kind, id, reason) {
  const t = ORDER_TABLES[kind];
  await db.query(
    `UPDATE ${t.table} SET status='CANCELLED',cancel_reason=$2,version=version+1,updated_at=now() WHERE id=$1`,
    [id, reason],
  );
  await db.query(`UPDATE ${t.lines} SET status='CANCELLED' WHERE ${t.fk}=$1`, [id]);
}

export async function listOrders(
  db,
  kind,
  siteId,
  { q = '', status = null, cursor = null, limit = 25 },
) {
  const t = ORDER_TABLES[kind];
  const params = [siteId, q, status];
  let where = `o.site_id=$1 AND (starts_with(lower(o.${t.no}),$2) OR starts_with(lower(p.code),$2)) AND ($3::text IS NULL OR o.status=$3)`;
  if (cursor) {
    params.push(...cursor);
    where += ` AND (lower(o.${t.no}),o.id::text) > ($4,$5)`;
  }
  params.push(limit + 1);
  const extra =
    kind === 'sales_orders'
      ? `to_char(o.promise_date,'YYYY-MM-DD') AS promise_date,o.allow_partial,
         (SELECT coalesce(sum(l.quantity),0) FROM sales_order_lines l WHERE l.order_id=o.id AND l.status='OPEN') AS open_quantity`
      : `(SELECT to_char(min(l.due_date),'YYYY-MM-DD') FROM purchase_order_lines l WHERE l.po_id=o.id AND l.status='OPEN' AND l.received_quantity<l.quantity) AS next_due`;
  const rows = (
    await db.query(
      `SELECT o.id,o.${t.no} AS no,p.code AS party,p.name AS party_name,to_char(o.order_date,'YYYY-MM-DD') AS order_date,o.status,o.version,${extra},
        (SELECT count(*) FROM ${t.lines} l WHERE l.${t.fk}=o.id AND l.status='OPEN')::int AS open_lines
       FROM ${t.table} o JOIN ${t.party.table} p ON p.id=o.${t.party.column}
       WHERE ${where} ORDER BY lower(o.${t.no}),o.id::text LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit ? [lc(last.no), String(last.id)] : null };
}

// ---------- Demand history ----------

export async function checkDemandHistory(db, rows, scope, { today }) {
  const pending = rows.filter((r) => !r.errors.length);
  const plants = await plantsByCode(
    db,
    pending.map((r) => r.value.plant),
  );
  const items = await itemsByCode(
    db,
    pending.map((r) => r.value.item),
  );
  for (const row of pending) {
    const v = row.value,
      e = row.errors;
    const plant = resolvePlant(plants, v.plant, scope, e);
    if (plant) {
      v.plant = plant.code;
      v.site_id = plant.id;
    }
    const item = resolveItem(items, v.item, '', e);
    if (item) {
      v.item = item.code;
      v.item_id = item.id;
      const q = parseQuantity(v.quantity, item.base_decimals, { label: 'Quantity' });
      if (q.error) e.push(err('quantity', `${q.error} (unit ${item.base_unit})`));
    }
    if (v.demand_date > today)
      e.push(
        err(
          'demand_date',
          'Demand history cannot be in the future. Use customer orders for future demand.',
        ),
      );
  }
  const ok = pending.filter((r) => !r.errors.length);
  const existing = new Map();
  for (let i = 0; i < ok.length; i += CHUNK) {
    const part = ok.slice(i, i + CHUNK);
    for (const d of (
      await db.query(
        `SELECT h.site_id,h.item_id,to_char(h.demand_date,'YYYY-MM-DD') AS demand_date,h.quantity FROM demand_history h
         JOIN unnest($1::uuid[],$2::uuid[],$3::date[]) AS k(site_id,item_id,demand_date)
           ON k.site_id=h.site_id AND k.item_id=h.item_id AND k.demand_date=h.demand_date`,
        [
          part.map((r) => r.value.site_id),
          part.map((r) => r.value.item_id),
          part.map((r) => r.value.demand_date),
        ],
      )
    ).rows)
      existing.set(`${d.site_id}|${d.item_id}|${d.demand_date}`, dec(d.quantity));
  }
  for (const row of ok) {
    const v = row.value;
    const old = existing.get(`${v.site_id}|${v.item_id}|${v.demand_date}`);
    row.action = old === undefined ? 'create' : old === dec(v.quantity) ? 'unchanged' : 'update';
  }
  return rows;
}

export async function writeDemandHistory(db, tenantId, values) {
  let created = 0,
    updated = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK);
    for (const r of (
      await db.query(
        `INSERT INTO demand_history(tenant_id,site_id,item_id,demand_date,quantity)
         SELECT $1,d.site,d.item,d.day,d.qty FROM unnest($2::uuid[],$3::uuid[],$4::date[],$5::numeric[]) AS d(site,item,day,qty)
         ON CONFLICT (tenant_id,site_id,item_id,demand_date) DO UPDATE SET quantity=excluded.quantity,updated_at=now()
         WHERE demand_history.quantity IS DISTINCT FROM excluded.quantity
         RETURNING (xmax=0) AS inserted`,
        [
          tenantId,
          part.map((v) => v.site_id),
          part.map((v) => v.item_id),
          part.map((v) => v.demand_date),
          part.map((v) => v.quantity),
        ],
      )
    ).rows)
      r.inserted ? created++ : updated++;
  }
  return { created, updated, unchanged: values.length - created - updated };
}

export async function listDemandHistory(db, siteId, { q = '', cursor = null, limit = 25 }) {
  const params = [siteId, q];
  let where = 'h.site_id=$1 AND starts_with(lower(i.code),$2)';
  if (cursor) {
    params.push(...cursor);
    where += ' AND (h.demand_date < $3::date OR (h.demand_date = $3::date AND lower(i.code) > $4))';
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT to_char(h.demand_date,'YYYY-MM-DD') AS demand_date,i.code AS item,i.name AS item_name,h.quantity,u.code AS unit
       FROM demand_history h JOIN items i ON i.id=h.item_id JOIN units u ON u.id=i.base_unit_id
       WHERE ${where} ORDER BY h.demand_date DESC,lower(i.code) LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit ? [last.demand_date, lc(last.item)] : null };
}

// ---------- Readiness ----------

export async function demandStockReadiness(db, siteId, today) {
  const c = (
    await db.query(
      `SELECT (SELECT count(*) FROM stock_locations WHERE site_id=$1 AND active)::int AS locations,
        (SELECT count(DISTINCT item_id) FROM stock_movements WHERE site_id=$1)::int AS stocked_items,
        (SELECT count(*) FROM sales_orders WHERE site_id=$1 AND status='OPEN')::int AS open_orders,
        (SELECT count(*) FROM purchase_orders WHERE site_id=$1 AND status='OPEN')::int AS open_pos,
        (SELECT count(DISTINCT item_id) FROM demand_history WHERE site_id=$1 AND demand_date > $2::date - 90)::int AS demand_items`,
      [siteId, today],
    )
  ).rows[0];
  return [
    {
      key: 'stock_locations',
      title: 'Stock locations',
      status: c.locations ? 'ready' : 'missing',
      detail: c.locations
        ? `${c.locations} active stock location(s).`
        : 'Create stores, production and finished-goods locations for this plant.',
    },
    {
      key: 'stock',
      title: 'Opening stock',
      status: c.stocked_items ? 'ready' : 'missing',
      detail: c.stocked_items
        ? `Stock recorded for ${c.stocked_items} item(s).`
        : 'Post opening stock or import it before planning materials.',
    },
    {
      key: 'demand',
      title: 'Demand',
      status: c.open_orders || c.demand_items ? 'ready' : 'missing',
      detail:
        c.open_orders || c.demand_items
          ? `${c.open_orders} open customer order(s); demand history for ${c.demand_items} item(s) in the last 90 days.`
          : 'Enter or import customer orders, and import recent demand history.',
    },
    {
      key: 'supply',
      title: 'Open purchase orders',
      status: 'info',
      detail: c.open_pos
        ? `${c.open_pos} open purchase order(s) count as incoming supply.`
        : 'No open purchase orders. Import them if suppliers already have orders from you.',
    },
  ];
}
