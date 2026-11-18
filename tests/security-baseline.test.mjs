import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

function sourceFiles() {
  const roots = ['apps', 'packages', 'scripts', 'db', 'infra', '.github'];
  const allowed = new Set([
    '',
    '.cjs',
    '.css',
    '.ftl',
    '.html',
    '.java',
    '.js',
    '.json',
    '.mjs',
    '.sh',
    '.sql',
    '.ts',
    '.tsx',
    '.yaml',
    '.yml',
  ]);
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['dist', 'node_modules', '.local'].includes(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && allowed.has(extname(entry.name))) files.push(full);
    }
  }
  for (const path of roots) walk(join(root, path));
  for (const path of [
    'compose.yaml',
    'compose.hostinger.yaml',
    'package.json',
    'package-lock.json',
  ])
    files.push(join(root, path));
  return files;
}

test('tracked source has no high-confidence secret or executable-code patterns', () => {
  const findings = [];
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['dynamic evaluation', /(?:^|[^\w.])(?:eval|new Function)\s*\(/m],
  ];
  for (const file of sourceFiles()) {
    const content = readFileSync(file, 'utf8');
    for (const [name, pattern] of patterns)
      if (pattern.test(content)) findings.push(`${relative(root, file)}: ${name}`);
  }
  assert.deepEqual(findings, []);
  assert.doesNotMatch(
    read('apps/web/src/main.tsx') + read('apps/web/src/security.tsx'),
    /dangerouslySetInnerHTML/,
  );
});

