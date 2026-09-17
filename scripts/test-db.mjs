import { permissions } from '../packages/schema/permissions.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const tenant = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000099';
try {
  const counts = await db.query(
    'SELECT (SELECT count(*) FROM app_users)::int users,(SELECT count(*) FROM roles)::int roles,(SELECT count(*) FROM permissions)::int permissions',
  );
  assert.ok(counts.rows[0].users >= 1);
  assert.ok(counts.rows[0].roles >= 1);
  assert.equal(counts.rows[0].permissions, permissions.length);
  console.log('PASS seed: admin/roles preserved, current permission catalog');
  await db.query('BEGIN');
  await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [other, 'Isolation fixture']);
  await db.query(
    "INSERT INTO audit_log(tenant_id,action,entity_type) VALUES($1,'hidden.event','test')",
    [other],
  );
  await db.query(
    "INSERT INTO audit_log(tenant_id,action,entity_type) SELECT $1,'load.fixture','test' FROM generate_series(1,100000)",
    [tenant],
  );
  await db.query('ANALYZE audit_log');
  await db.query('SET LOCAL ROLE rare_app');
  assert.equal((await db.query('SELECT * FROM tenants')).rowCount, 0);
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  assert.equal((await db.query('SELECT * FROM tenants')).rowCount, 1);
  assert.equal((await db.query('SELECT * FROM tenants WHERE id=$1', [other])).rowCount, 0);
  assert.equal((await db.query("SELECT * FROM audit_log WHERE action='hidden.event'")).rowCount, 0);
  await db.query('SAVEPOINT denied');
  await assert.rejects(
    () =>
      db.query("INSERT INTO audit_log(tenant_id,action,entity_type) VALUES($1,'bad','test')", [
        other,
      ]),
    (e) => e.code === '42501',
  );
  await db.query('ROLLBACK TO SAVEPOINT denied');
  await db.query('SAVEPOINT deniedrole');
  await assert.rejects(
    () => db.query('DELETE FROM permissions'),
    (e) => e.code === '42501',
  );
  await db.query('ROLLBACK TO SAVEPOINT deniedrole');
  // AV-0: availability foundation tables keep company isolation and narrow runtime privileges.
  await db.query('RESET ROLE');
  await db.query("SELECT set_config('app.tenant_id','',true)");
  const batch = '20000000-0000-4000-8000-0000000000a1';
  await db.query(
    "INSERT INTO units(id,tenant_id,code,name,decimals) VALUES(gen_random_uuid(),$1,'ISO','Hidden unit',0)",
    [other],
  );
  await db.query(
    'INSERT INTO outbox_events(tenant_id,kind,payload) VALUES($1,\'import.validate\',\'{"secret":"payload"}\')',
    [other],
  );
  await db.query('SET LOCAL ROLE rare_app');
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  assert.equal((await db.query("SELECT * FROM units WHERE code='ISO'")).rowCount, 0);
  await db.query(
    "INSERT INTO units(id,tenant_id,code,name,decimals) VALUES(gen_random_uuid(),$1,'ISO','Same code other company',0)",
    [tenant],
  );
  await db.query('SAVEPOINT dupunit');
  await assert.rejects(
    () =>
      db.query(
        "INSERT INTO units(id,tenant_id,code,name,decimals) VALUES(gen_random_uuid(),$1,'ISO','Duplicate',0)",
        [tenant],
      ),
    (e) => e.code === '23505',
  );
  await db.query('ROLLBACK TO SAVEPOINT dupunit');
  const numbers = [];
  for (let i = 0; i < 3; i++)
    numbers.push(Number((await db.query("SELECT next_number('db_test') AS n")).rows[0].n));
  assert.deepEqual(numbers, [1, 2, 3]);
  const sha = 'a'.repeat(64);
  await db.query(
    "INSERT INTO import_batches(id,tenant_id,batch_no,kind,file_name,file_sha256,status,total_rows) VALUES($1,$2,1000001,'units','t.csv',$3,'committed',1)",
    [batch, tenant, sha],
  );
  await db.query(
    'INSERT INTO import_rows(tenant_id,batch_id,line_no,data) VALUES($1,$2,2,\'{"code":"X"}\')',
    [tenant, batch],
  );
  await db.query('SAVEPOINT samefile');
  await assert.rejects(
    () =>
      db.query(
        "INSERT INTO import_batches(id,tenant_id,batch_no,kind,file_name,file_sha256,status,total_rows) VALUES(gen_random_uuid(),$1,1000002,'units','t.csv',$2,'committed',1)",
        [tenant, sha],
      ),
    (e) => e.code === '23505',
  );
  await db.query('ROLLBACK TO SAVEPOINT samefile');
  for (const [name, sql] of [
    ['delete staged rows', 'DELETE FROM import_rows'],
    ['rewrite staged source data', "UPDATE import_rows SET data='{}'"],
    ['delete batches', 'DELETE FROM import_batches'],
  ]) {
    await db.query('SAVEPOINT denied_' + name.replaceAll(' ', '_'));
    await assert.rejects(
      () => db.query(sql),
      (e) => e.code === '42501',
      name,
    );
    await db.query('ROLLBACK TO SAVEPOINT denied_' + name.replaceAll(' ', '_'));
  }
  // AV-1: item masters keep company-scoped references and uniqueness rules in the database itself.
  const isoUnit = (
    await db.query("SELECT id FROM units WHERE code='ISO' AND tenant_id=$1", [tenant])
  ).rows[0].id;
  const denied = async (label, code, sql, params = []) => {
    await db.query('SAVEPOINT av1');
    await assert.rejects(
      () => db.query(sql, params),
      (e) => e.code === code,
      label,
    );
    await db.query('ROLLBACK TO SAVEPOINT av1');
  };
  const hiddenUnit = '20000000-0000-4000-8000-0000000000b9';
  await db.query('RESET ROLE');
  await db.query("SELECT set_config('app.tenant_id','',true)");
  await db.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'HID','Hidden')", [
    hiddenUnit,
    other,
  ]);
  await db.query('SET LOCAL ROLE rare_app');
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  await denied(
    'item cannot use another company unit',
    '23503',
    "INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id) VALUES(gen_random_uuid(),$1,'X1','x','RM','BUY',$2)",
    [tenant, hiddenUnit],
  );
  const itemId = '20000000-0000-4000-8000-0000000000b1';
  await db.query(
    "INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id) VALUES($1,$2,'DBRM','Raw','RM','BUY',$3)",
    [itemId, tenant, isoUnit],
  );
  const suppliers = [
    '20000000-0000-4000-8000-0000000000b2',
    '20000000-0000-4000-8000-0000000000b3',
  ];
  for (const [n, id] of suppliers.entries())
    await db.query(
      'INSERT INTO suppliers(id,tenant_id,code,name,lead_time_days) VALUES($1,$2,$3,$4,7)',
      [id, tenant, 'DBS' + n, 'Supplier ' + n],
    );
  await db.query(
    'INSERT INTO item_suppliers(id,tenant_id,item_id,supplier_id,purchase_unit_id,preferred) VALUES(gen_random_uuid(),$1,$2,$3,$4,true)',
    [tenant, itemId, suppliers[0], isoUnit],
  );
  await denied(
    'second preferred supplier for one item',
    '23505',
    'INSERT INTO item_suppliers(id,tenant_id,item_id,supplier_id,purchase_unit_id,preferred) VALUES(gen_random_uuid(),$1,$2,$3,$4,true)',
    [tenant, itemId, suppliers[1], isoUnit],
  );
  const box = '20000000-0000-4000-8000-0000000000b4';
  await db.query("INSERT INTO units(id,tenant_id,code,name) VALUES($1,$2,'DBBOX','Box')", [
    box,
    tenant,
  ]);
  await db.query(
    'INSERT INTO unit_conversions(id,tenant_id,from_unit_id,to_unit_id,factor) VALUES(gen_random_uuid(),$1,$2,$3,12)',
    [tenant, box, isoUnit],
  );
  await denied(
    'duplicate company-wide conversion',
    '23505',
    'INSERT INTO unit_conversions(id,tenant_id,from_unit_id,to_unit_id,factor) VALUES(gen_random_uuid(),$1,$2,$3,10)',
    [tenant, box, isoUnit],
  );
  await denied(
    'conversion to the same unit',
    '23514',
    'INSERT INTO unit_conversions(id,tenant_id,from_unit_id,to_unit_id,factor) VALUES(gen_random_uuid(),$1,$2,$2,1)',
    [tenant, box],
  );
  for (const table of ['items', 'suppliers', 'customers', 'item_suppliers', 'unit_conversions'])
    await denied('delete ' + table, '42501', `DELETE FROM ${table}`);
  assert.equal((await db.query("SELECT * FROM units WHERE code='HID'")).rowCount, 0);
  console.log(
    'PASS item masters: company-scoped references, one preferred source, unique conversions, no hard deletes',
  );
  // AV-2: plant model keeps plant/company references, one default calendar and unique line keys.
  const site = '20000000-0000-4000-8000-0000000000c1';
  const hiddenSite = '20000000-0000-4000-8000-0000000000c9';
  await db.query('RESET ROLE');
  await db.query("SELECT set_config('app.tenant_id','',true)");
  await db.query("INSERT INTO sites(id,tenant_id,code,name) VALUES($1,$2,'DBP1','Plant')", [
    site,
    tenant,
  ]);
  await db.query("INSERT INTO sites(id,tenant_id,code,name) VALUES($1,$2,'DBPX','Hidden')", [
    hiddenSite,
    other,
  ]);
  await db.query('SET LOCAL ROLE rare_app');
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  await denied(
    'calendar in another company plant',
    '23503',
    "INSERT INTO calendars(id,tenant_id,site_id,code,name,working_days) VALUES(gen_random_uuid(),$1,$2,'X','x','1111100')",
    [tenant, hiddenSite],
  );
  await denied(
    'calendar without working days',
    '23514',
    "INSERT INTO calendars(id,tenant_id,site_id,code,name,working_days) VALUES(gen_random_uuid(),$1,$2,'X','x','0000000')",
    [tenant, site],
  );
  const calendar = '20000000-0000-4000-8000-0000000000c2';
  await db.query(
    "INSERT INTO calendars(id,tenant_id,site_id,code,name,working_days,is_default) VALUES($1,$2,$3,'GEN','General','1111110',true)",
    [calendar, tenant, site],
  );
  await denied(
    'second default calendar in one plant',
    '23505',
    "INSERT INTO calendars(id,tenant_id,site_id,code,name,working_days,is_default) VALUES(gen_random_uuid(),$1,$2,'NIGHT','Night','1111110',true)",
    [tenant, site],
  );
  await db.query(
    "INSERT INTO calendar_shifts(id,tenant_id,calendar_id,sequence,name,start_time,end_time) VALUES(gen_random_uuid(),$1,$2,1,'Day','08:00','16:00')",
    [tenant, calendar],
  );
  await denied(
    'duplicate holiday date',
    '23505',
    "INSERT INTO calendar_holidays(id,tenant_id,calendar_id,holiday_date,name) VALUES(gen_random_uuid(),$1,$2,'2026-10-02','A'),(gen_random_uuid(),$1,$2,'2026-10-02','B')",
    [tenant, calendar],
  );
  const resource = '20000000-0000-4000-8000-0000000000c3';
  await db.query(
    "INSERT INTO resources(id,tenant_id,site_id,code,name,resource_type,machine_count,calendar_id) VALUES($1,$2,$3,'CNC','CNC','MACHINE',2,$4)",
    [resource, tenant, site, calendar],
  );
  for (const [label, machines, efficiency] of [
    ['zero machines', 0, 100],
    ['efficiency above 100', 1, 101],
  ])
    await denied(
      label,
      '23514',
      "INSERT INTO resources(id,tenant_id,site_id,code,name,resource_type,machine_count,efficiency_pct) VALUES(gen_random_uuid(),$1,$2,'R2','x','MACHINE',$3,$4)",
      [tenant, site, machines, efficiency],
    );
  const fg = '20000000-0000-4000-8000-0000000000c4';
  await db.query(
    "INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id) VALUES($1,$2,'DBFG','Finished','FG','MAKE',$3)",
    [fg, tenant, isoUnit],
  );
  const bom = '20000000-0000-4000-8000-0000000000c5';
  await denied(
    'BOM ending before it starts',
    '23514',
    "INSERT INTO boms(id,tenant_id,item_id,revision,effective_from,effective_to) VALUES(gen_random_uuid(),$1,$2,'V0','2026-10-01','2026-09-01')",
    [tenant, fg],
  );
  await db.query(
    "INSERT INTO boms(id,tenant_id,item_id,revision,effective_from) VALUES($1,$2,$3,'V1','2026-10-01')",
    [bom, tenant, fg],
  );
  await denied(
    'duplicate BOM revision (case-insensitive)',
    '23505',
    "INSERT INTO boms(id,tenant_id,item_id,revision,effective_from) VALUES(gen_random_uuid(),$1,$2,'v1','2027-01-01')",
    [tenant, fg],
  );
  await db.query(
    'INSERT INTO bom_lines(id,tenant_id,bom_id,line_no,component_item_id,quantity,unit_id) VALUES(gen_random_uuid(),$1,$2,1,$3,2,$4)',
    [tenant, bom, itemId, isoUnit],
  );
  await denied(
    'same component twice in one BOM',
    '23505',
    'INSERT INTO bom_lines(id,tenant_id,bom_id,line_no,component_item_id,quantity,unit_id) VALUES(gen_random_uuid(),$1,$2,2,$3,1,$4)',
    [tenant, bom, itemId, isoUnit],
  );
  await denied(
    '100% scrap',
    '23514',
    'INSERT INTO bom_lines(id,tenant_id,bom_id,line_no,component_item_id,quantity,unit_id,scrap_pct) VALUES(gen_random_uuid(),$1,$2,3,$3,1,$4,100)',
    [tenant, bom, fg, isoUnit],
  );
  const routing = '20000000-0000-4000-8000-0000000000c6';
  await db.query(
    "INSERT INTO routings(id,tenant_id,site_id,item_id,revision,effective_from) VALUES($1,$2,$3,$4,'V1','2026-10-01')",
    [routing, tenant, site, fg],
  );
  await db.query(
    "INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,resource_id,run_minutes_per_unit) VALUES(gen_random_uuid(),$1,$2,10,'CUT',$3,1.5)",
    [tenant, routing, resource],
  );
  await denied(
    'duplicate operation sequence',
    '23505',
    "INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,resource_id,run_minutes_per_unit) VALUES(gen_random_uuid(),$1,$2,10,'DRILL',$3,1)",
    [tenant, routing, resource],
  );
  await denied(
    'duplicate operation code (case-insensitive)',
    '23505',
    "INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,resource_id,run_minutes_per_unit) VALUES(gen_random_uuid(),$1,$2,20,'cut',$3,1)",
    [tenant, routing, resource],
  );
  await denied(
    'zero run time',
    '23514',
    "INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,resource_id,run_minutes_per_unit) VALUES(gen_random_uuid(),$1,$2,30,'PACK',$3,0)",
    [tenant, routing, resource],
  );
  for (const table of ['calendars', 'resources', 'boms', 'routings'])
    await denied('delete ' + table, '42501', `DELETE FROM ${table}`);
  // Line tables may be replaced as a set by their header save.
  await db.query('SAVEPOINT av2lines');
  await db.query('DELETE FROM routing_operations WHERE routing_id=$1', [routing]);
  await db.query('ROLLBACK TO SAVEPOINT av2lines');
  assert.equal((await db.query('SELECT * FROM sites WHERE id=$1', [hiddenSite])).rowCount, 0);
  console.log(
    'PASS plant model: plant/company references, one default calendar, unique BOM components and operations, CHECK limits, no header deletes',
  );
  await db.query("SELECT set_config('app.tenant_id','',true)");
  assert.equal((await db.query('SELECT * FROM import_batches')).rowCount, 0);
  const pending = await db.query('SELECT * FROM outbox_pending(500)');
  assert.deepEqual(
    pending.fields.map((f) => f.name),
    ['id', 'tenant_id', 'kind'],
  );
  assert.ok(pending.rows.some((r) => r.tenant_id === other && r.kind === 'import.validate'));
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  console.log(
    'PASS availability foundation: unit/import isolation, per-company codes, number series, single file commit, staged rows immutable, outbox dispatch exposes no payloads',
  );
  const plan = await db.query(
    'EXPLAIN (ANALYZE,FORMAT JSON) SELECT id,action,entity_type,created_at FROM audit_log ORDER BY id DESC LIMIT 26',
  );
  const txt = JSON.stringify(plan.rows[0]);
  assert.match(txt, /Index/);
  console.log('PASS tenant isolation, cross-tenant write denial, runtime privilege restrictions');
  console.log(
    'PASS 100,000-row audit query uses an index; execution ms:',
    plan.rows[0]['QUERY PLAN'][0]['Execution Time'],
  );
  await db.query('ROLLBACK');
  assert.equal((await db.query('SELECT * FROM tenants WHERE id=$1', [other])).rowCount, 0);
  console.log('PASS fixtures rolled back; customer data unchanged');
} finally {
  await db.query('ROLLBACK');
  await db.end();
}
