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
