// Database side of the plant model, shared by the API (forms) and the worker (imports).
// Every function receives a pg client inside a company-scoped (RLS) transaction.
import {
  calendarDayMinutes,
  findCycle,
  rangesOverlap,
  resourceDailyCapacity,
} from '../engines/plant-model.mjs';
import { parseQuantity } from './quantity.mjs';

const lc = (v) => String(v ?? '').toLowerCase();
const dec = (v) =>
  v === null || v === undefined ? null : parseQuantity(String(v), 6, { allowNegative: true }).value;
const err = (column, message) => ({ column, message });

// Plants the actor may use: null means every plant (system role, all-plants permission, platform access).
export async function plantScope(db, actorId) {
  if (!actorId) return null;
  const r = (
    await db.query(
      `SELECT r.is_system, EXISTS(SELECT 1 FROM role_permissions p WHERE p.role_id=r.id AND p.permission_code='sites.read_all') AS all_plants
       FROM app_users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 AND u.active`,
      [actorId],
    )
  ).rows[0];
  if (!r) return new Set();
  if (r.is_system || r.all_plants) return null;
  return new Set(
    (await db.query('SELECT site_id FROM user_sites WHERE user_id=$1', [actorId])).rows.map(
      (x) => x.site_id,
    ),
  );
}

export async function plantsByCode(db, codes) {
  const rows = (
    await db.query('SELECT id,code,name,active FROM sites WHERE lower(code)=ANY($1::text[])', [
      [...new Set(codes.map(lc))],
    ])
  ).rows;
  return new Map(rows.map((r) => [lc(r.code), r]));
}

export function resolvePlant(map, code, scope, errors) {
  const plant = map.get(lc(code));
  if (!plant) errors.push(err('plant', `Plant ${code} was not found.`));
  else if (!plant.active) errors.push(err('plant', `Plant ${plant.code} is inactive.`));
  else if (scope && !scope.has(plant.id))
    errors.push(err('plant', `You do not have access to plant ${plant.code}.`));
  else return plant;
  return null;
}

export async function itemsByCode(db, codes) {
  const rows = (
    await db.query(
      'SELECT i.id,i.code,i.active,i.make_buy,i.item_type,i.base_unit_id,u.code AS base_unit,u.decimals AS base_decimals FROM items i JOIN units u ON u.id=i.base_unit_id WHERE lower(i.code)=ANY($1::text[])',
      [[...new Set(codes.map(lc))]],
    )
  ).rows;
  return new Map(rows.map((r) => [lc(r.code), r]));
}

// ---------- Calendars ----------

