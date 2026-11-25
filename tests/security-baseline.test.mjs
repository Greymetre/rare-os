import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

// The same file with its comments taken out. Assertions of the form "this word appears nowhere"
// have to run over this and not over the raw text: the comment that explains a rule contains
// the very words the rule forbids, so a regex over the whole file fails on a file that is
// correct. That has now happened three times in this suite, in three different milestones.
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

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

test('RCH-6 freezes a policy once it governs, and stores no amount at all', () => {
  const migration = read('db/migrations/035_reach_expenses.sql');
  // A claim, a decision and a policy version are records of what happened or what somebody was
  // paid against. Nothing here may be removed by the runtime role.
  for (const [, privileges, granted] of migration.matchAll(
    /GRANT ([^;]*?) ON ([^;]*?) TO rare_app/gi,
  ))
    assert.doesNotMatch(privileges, /\bDELETE\b/i, `DELETE granted on ${granted.trim()}`);
  for (const table of [
    'expense_categories',
    'expense_policies',
    'expense_policy_rates',
    'expense_claims',
    'expense_lines',
  ])
    assert.ok(new RegExp(`'${table}'`).test(migration), `${table} is not row-level scoped`);

  // Nothing a screen works out may be stored. A column for any of these would be a second
  // version of the truth, and the first one somebody forgets to rewrite.
  const sqlOnly = migration.replace(/--.*$/gm, '');
  for (const column of ['allowed', 'approved_amount', 'computed', 'policy_amount', 'payable'])
    assert.ok(
      !new RegExp(`\\b${column}\\s+numeric`, 'i').test(sqlOnly),
      `the schema stores ${column}, which must be calculated`,
    );
  // What the rep asked for is kept; what the policy makes of it is not.
  assert.match(sqlOnly, /claimed_amount numeric/);

  // The milestone's own acceptance, in the table rather than only in the controller.
  assert.match(
    sqlOnly,
    /CHECK \(manager_by IS NULL OR finance_by IS NULL OR manager_by <> finance_by\)/,
  );
  // Finance cannot have seen a claim a manager never passed, and a refusal has to say why.
  assert.match(sqlOnly, /CHECK \(finance_by IS NULL OR manager_by IS NOT NULL\)/);
  assert.match(sqlOnly, /CHECK \(status <> 'REJECTED' OR reject_reason <> ''\)/);
  // One claim per rep per period, and two versions cannot begin on the same day.
  assert.match(migration, /CREATE UNIQUE INDEX expense_claims_period_idx/);
  assert.match(migration, /CREATE UNIQUE INDEX expense_policies_from_idx/);

  const controller = read('apps/api/src/reach-expense.controller.ts');
  // The rule the whole module rests on, enforced where today's date is visible.
  assert.match(controller, /has to start after today/);
  assert.match(controller, /POLICY_IN_FORCE/);
  assert.ok(
    (controller.match(/policyIsOpen\(policy, today\)/g) ?? []).length >= 2,
    'a started version must be refused on both the version and its rates',
  );
  // The rep is the signed-in login; a rep id in a body is never read.
  assert.match(controller, /repForUser\(db, actor\.id\)/);
  assert.doesNotMatch(controller, /body\(req, \[[^\]]*'rep_id'/);
  assert.match(controller, /You may only change your own claim/);
  assert.match(controller, /You may only read your own claims/);
  // The two desks are two rights, and one person cannot use both on one claim.
  for (const required of [
    "mutate(req, 'reach.expense'",
    "mutate(req, 'reach.setup'",
    "stage === 'MANAGER' ? 'reach.expense_approve' : 'reach.expense_finance'",
    'NOT_YOURS_TO_DECIDE',
  ])
    assert.ok(controller.includes(required), `the controller is missing ${required}`);
  // One request may ask for at most a year, and a claim is a page of lines.
  assert.match(controller, /MAX_SPAN_DAYS = 366/);
  assert.match(controller, /MAX_LINES = 200/);
  // The payout file is served as a file and never sniffed as something a browser would run.
  assert.match(controller, /'X-Content-Type-Options', 'nosniff'/);
  // Only what finance approved is paid out.
  assert.match(controller, /status: 'APPROVED'/);

  const engine = read('packages/engines/expense.mjs');
  // A day the register settles as "not at work" earns no daily allowance.
  assert.match(engine, /NOT_AT_WORK = \['ABSENT', 'LEAVE', 'WEEK_OFF', 'HOLIDAY'\]/);
  // The plan's town outranks the one the rep typed, or a day at headquarters could be claimed
  // as a day in the next district.
  assert.match(engine, /const fromPlan = String\(plannedTown/);
  // Over the limit is capped, never refused.
  assert.match(engine, /reasons\.push\('CAPPED'\)/);

  const layer = read('packages/schema/expense-db.mjs');
  // The rates of a version are replaced as a set, and nothing is deleted doing it — the grant
  // refuses a DELETE here outright, so this is the only shape that works.
  assert.doesNotMatch(layer, /DELETE FROM expense_/);
  assert.match(layer, /ON CONFLICT \(tenant_id,policy_id,category_id,key\) DO UPDATE/);
});

test('RCH-7 counts what is there and has no way to change any of it', () => {
  const layer = read('packages/schema/reach-overview-db.mjs');
  // The milestone's own acceptance, made structural: this file cannot write. If it cannot write,
  // a proposal cannot act, and a tile cannot be a stored number that has drifted.
  for (const write of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'TRUNCATE'])
    assert.ok(!layer.includes(write), `the overview reader contains a ${write.trim()}`);

  const controller = read('apps/api/src/reach-overview.controller.ts');
  // `mutate` is the only way this codebase writes behind a permission, so its absence is the
  // plainest statement that nothing here changes anything.
  assert.ok(!controller.includes('mutate('), 'the overview controller writes');
  assert.doesNotMatch(controller, /@(Post|Put|Patch|Delete)\(/);
  // Reading the module needs the right to read it; its audit trail needs the audit right.
  assert.match(controller, /access\(req, 'reach\.read'\)/);
  assert.match(controller, /access\(req, 'audit\.read'\)/);
  // One request may ask for at most a year of trail, and a page of it at a time.
  assert.match(controller, /MAX_SPAN_DAYS = 366/);
  assert.match(controller, /MAX_AUDIT_ROWS = 200/);

  const engine = read('packages/engines/reach-overview.mjs');
  // A proposal pointing at a screen somebody cannot open is noise, so every one names the right
  // it needs and the overview filters on it.
  assert.match(engine, /PROPOSAL_RIGHTS/);
  assert.match(engine, /if \(permissions && needs && !permissions\.includes\(needs\)\) continue/);
  // Nothing counted is nothing proposed: the system says nothing rather than reassuring anybody.
  assert.match(engine, /if \(!count\) continue/);
  // The queue total is the sum of the rows beneath it, which is the acceptance in one line.
  assert.match(engine, /total: waiting\.reduce/);
  // Going live is read from the data, never from somebody having ticked a box.
  assert.doesNotMatch(engine, /acknowledged|dismissed|marked_done/i);
});

test('RCH-8 lets a phone in on its own token, and never twice on the same work', () => {
  const auth = read('apps/api/src/device-auth.ts');
  // A device token is its own client. Without this, a browser's token would be a permanent
  // field login and "sign every phone out" would be impossible.
  assert.match(auth, /DEVICE_CLIENT_ID = 'rare-os-mobile'/);
  assert.match(auth, /audience: DEVICE_CLIENT_ID/);
  assert.match(auth, /algorithms: \['RS256'\]/);
  assert.match(auth, /issuer: authUrl \+ realm/);
  // `azp` as well as the audience, so a token merely listing this client cannot be spent here.
  assert.match(auth, /p\.azp !== DEVICE_CLIENT_ID/);
  // The same revocation record a browser session checks. A long-lived field login without this
  // would be a door with no lock.
  assert.match(auth, /rare:revoked:sid:/);
  assert.match(auth, /rare:revoked:subject:/);
  // A second factor cannot be asked for mid-request, so an account that needs one is refused
  // rather than quietly let past it.
  assert.match(auth, /requiresMfa\(subject\)/);
  assert.match(auth, /MFA_NOT_SUPPORTED_ON_DEVICE/);
  // One login, one company: a phone has no company picker, so two memberships is a refusal and
  // never a guess about whose books the day belongs in.
  assert.match(auth, /memberships\.length !== 1/);

  // A phone is never a platform administrator.
  const core = read('apps/api/src/core.ts');
  assert.match(core, /platformCompanyVersion: undefined as number \| undefined/);

  // CSRF is skipped for bearer requests and for nothing else.
  const api = read('apps/api/src/main.ts');
  assert.match(api, /if \(isDeviceRequest\(req\)\) return next\(\);/);
  // The one unauthenticated route the app needs says where to sign in and nothing more.
  assert.doesNotMatch(api, /mobileConfig[\s\S]{0,200}(clientSecret|OIDC_CLIENT_SECRET)/);

  // Exactly once, where a repeat would otherwise become a second record.
  const migration = read('db/migrations/036_reach_sync.sql');
  for (const table of ['trade_orders', 'trade_receipts', 'stored_files'])
    assert.match(
      migration,
      new RegExp(
        `CREATE UNIQUE INDEX ${table}_client_ref_idx[\\s\\S]{0,120}WHERE client_ref <> ''`,
      ),
      `${table} may hold two rows for one device reference`,
    );
  // A heartbeat is contact, not content. Read the table definition itself, not the comments
  // around it, and check that nothing from a rep's actual work can be written to it.
  const deviceTable = /CREATE TABLE device_syncs \(([\s\S]*?)\n\);/.exec(migration);
  assert.ok(deviceTable, 'device_syncs is not defined where it was expected');
  assert.doesNotMatch(deviceTable[1], /amount|payload|report|lines|latitude|longitude|photo/i);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON device_syncs TO rare_app/);
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE[^;]*device_syncs/);

  // The engine sends a reference only where the route reads one. The write routes refuse unknown
  // fields, so getting this wrong would block a rep's whole morning behind a 400.
  const engine = read('packages/engines/sync-queue.mjs');
  assert.match(
    engine,
    /payload: spec\.ref \? \{ \.\.\.payload, client_ref: clientRef \} : \{ \.\.\.payload \}/,
  );
  // A refusal the server understood is never retried; an unknown outcome always is.
  assert.match(engine, /status >= 400 && status < 500 && status !== 408 && status !== 429/);
  // Nothing is ever dropped: every item ends in one of three named states.
  assert.match(engine, /OUTBOX_STATES = \['QUEUED', 'SENT', 'BLOCKED'\]/);
  // An unresolved local id is named, never sent.
  assert.match(engine, /missing\.push\(value\)/);

  // ---- The field app is an installed app, so none of it is served or shipped here ----

  // The desk app keeps "not even our own page may ask" for a camera or a location. When the
  // field app was a page in this origin that had to be widened for one path; now that it is an
  // installed app it does not, and the strict policy stands alone again.
  const nginx = read('infra/docker/nginx.conf');
  assert.match(
    nginx,
    /add_header Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\)" always;/,
  );
  assert.doesNotMatch(nginx, /camera=\(self\)|geolocation=\(self\)/);
  // Nothing of the field app is served from this origin any more, so there is no service worker
  // to go stale and no second single-page app to keep headers in step with.
  assert.doesNotMatch(nginx, /location \/mobile\//);
  assert.doesNotMatch(nginx, /sw\.js/);

  // Nor does any of it reach the containers. This is the whole reason the app is not an npm
  // workspace: Expo's bundler and command line are build tooling, and calling them production
  // dependencies of the API image would have been a lie that the dependency gate then had to be
  // bent around.
  const dockerfile = read('infra/docker/Dockerfile');
  assert.doesNotMatch(dockerfile, /apps\/mobile/);

  const root = JSON.parse(read('package.json'));
  assert.ok(
    !root.workspaces.includes('apps/*') && !root.workspaces.includes('apps/mobile'),
    'the field app is back inside the npm workspaces, which puts Expo in the container tree',
  );
  const rootLock = read('package-lock.json');
  assert.doesNotMatch(rootLock, /node_modules\/(expo|react-native)[/"]/);

  // Leaving the workspace must not mean leaving the gate. The field app has its own lockfile and
  // the gate audits it on its own terms; a missing lockfile is a failure there, never a pass,
  // because an unaudited tree must never read as a clean one.
  const audit = read('scripts/audit.mjs');
  assert.match(audit, /const FIELD_APP = 'apps\/mobile'/);
  assert.match(audit, /existsSync\(`\$\{FIELD_APP\}\/package-lock\.json`\)/);
  assert.match(audit, /ACCEPTED_FIELD_APP/);
  assert.ok(
    read('apps/mobile/package-lock.json').length > 0,
    'the field app has no lockfile, so its dependencies are not audited',
  );
  // Nothing in the production half can ever be excused, in either tree.
  const productionHalf = audit.slice(
    audit.indexOf('// ---------- What ships ----------'),
    audit.indexOf('// ---------- Everything, build toolchain included ----------'),
  );
  assert.doesNotMatch(productionHalf, /ACCEPTED/);

  // ---- The phone's own secrets ----

  const clientAuth = read('apps/mobile/src/auth.ts');
  // Authorization Code with PKCE. There is no secret in an app a rep can install, so the proof
  // has to be the verifier this app generated.
  assert.match(clientAuth, /usePKCE: true/);
  assert.match(clientAuth, /offline_access/);
  // The refresh token lives in the operating system's keystore, which is the one real security
  // improvement that came with leaving the browser: in the page version it had to sit in
  // IndexedDB, where any script in the page could read it.
  assert.match(clientAuth, /expo-secure-store/);
  assert.match(clientAuth, /SecureStore\.setItemAsync\(REFRESH_KEY/);
  // Signing out reaches the server, so the token is dead and not merely forgotten.
  assert.match(clientAuth, /revokeAsync/);
  // And it must not be able to throw away work the rep has not sent. Checked at the import lines
  // rather than in prose — a regex over the whole file matches the comment that explains the
  // rule, which is how this assertion was wrong the first time it was written. The module's own
  // imports are the real guarantee: it cannot reach the outbox, so it cannot clear it by
  // accident or by a later edit.
  const authImports = [...clientAuth.matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(
    authImports.filter((from) => from.startsWith('.')),
    ['./config'],
    'the field app auth module can now reach something other than its own configuration',
  );

  // The database holds the day and the outbox. It must never hold a token: a database file is
  // not a keystore, and WAL copies would outlive a sign-out.
  const store = code('apps/mobile/src/db.ts');
  assert.doesNotMatch(store, /refresh|access_token|accessToken|bearer/i);
  // Losing a row here loses a real order, so a pass is written in one transaction.
  assert.match(store, /withExclusiveTransactionAsync/);

  // The app talks to one server, named at build time, and never carries a client secret.
  const config = code('apps/mobile/src/config.ts');
  assert.doesNotMatch(config, /secret|password|client_secret/i);
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