test('database privilege boundaries retain RLS and hardened security-definer functions', () => {
  const migrations = readdirSync(join(root, 'db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => read(`db/migrations/${name}`))
    .join('\n');
  assert.match(migrations, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(migrations, /GRANT\s+ALL\b[^;]*\bTO\s+rare_(?:app|keycloak)\b/i);
  const functions = [
    ...migrations.matchAll(
      /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+([a-z_][a-z0-9_]*)[^;]*?SECURITY DEFINER\s+SET search_path=public,pg_temp/gi,
    ),
  ].map((match) => match[1]);
  assert.ok(functions.length >= 6, 'expected all privileged helper functions to be found');
  for (const name of new Set(functions))
    assert.match(migrations, new RegExp(`REVOKE ALL ON FUNCTION[^;]*\\b${name}\\(`, 'i'));
});

test('RCH-0 uploads and field data keep their boundaries in the source itself', () => {
  const migration = read('db/migrations/029_reach_foundation.sql');
  const reachTables = [
    'territories',
    'rep_grades',
    'leave_types',
    'field_reps',
    'holidays',
    'stored_files',
  ];
  // Removal is a stamp, so the runtime role must never hold DELETE on field data.
  const grants = [...migration.matchAll(/GRANT ([^;]*?) ON ([^;]*?) TO rare_app/gi)];
  assert.ok(grants.length, 'the migration grants nothing to the runtime role');
  for (const [, privileges, tables] of grants)
    if (reachTables.some((t) => tables.includes(t)))
      assert.doesNotMatch(privileges, /\bDELETE\b/i, `DELETE granted on ${tables.trim()}`);
  // Every one of them is row-level scoped to a company, and keeps removed rows out of its
  // uniqueness rule so a removed code can be used again.
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  for (const table of reachTables)
    assert.ok(
      new RegExp(`'${table}'`).test(migration),
      `${table} is not in the row-level-security list`,
    );
  // The path a file is read from is derived from its own checksum and checked every time, and the
  // bytes are never put in the database.
  const store = read('apps/api/src/file-store.ts');
  assert.match(store, /isStorageKey\(key\)/);
  assert.match(store, /full\.startsWith\(root \+ sep\)/);
  assert.doesNotMatch(store, /req\.(?:query|params|headers|body)/);
  assert.doesNotMatch(migration, /content bytea/);
  // What may be stored is decided from the bytes, with an allowlist, a size cap and a pixel cap.
  const rules = read('packages/engines/file-bytes.mjs');
  for (const required of [
    'FILE_TYPE_MISMATCH',
    'UNSUPPORTED_FILE_TYPE',
    'FILE_TOO_LARGE',
    'IMAGE_TOO_LARGE',
  ])
    assert.ok(rules.includes(required), `upload rules are missing ${required}`);
  // Uploads arrive as bytes on one route only, typed and capped.
  assert.match(
    read('apps/api/src/main.ts'),
    /app\.use\('\/api\/files', raw\(\{ type: UPLOAD_TYPES, limit: MAX_FILE_BYTES \}\)\)/,
  );
  // A file is served with the type it was stored as, never sniffed, and a PDF is a download.
  const controller = read('apps/api/src/reach.controller.ts');
  assert.match(controller, /'X-Content-Type-Options', 'nosniff'/);
  assert.match(controller, /shown \? 'inline' : 'attachment'/);
  // Only the application's user writes to the volume. The directory is setgid and group-readable
  // so the backup job can read it as a member of that group rather than as root, and the backup
  // job's mount is read-only, so it cannot change a photo.
  assert.match(read('infra/docker/Dockerfile'), /chmod 2750 \/var\/lib\/rare-os\/files/);
  const opsImage = read('infra/ops/Ops.Dockerfile');
  assert.match(opsImage, /addgroup -g 1000 appdata/);
  assert.match(opsImage, /addgroup ops appdata/);
  assert.match(opsImage, /USER ops/);
  const ops = read('compose.yaml');
  assert.match(ops, /volumes: \[opsstate:\/state, 'filedata:\/files:ro'\]/);
  assert.doesNotMatch(ops, /filedata:\/files(?!:ro)/);
});

test('RCH-1 customers, tags and rounds keep their boundaries in the source itself', () => {
  const migration = read('db/migrations/030_reach_customers.sql');
  const keepers = [
    'reach_settings',
    'customer_types',
    'customer_form_fields',
    'customer_form_rules',
    'beats',
    'trade_customers',
    'beat_assignments',
    'customer_geo_log',
  ];
  // A customer, a decision and a tag are records to keep: the runtime role never gets DELETE on
  // them. A beat's stops are the one exception, because a round has to stay a clean 1..n.
  for (const [, privileges, tables] of migration.matchAll(
    /GRANT ([^;]*?) ON ([^;]*?) TO rare_app/gi,
  ))
    if (keepers.some((t) => new RegExp(`\\b${t}\\b`).test(tables)))
      assert.doesNotMatch(privileges, /\bDELETE\b/i, `DELETE granted on ${tables.trim()}`);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON beat_outlets TO rare_app/);
  for (const table of [...keepers, 'beat_outlets'])
    assert.ok(new RegExp(`'${table}'`).test(migration), `${table} is not row-level scoped`);
  // A position in a round is unique, and the check is deferred only so a re-order can swap past
  // itself inside one transaction — it is never dropped.
  assert.match(migration, /beat_outlets_order_uniq UNIQUE \(tenant_id, beat_id, sequence\)/);
  assert.match(migration, /DEFERRABLE INITIALLY IMMEDIATE/);
  // One pending move per shop, so two reps cannot queue conflicting re-tags.
  assert.match(migration, /customer_geo_log_pending_idx[\s\S]{0,160}WHERE status = 'PENDING'/);

  const controller = read('apps/api/src/reach-customers.controller.ts');
  // A coordinate off the planet is a typo somebody has to see, not a number to round.
  assert.match(controller, /function coordinate\(/);
  assert.match(controller, /coordinate\(raw\.latitude, 'Latitude', 90\)/);
  assert.match(controller, /coordinate\(raw\.longitude, 'Longitude', 180\)/);
  // Filters are an allowlist, so a hand-made link cannot widen what a reader sees.
  assert.match(controller, /STATUSES\.includes\(status\)/);
  assert.match(controller, /GEO_FILTERS\.includes\(geo\)/);
  assert.match(controller, /GEO_SOURCES\.includes\(raw\.source\)/);
  // Deciding is its own permission, and a rejection has to carry a reason.
  for (const required of [
    "mutate(req, 'reach.approve'",
    "mutate(req, 'reach.setup'",
    "mutate(req, 'reach.delete'",
    'REASON_REQUIRED',
  ])
    assert.ok(controller.includes(required), `the controller is missing ${required}`);
  // Answers are judged against the type's own form, and an unasked key is refused rather than
  // stored where no screen would ever show it.
  assert.match(read('packages/schema/customers-db.mjs'), /This customer type is not asked for/);
});

test('RCH-2 attendance keeps every record it writes, and a rep marks only their own day', () => {
  const migration = read('db/migrations/031_reach_attendance.sql');
  const tables = ['work_types', 'shifts', 'attendance_days', 'leave_requests', 'attendance_edits'];
  // A punch, a leave decision and a correction are all records of what happened. Nothing here is
  // ever deleted — it is cancelled or superseded — so the runtime role gets no DELETE at all.
  for (const [, privileges, granted] of migration.matchAll(
    /GRANT ([^;]*?) ON ([^;]*?) TO rare_app/gi,
  ))
    assert.doesNotMatch(privileges, /\bDELETE\b/i, `DELETE granted on ${granted.trim()}`);
  for (const table of tables)
    assert.ok(new RegExp(`'${table}'`).test(migration), `${table} is not row-level scoped`);

  // One day per rep, and one correction in flight per day, so two writes cannot race into each
  // other and leave a register nobody can explain.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX attendance_days_rep_date_idx ON attendance_days\(tenant_id, rep_id, work_date\)/,
  );
  assert.match(migration, /attendance_edits_pending_idx[\s\S]{0,160}WHERE status = 'PENDING'/);
  // A correction has to change something, and a rejection has to say why.
  assert.match(
    migration,
    /CHECK \(requested_start_at IS NOT NULL OR requested_end_at IS NOT NULL\)/,
  );
  for (const table of ['leave_requests', 'attendance_edits'])
    assert.ok(
      migration.includes("CHECK (status <> 'REJECTED' OR decision_reason <> '')"),
      `${table} allows a rejection with no reason`,
    );

  const controller = read('apps/api/src/reach-attendance.controller.ts');
  // The rep is read from the signed-in login. A rep id in a request body is never trusted, so
  // nobody can mark, withdraw or correct somebody else's day.
  assert.match(controller, /repForUser\(db, actor\.id\)/);
  assert.doesNotMatch(controller, /body\(req, \[[^\]]*'rep_id'/);
  assert.match(controller, /You may only withdraw your own request/);
  assert.match(controller, /You may only read your own attendance/);
  // Marking a day, deciding leave and changing setup are three different rights.
  for (const required of [
    "mutate(req, 'reach.attend'",
    "mutate(req, 'reach.leave'",
    "mutate(req, 'reach.setup'",
    "access(req, 'reach.read')",
  ])
    assert.ok(controller.includes(required), `the controller is missing ${required}`);
  // A coordinate off the planet is a typo somebody has to see, not a number to round.
  assert.match(controller, /coordinate\(raw\.latitude, 'Latitude', 90\)/);
  assert.match(controller, /coordinate\(raw\.longitude, 'Longitude', 180\)/);
  assert.match(controller, /GEO_SOURCES\.includes\(source\)/);
  assert.match(controller, /LEAVE_DECISIONS\.includes\(status\)/);
  // One request can ask for at most a year, so it cannot walk a company's whole history.
  assert.match(controller, /MAX_SPAN_DAYS = 366/);
  // The export is served as a file and never sniffed as something a browser would run.
  assert.match(controller, /'X-Content-Type-Options', 'nosniff'/);
  assert.match(controller, /Content-Disposition[\s\S]{0,40}attachment/);

  // The register is calculated, never stored: the punch table keeps no status column to drift
  // away from the evidence it was derived from.
  const punchTable = /CREATE TABLE attendance_days[\s\S]*?\n\);/i.exec(migration)?.[0] ?? '';
  assert.ok(punchTable, 'attendance_days is not declared in the migration');
  assert.doesNotMatch(punchTable, /\bstatus\b/i);

  // One settings row holds every Reach setting, so a partial save must not blank its neighbours.
  assert.match(
    read('packages/schema/customers-db.mjs'),
    /value\[c\] === undefined \? current\[c\] : value\[c\]/,
  );
});

test('RCH-3 tour plans are built by the rep who walks them, and nothing is deleted', () => {
  const migration = read('db/migrations/032_reach_tour_plan.sql');
  const tables = ['tour_plans', 'tour_plan_days', 'tour_plan_changes', 'visits'];
  // A plan, the decision taken on it, a change request and a visit are all records of what was
  // intended or what happened. Nothing here is ever deleted, so the runtime role gets no DELETE.
  for (const [, privileges, granted] of migration.matchAll(
    /GRANT ([^;]*?) ON ([^;]*?) TO rare_app/gi,
  ))
    assert.doesNotMatch(privileges, /\bDELETE\b/i, `DELETE granted on ${granted.trim()}`);
  for (const table of tables)
    assert.ok(new RegExp(`'${table}'`).test(migration), `${table} is not row-level scoped`);

  // One plan per rep per month, and one change in flight per day, so two writes cannot race into
  // each other and leave a month nobody can explain.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX tour_plans_rep_month_idx ON tour_plans\(tenant_id, rep_id, plan_month\)/,
  );
  assert.match(migration, /tour_plan_changes_pending_idx[\s\S]{0,160}WHERE status = 'PENDING'/);
  // A month is one value, not a pair of dates to keep in step.
  assert.match(migration, /CHECK \(plan_month = date_trunc\('month', plan_month\)::date\)/);
  // Sending a month back or rejecting a change without saying why teaches the rep nothing.
  assert.match(migration, /CHECK \(status <> 'SENT_BACK' OR decision_reason <> ''\)/);
  assert.match(migration, /CHECK \(status <> 'REJECTED' OR decision_reason <> ''\)/);

  const controller = read('apps/api/src/reach-tour.controller.ts');
  // The rep is read from the signed-in login. A rep id in a request body is never trusted, so
  // nobody builds, submits or moves a day on somebody else's month.
  assert.match(controller, /repForUser\(db, actor\.id\)/);
  assert.doesNotMatch(controller, /body\(req, \[[^\]]*'rep_id'/);
  assert.match(controller, /A tour plan is built by the rep who walks it/);
  assert.match(controller, /You may only read your own tour plan/);
  // Building a month, deciding one and changing the numbers it is judged by are three rights.
  for (const required of [
    "mutate(req, 'reach.plan'",
    "mutate(req, 'reach.plan_approve'",
    "mutate(req, 'reach.setup'",
    "access(req, 'reach.read')",
  ])
    assert.ok(controller.includes(required), `the controller is missing ${required}`);
  // A month stops being editable the moment it is submitted, and after approval a day moves by
  // request. Both are refused in the controller, not only hidden in the screens.
  assert.match(controller, /EDITABLE\.includes\(plan!\.status\)/);
  assert.match(controller, /Only an approved month moves a day by request/);
  // Every decision and every status is checked against a list the code declares.
  assert.match(controller, /PLAN_DECISIONS\.includes\(status\)/);
  assert.match(controller, /CHANGE_DECISIONS\.includes\(status\)/);
  // One request can ask for at most a year, so it cannot walk a company's whole history.
  assert.match(controller, /MAX_SPAN_DAYS = 366/);
  // A rep cannot plan a round they do not hold, and cannot name a town the round does not pass
  // through: the town is taken from the beat, never from the request body.
  assert.match(controller, /That round is not one this rep holds in this month/);
  assert.doesNotMatch(controller, /body\(req, \[[^\]]*'town'/);

  // Plan versus actual is calculated, never stored: the plan tables keep no verdict column to
  // drift away from the evidence it came from. This is what lets leave approved after the plan
  // was built stop a day counting as missed.
  for (const table of ['tour_plans', 'tour_plan_days']) {
    const declared =
      new RegExp(`CREATE TABLE ${table}[\\s\\S]*?\\n\\);`, 'i').exec(migration)?.[0] ?? '';
    assert.ok(declared, `${table} is not declared in the migration`);
    for (const word of ['FOLLOWED', 'PARTIAL', 'DEVIATED', 'MISSED', 'adherence'])
      assert.ok(!declared.includes(word), `${table} stores ${word}, which must be calculated`);
  }

  // A check-in from outside a shop's radius is recorded and flagged, never refused: rejecting it
  // loses a real visit and teaches the salesman to distrust the app.
  assert.match(migration, /out_of_fence boolean NOT NULL DEFAULT false/);
});

test('RCH-4 records every call, never refuses one for being far away, and never duplicates it', () => {
  const migration = read('db/migrations/033_reach_visits.sql');
  // The report form is setup like any other master; the visit itself was granted by 032. Nothing
  // in either file may be deleted by the runtime role.
  for (const [, privileges, granted] of migration.matchAll(
    /GRANT ([^;]*?) ON ([^;]*?) TO rare_app/gi,
  ))
    assert.doesNotMatch(privileges, /\bDELETE\b/i, `DELETE granted on ${granted.trim()}`);
  for (const table of ['visit_form_fields', 'visit_form_rules'])
    assert.ok(new RegExp(`'${table}'`).test(migration), `${table} is not row-level scoped`);

  // The two indexes that make a retry on a bad line safe rather than hopeful.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX visits_open_idx ON visits\(tenant_id, rep_id, customer_id\)\s*\n\s*WHERE checked_out_at IS NULL/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX visits_client_ref_idx ON visits\(tenant_id, client_ref\)\s*\n\s*WHERE client_ref <> ''/,
  );
  // Time does not run backwards, and a place can only be recorded for a visit that has ended.
  assert.match(migration, /CHECK \(checked_out_at IS NULL OR checked_out_at >= checked_in_at\)/);
  assert.match(migration, /visits_out_needs_checkout/);

  // There is nothing in this migration that can refuse a check-in for being far from the shop.
  // `out_of_fence` is evidence, not a gate: no constraint may test it. The prose is stripped
  // first, because this file argues the point in words as well as in SQL.
  const sqlOnly = migration.replace(/--.*$/gm, '');
  assert.doesNotMatch(sqlOnly, /CHECK\s*\([^)]*out_of_fence/i);
  assert.doesNotMatch(sqlOnly, /CHECK\s*\([^)]*distance_m/i);

  // How a visit reads is calculated: no status, no duration and no "report complete" column.
  for (const column of ['status', 'duration', 'report_complete', 'minutes'])
    assert.ok(
      !new RegExp(`ADD COLUMN ${column}\\b`, 'i').test(migration),
      `visits stores ${column}, which must be calculated`,
    );

  const controller = read('apps/api/src/reach-visit.controller.ts');
  // The rep is read from the signed-in login. A rep id in a request body is never trusted.
  assert.match(controller, /repForUser\(db, actor\.id\)/);
  assert.doesNotMatch(controller, /body\(req, \[[^\]]*'rep_id'/);
  assert.match(controller, /You may only check out of your own visit/);
  assert.match(controller, /You may only correct your own report/);
  assert.match(controller, /You may only read your own visits/);
  // Calling on a shop, reading everyone's day and changing the setup are three rights.
  for (const required of [
    "mutate(req, 'reach.visit'",
    "mutate(req, 'reach.setup'",
    "access(req, 'reach.read')",
  ])
    assert.ok(controller.includes(required), `the controller is missing ${required}`);
  // A coordinate off the planet is a typo somebody has to see, not a number to round.
  assert.match(controller, /coordinate\(raw\.latitude, 'Latitude', 90\)/);
  assert.match(controller, /coordinate\(raw\.longitude, 'Longitude', 180\)/);
  assert.match(controller, /GEO_SOURCES\.includes\(source\)/);
  // One request can ask for at most a year, so it cannot walk a company's whole history.
  assert.match(controller, /MAX_SPAN_DAYS = 366/);
  // The export is served as a file and never sniffed as something a browser would run.
  assert.match(controller, /'X-Content-Type-Options', 'nosniff'/);
  assert.match(controller, /Content-Disposition[\s\S]{0,40}attachment/);
  // A repeat is answered with the visit that already exists rather than refused.
  assert.match(controller, /repeated: true/);
  // An answer the form never asked for is refused rather than stored.
  assert.match(read('packages/schema/visit-db.mjs'), /validateAnswers\(form, raw\)/);
});

test('RCH-5 holds an order rather than refusing it, and never stores what it works out', () => {
  const migration = read('db/migrations/034_reach_trade.sql');
  // An order, a bill, a collection and a KYC decision are records of what happened. None of
  // them may be deleted by the runtime role; they are cancelled, never removed.
  for (const [, privileges, granted] of migration.matchAll(
    /GRANT ([^;]*?) ON ([^;]*?) TO rare_app/gi,
  ))
    assert.doesNotMatch(privileges, /\bDELETE\b/i, `DELETE granted on ${granted.trim()}`);
  for (const table of [
    'kyc_types',
    'kyc_rules',
    'kyc_documents',
    'price_list_items',
    'trade_schemes',
    'trade_orders',
    'trade_order_lines',
    'trade_invoices',
    'trade_invoice_lines',
    'trade_receipts',
    'invoice_series',
  ])
    assert.ok(new RegExp(`'${table}'`).test(migration), `${table} is not row-level scoped`);

  // The two numbering authorities are told apart by the table itself, not by a convention: a
  // bill this module raised has a series and a recorded one never does.
  assert.match(migration, /CHECK \(\(source = 'RAISED'\) = \(series_id IS NOT NULL\)\)/);
  assert.match(
    migration,
    /CHECK \(source <> 'RAISED' OR \(taxable IS NOT NULL AND gst IS NOT NULL\)\)/,
  );
  // One number per company, prefix and year, and a counter that only ever goes up: a cancelled
  // bill keeps its number used, which is what a gapless series means in practice.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX invoice_series_key_idx ON invoice_series\(tenant_id, lower\(prefix\), fy\)/,
  );
  assert.match(migration, /next_no integer NOT NULL DEFAULT 1 CHECK \(next_no >= 1\)/);
  // One bill number may only be recorded once.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX trade_invoices_no_idx ON trade_invoices\(tenant_id, lower\(invoice_no\)\)/,
  );
  // Every document uploaded inside one transaction needs its own moment, or "the newest one"
  // is undecidable and a re-upload after a rejection never takes effect.
  assert.match(migration, /uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/);

  // Nothing a screen works out may be stored. A column for any of these would be a second
  // version of the truth that somebody has to remember to rewrite.
  const sqlOnly = migration.replace(/--.*$/gm, '');
  for (const column of [
    'outstanding',
    'credit_hold',
    'on_hold',
    'kyc_status',
    'dso',
    'ageing_bucket',
    'age_days',
  ])
    assert.ok(
      !new RegExp(`\\b${column}\\s+(numeric|integer|boolean|text|date)`, 'i').test(sqlOnly),
      `the schema stores ${column}, which must be calculated`,
    );
  // Nothing in this migration can refuse an order for credit or for paperwork: a hold is
  // recorded on the order, never enforced by a constraint.
  assert.doesNotMatch(sqlOnly, /CHECK\s*\([^)]*credit_limit[^)]*total/i);
  assert.doesNotMatch(sqlOnly, /CHECK\s*\([^)]*hold_reasons[^)]*=\s*'\{\}'/i);

  const controller = read('apps/api/src/reach-trade.controller.ts');
  // The rep is the signed-in login. A rep id in a request body is never read, so nobody takes
  // an order or banks a collection in somebody else's name.
  assert.match(controller, /repForUser\(db, actor\.id\)/);
  assert.doesNotMatch(controller, /body\(req, \[[^\]]*'rep_id'/);
  assert.match(controller, /You may only read your own orders/);
  assert.match(controller, /You may only cancel your own order/);
  assert.match(controller, /You may only cancel your own receipt/);
  // An order past the limit is taken and held, not refused.
  assert.match(controller, /taken and held/);
  // Both ways a bill arrives sit behind one right, so granting nobody that right means no bill
  // is ever raised here and every one arrives from an ERP. There is no setting to deploy.
  for (const required of [
    "mutate(req, 'reach.invoice'",
    "mutate(req, 'reach.order'",
    "mutate(req, 'reach.collect'",
    "mutate(req, 'reach.kyc'",
    "mutate(req, 'reach.credit'",
    "mutate(req, 'reach.setup'",
    "access(req, 'reach.read')",
  ])
    assert.ok(controller.includes(required), `the controller is missing ${required}`);
  // Releasing a hold and deciding a document are decisions, and each one carries its reason.
  assert.match(controller, /text\(raw\.reason, 'Reason', 1, 300\)/);
  // A recorded bill may never claim this module's own numbering authority.
  assert.match(controller, /INVOICE_SOURCES = \['MANUAL', 'IMPORT', 'ERP'\]/);
  // One request may ask for at most a year, and a basket is a basket.
  assert.match(controller, /MAX_SPAN_DAYS = 366/);
  assert.match(controller, /MAX_LINES = 200/);
  // Money finer than a paisa is refused rather than silently rounded.
  assert.match(controller, /cannot be finer than a paisa/);
  // Lines sent with a recorded bill have to agree with what the bill says it came to.
  assert.match(controller, /The lines come to/);

  const db = read('packages/schema/trade-db.mjs');
  // The number is read and advanced in one statement, so two people billing at the same moment
  // cannot be handed the same one.
  assert.match(
    db,
    /ON CONFLICT \(tenant_id,lower\(prefix\),fy\)\s*\n?\s*DO UPDATE SET next_no = invoice_series\.next_no \+ 1/,
  );
  assert.doesNotMatch(db, /SELECT next_no[\s\S]{0,200}UPDATE invoice_series SET next_no/);
  // The newest document is decided by a stable order, not by whichever row came back first.
  assert.match(db, /ORDER BY (d\.)?uploaded_at DESC, (d\.)?id DESC/);

  // The hold reasons the engine can give are the ones the catalogue knows about.
  const engine = read('packages/engines/trade.mjs');
  for (const reason of ['OVER_LIMIT', 'OVERDUE', 'KYC', 'APPROVAL', 'INACTIVE'])
    assert.ok(new RegExp(`${reason}:`).test(engine), `HOLD_REASONS is missing ${reason}`);
  // Rates keep four decimals so a bulk list quoting 0.3333 a piece does not lose its precision
  // on the way to a total; only the amounts a rate produces are rounded to the paisa.
  assert.match(engine, /const unitRate = \(value\) => \{[\s\S]{0,160}10000\) \/ 10000/);
  assert.match(engine, /const price = unitRate\(rate\)/);
});