export async function calendarDetail(db, id) {
  const cal = (
    await db.query(
      'SELECT c.*,s.code AS plant FROM calendars c JOIN sites s ON s.id=c.site_id WHERE c.id=$1',
      [id],
    )
  ).rows[0];
  if (!cal) return null;
  cal.shifts = (
    await db.query(
      "SELECT name,to_char(start_time,'HH24:MI') AS start_time,to_char(end_time,'HH24:MI') AS end_time,break_minutes FROM calendar_shifts WHERE calendar_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows;
  cal.holidays = (
    await db.query(
      "SELECT to_char(holiday_date,'YYYY-MM-DD') AS holiday_date,name FROM calendar_holidays WHERE calendar_id=$1 ORDER BY holiday_date",
      [id],
    )
  ).rows;
  cal.day_minutes = calendarDayMinutes(cal.shifts);
  return cal;
}

export async function listCalendars(db, siteId) {
  const rows = (
    await db.query(
      `SELECT c.id,c.code,c.name,c.working_days,c.is_default,c.active,c.version,
        coalesce(json_agg(json_build_object('start_time',to_char(s.start_time,'HH24:MI'),'end_time',to_char(s.end_time,'HH24:MI'),'break_minutes',s.break_minutes)) FILTER (WHERE s.id IS NOT NULL),'[]') AS shifts,
        (SELECT count(*) FROM calendar_holidays h WHERE h.calendar_id=c.id)::int AS holidays
       FROM calendars c LEFT JOIN calendar_shifts s ON s.calendar_id=c.id WHERE c.site_id=$1 GROUP BY c.id ORDER BY lower(c.code) LIMIT 200`,
      [siteId],
    )
  ).rows;
  return rows.map(({ shifts, ...c }) => ({
    ...c,
    shift_count: shifts.length,
    day_minutes: calendarDayMinutes(shifts),
  }));
}

export async function saveCalendar(db, tenantId, siteId, value, existing) {
  const clash = (
    await db.query(
      'SELECT id FROM calendars WHERE site_id=$1 AND lower(code)=lower($2) AND id<>coalesce($3::uuid,$4::uuid)',
      [siteId, value.code, existing?.id ?? null, '00000000-0000-0000-0000-000000000000'],
    )
  ).rows[0];
  if (clash)
    return { errors: [err('code', `Calendar ${value.code} already exists in this plant.`)] };
  const active = existing ? value.active !== false : true;
  if (existing && existing.is_default && (!value.is_default || !active))
    return {
      errors: [
        err(
          'is_default',
          'A plant needs a default calendar. Mark another calendar as default first.',
        ),
      ],
    };
  if (value.is_default && active)
    await db.query(
      'UPDATE calendars SET is_default=false,version=version+1,updated_at=now() WHERE site_id=$1 AND is_default AND id<>coalesce($2::uuid,$3::uuid)',
      [siteId, existing?.id ?? null, '00000000-0000-0000-0000-000000000000'],
    );
  let id = existing?.id;
  if (existing)
    await db.query(
      'UPDATE calendars SET name=$2,working_days=$3,is_default=$4,active=$5,version=version+1,updated_at=now() WHERE id=$1',
      [id, value.name, value.working_days, value.is_default, active],
    );
  else {
    id = (
      await db.query(
        'INSERT INTO calendars(id,tenant_id,site_id,code,name,working_days,is_default) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) RETURNING id',
        [tenantId, siteId, value.code, value.name, value.working_days, value.is_default],
      )
    ).rows[0].id;
  }
  await db.query('DELETE FROM calendar_shifts WHERE calendar_id=$1', [id]);
  await db.query('DELETE FROM calendar_holidays WHERE calendar_id=$1', [id]);
  for (const [i, s] of value.shifts.entries())
    await db.query(
      'INSERT INTO calendar_shifts(id,tenant_id,calendar_id,sequence,name,start_time,end_time,break_minutes) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)',
      [tenantId, id, i + 1, s.name, s.start_time, s.end_time, s.break_minutes],
    );
  for (const h of value.holidays)
    await db.query(
      'INSERT INTO calendar_holidays(id,tenant_id,calendar_id,holiday_date,name) VALUES(gen_random_uuid(),$1,$2,$3,$4)',
      [tenantId, id, h.holiday_date, h.name],
    );
  return { id, errors: [] };
}

// ---------- Resources ----------

export async function listResources(db, siteId) {
  const resources = (
    await db.query(
      'SELECT r.id,r.code,r.name,r.resource_type,r.machine_count,r.efficiency_pct,r.changeover_minutes,r.planned_utilization_pct,r.calendar_id,c.code AS calendar,r.active,r.version FROM resources r LEFT JOIN calendars c ON c.id=r.calendar_id WHERE r.site_id=$1 ORDER BY lower(r.code) LIMIT 500',
      [siteId],
    )
  ).rows;
  const calendars = new Map((await listCalendars(db, siteId)).map((c) => [c.id, c]));
  const fallback = [...calendars.values()].find((c) => c.is_default && c.active);
  return resources.map((r) => {
    const cal = r.calendar_id ? calendars.get(r.calendar_id) : fallback;
    return {
      ...r,
      calendar_used: cal?.code ?? null,
      capacity_minutes_per_day: cal ? resourceDailyCapacity(r, cal.day_minutes) : null,
    };
  });
}

// Checks resource rows (form or import) and resolves plant/calendar ids.
export async function checkResources(db, rows, scope) {
  const plants = await plantsByCode(
    db,
    rows.map((r) => r.value.plant),
  );
  const keys = rows
    .map((r) => [plants.get(lc(r.value.plant))?.id, lc(r.value.calendar)])
    .filter(([s, c]) => s && c);
  const calendars = new Map();
  for (const [siteId, code] of keys)
    if (!calendars.has(siteId + '|' + code)) {
      const c = (
        await db.query('SELECT id,code,active FROM calendars WHERE site_id=$1 AND lower(code)=$2', [
          siteId,
          code,
        ])
      ).rows[0];
      calendars.set(siteId + '|' + code, c ?? null);
    }
  const existing = new Map();
  for (const row of rows) {
    const plant = resolvePlant(plants, row.value.plant, scope, row.errors);
    if (!plant) continue;
    row.value.plant = plant.code;
    row.value.site_id = plant.id;
    row.value.calendar_id = null;
    if (row.value.calendar) {
      const c = calendars.get(plant.id + '|' + lc(row.value.calendar));
      if (!c)
        row.errors.push(
          err('calendar', `Calendar ${row.value.calendar} was not found in plant ${plant.code}.`),
        );
      else if (!c.active) row.errors.push(err('calendar', `Calendar ${c.code} is inactive.`));
      else row.value.calendar_id = c.id;
    }
    const key = plant.id + '|' + lc(row.value.code);
    if (!existing.has(key))
      existing.set(
        key,
        (
          await db.query('SELECT * FROM resources WHERE site_id=$1 AND lower(code)=$2', [
            plant.id,
            lc(row.value.code),
          ])
        ).rows[0] ?? null,
      );
    row.existing = existing.get(key);
  }
  return rows;
}

export function resourceAction(value, old) {
  if (!old) return 'create';
  const same =
    old.name === value.name &&
    old.resource_type === value.resource_type &&
    old.machine_count === value.machine_count &&
    dec(old.efficiency_pct) === dec(value.efficiency_pct) &&
    dec(old.changeover_minutes) === dec(value.changeover_minutes) &&
    dec(old.planned_utilization_pct) === dec(value.planned_utilization_pct) &&
    (old.calendar_id ?? null) === (value.calendar_id ?? null);
  return same ? 'unchanged' : 'update';
}

export async function writeResource(db, tenantId, value, old, active = true) {
  if (old) {
    await db.query(
      'UPDATE resources SET name=$2,resource_type=$3,machine_count=$4,efficiency_pct=$5,changeover_minutes=$6,calendar_id=$7,active=$8,planned_utilization_pct=$9,version=version+1,updated_at=now() WHERE id=$1',
      [
        old.id,
        value.name,
        value.resource_type,
        value.machine_count,
        value.efficiency_pct,
        value.changeover_minutes,
        value.calendar_id,
        active,
        value.planned_utilization_pct ?? null,
      ],
    );
    return old.id;
  }
  return (
    await db.query(
      'INSERT INTO resources(id,tenant_id,site_id,code,name,resource_type,machine_count,efficiency_pct,changeover_minutes,calendar_id,planned_utilization_pct) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [
        tenantId,
        value.site_id,
        value.code,
        value.name,
        value.resource_type,
        value.machine_count,
        value.efficiency_pct,
        value.changeover_minutes,
        value.calendar_id,
        value.planned_utilization_pct ?? null,
      ],
    )
  ).rows[0].id;
}

// ---------- BOMs ----------

async function unitsAndConversions(db, docs, items) {
  const unitCodes = docs.flatMap((d) => d.value.lines.map((l) => l.unit).filter(Boolean));
  const units = new Map(
    (
      await db.query(
        'SELECT id,code,active,decimals FROM units WHERE lower(code)=ANY($1::text[])',
        [[...new Set(unitCodes.map(lc))]],
      )
    ).rows.map((u) => [lc(u.code), u]),
  );
  const itemIds = [...items.values()].map((i) => i.id);
  const conversions = new Set(
    (
      await db.query(
        'SELECT from_unit_id,to_unit_id,item_id FROM unit_conversions WHERE active AND (item_id IS NULL OR item_id=ANY($1::uuid[]))',
        [itemIds],
      )
    ).rows.flatMap((c) => [
      `${c.from_unit_id}|${c.to_unit_id}|${c.item_id ?? ''}`,
      `${c.to_unit_id}|${c.from_unit_id}|${c.item_id ?? ''}`,
    ]),
  );
  return { units, conversions };
}

// docs: [{ value, errors, id? }] where value is a validated BOM (header + lines).
// Resolves ids, then checks overlaps and cycles across the database AND the other documents.
export async function checkBoms(db, docs) {
  const items = await itemsByCode(
    db,
    docs.flatMap((d) => [d.value.parent_item, ...d.value.lines.map((l) => l.component_item)]),
  );
  const { units, conversions } = await unitsAndConversions(db, docs, items);
  for (const doc of docs) {
    const v = doc.value;
    const parent = items.get(lc(v.parent_item));
    if (!parent) doc.errors.push(err('parent_item', `Item ${v.parent_item} was not found.`));
    else if (!parent.active)
      doc.errors.push(err('parent_item', `Item ${parent.code} is inactive.`));
    else if (parent.make_buy !== 'MAKE')
      doc.errors.push(
        err('parent_item', `Item ${parent.code} is BUY. Only MAKE items have a BOM.`),
      );
    else {
      v.parent_item = parent.code;
      v.item_id = parent.id;
    }
    for (const [i, line] of v.lines.entries()) {
      const label = `Line ${i + 1}`;
      const comp = items.get(lc(line.component_item));
      if (!comp) {
        doc.errors.push(err('lines', `${label}: item ${line.component_item} was not found.`));
        continue;
      }
      if (!comp.active) {
        doc.errors.push(err('lines', `${label}: item ${comp.code} is inactive.`));
        continue;
      }
      line.component_item = comp.code;
      line.component_item_id = comp.id;
      let unit = {
        id: comp.base_unit_id,
        code: comp.base_unit,
        decimals: comp.base_decimals,
        active: true,
      };
      if (line.unit) {
        const u = units.get(lc(line.unit));
        if (!u) {
          doc.errors.push(err('lines', `${label}: unit ${line.unit} was not found.`));
          continue;
        }
        if (!u.active) {
          doc.errors.push(err('lines', `${label}: unit ${u.code} is inactive.`));
          continue;
        }
        unit = u;
        if (
          u.id !== comp.base_unit_id &&
          !conversions.has(`${u.id}|${comp.base_unit_id}|${comp.id}`) &&
          !conversions.has(`${u.id}|${comp.base_unit_id}|`)
        )
          doc.errors.push(
            err(
              'lines',
              `${label}: no conversion between ${u.code} and ${comp.base_unit} for item ${comp.code}. Add a unit conversion first.`,
            ),
          );
      }
      line.unit = unit.code;
      line.unit_id = unit.id;
      const q = parseQuantity(line.quantity, unit.decimals, { label: `${label}: quantity` });
      if (q.error)
        doc.errors.push(
          err('lines', `${q.error} (unit ${unit.code}; use base quantity for fractions)`),
        );
    }
  }
  const valid = docs.filter((d) => !d.errors.length);
  if (!valid.length) return docs;
  // Existing versions of the same items for overlap checks and update/unchanged decisions.
  const itemIds = [...new Set(valid.map((d) => d.value.item_id))];
  const existing = (
    await db.query(
      "SELECT id,item_id,revision,to_char(effective_from,'YYYY-MM-DD') AS effective_from,to_char(effective_to,'YYYY-MM-DD') AS effective_to,base_quantity,active,version FROM boms WHERE item_id=ANY($1::uuid[])",
      [itemIds],
    )
  ).rows;
  for (const doc of valid) {
    const v = doc.value;
    doc.existing =
      existing.find((b) => b.item_id === v.item_id && lc(b.revision) === lc(v.revision)) ?? null;
    if (doc.id && doc.existing?.id !== doc.id)
      doc.errors.push(err('revision', 'This BOM revision does not match the record being edited.'));
    const others = [
      ...existing.filter((b) => b.item_id === v.item_id && lc(b.revision) !== lc(v.revision)),
      ...valid
        .filter(
          (o) =>
            o !== doc && o.value.item_id === v.item_id && lc(o.value.revision) !== lc(v.revision),
        )
        .map((o) => ({ ...o.value, active: true })),
    ];
    const clash =
      v.active === false ? null : others.find((o) => o.active !== false && rangesOverlap(v, o));
    if (clash)
      doc.errors.push(
        err(
          'effective_from',
          `Effective dates overlap with BOM ${v.parent_item} ${clash.revision}. End the old revision first.`,
        ),
      );
  }
  // Cycle check on the component graph of every active BOM, with this batch replacing its revisions.
  const replaced = new Set(valid.map((d) => d.existing?.id).filter(Boolean));
  const edges = new Map();
  const add = (parent, child) => {
    if (!edges.has(parent)) edges.set(parent, new Set());
    edges.get(parent).add(child);
  };
  for (const e of (
    await db.query(
      'SELECT b.id AS bom_id,b.item_id,l.component_item_id FROM bom_lines l JOIN boms b ON b.id=l.bom_id WHERE b.active',
    )
  ).rows)
    if (!replaced.has(e.bom_id)) add(e.item_id, e.component_item_id);
  for (const doc of valid)
    if (doc.value.active !== false)
      for (const l of doc.value.lines) add(doc.value.item_id, l.component_item_id);
  const cycle = findCycle(edges);
  if (cycle) {
    const names = new Map([...items.values()].map((i) => [i.id, i.code]));
    for (const id of cycle.filter((x) => !names.has(x)))
      names.set(
        id,
        (await db.query('SELECT code FROM items WHERE id=$1', [id])).rows[0]?.code ?? id,
      );
    const path = cycle.map((id) => names.get(id)).join(' → ');
    for (const doc of valid)
      if (cycle.includes(doc.value.item_id))
        doc.errors.push(
          err(
            'lines',
            `This creates a BOM loop: ${path}. An item cannot contain itself through its components.`,
          ),
        );
  }
  return docs;
}

export async function bomDetail(db, id) {
  const bom = (
    await db.query(
      "SELECT b.id,i.code AS parent_item,b.item_id,b.revision,to_char(b.effective_from,'YYYY-MM-DD') AS effective_from,to_char(b.effective_to,'YYYY-MM-DD') AS effective_to,b.base_quantity,b.active,b.version FROM boms b JOIN items i ON i.id=b.item_id WHERE b.id=$1",
      [id],
    )
  ).rows[0];
  if (!bom) return null;
  bom.lines = (
    await db.query(
      'SELECT i.code AS component_item,l.component_item_id,l.quantity,u.code AS unit,l.unit_id,l.scrap_pct FROM bom_lines l JOIN items i ON i.id=l.component_item_id JOIN units u ON u.id=l.unit_id WHERE l.bom_id=$1 ORDER BY l.line_no',
      [id],
    )
  ).rows;
  return bom;
}

export async function bomAction(db, doc) {
  if (!doc.existing) return 'create';
  const old = await bomDetail(db, doc.existing.id);
  const v = doc.value;
  const same =
    old.effective_from === v.effective_from &&
    (old.effective_to ?? null) === (v.effective_to ?? null) &&
    dec(old.base_quantity) === dec(v.base_quantity) &&
    old.active === (v.active !== false) &&
    old.lines.length === v.lines.length &&
    old.lines.every(
      (l, i) =>
        l.component_item_id === v.lines[i].component_item_id &&
        l.unit_id === v.lines[i].unit_id &&
        dec(l.quantity) === dec(v.lines[i].quantity) &&
        dec(l.scrap_pct) === dec(v.lines[i].scrap_pct),
    );
  return same ? 'unchanged' : 'update';
}

export async function writeBom(db, tenantId, doc) {
  const v = doc.value;
  let id = doc.existing?.id;
  if (id)
    await db.query(
      'UPDATE boms SET effective_from=$2,effective_to=$3,base_quantity=$4,active=$5,version=version+1,updated_at=now() WHERE id=$1',
      [id, v.effective_from, v.effective_to, v.base_quantity, v.active !== false],
    );
  else
    id = (
      await db.query(
        'INSERT INTO boms(id,tenant_id,item_id,revision,effective_from,effective_to,base_quantity) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) RETURNING id',
        [tenantId, v.item_id, v.revision, v.effective_from, v.effective_to, v.base_quantity],
      )
    ).rows[0].id;
  await db.query('DELETE FROM bom_lines WHERE bom_id=$1', [id]);
  await db.query(
    'INSERT INTO bom_lines(id,tenant_id,bom_id,line_no,component_item_id,quantity,unit_id,scrap_pct) SELECT gen_random_uuid(),$1,$2,l.n,l.item,l.qty,l.unit,l.scrap FROM unnest($3::int[],$4::uuid[],$5::numeric[],$6::uuid[],$7::numeric[]) AS l(n,item,qty,unit,scrap)',
    [
      tenantId,
      id,
      v.lines.map((_, i) => i + 1),
      v.lines.map((l) => l.component_item_id),
      v.lines.map((l) => l.quantity),
      v.lines.map((l) => l.unit_id),
      v.lines.map((l) => l.scrap_pct),
    ],
  );
  return id;
}

export async function listBoms(db, { q = '', cursor = null, limit = 25 }) {
  const params = [q];
  let where = '(starts_with(lower(i.code),$1) OR starts_with(lower(i.name),$1))';
  if (cursor) {
    params.push(...cursor);
    where += ' AND (lower(i.code),lower(b.revision),b.id::text) > ($2,$3,$4)';
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT b.id,i.code AS parent_item,i.name AS item_name,b.revision,to_char(b.effective_from,'YYYY-MM-DD') AS effective_from,to_char(b.effective_to,'YYYY-MM-DD') AS effective_to,b.base_quantity,b.active,b.version,(SELECT count(*) FROM bom_lines l WHERE l.bom_id=b.id)::int AS line_count
       FROM boms b JOIN items i ON i.id=b.item_id WHERE ${where} ORDER BY lower(i.code),lower(b.revision),b.id::text LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit ? [lc(last.parent_item), lc(last.revision), String(last.id)] : null,
  };
}

// ---------- Routings ----------

export async function checkRoutings(db, docs, scope) {
  const plants = await plantsByCode(
    db,
    docs.map((d) => d.value.plant),
  );
  const items = await itemsByCode(
    db,
    docs.map((d) => d.value.item),
  );
  for (const doc of docs) {
    const v = doc.value;
    const plant = resolvePlant(plants, v.plant, scope, doc.errors);
    const item = items.get(lc(v.item));
    if (!item) doc.errors.push(err('item', `Item ${v.item} was not found.`));
    else if (!item.active) doc.errors.push(err('item', `Item ${item.code} is inactive.`));
    else if (item.make_buy !== 'MAKE')
      doc.errors.push(err('item', `Item ${item.code} is BUY. Only MAKE items have a routing.`));
    else {
      v.item = item.code;
      v.item_id = item.id;
    }
    if (!plant) continue;
    v.plant = plant.code;
    v.site_id = plant.id;
    const resources = new Map(
      (
        await db.query(
          'SELECT id,code,active FROM resources WHERE site_id=$1 AND lower(code)=ANY($2::text[])',
          [plant.id, [...new Set(v.operations.map((o) => lc(o.resource)))]],
        )
      ).rows.map((r) => [lc(r.code), r]),
    );
    for (const op of v.operations) {
      const r = resources.get(lc(op.resource));
      if (!r)
        doc.errors.push(
          err(
            'operations',
            `Operation ${op.operation_code}: resource ${op.resource} was not found in plant ${plant.code}.`,
          ),
        );
      else if (!r.active)
        doc.errors.push(
          err('operations', `Operation ${op.operation_code}: resource ${r.code} is inactive.`),
        );
      else {
        op.resource = r.code;
        op.resource_id = r.id;
      }
    }
  }
  const valid = docs.filter((d) => !d.errors.length);
  if (!valid.length) return docs;
  const existing = (
    await db.query(
      "SELECT id,site_id,item_id,revision,to_char(effective_from,'YYYY-MM-DD') AS effective_from,to_char(effective_to,'YYYY-MM-DD') AS effective_to,active,version FROM routings WHERE item_id=ANY($1::uuid[])",
      [[...new Set(valid.map((d) => d.value.item_id))]],
    )
  ).rows;
  for (const doc of valid) {
    const v = doc.value;
    const same = (x) => x.site_id === v.site_id && x.item_id === v.item_id;
    doc.existing = existing.find((r) => same(r) && lc(r.revision) === lc(v.revision)) ?? null;
    if (doc.id && doc.existing?.id !== doc.id)
      doc.errors.push(
        err('revision', 'This routing revision does not match the record being edited.'),
      );
    const others = [
      ...existing.filter((r) => same(r) && lc(r.revision) !== lc(v.revision)),
      ...valid
        .filter((o) => o !== doc && same(o.value) && lc(o.value.revision) !== lc(v.revision))
        .map((o) => ({ ...o.value, active: true })),
    ];
    const clash =
      v.active === false ? null : others.find((o) => o.active !== false && rangesOverlap(v, o));
    if (clash)
      doc.errors.push(
        err(
          'effective_from',
          `Effective dates overlap with routing ${v.item} ${clash.revision} in plant ${v.plant}. End the old revision first.`,
        ),
      );
  }
  return docs;
}

export async function routingDetail(db, id) {
  const routing = (
    await db.query(
      "SELECT r.id,s.code AS plant,r.site_id,i.code AS item,r.item_id,r.revision,to_char(r.effective_from,'YYYY-MM-DD') AS effective_from,to_char(r.effective_to,'YYYY-MM-DD') AS effective_to,r.active,r.version FROM routings r JOIN sites s ON s.id=r.site_id JOIN items i ON i.id=r.item_id WHERE r.id=$1",
      [id],
    )
  ).rows[0];
  if (!routing) return null;
  routing.operations = (
    await db.query(
      'SELECT o.sequence,o.operation_code,o.description,res.code AS resource,o.resource_id,o.setup_minutes,o.run_minutes_per_unit FROM routing_operations o JOIN resources res ON res.id=o.resource_id WHERE o.routing_id=$1 ORDER BY o.sequence',
      [id],
    )
  ).rows;
  return routing;
}

export async function routingAction(db, doc) {
  if (!doc.existing) return 'create';
  const old = await routingDetail(db, doc.existing.id);
  const v = doc.value;
  const same =
    old.effective_from === v.effective_from &&
    (old.effective_to ?? null) === (v.effective_to ?? null) &&
    old.active === (v.active !== false) &&
    old.operations.length === v.operations.length &&
    old.operations.every(
      (o, i) =>
        o.sequence === v.operations[i].sequence &&
        lc(o.operation_code) === lc(v.operations[i].operation_code) &&
        o.description === (v.operations[i].description ?? '') &&
        o.resource_id === v.operations[i].resource_id &&
        dec(o.setup_minutes) === dec(v.operations[i].setup_minutes) &&
        dec(o.run_minutes_per_unit) === dec(v.operations[i].run_minutes_per_unit),
    );
  return same ? 'unchanged' : 'update';
}

export async function writeRouting(db, tenantId, doc) {
  const v = doc.value;
  let id = doc.existing?.id;
  if (id)
    await db.query(
      'UPDATE routings SET effective_from=$2,effective_to=$3,active=$4,version=version+1,updated_at=now() WHERE id=$1',
      [id, v.effective_from, v.effective_to, v.active !== false],
    );
  else
    id = (
      await db.query(
        'INSERT INTO routings(id,tenant_id,site_id,item_id,revision,effective_from,effective_to) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) RETURNING id',
        [tenantId, v.site_id, v.item_id, v.revision, v.effective_from, v.effective_to],
      )
    ).rows[0].id;
  await db.query('DELETE FROM routing_operations WHERE routing_id=$1', [id]);
  await db.query(
    'INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,description,resource_id,setup_minutes,run_minutes_per_unit) SELECT gen_random_uuid(),$1,$2,o.seq,o.code,o.descr,o.res,o.setup,o.run FROM unnest($3::int[],$4::text[],$5::text[],$6::uuid[],$7::numeric[],$8::numeric[]) AS o(seq,code,descr,res,setup,run)',
    [
      tenantId,
      id,
      v.operations.map((o) => o.sequence),
      v.operations.map((o) => o.operation_code),
      v.operations.map((o) => o.description ?? ''),
      v.operations.map((o) => o.resource_id),
      v.operations.map((o) => o.setup_minutes),
      v.operations.map((o) => o.run_minutes_per_unit),
    ],
  );
  return id;
}

export async function listRoutings(db, siteId, { q = '', cursor = null, limit = 25 }) {
  const params = [siteId, q];
  let where = 'r.site_id=$1 AND (starts_with(lower(i.code),$2) OR starts_with(lower(i.name),$2))';
  if (cursor) {
    params.push(...cursor);
    where += ' AND (lower(i.code),lower(r.revision),r.id::text) > ($3,$4,$5)';
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT r.id,i.code AS item,i.name AS item_name,r.revision,to_char(r.effective_from,'YYYY-MM-DD') AS effective_from,to_char(r.effective_to,'YYYY-MM-DD') AS effective_to,r.active,r.version,
        (SELECT count(*) FROM routing_operations o WHERE o.routing_id=r.id)::int AS operation_count,
        (SELECT coalesce(sum(o.run_minutes_per_unit),0) FROM routing_operations o WHERE o.routing_id=r.id) AS run_minutes_per_unit
       FROM routings r JOIN items i ON i.id=r.item_id WHERE ${where} ORDER BY lower(i.code),lower(r.revision),r.id::text LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit ? [lc(last.item), lc(last.revision), String(last.id)] : null,
  };
}

// ---------- Readiness for one plant ----------

export async function plantReadiness(db, siteId, today) {
  const cal = (await listCalendars(db, siteId)).find((c) => c.is_default && c.active);
  const resources = Number(
    (await db.query('SELECT count(*) FROM resources WHERE site_id=$1 AND active', [siteId])).rows[0]
      .count,
  );
  const noBom = (
    await db.query(
      `SELECT i.code FROM items i WHERE i.active AND i.make_buy='MAKE' AND NOT EXISTS (
         SELECT 1 FROM boms b WHERE b.item_id=i.id AND b.active AND b.effective_from<=$1 AND (b.effective_to IS NULL OR b.effective_to>=$1))
       ORDER BY lower(i.code) LIMIT 6`,
      [today],
    )
  ).rows.map((r) => r.code);
  const noRouting = (
    await db.query(
      `SELECT i.code FROM items i WHERE i.active AND i.make_buy='MAKE' AND NOT EXISTS (
         SELECT 1 FROM routings r WHERE r.item_id=i.id AND r.site_id=$2 AND r.active AND r.effective_from<=$1 AND (r.effective_to IS NULL OR r.effective_to>=$1))
       ORDER BY lower(i.code) LIMIT 6`,
      [today, siteId],
    )
  ).rows.map((r) => r.code);
  const list = (codes) =>
    codes.length > 5 ? codes.slice(0, 5).join(', ') + ' and more' : codes.join(', ');
  return [
    {
      key: 'calendar',
      title: 'Plant calendar',
      status: cal ? 'ready' : 'missing',
      detail: cal
        ? `Default calendar ${cal.code}: ${cal.day_minutes} working minutes per day.`
        : 'Create a calendar with shifts and mark it as the plant default.',
    },
    {
      key: 'resources',
      title: 'Resources',
      status: resources ? 'ready' : 'missing',
      detail: resources
        ? `${resources} active resource(s) in this plant.`
        : 'Add machines, lines or manual work centres for this plant.',
    },
    {
      key: 'boms',
      title: 'BOMs',
      status: noBom.length ? 'missing' : 'ready',
      detail: noBom.length
        ? `MAKE items without a BOM effective today: ${list(noBom)}.`
        : 'Every MAKE item has a BOM effective today.',
    },
    {
      key: 'routings',
      title: 'Routings',
      status: noRouting.length ? 'missing' : 'ready',
      detail: noRouting.length
        ? `MAKE items without a routing in this plant today: ${list(noRouting)}.`
        : 'Every MAKE item has a routing in this plant effective today.',
    },
  ];
}
