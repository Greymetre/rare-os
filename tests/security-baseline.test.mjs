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