test('production gateways and images retain baseline VAPT hardening', () => {
  const nginx = read('infra/docker/nginx.conf');
  for (const required of [
    'server_tokens off',
    'X-Content-Type-Options nosniff',
    'X-Frame-Options DENY',
    'Permissions-Policy',
    "object-src 'none'",
    "frame-ancestors 'none'",
  ])
    assert.ok(nginx.includes(required), `nginx is missing ${required}`);

  const caddy = read('infra/docker/Caddyfile');
  for (const required of [
    '-Server',
    'Strict-Transport-Security',
    'X-Content-Type-Options nosniff',
    'X-Frame-Options DENY',
    '@management path /admin /admin/* /metrics /metrics/* /health /health*',
  ])
    assert.ok(caddy.includes(required), `Caddy is missing ${required}`);

  const appImage = read('infra/docker/Dockerfile');
  assert.match(
    appImage,
    /FROM node:24-alpine3\.23 AS runtime[\s\S]*?apk upgrade --no-cache[\s\S]*?USER node[\s\S]*?HEALTHCHECK/,
  );
  assert.match(
    appImage,
    /FROM alpine:3\.23 AS web[\s\S]*?apk upgrade --no-cache[\s\S]*?USER nginx[\s\S]*?HEALTHCHECK/,
  );
  const postgresImage = read('infra/docker/Postgres.Dockerfile');
  assert.match(
    postgresImage,
    /FROM postgres:16-alpine3\.23[\s\S]*apk upgrade --no-cache[\s\S]*rm -f \/usr\/local\/bin\/gosu[\s\S]*USER postgres/,
  );
  const caddyImage = read('infra/docker/Caddy.Dockerfile');
  assert.match(
    caddyImage,
    /FROM caddy:2\.11\.4-alpine[\s\S]*apk upgrade --no-cache[\s\S]*USER caddy/,
  );

  const identityImage = read('infra/keycloak/Dockerfile');
  assert.match(identityImage, /netty-handler-4\.1\.137\.Final\.jar/);
  assert.match(identityImage, /sha256sum -c/);
  assert.match(identityImage, /USER 1000[\s\S]*HEALTHCHECK/);

  const compose = read('compose.yaml');
  assert.doesNotMatch(compose, /privileged:\s*true|network_mode:\s*host|docker\.sock/);
  assert.ok((compose.match(/no-new-privileges:true/g) || []).length >= 1);
  for (const port of compose.matchAll(/ports:\s*\[([^\]]+)\]/g))
    assert.match(port[1], /127\.0\.0\.1:/, `non-loopback base port: ${port[0]}`);
  const production = read('compose.hostinger.yaml');
  assert.match(production, /caddy:[\s\S]*ports: \['80:8080', '443:8443'\]/);
  assert.doesNotMatch(
    production,
    /(?:db|redis|keycloak|api|web):[\s\S]{0,160}ports:\s*\['(?:0\.0\.0\.0:)?(?:5432|6379|8080|4000|80):/,
  );

  const imageScan = read('scripts/security-scan-containers.sh');
  assert.match(imageScan, /ghcr\.io\/aquasecurity\/trivy:0\.74\.0/);
  assert.match(imageScan, /--severity HIGH,CRITICAL/);
  assert.match(imageScan, /--exit-code 1/);
  assert.match(imageScan, /rare-os-api:latest rare-os-web:latest rare-os-ops:latest/);
  assert.match(imageScan, /--platform/);
  assert.match(imageScan, /rare-os-postgres:latest rare-os-keycloak:latest rare-os-caddy:latest/);
});

test('API bootstrap keeps bounded parsing, secure sessions, CSRF and strict token validation', () => {
  const api = read('apps/api/src/main.ts');
  for (const required of [
    "status === 413 ? 'PAYLOAD_TOO_LARGE'",
    'bodyParser: false',
    "json({ limit: '64kb' })",
    "urlencoded({ extended: false, limit: '64kb' })",
    'app.use(helmet())',
    "sameSite: 'lax'",
    'req.headers.origin !== appUrl',
    "req.headers['x-csrf-token'] !== req.session.csrf",
    "algorithms: ['RS256']",
    'issuer: authUrl + realm',
    "audience: 'rare-os-web'",
  ])
    assert.ok(api.includes(required), `API bootstrap is missing ${required}`);
  assert.doesNotMatch(api, /console\.error\([^)]*(?:password|token|secret)/i);
});
