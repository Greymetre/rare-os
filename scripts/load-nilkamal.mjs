// Replaces every company with one company, "Nilkamal", holding the
// Barjora plant (1116) from the Nilkamal simulation handover (21-Sep-2026): items, BOMs, routings,
// work centres, MB52 stock, open POs, open production orders, 27 months of invoice demand and
// the demo's weekly buffers. Build the bundle first with scripts/nilkamal-convert.py.
//
// The workspace company (with the seeded platform administrator and its users) is kept and
// renamed; every other company and all planning data are deleted. Dates move forward by whole
// weeks so the demo's model day (27-Jul-2026) falls in the current week.
//
// Run: docker compose run --rm --no-deps -v "$PWD/.local/nilkamal:/data:ro" seed \
//        node scripts/load-nilkamal.mjs /data/bundle.json --replace-all-companies
// On a server add --on-server. The bundle is client data.
import fs from 'node:fs';
import pg from 'pg';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const SEED_ADMIN_USER = '30000000-0000-4000-8000-000000000001';
const PLANT_ID = 'd0000000-0000-4000-8000-0000000011a6';
const [file, ...flags] = process.argv.slice(2);
const appUrl = process.env.APP_URL ?? '';
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(appUrl);
if (!file || !flags.includes('--replace-all-companies'))
  throw Error(
    'Usage: node scripts/load-nilkamal.mjs <bundle.json> --replace-all-companies (deletes every company).',
  );
// A server needs a second, explicit flag.
if (!local && !flags.includes('--on-server'))
  throw Error(
    `Refused: APP_URL is ${appUrl || 'not set'}. On a server add --on-server (every company there is deleted).`,
  );
const b = JSON.parse(fs.readFileSync(file, 'utf8'));

