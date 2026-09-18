import { randomUUID } from 'node:crypto';
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
  // Temporary MFA exemption: time-limited, ends automatically, invisible to the runtime role.
  const adminSubject = (await db.query('SELECT identity_id FROM platform_admins LIMIT 1')).rows[0]
    ?.identity_id;
  if (adminSubject) {
    const requires = async () =>
      (await db.query('SELECT identity_requires_mfa($1) AS r', [adminSubject])).rows[0].r;
    assert.equal(await requires(), true);
    await db.query(
      "INSERT INTO mfa_exemptions(identity_id,email,reason,expires_at) VALUES($1,'admin@test','regression',now()+interval '30 days')",
      [adminSubject],
    );
    assert.equal(await requires(), false);
    assert.ok((await db.query('SELECT mfa_exemption_until($1) AS u', [adminSubject])).rows[0].u);
    await db.query(
      "UPDATE mfa_exemptions SET created_at=now()-interval '40 days',expires_at=now()-interval '1 minute' WHERE identity_id=$1",
      [adminSubject],
    );
    assert.equal(await requires(), true, 'an expired exemption requires MFA again');
    await db.query('SAVEPOINT exemption');
    await assert.rejects(
      () =>
        db.query(
          "UPDATE mfa_exemptions SET created_at=now(),expires_at=now()+interval '61 days' WHERE identity_id=$1",
          [adminSubject],
        ),
      (e) => e.code === '23514',
      'exemptions longer than 60 days',
    );
    await db.query('ROLLBACK TO SAVEPOINT exemption');
    await db.query('SET LOCAL ROLE rare_app');
    await db.query('SAVEPOINT exemption');
    await assert.rejects(
      () => db.query('SELECT * FROM mfa_exemptions'),
      (e) => e.code === '42501',
      'runtime cannot read exemptions',
    );
    await db.query('ROLLBACK TO SAVEPOINT exemption');
    await db.query('RESET ROLE');
    await db.query('DELETE FROM mfa_exemptions WHERE identity_id=$1', [adminSubject]);
    console.log(
      'PASS MFA exemption: time-limited (max 60 days), ends automatically, not readable by the runtime',
    );
  }
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
  // AV-3: the stock ledger is append-only, balances follow it and never go negative.
  const store = '20000000-0000-4000-8000-0000000000d1';
  const otherStore = '20000000-0000-4000-8000-0000000000d2';
  await db.query(
    "INSERT INTO stock_locations(id,tenant_id,site_id,code,name,location_type) VALUES($1,$2,$3,'DBSTORE','Store','STORES')",
    [store, tenant, site],
  );
  const movement = (no, type, quantity, extra = {}) =>
    db.query(
      'INSERT INTO stock_movements(id,tenant_id,movement_no,site_id,location_id,item_id,movement_type,quantity,entered_quantity,entered_unit_id,movement_date,reason,external_ref,reverses_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,abs($8::numeric),$9,current_date,$10,$11,$12)',
      [
        extra.id ?? randomUUID(),
        tenant,
        no,
        extra.site ?? site,
        extra.location ?? store,
        itemId,
        type,
        quantity,
        isoUnit,
        extra.reason ?? '',
        extra.ref ?? null,
        extra.reverses ?? null,
      ],
    );
  const opening = '20000000-0000-4000-8000-0000000000d3';
  await movement(9001, 'OPENING', 100, { id: opening, ref: 'DB-OPEN-1' });
  const issue = '20000000-0000-4000-8000-0000000000d5';
  await movement(9002, 'ISSUE', -40, { id: issue });
  await db.query('SAVEPOINT av3');
  await assert.rejects(
    () => movement(9003, 'ISSUE', -61),
    (e) => e.code === '23514' && e.constraint === 'stock_not_negative',
    'issue below zero',
  );
  await db.query('ROLLBACK TO SAVEPOINT av3');
  for (const [label, run] of [
    ['issue with a positive quantity', () => movement(9004, 'ISSUE', 5)],
    ['adjustment without a reason', () => movement(9005, 'ADJUSTMENT', 5)],
    ['reversal without the original', () => movement(9006, 'REVERSAL', -5, { reason: 'x' })],
    ['movement number reused', () => movement(9001, 'RECEIPT', 5)],
    [
      'external reference reused in another case',
      () => movement(9007, 'RECEIPT', 5, { ref: 'db-open-1' }),
    ],
    ['location from another plant', () => movement(9008, 'RECEIPT', 5, { site: hiddenSite })],
  ]) {
    await db.query('SAVEPOINT av3');
    await assert.rejects(run, (e) => ['23514', '23505', '23503'].includes(e.code), label);
    await db.query('ROLLBACK TO SAVEPOINT av3');
  }
  await movement(9009, 'REVERSAL', 40, { reverses: issue, reason: 'Issued by mistake' });
  await db.query('SAVEPOINT av3');
  await assert.rejects(
    () => movement(9010, 'REVERSAL', 40, { reverses: issue, reason: 'Twice' }),
    (e) => e.code === '23505',
    'second reversal of one movement',
  );
  await db.query('ROLLBACK TO SAVEPOINT av3');
  const ledger = (
    await db.query(
      'SELECT b.quantity, (SELECT sum(m.quantity) FROM stock_movements m WHERE m.location_id=b.location_id AND m.item_id=b.item_id) AS ledger FROM stock_balances b WHERE b.location_id=$1',
      [store],
    )
  ).rows[0];
  assert.equal(Number(ledger.quantity), Number(ledger.ledger));
  for (const [label, sql] of [
    ['edit a posted movement', 'UPDATE stock_movements SET quantity=1'],
    ['delete a posted movement', 'DELETE FROM stock_movements'],
    ['write balances directly', 'UPDATE stock_balances SET quantity=1000'],
    [
      'insert balances directly',
      `INSERT INTO stock_balances(tenant_id,site_id,location_id,item_id,quantity,last_movement_no) VALUES('${tenant}','${site}','${store}','${fg}',5,1)`,
    ],
    ['delete orders', 'DELETE FROM sales_orders'],
    ['delete order lines', 'DELETE FROM sales_order_lines'],
    ['delete purchase orders', 'DELETE FROM purchase_orders'],
    ['delete demand history', 'DELETE FROM demand_history'],
    ['delete stock locations', 'DELETE FROM stock_locations'],
  ])
    await denied(label, '42501', sql);
  const customer = '20000000-0000-4000-8000-0000000000d4';
  await db.query(
    "INSERT INTO customers(id,tenant_id,code,name,customer_type) VALUES($1,$2,'DBC','Customer','OEM')",
    [customer, tenant],
  );
  await db.query(
    "INSERT INTO sales_orders(id,tenant_id,site_id,order_no,customer_id,order_date,promise_date) VALUES(gen_random_uuid(),$1,$2,'DB-SO-1',$3,'2026-09-01','2026-09-10')",
    [tenant, site, customer],
  );
  await denied(
    'duplicate order number in another case',
    '23505',
    "INSERT INTO sales_orders(id,tenant_id,site_id,order_no,customer_id,order_date,promise_date) VALUES(gen_random_uuid(),$1,$2,'db-so-1',$3,'2026-09-01','2026-09-10')",
    [tenant, site, customer],
  );
  await denied(
    'promise before order date',
    '23514',
    "INSERT INTO sales_orders(id,tenant_id,site_id,order_no,customer_id,order_date,promise_date) VALUES(gen_random_uuid(),$1,$2,'DB-SO-2',$3,'2026-09-10','2026-09-01')",
    [tenant, site, customer],
  );
  await denied(
    'negative demand history',
    '23514',
    "INSERT INTO demand_history(tenant_id,site_id,item_id,demand_date,quantity) VALUES($1,$2,$3,'2026-09-01',-1)",
    [tenant, site, itemId],
  );
  await db.query('RESET ROLE');
  await db.query("SELECT set_config('app.tenant_id','',true)");
  await db.query(
    "INSERT INTO stock_locations(id,tenant_id,site_id,code,name,location_type) VALUES($1,$2,$3,'HIDDEN','Hidden','STORES')",
    [otherStore, other, hiddenSite],
  );
  await db.query('SET LOCAL ROLE rare_app');
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  assert.equal(
    (await db.query('SELECT * FROM stock_locations WHERE id=$1', [otherStore])).rowCount,
    0,
  );
  await denied(
    'movement into another company location',
    '42501',
    "INSERT INTO stock_movements(id,tenant_id,movement_no,site_id,location_id,item_id,movement_type,quantity,entered_quantity,entered_unit_id,movement_date) VALUES(gen_random_uuid(),$1,9100,$2,$3,$4,'RECEIPT',1,1,$5,current_date)",
    [other, hiddenSite, otherStore, itemId, isoUnit],
  );
  console.log(
    'PASS demand and stock: append-only ledger, balances equal the ledger and never go negative, one reversal, unique references and order numbers, no deletes, company isolation',
  );
  // AV-4: planning inputs leave change markers; results are derived; runs promote in queue order.
  await db.query('DELETE FROM planning_input_events');
  await db.query(
    "INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id) VALUES(gen_random_uuid(),$1,'DBPLAN','Plan','RM','BUY',$2)",
    [tenant, isoUnit],
  );
  assert.ok(
    (await db.query('SELECT count(*)::int AS n FROM planning_input_events')).rows[0].n >= 1,
    'an input change leaves a marker',
  );
  const profile = '20000000-0000-4000-8000-0000000000e1';
  await db.query(
    "INSERT INTO buffer_profiles(id,tenant_id,code,name,red_base_pct,green_pct) VALUES($1,$2,'DBBP','Profile',50,50)",
    [profile, tenant],
  );
  await denied(
    'buffered item without a profile',
    '23514',
    "INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy) VALUES(gen_random_uuid(),$1,$2,$3,'BUFFER')",
    [tenant, site, itemId],
  );
  await db.query(
    "INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy,profile_id) VALUES(gen_random_uuid(),$1,$2,$3,'BUFFER',$4)",
    [tenant, site, itemId, profile],
  );
  await denied(
    'second setting for the same plant and item',
    '23505',
    "INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy) VALUES(gen_random_uuid(),$1,$2,$3,'MTO')",
    [tenant, site, itemId],
  );
  await db.query('INSERT INTO planning_state(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [
    tenant,
  ]);
  const runs = {};
  for (const n of [7, 5]) {
    runs[n] = randomUUID();
    await db.query(
      "INSERT INTO planning_runs(id,tenant_id,run_no,trigger,input_version) VALUES($1,$2,$3,'auto',0)",
      [runs[n], tenant, 900000 + n],
    );
  }
  const promote = async (n) =>
    (await db.query('SELECT promote_planning_run($1,$2) AS ok', [runs[n], 900000 + n])).rows[0].ok;
  assert.equal(await promote(7), true);
  assert.equal(await promote(5), false, 'an earlier-queued run finishing later is not promoted');
  assert.equal(
    (await db.query('SELECT current_run_id FROM planning_state')).rows[0].current_run_id,
    runs[7],
  );
  await db.query(
    "INSERT INTO planning_results(tenant_id,run_id,site_id,item_id,policy,status,adu,on_hand,open_supply,qualified_demand,spike_demand,outside_horizon) VALUES($1,$2,$3,$4,'BUFFER','planned',1,0,0,0,0,0)",
    [tenant, runs[7], site, itemId],
  );
  for (const [label, sql] of [
    ['rewrite a planning result', 'UPDATE planning_results SET nfp=1'],
    ['delete buffer profiles', 'DELETE FROM buffer_profiles'],
    ['delete buffer settings', 'DELETE FROM item_buffers'],
    ['delete planning runs', 'DELETE FROM planning_runs'],
  ])
    await denied(label, '42501', sql);
  const due = await db.query('SELECT * FROM planning_due(100)');
  assert.deepEqual(
    due.fields.map((f) => f.name),
    ['tenant_id'],
  );
  await db.query('RESET ROLE');
  await db.query("SELECT set_config('app.tenant_id','',true)");
  await db.query('INSERT INTO planning_input_events(tenant_id) VALUES($1)', [other]);
  await db.query('SET LOCAL ROLE rare_app');
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  assert.equal(
    (await db.query('SELECT * FROM planning_input_events WHERE tenant_id=$1', [other])).rowCount,
    0,
  );
  console.log(
    'PASS material buffers: input change markers, profile required for buffers, one setting per plant and item, queue-order promotion, derived results not editable, company isolation',
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
