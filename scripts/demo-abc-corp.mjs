// Optional ABC Corp demo company for Availability development and demos. Repeat-safe: fixed ids,
// inserts only, never updates or deletes existing rows. Real companies are never touched.
// Run: docker compose run --rm --no-deps seed node scripts/demo-abc-corp.mjs
import pg from 'pg';

const DEMO = {
  tenant: 'd0000000-0000-4000-8000-00000000abc1',
  role: 'd0000000-0000-4000-8000-00000000abc2',
  plant: 'd0000000-0000-4000-8000-00000000abc3',
  member: 'd0000000-0000-4000-8000-00000000abc4',
};
// Seeded platform administrator in the default workspace (see scripts/seed.mjs).
const SEED_ADMIN_USER = '30000000-0000-4000-8000-000000000001';
const UNITS = [
  ['NOS', 'Numbers', 0],
  ['SET', 'Set', 0],
  ['KG', 'Kilogram', 3],
  ['M', 'Metre', 3],
  ['L', 'Litre', 3],
];

// From the prototype's ABC Corp seed (prototype/abc_corp_seed_data_v5.json).
const FINISHED = [
  ['FGa', 'SKU-101', 'DIV-A', 'runner', 4200, 32],
  ['FGb', 'SKU-102', 'DIV-A', 'runner', 3800, 30],
  ['FGc', 'SKU-103', 'DIV-A', 'runner', 5100, 34],
  ['FGd', 'SKU-104', 'DIV-A', 'repeater', 2600, 26],
  ['FGe', 'SKU-105', 'DIV-A', 'repeater', 2900, 24],
  ['FGf', 'SKU-106', 'DIV-B', 'repeater', 3300, 28],
  ['FGg', 'SKU-107', 'DIV-B', 'repeater', 3600, 27],
  ['FGh', 'SKU-108', 'DIV-B', 'stranger', 6100, 30],
  ['FGi', 'SKU-109', 'DIV-B', 'stranger', 7400, 30],
  ['FGj', 'SKU-110', 'DIV-B', 'stranger', 2100, 30],
  ['FGk', 'SKU-111', 'DIV-A', 'stranger', 1950, 30],
  ['FGl', 'SKU-112', 'DIV-B', 'repeater', 3100, 30],
];
const MONTHLY_UNITS = {
  FGa: 900,
  FGb: 820,
  FGc: 640,
  FGd: 300,
  FGe: 260,
  FGf: 210,
  FGg: 180,
  FGh: 45,
  FGi: 30,
  FGj: 120,
  FGk: 110,
  FGl: 190,
};
const RAW = [
  ['RMa', 'SUP-1', 320, 'KG'],
  ['RMb', 'SUP-2', 540, 'KG'],
  ['RMc', 'SUP-1', 210, 'KG'],
  ['RMd', 'SUP-3', 880, 'KG'],
  ['RMe', 'SUP-2', 150, 'NOS'],
  ['RMf', 'SUP-4', 95, 'NOS'],
  ['RMg', 'SUP-3', 1250, 'NOS'],
  ['RMh', 'SUP-1', 60, 'NOS'],
];
const SUPPLIERS = [
  ['SUP-1', 'Supplier One', 7],
  ['SUP-2', 'Supplier Two', 14],
  ['SUP-3', 'Supplier Three', 21],
  ['SUP-4', 'Supplier Four', 5],
];
const CUSTOMERS = [
  ['OEM-1', 'OEM Customer One', 'OEM', ''],
  ['OEM-2', 'OEM Customer Two', 'OEM', ''],
  ['OEM-3', 'OEM Customer Three', 'OEM', ''],
  ['DIST-1', 'Distributor North', 'DISTRIBUTOR', 'North'],
  ['DIST-2', 'Distributor West', 'DISTRIBUTOR', 'West'],
  ['DIST-3', 'Distributor South', 'DISTRIBUTOR', 'South'],
  ['DIST-4', 'Distributor East', 'DISTRIBUTOR', 'East'],
];

