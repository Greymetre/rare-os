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
  if (created.rowCount)
    await db.query(
      "INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES($1::uuid,'demo.seeded','company',$1::text,'{\"source\":\"scripts/demo-abc-corp.mjs\"}')",
      [DEMO.tenant],
    );
  await db.query('COMMIT');
  console.log(
    created.rowCount
      ? `ABC Corp (Demo) created with Plant 1, ${units.rowCount} units, ${items.rowCount} items, 4 suppliers and 7 customers. Sign in as ${admin.email} and switch company.`
      : `ABC Corp (Demo) already present; added ${units.rowCount} missing unit(s) and ${items.rowCount} missing item(s). Existing data unchanged.`,
  );
} catch (e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  await db.end();
}