// Tables that belong to a company but not to its identity and access set-up.
const PLANNING_TABLES = [
  'order_plans',
  'expedite_actions',
  'expedite_bundles',
  'estimated_items',
  'odd_size_families',
  'planning_decisions',
  'plant_sequence',
  'schedule_publications',
  'schedule_operations',
  'schedule_orders',
  'schedule_resources',
  'schedule_plants',
  'plant_planning',
  'goods_receipt_lines',
  'goods_receipts',
  'purchase_proposals',
  'planning_results',
  'planning_runs',
  'planning_state',
  'planning_input_events',
  'item_buffers',
  'buffer_profiles',
  'production_orders',
  'demand_history',
  'purchase_order_lines',
  'purchase_orders',
  'sales_order_lines',
  'sales_orders',
  'stock_balances',
  'stock_movements',
  'stock_locations',
  'routing_operations',
  'routings',
  'bom_lines',
  'boms',
  'resources',
  'calendar_holidays',
  'calendar_shifts',
  'calendars',
  'unit_conversions',
  'item_suppliers',
  'customers',
  'suppliers',
  'items',
  'units',
  'import_rows',
  'import_batches',
  'user_sites',
  'sites',
];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = (text, params) => db.query(text, params);
try {
  await q('BEGIN');
  await q('SELECT pg_advisory_xact_lock(421121)');
  const admin = (
    await q('SELECT identity_id,email FROM app_users WHERE id=$1 AND tenant_id=$2', [
      SEED_ADMIN_USER,
      WORKSPACE,
    ])
  ).rows[0];
  if (!admin || admin.identity_id.startsWith('pending:'))
    throw Error('Run the main seeder first so the platform administrator exists.');

  // ---------- Delete every other company and all planning data ----------
  const others = (await q('SELECT id,name FROM tenants WHERE id<>$1', [WORKSPACE])).rows;
  const removedUsers = (
    await q(
      `SELECT DISTINCT u.email FROM app_users u WHERE u.tenant_id=ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM app_users w WHERE w.tenant_id=$2 AND w.identity_id=u.identity_id)`,
      [others.map((t) => t.id), WORKSPACE],
    )
  ).rows.map((r) => r.email);
  const tables = (
    await q(
      `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema,table_name)
       WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'`,
    )
  ).rows.map((r) => r.table_name);
  // Foreign keys and ledger guards are triggers; replica mode skips them for this bulk delete.
  await q("SET LOCAL session_replication_role = 'replica'");
  let deleted = 0;
  for (const t of tables)
    deleted += (
      await q(`DELETE FROM ${t} WHERE tenant_id=ANY($1::uuid[])`, [others.map((x) => x.id)])
    ).rowCount;
  for (const t of PLANNING_TABLES.filter((x) => tables.includes(x)))
    deleted += (await q(`DELETE FROM ${t} WHERE tenant_id=$1`, [WORKSPACE])).rowCount;
  await q(
    "DELETE FROM outbox_events WHERE tenant_id=$1 AND (kind LIKE 'planning.%' OR kind LIKE 'import.%')",
    [WORKSPACE],
  );
  // Planning decisions and inserted orders start again from #1.
  await q(
    "DELETE FROM number_series WHERE tenant_id=$1 AND series IN ('planning_decision','inserted_order','expedite_bundle','expedite_action')",
    [WORKSPACE],
  );
  await q('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [others.map((x) => x.id)]);
  await q("SET LOCAL session_replication_role = 'origin'");
  await q("UPDATE tenants SET name=$2,code='NILKAMAL',version=version+1 WHERE id=$1", [
    WORKSPACE,
    b.meta.company,
  ]);

  // ---------- Load Nilkamal Barjora ----------
  await q("SELECT set_config('app.tenant_id',$1,true)", [WORKSPACE]);
  const shift = Number(
    (await q('SELECT floor((current_date - $1::date) / 7.0)::int * 7 AS d', [b.meta.model_date]))
      .rows[0].d,
  );
  const at = (day) => {
    const d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + shift);
    return d.toISOString().slice(0, 10);
  };
  const modelDay = at(b.meta.model_date);
  const T = WORKSPACE;
  await q(
    "INSERT INTO sites(id,tenant_id,code,name,location,timezone) VALUES($1,$2,$3,$4,$5,'Asia/Kolkata')",
    [PLANT_ID, T, b.meta.plant.code, b.meta.plant.name, b.meta.plant.location],
  );
  await q(
    'INSERT INTO units(id,tenant_id,code,name,decimals) SELECT gen_random_uuid(),$1,u.c,u.n,u.d FROM unnest($2::text[],$3::text[],$4::smallint[]) AS u(c,n,d)',
    [T, b.units.map((u) => u[0]), b.units.map((u) => u[1]), b.units.map((u) => u[2])],
  );
  const col = (rows, f) => rows.map(f);
  await q(
    `INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id,family,demand_class)
     SELECT gen_random_uuid(),$1,i.code,i.name,i.kind,i.mb,u.id,i.family,i.class
     FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[]) AS i(code,name,kind,mb,unit,family,class)
     JOIN units u ON u.tenant_id=$1 AND u.code=i.unit`,
    [
      T,
      col(b.items, (i) => i.code),
      col(b.items, (i) => i.name),
      col(b.items, (i) => i.type),
      col(b.items, (i) => i.make_buy),
      col(b.items, (i) => i.unit),
      col(b.items, (i) => i.family),
      col(b.items, (i) => i.demand_class),
    ],
  );
  const item = new Map(
    (await q('SELECT id,code,base_unit_id FROM items WHERE tenant_id=$1', [T])).rows.map((r) => [
      r.code,
      r,
    ]),
  );
  await q(
    'INSERT INTO suppliers(id,tenant_id,code,name,lead_time_days) SELECT gen_random_uuid(),$1,s.c,s.n,$4 FROM unnest($2::text[],$3::text[]) AS s(c,n)',
    [T, b.suppliers.map((s) => s[0]), b.suppliers.map((s) => s[1]), b.meta.lead_time_days],
  );
  await q(
    `INSERT INTO item_suppliers(id,tenant_id,item_id,supplier_id,purchase_unit_id,moq,lot_multiple,preferred)
     SELECT gen_random_uuid(),$1,i.id,s.id,i.base_unit_id,x.moq,x.mult,true
     FROM unnest($2::text[],$3::text[],$4::numeric[],$5::numeric[]) AS x(item,sup,moq,mult)
     JOIN items i ON i.tenant_id=$1 AND i.code=x.item JOIN suppliers s ON s.tenant_id=$1 AND s.code=x.sup`,
    [
      T,
      col(b.sources, (s) => s.item),
      col(b.sources, (s) => s.supplier),
      col(b.sources, (s) => s.moq),
      col(b.sources, (s) => s.multiple),
    ],
  );
  // Barjora runs round the clock: three 8-hour shifts, every day.
  const calendar = (
    await q(
      "INSERT INTO calendars(id,tenant_id,site_id,code,name,working_days,is_default) VALUES(gen_random_uuid(),$1,$2,'24X7','Three shifts, every day','1111111',true) RETURNING id",
      [T, PLANT_ID],
    )
  ).rows[0].id;
  await q(
    "INSERT INTO calendar_shifts(id,tenant_id,calendar_id,sequence,name,start_time,end_time,break_minutes) VALUES (gen_random_uuid(),$1,$2,1,'A','06:00','14:00',0),(gen_random_uuid(),$1,$2,2,'B','14:00','22:00',0),(gen_random_uuid(),$1,$2,3,'C','22:00','06:00',0)",
    [T, calendar],
  );
  await q(
    `INSERT INTO resources(id,tenant_id,site_id,code,name,resource_type,machine_count,efficiency_pct,changeover_minutes,planned_utilization_pct)
     SELECT gen_random_uuid(),$1,$2,r.c,r.n,'MACHINE',r.m,r.e,r.co,r.u FROM unnest($3::text[],$4::text[],$5::int[],$6::numeric[],$7::numeric[],$8::numeric[]) AS r(c,n,m,e,co,u)`,
    [
      T,
      PLANT_ID,
      col(b.resources, (r) => r.code),
      col(b.resources, (r) => r.name),
      col(b.resources, (r) => r.machines),
      col(b.resources, (r) => r.efficiency),
      col(b.resources, (r) => r.changeover),
      col(b.resources, (r) => r.planned_utilization ?? null),
    ],
  );
  const resource = new Map(
    (await q('SELECT id,code FROM resources WHERE site_id=$1', [PLANT_ID])).rows.map((r) => [
      r.code,
      r.id,
    ]),
  );
  let bomLines = 0;
  for (const [fg, lines] of Object.entries(b.boms)) {
    const bom = (
      await q(
        "INSERT INTO boms(id,tenant_id,item_id,revision,effective_from) VALUES(gen_random_uuid(),$1,$2,'V1','2024-01-01') RETURNING id",
        [T, item.get(fg).id],
      )
    ).rows[0].id;
    await q(
      'INSERT INTO bom_lines(id,tenant_id,bom_id,line_no,component_item_id,quantity,unit_id) SELECT gen_random_uuid(),$1,$2,l.n,l.item,l.qty,l.unit FROM unnest($3::int[],$4::uuid[],$5::numeric[],$6::uuid[]) AS l(n,item,qty,unit)',
      [
        T,
        bom,
        lines.map((_, i) => i + 1),
        lines.map((l) => item.get(l[0]).id),
        lines.map((l) => l[1]),
        lines.map((l) => item.get(l[0]).base_unit_id),
      ],
    );
    bomLines += lines.length;
  }
  for (const [fg, ops] of Object.entries(b.routings)) {
    if (!ops.length) continue;
    const routing = (
      await q(
        "INSERT INTO routings(id,tenant_id,site_id,item_id,revision,effective_from) VALUES(gen_random_uuid(),$1,$2,$3,'V1','2024-01-01') RETURNING id",
        [T, PLANT_ID, item.get(fg).id],
      )
    ).rows[0].id;
    await q(
      'INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,description,resource_id,run_minutes_per_unit) SELECT gen_random_uuid(),$1,$2,o.s,o.c,o.d,o.r,o.m FROM unnest($3::int[],$4::text[],$5::text[],$6::uuid[],$7::numeric[]) AS o(s,c,d,r,m)',
      [
        T,
        routing,
        ops.map((o) => o[0]),
        ops.map((o) => o[1]),
        ops.map((o) => o[2]),
        ops.map((o) => resource.get(o[1])),
        ops.map((o) => o[3]),
      ],
    );
  }
  // Storage locations as in MB52; all unrestricted stock counts, as in the demo.
  await q(
    `INSERT INTO stock_locations(id,tenant_id,site_id,code,name,location_type,nettable)
     SELECT gen_random_uuid(),$1,$2,l,CASE WHEN l=$4 THEN 'Finished goods store' WHEN l='NOSLOC' THEN 'MB52 rows without storage location' ELSE 'SAP storage location '||l END,
       CASE WHEN l=$4 THEN 'FINISHED' ELSE 'STORES' END,true FROM unnest($3::text[]) AS l`,
    [T, PLANT_ID, b.locations, b.fg_location],
  );
  await q(
    `INSERT INTO stock_movements(id,tenant_id,movement_no,site_id,location_id,item_id,movement_type,quantity,entered_quantity,entered_unit_id,movement_date,reference,external_ref)
     SELECT gen_random_uuid(),$1,next_number('stock_movement'),$2,l.id,i.id,'OPENING',s.qty,s.qty,i.base_unit_id,$6::date,
       CASE WHEN l.code=$7 THEN 'Nilkamal demo FG position' ELSE 'MB52 unrestricted stock' END,'NK-OPEN-'||s.n
     FROM unnest($3::text[],$4::text[],$5::numeric[]) WITH ORDINALITY AS s(item,loc,qty,n)
     JOIN items i ON i.tenant_id=$1 AND i.code=s.item JOIN stock_locations l ON l.site_id=$2 AND l.code=s.loc
     ORDER BY s.n`,
    [
      T,
      PLANT_ID,
      col(b.stock, (s) => s[0]),
      col(b.stock, (s) => s[1]),
      col(b.stock, (s) => s[2]),
      modelDay,
      b.fg_location,
    ],
  );
  const pos = new Map();
  for (const l of b.purchase_orders) {
    if (!pos.has(l.po_no)) pos.set(l.po_no, []);
    pos.get(l.po_no).push(l);
  }
  for (const [no, lines] of pos) {
    const orderDate = lines.map((l) => l.order_date).sort()[0];
    const po = (
      await q(
        'INSERT INTO purchase_orders(id,tenant_id,site_id,po_no,supplier_id,order_date) SELECT gen_random_uuid(),$1,$2,$3,id,$5 FROM suppliers WHERE tenant_id=$1 AND code=$4 RETURNING id',
        [T, PLANT_ID, no, lines[0].supplier, at(orderDate)],
      )
    ).rows[0].id;
    await q(
      `INSERT INTO purchase_order_lines(id,tenant_id,po_id,line_no,item_id,unit_id,unit_factor,quantity,due_date)
       SELECT gen_random_uuid(),$1,$2,l.n,i.id,i.base_unit_id,1,l.qty,l.due FROM unnest($3::int[],$4::text[],$5::numeric[],$6::date[]) AS l(n,item,qty,due)
       JOIN items i ON i.tenant_id=$1 AND i.code=l.item`,
      [
        T,
        po,
        lines.map((l) => l.line_no),
        lines.map((l) => l.item),
        lines.map((l) => l.quantity),
        lines.map((l) => at(l.due_date)),
      ],
    );
  }
  const po = b.production_orders;
  await q(
    `INSERT INTO production_orders(id,tenant_id,site_id,order_no,item_id,quantity,start_date,due_date,order_type,reference)
     SELECT gen_random_uuid(),$1,$2,o.no,i.id,o.qty,o.start,o.due,o.kind,o.ref
     FROM unnest($3::text[],$4::text[],$5::numeric[],$6::date[],$7::date[],$8::text[],$9::text[]) AS o(no,item,qty,start,due,kind,ref)
     JOIN items i ON i.tenant_id=$1 AND i.code=o.item`,
    [
      T,
      PLANT_ID,
      col(po, (o) => o.order_no),
      col(po, (o) => o.item),
      col(po, (o) => o.quantity),
      col(po, (o) => at(o.start_date)),
      col(po, (o) => at(o.due_date)),
      col(po, (o) => o.order_type),
      col(po, (o) => o.reference),
    ],
  );
  for (let i = 0; i < b.demand.length; i += 5000) {
    const part = b.demand.slice(i, i + 5000);
    await q(
      `INSERT INTO demand_history(tenant_id,site_id,item_id,demand_date,quantity)
       SELECT $1,$2,i.id,d.day,d.qty FROM unnest($3::text[],$4::date[],$5::numeric[]) AS d(item,day,qty)
       JOIN items i ON i.tenant_id=$1 AND i.code=d.item`,
      [T, PLANT_ID, col(part, (d) => d[0]), col(part, (d) => at(d[1])), col(part, (d) => d[2])],
    );
  }
  // The demo's zone method: 13 weekly means, CV safety, whole-week lead time, one week of green.
  await q(
    `INSERT INTO buffer_profiles(id,tenant_id,code,name,red_base_pct,red_safety_pct,green_pct,order_cycle_days,adu_window_days,method,zone_weeks,cv_weeks,order_multiple,moq_adu_days)
     VALUES (gen_random_uuid(),$1,'NK-FG','Nilkamal finished goods (weekly, CV safety)',50,0,100,7,91,'WEEKLY',13,52,10,1.5),
            (gen_random_uuid(),$1,'NK-RM','Nilkamal components (weekly, CV safety)',50,0,100,7,91,'WEEKLY',13,52,NULL,NULL)`,
    [T],
  );
  await q(
    `INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy,profile_id,lead_time_days,reference_lot)
     SELECT gen_random_uuid(),$1,$2,i.id,'BUFFER',p.id,x.lt,x.lot FROM unnest($3::text[],$4::text[],$5::int[],$6::numeric[]) AS x(item,kind,lt,lot)
     JOIN items i ON i.tenant_id=$1 AND i.code=x.item JOIN buffer_profiles p ON p.tenant_id=$1 AND p.code='NK-'||x.kind`,
    [
      T,
      PLANT_ID,
      col(b.buffers, (x) => x.item),
      col(b.buffers, (x) => x.kind),
      col(b.buffers, (x) => x.lead_time_days),
      col(b.buffers, (x) => x.reference_lot ?? null),
    ],
  );
  await q(
    "INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy) SELECT gen_random_uuid(),$1,$2,i.id,'MTO' FROM items i WHERE i.tenant_id=$1 AND i.code=ANY($3::text[])",
    [T, PLANT_ID, b.mto],
  );
  // The simulation plans on its (shifted) model day, like the demo, whatever today is.
  await q(
    'INSERT INTO planning_state(tenant_id,as_of_date) VALUES($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET as_of_date=excluded.as_of_date',
    [T, modelDay],
  );
  if (b.planning)
    await q(
      'INSERT INTO plant_planning(tenant_id,site_id,club_window_days,lead_time_basis,day_weights,profile_day,area_operations) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        T,
        PLANT_ID,
        b.planning.club_window_days,
        b.planning.lead_time_basis,
        b.planning.day_weights,
        b.planning.profile_day,
        b.planning.area_operations ?? [],
      ],
    );
  // Odd-size families (code stem and trade name) for the Insert screen.
  if (b.odd_size_families?.length)
    await q(
      'INSERT INTO odd_size_families(tenant_id,code,name) SELECT $1,f.c,f.n FROM unnest($2::text[],$3::text[]) AS f(c,n)',
      [T, col(b.odd_size_families, (f) => f[0]), col(b.odd_size_families, (f) => f[1])],
    );
  await q(
    "INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES($1::uuid,'demo.seeded','company',$1::text,$2)",
    [
      T,
      JSON.stringify({
        source: 'scripts/load-nilkamal.mjs',
        sources: b.meta.sources,
        shiftDays: shift,
      }),
    ],
  );
  await q('COMMIT');
  console.log(
    [
      `Deleted ${others.length} other compan${others.length === 1 ? 'y' : 'ies'} (${others.map((t) => t.name).join(', ') || 'none'}) and ${deleted} planning rows.`,
      removedUsers.length
        ? `Logins left without a company: ${removedUsers.join(', ')}.`
        : 'No logins were left without a company.',
      `Company "${b.meta.company}" loaded with plant ${b.meta.plant.code} (${b.meta.plant.name}): ${b.items.length} items, ${Object.keys(b.boms).length} BOMs (${bomLines} lines), ${Object.keys(b.routings).length} routings, ${b.resources.length} work centres, ${b.stock.length} opening stock rows, ${pos.size} open POs (${b.purchase_orders.length} lines), ${po.length} production orders, ${b.demand.length} demand days, ${b.buffers.length} buffers.`,
      `Dates moved forward ${shift} days: the demo model day ${b.meta.model_date} is ${modelDay}; demand history ends ${at(b.meta.history_end)}. Planning is fixed on ${modelDay}.`,
      `Sign in as ${admin.email}. Buffers recalculate within a few seconds.`,
    ].join('\n'),
  );
} catch (e) {
  await q('ROLLBACK');
  throw e;
} finally {
  await db.end();
}