// Plant 1 of the prototype: SEG-D line, three 480-minute shifts, Monday to Saturday.
const STATIONS = [
  ['S1', 'Prep', 2, 10, 'PREP'],
  ['S2', 'Machining (shared)', 3, 10, 'MACH'],
  ['S3', 'Assembly', 1, 20, 'ASSY'],
  ['S4', 'Testing', 1, 35, 'TEST'],
  ['S5', 'Packing', 2, 5, 'PACK'],
];
const BOM = {
  FGa: { RMa: 2, RMb: 1, RMf: 3 },
  FGb: { RMa: 1, RMb: 2, RMe: 2 },
  FGc: { RMc: 2, RMd: 1, RMg: 1 },
  FGd: { RMa: 1, RMe: 2, RMh: 4 },
  FGe: { RMc: 2, RMf: 1 },
  FGf: { RMb: 1, RMf: 3, RMh: 2 },
  FGg: { RMe: 2, RMg: 1 },
  FGh: { RMd: 1, RMg: 1, RMa: 2 },
  FGi: { RMd: 2, RMg: 1 },
  FGj: { RMh: 3, RMf: 1 },
  FGk: { RMh: 2, RMc: 1 },
  FGl: { RMa: 1, RMe: 1, RMf: 2 },
};
// Run minutes per unit at S1..S5 (prototype routing_min_per_unit, ordered by station).
const ROUTING = {
  FGa: [3, 5, 7, 3, 2],
  FGb: [3, 4, 6, 3, 2],
  FGc: [4, 6, 8, 4, 2],
  FGd: [2, 3, 5, 2, 2],
  FGe: [2, 3, 5, 2, 2],
  FGf: [3, 4, 5, 3, 2],
  FGg: [3, 4, 5, 3, 2],
  FGh: [4, 6, 9, 5, 3],
  FGi: [5, 7, 10, 5, 3],
  FGj: [2, 2, 4, 2, 2],
  FGk: [2, 2, 4, 2, 2],
  FGl: [3, 4, 5, 3, 2],
};

// Plant 1 stock and demand (AV-3). Opening stock is the prototype's on-hand; dates are relative to today.
const LOCATIONS = [
  ['RM-STORE', 'Raw material store', 'STORES', true],
  ['FG-STORE', 'Finished goods store', 'FINISHED', true],
  ['WIP', 'Line work in progress', 'PRODUCTION', true],
  ['QC-HOLD', 'Quality hold', 'QUARANTINE', false],
];
const ON_HAND = {
  FGa: 340,
  FGb: 360,
  FGc: 320,
  FGd: 90,
  FGe: 100,
  RMa: 1500,
  RMb: 520,
  RMc: 1100,
  RMd: 1050,
  RMe: 1000,
  RMf: 1200,
  RMg: 1000,
  RMh: 1700,
};
// [PO, item, quantity, supplier, due in days]
const PURCHASE_ORDERS = [
  ['PO-101', 'RMa', 400, 'SUP-1', 4],
  ['PO-102', 'RMb', 300, 'SUP-2', 9],
  ['PO-103', 'RMd', 300, 'SUP-3', 13],
  ['PO-104', 'RMg', 300, 'SUP-3', 15],
];
// [order, customer, promise in days, partial delivery allowed, [[item, quantity]...]]
const SALES_ORDERS = [
  ['O-101', 'OEM-1', 5, true, [['FGc', 120]]],
  ['O-102', 'DIST-1', 4, true, [['FGa', 300]]],
  ['O-103', 'DIST-2', 6, true, [['FGb', 250]]],
  ['O-104', 'OEM-2', 8, true, [['FGh', 40]]],
  ['O-105', 'DIST-3', 5, true, [['FGc', 180]]],
  ['O-106', 'DIST-1', 7, true, [['FGd', 220]]],
  ['O-107', 'OEM-1', 9, true, [['FGi', 30]]],
  ['O-108', 'DIST-4', 5, true, [['FGa', 150]]],
  ['O-109', 'DIST-2', 8, true, [['FGf', 200]]],
  ['O-110', 'OEM-3', 10, true, [['FGg', 90]]],
  ['O-111', 'DIST-3', 9, true, [['FGe', 160]]],
  ['O-112', 'DIST-2', 11, true, [['FGb', 400]]],
  [
    'O-113',
    'OEM-2',
    10,
    false,
    [
      ['FGa', 80],
      ['FGd', 60],
      ['FGf', 40],
    ],
  ],
  [
    'O-114',
    'DIST-1',
    12,
    true,
    [
      ['FGe', 90],
      ['FGl', 50],
    ],
  ],
];
// Daily demand history for the last 90 days: monthly units spread over working days with a fixed weekly pattern.
const DAILY_PATTERN = [1.1, 0.9, 1.3, 1.0, 0.8, 0.9, 0];

// Buffers (AV-4): prototype profiles; FGa-FGe and every raw material are buffered, the other
// finished goods are made to order. Lead times for made items are the prototype's lt_days.
const PROFILES = [
  ['BP-RM-SHORT', 'Bought, short lead time', 30, 0, 35],
  ['BP-RM-LONG', 'Bought, long lead time', 40, 0, 45],
  ['BP-FG', 'Finished goods', 30, 0, 30],
];
const BUFFERED_FG = { FGa: 4, FGb: 4, FGc: 5, FGd: 4, FGe: 4 };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(421120)');
  const admin = (
    await db.query('SELECT identity_id,email FROM app_users WHERE id=$1', [SEED_ADMIN_USER])
  ).rows[0];
  if (!admin || admin.identity_id.startsWith('pending:'))
    throw Error('Run the main seeder first so the platform administrator exists.');
  const created = await db.query(
    "INSERT INTO tenants(id,name,code,contact_email) VALUES($1,'ABC Corp (Demo)','ABCDEMO',$2) ON CONFLICT (id) DO NOTHING RETURNING id",
    [DEMO.tenant, admin.email],
  );
  await db.query(
    "INSERT INTO roles(id,tenant_id,name,is_system) VALUES($1,$2,'Main Admin',true) ON CONFLICT (id) DO NOTHING",
    [DEMO.role, DEMO.tenant],
  );
  await db.query(
    'INSERT INTO role_permissions(tenant_id,role_id,permission_code) SELECT $1,$2,code FROM permissions ON CONFLICT DO NOTHING',
    [DEMO.tenant, DEMO.role],
  );
  await db.query(
    "INSERT INTO app_users(id,tenant_id,identity_id,email,name,role_id,sync_state) VALUES($1,$2,$3,$4,'Main Admin',$5,'ready') ON CONFLICT DO NOTHING",
    [DEMO.member, DEMO.tenant, admin.identity_id, admin.email, DEMO.role],
  );
  await db.query(
    "INSERT INTO sites(id,tenant_id,code,name,location,timezone) VALUES($1,$2,'PLANT-1','Plant 1 — multi-station line','Demo location','Asia/Kolkata') ON CONFLICT DO NOTHING",
    [DEMO.plant, DEMO.tenant],
  );
  const units = await db.query(
    'INSERT INTO units(id,tenant_id,code,name,decimals) SELECT gen_random_uuid(),$1,u.code,u.name,u.decimals FROM unnest($2::text[],$3::text[],$4::smallint[]) AS u(code,name,decimals) ON CONFLICT (tenant_id,lower(code)) DO NOTHING',
    [DEMO.tenant, UNITS.map((u) => u[0]), UNITS.map((u) => u[1]), UNITS.map((u) => u[2])],
  );
  const unitIds = Object.fromEntries(
    (await db.query('SELECT code,id FROM units WHERE tenant_id=$1', [DEMO.tenant])).rows.map(
      (u) => [u.code, u.id],
    ),
  );
  const items = await db.query(
    'INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id,family,standard_cost,demand_class) SELECT gen_random_uuid(),$1,i.code,i.name,i.item_type,i.make_buy,i.unit_id,i.family,i.cost,i.demand FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::uuid[],$7::text[],$8::numeric[],$9::text[]) AS i(code,name,item_type,make_buy,unit_id,family,cost,demand) ON CONFLICT (tenant_id,lower(code)) DO NOTHING',
    [
      DEMO.tenant,
      [...FINISHED.map((f) => f[0]), ...RAW.map((r) => r[0])],
      [
        ...FINISHED.map((f) => `Finished good ${f[0]} (${f[1]})`),
        ...RAW.map((r) => `Raw material ${r[0]}`),
      ],
      [...FINISHED.map(() => 'FG'), ...RAW.map(() => 'RM')],
      [...FINISHED.map(() => 'MAKE'), ...RAW.map(() => 'BUY')],
      [...FINISHED.map(() => unitIds.NOS), ...RAW.map((r) => unitIds[r[3]])],
      [...FINISHED.map((f) => f[2]), ...RAW.map(() => 'Raw materials')],
      [...FINISHED.map((f) => ((f[4] * (100 - f[5])) / 100).toFixed(2)), ...RAW.map((r) => r[2])],
      [...FINISHED.map((f) => f[3]), ...RAW.map(() => null)],
    ],
  );
  await db.query(
    'INSERT INTO suppliers(id,tenant_id,code,name,lead_time_days) SELECT gen_random_uuid(),$1,s.code,s.name,s.days FROM unnest($2::text[],$3::text[],$4::int[]) AS s(code,name,days) ON CONFLICT (tenant_id,lower(code)) DO NOTHING',
    [
      DEMO.tenant,
      SUPPLIERS.map((x) => x[0]),
      SUPPLIERS.map((x) => x[1]),
      SUPPLIERS.map((x) => x[2]),
    ],
  );
  await db.query(
    'INSERT INTO customers(id,tenant_id,code,name,customer_type,city) SELECT gen_random_uuid(),$1,c.code,c.name,c.kind,c.city FROM unnest($2::text[],$3::text[],$4::text[],$5::text[]) AS c(code,name,kind,city) ON CONFLICT (tenant_id,lower(code)) DO NOTHING',
    [
      DEMO.tenant,
      CUSTOMERS.map((x) => x[0]),
      CUSTOMERS.map((x) => x[1]),
      CUSTOMERS.map((x) => x[2]),
      CUSTOMERS.map((x) => x[3]),
    ],
  );
  // Preferred source per raw material; skipped when any source already exists for that item.
  await db.query(
    `INSERT INTO item_suppliers(id,tenant_id,item_id,supplier_id,purchase_unit_id,moq,lot_multiple,preferred)
     SELECT gen_random_uuid(),$1,i.id,s.id,i.base_unit_id,100,10,true
     FROM unnest($2::text[],$3::text[]) AS m(item_code,supplier_code)
     JOIN items i ON i.tenant_id=$1 AND i.code=m.item_code
     JOIN suppliers s ON s.tenant_id=$1 AND s.code=m.supplier_code
     WHERE NOT EXISTS (SELECT 1 FROM item_suppliers x WHERE x.item_id=i.id)`,
    [DEMO.tenant, RAW.map((r) => r[0]), RAW.map((r) => r[1])],
  );
  const calendar = await db.query(
    "INSERT INTO calendars(id,tenant_id,site_id,code,name,working_days,is_default) VALUES(gen_random_uuid(),$1,$2,'3SHIFT','Three shifts, Monday to Saturday','1111110',true) ON CONFLICT DO NOTHING RETURNING id",
    [DEMO.tenant, DEMO.plant],
  );
  if (calendar.rowCount)
    await db.query(
      "INSERT INTO calendar_shifts(id,tenant_id,calendar_id,sequence,name,start_time,end_time,break_minutes) VALUES (gen_random_uuid(),$1,$2,1,'A','06:00','14:00',0),(gen_random_uuid(),$1,$2,2,'B','14:00','22:00',0),(gen_random_uuid(),$1,$2,3,'C','22:00','06:00',0)",
      [DEMO.tenant, calendar.rows[0].id],
    );
  const resources = await db.query(
    "INSERT INTO resources(id,tenant_id,site_id,code,name,resource_type,machine_count,changeover_minutes) SELECT gen_random_uuid(),$1,$2,r.code,r.name,'MACHINE',r.machines,r.changeover FROM unnest($3::text[],$4::text[],$5::int[],$6::numeric[]) AS r(code,name,machines,changeover) ON CONFLICT DO NOTHING",
    [
      DEMO.tenant,
      DEMO.plant,
      STATIONS.map((x) => x[0]),
      STATIONS.map((x) => x[1]),
      STATIONS.map((x) => x[2]),
      STATIONS.map((x) => x[3]),
    ],
  );
  // One BOM and one routing (V1) per finished good; existing revisions are left untouched.
  let boms = 0,
    routings = 0;
  for (const [fg, components] of Object.entries(BOM)) {
    const bom = await db.query(
      "INSERT INTO boms(id,tenant_id,item_id,revision,effective_from) SELECT gen_random_uuid(),$1,id,'V1','2026-01-01' FROM items WHERE tenant_id=$1 AND code=$2 ON CONFLICT DO NOTHING RETURNING id",
      [DEMO.tenant, fg],
    );
    boms += bom.rowCount;
    if (bom.rowCount)
      await db.query(
        'INSERT INTO bom_lines(id,tenant_id,bom_id,line_no,component_item_id,quantity,unit_id) SELECT gen_random_uuid(),$1,$2,c.n,i.id,c.qty,i.base_unit_id FROM unnest($3::int[],$4::text[],$5::numeric[]) AS c(n,code,qty) JOIN items i ON i.tenant_id=$1 AND i.code=c.code',
        [
          DEMO.tenant,
          bom.rows[0].id,
          Object.keys(components).map((_, n) => n + 1),
          Object.keys(components),
          Object.values(components),
        ],
      );
    const routing = await db.query(
      "INSERT INTO routings(id,tenant_id,site_id,item_id,revision,effective_from) SELECT gen_random_uuid(),$1,$2,id,'V1','2026-01-01' FROM items WHERE tenant_id=$1 AND code=$3 ON CONFLICT DO NOTHING RETURNING id",
      [DEMO.tenant, DEMO.plant, fg],
    );
    routings += routing.rowCount;
    if (routing.rowCount)
      await db.query(
        'INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,description,resource_id,run_minutes_per_unit) SELECT gen_random_uuid(),$1,$2,o.seq,o.code,o.descr,r.id,o.run FROM unnest($3::int[],$4::text[],$5::text[],$6::text[],$7::numeric[]) AS o(seq,code,descr,station,run) JOIN resources r ON r.tenant_id=$1 AND r.site_id=$8 AND r.code=o.station',
        [
          DEMO.tenant,
          routing.rows[0].id,
          STATIONS.map((_, n) => (n + 1) * 10),
          STATIONS.map((x) => x[4]),
          STATIONS.map((x) => x[1]),
          STATIONS.map((x) => x[0]),
          ROUTING[fg],
          DEMO.plant,
        ],
      );
  }
  // Stock and demand for Plant 1; each record is added only when missing.
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [DEMO.tenant]);
  const locations = await db.query(
    'INSERT INTO stock_locations(id,tenant_id,site_id,code,name,location_type,nettable) SELECT gen_random_uuid(),$1,$2,l.code,l.name,l.kind,l.nettable FROM unnest($3::text[],$4::text[],$5::text[],$6::boolean[]) AS l(code,name,kind,nettable) ON CONFLICT DO NOTHING',
    [
      DEMO.tenant,
      DEMO.plant,
      LOCATIONS.map((l) => l[0]),
      LOCATIONS.map((l) => l[1]),
      LOCATIONS.map((l) => l[2]),
      LOCATIONS.map((l) => l[3]),
    ],
  );
  const openings = await db.query(
    `INSERT INTO stock_movements(id,tenant_id,movement_no,site_id,location_id,item_id,movement_type,quantity,entered_quantity,entered_unit_id,movement_date,reference,external_ref)
     SELECT gen_random_uuid(),$1,next_number('stock_movement'),$2,l.id,i.id,'OPENING',o.qty,o.qty,i.base_unit_id,current_date,'Demo opening stock','DEMO-OPEN-'||i.code
     FROM unnest($3::text[],$4::numeric[]) WITH ORDINALITY AS o(code,qty,ord)
     JOIN items i ON i.tenant_id=$1 AND i.code=o.code
     JOIN stock_locations l ON l.tenant_id=$1 AND l.site_id=$2 AND l.code=CASE WHEN i.item_type='FG' THEN 'FG-STORE' ELSE 'RM-STORE' END
     WHERE NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id=$1 AND lower(m.external_ref)=lower('DEMO-OPEN-'||i.code))
     ORDER BY o.ord`,
    [DEMO.tenant, DEMO.plant, Object.keys(ON_HAND), Object.values(ON_HAND)],
  );
  let purchaseOrders = 0;
  for (const [no, item, qty, supplier, due] of PURCHASE_ORDERS) {
    const po = await db.query(
      'INSERT INTO purchase_orders(id,tenant_id,site_id,po_no,supplier_id,order_date) SELECT gen_random_uuid(),$1,$2,$3,id,current_date-3 FROM suppliers WHERE tenant_id=$1 AND code=$4 ON CONFLICT DO NOTHING RETURNING id',
      [DEMO.tenant, DEMO.plant, no, supplier],
    );
    purchaseOrders += po.rowCount;
    if (po.rowCount)
      await db.query(
        'INSERT INTO purchase_order_lines(id,tenant_id,po_id,line_no,item_id,unit_id,unit_factor,quantity,due_date) SELECT gen_random_uuid(),$1,$2,1,id,base_unit_id,1,$3,current_date+$4::int FROM items WHERE tenant_id=$1 AND code=$5',
        [DEMO.tenant, po.rows[0].id, qty, due, item],
      );
  }
  let salesOrders = 0;
  for (const [no, customer, promise, partial, lines] of SALES_ORDERS) {
    const order = await db.query(
      'INSERT INTO sales_orders(id,tenant_id,site_id,order_no,customer_id,order_date,promise_date,allow_partial) SELECT gen_random_uuid(),$1,$2,$3,id,current_date-2,current_date+$4::int,$5 FROM customers WHERE tenant_id=$1 AND code=$6 ON CONFLICT DO NOTHING RETURNING id',
      [DEMO.tenant, DEMO.plant, no, promise, partial, customer],
    );
    salesOrders += order.rowCount;
    if (order.rowCount)
      await db.query(
        'INSERT INTO sales_order_lines(id,tenant_id,order_id,line_no,item_id,quantity,promise_date) SELECT gen_random_uuid(),$1,$2,l.n*10,i.id,l.qty,current_date+$3::int FROM unnest($4::text[],$5::numeric[]) WITH ORDINALITY AS l(code,qty,n) JOIN items i ON i.tenant_id=$1 AND i.code=l.code',
        [DEMO.tenant, order.rows[0].id, promise, lines.map((l) => l[0]), lines.map((l) => l[1])],
      );
  }
  const history = await db.query(
    `INSERT INTO demand_history(tenant_id,site_id,item_id,demand_date,quantity)
     SELECT $1,$2,i.id,d.day,round(f.monthly / 26.0 * ($5::numeric[])[extract(isodow FROM d.day)::int])
     FROM unnest($3::text[],$4::numeric[]) AS f(code,monthly)
     JOIN items i ON i.tenant_id=$1 AND i.code=f.code
     CROSS JOIN generate_series(current_date-90,current_date-1,interval '1 day') AS d(day)
     ON CONFLICT DO NOTHING`,
    [
      DEMO.tenant,
      DEMO.plant,
      FINISHED.map((f) => f[0]),
      FINISHED.map((f) => MONTHLY_UNITS[f[0]]),
      DAILY_PATTERN,
    ],
  );
  const profiles = await db.query(
    'INSERT INTO buffer_profiles(id,tenant_id,code,name,red_base_pct,red_safety_pct,green_pct) SELECT gen_random_uuid(),$1,p.code,p.name,p.red,p.safety,p.green FROM unnest($2::text[],$3::text[],$4::numeric[],$5::numeric[],$6::numeric[]) AS p(code,name,red,safety,green) ON CONFLICT DO NOTHING',
    [
      DEMO.tenant,
      PROFILES.map((p) => p[0]),
      PROFILES.map((p) => p[1]),
      PROFILES.map((p) => p[2]),
      PROFILES.map((p) => p[3]),
      PROFILES.map((p) => p[4]),
    ],
  );
  const settings = await db.query(
    `INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy,profile_id,lead_time_days)
     SELECT gen_random_uuid(),$1,$2,i.id,
       CASE WHEN i.make_buy='BUY' OR i.code=ANY($3::text[]) THEN 'BUFFER' ELSE 'MTO' END,
       CASE WHEN i.make_buy='MAKE' AND i.code=ANY($3::text[]) THEN (SELECT id FROM buffer_profiles WHERE tenant_id=$1 AND code='BP-FG')
            WHEN i.make_buy='BUY' THEN (SELECT id FROM buffer_profiles WHERE tenant_id=$1 AND code=
              CASE WHEN coalesce(src.lead_time_days,s.lead_time_days,0) >= 14 THEN 'BP-RM-LONG' ELSE 'BP-RM-SHORT' END) END,
       CASE WHEN i.make_buy='MAKE' THEN (($4::jsonb)->>i.code)::int END
     FROM items i
     LEFT JOIN item_suppliers src ON src.item_id=i.id AND src.preferred
     LEFT JOIN suppliers s ON s.id=src.supplier_id
     WHERE i.tenant_id=$1
     ON CONFLICT DO NOTHING`,
    [DEMO.tenant, DEMO.plant, Object.keys(BUFFERED_FG), JSON.stringify(BUFFERED_FG)],
  );
  if (created.rowCount)
    await db.query(
      "INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES($1::uuid,'demo.seeded','company',$1::text,'{\"source\":\"scripts/demo-abc-corp.mjs\"}')",
      [DEMO.tenant],
    );
  await db.query('COMMIT');
  console.log(
    created.rowCount
      ? `ABC Corp (Demo) created with Plant 1, ${units.rowCount} units, ${items.rowCount} items, 4 suppliers, 7 customers, a 3-shift calendar, 5 resources, 12 BOMs, 12 routings, ${locations.rowCount} stock locations, opening stock for ${openings.rowCount} items, ${purchaseOrders} open purchase orders, ${salesOrders} customer orders, ${history.rowCount} demand history rows, ${profiles.rowCount} buffer profiles and ${settings.rowCount} buffer settings. Sign in as ${admin.email} and switch company.`
      : `ABC Corp (Demo) already present; added ${units.rowCount} unit(s), ${items.rowCount} item(s), ${calendar.rowCount} calendar(s), ${resources.rowCount} resource(s), ${boms} BOM(s), ${routings} routing(s), ${locations.rowCount} stock location(s), ${openings.rowCount} opening stock movement(s), ${purchaseOrders} purchase order(s), ${salesOrders} customer order(s), ${history.rowCount} demand history row(s), ${profiles.rowCount} buffer profile(s) and ${settings.rowCount} buffer setting(s) that were missing. Existing data unchanged.`,
  );
} catch (e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  await db.end();
}
