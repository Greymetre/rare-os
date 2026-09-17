import { cleanupRegression } from './regression-cleanup.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Snapshot the current working tree, including uncommitted changes, but never local configuration.
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const id = Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
const project = 'rare-regression-' + id;
const report = join(root, '.local/regression', id);
const workspace = join(report, 'workspace');
const summary = {
  run: id,
  project,
  startedAt: new Date().toISOString(),
  steps: [],
  status: 'running',
};
mkdirSync(report, { recursive: true, mode: 0o700 });
let child,
  interrupted = false,
  composeStarted = false;
let env = { ...process.env };
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    child?.kill('SIGTERM');
  });
function command(program, args, cwd = workspace, capture = false) {
  return new Promise((accept, reject) => {
    const p = spawn(program, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    child = p;
    let output = '';
    if (capture)
      p.stdout.on('data', (data) => {
        output += data;
      });
    const timer = setTimeout(() => p.kill('SIGKILL'), 25 * 60 * 1000);
    p.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    p.once('close', (code) => {
      clearTimeout(timer);
      if (child === p) child = undefined;
      if (code === 0) accept(output.trim());
      else reject(Error(`${program} ${args.slice(0, 3).join(' ')} failed (exit ${code})`));
    });
  });
}
async function step(name, program, args, cwd = workspace) {
  if (interrupted) throw Error('Regression interrupted');
  console.log('\n[regression] ' + name);
  const item = { name, status: 'running', startedAt: new Date().toISOString() };
  summary.steps.push(item);
  const started = Date.now();
  try {
    await command(program, args, cwd);
    item.status = 'passed';
  } catch (error) {
    item.status = 'failed';
    throw error;
  } finally {
    item.durationMs = Date.now() - started;
  }
}
async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}
const secret = () => randomBytes(24).toString('hex');
try {
  await step(
    'Format, types, unit tests and production build',
    'npm',
    ['run', 'verify:quick'],
    root,
  );
  const endpoint =
    (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
    JSON.parse(await command('docker', ['context', 'inspect'], root, true))[0].Endpoints.docker
      .Host;
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://'))
    throw Error('Regression requires a local Docker socket, not a remote Docker host.');
  mkdirSync(workspace, { mode: 0o700 });
  for (const name of [
    'apps',
    'packages',
    'db',
    'infra',
    'scripts',
    'tests',
    'package.json',
    'package-lock.json',
    'compose.yaml',
    'playwright.config.ts',
    '.dockerignore',
  ])
    cpSync(join(root, name), join(workspace, name), {
      recursive: true,
      filter: (path) =>
        !['node_modules', 'dist', '.local', '.git'].includes(basename(path)) &&
        !basename(path).startsWith('.env'),
    });
  symlinkSync(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  const ports = new Set();
  while (ports.size < 3) {
    const port = await freePort();
    if (![4310, 4311, 4312].includes(port)) ports.add(port);
  }
  const [web, auth, mail] = [...ports];
  const values = {
    APP_URL: `http://localhost:${web}`,
    AUTH_URL: `http://localhost:${auth}`,
    MAILPIT_URL: `http://localhost:${mail}`,
    WEB_PORT: web,
    KEYCLOAK_PORT: auth,
    MAILPIT_PORT: mail,
    KEYCLOAK_IMAGE: project + '-keycloak',
    DB_PASSWORD: secret(),
    APP_DB_PASSWORD: secret(),
    KEYCLOAK_DB_PASSWORD: secret(),
    SESSION_SECRET: secret(),
    OIDC_CLIENT_SECRET: secret(),
    IDENTITY_CLIENT_SECRET: secret(),
    KC_ADMIN_PASSWORD: secret(),
    SEED_ADMIN_EMAIL: 'admin@rareos.local',
    SEED_ADMIN_PASSWORD: secret(),
  };
  writeFileSync(
    join(workspace, '.env'),
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  mkdirSync(join(workspace, '.local'), { mode: 0o700 });
  const nonce = secret();
  writeFileSync(
    join(workspace, '.local/regression-stack.json'),
    JSON.stringify({ project, nonce }),
    { mode: 0o600 },
  );
  // Remove inherited Compose selectors; subprocesses (including SQL/outage tests) share exactly this stack.
  for (const key of Object.keys(env))
    if (key.startsWith('COMPOSE_') || key.startsWith('RARE_E2E_') || key === 'RARE_REVIEW_DEMO')
      delete env[key];
  env = {
    ...env,
    ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: join(workspace, 'compose.yaml'),
    COMPOSE_ENV_FILES: join(workspace, '.env'),
    RARE_E2E_DISPOSABLE_STACK: 'true',
    RARE_E2E_NONCE: nonce,
  };
  await step('Validate disposable stack', 'docker', ['compose', 'config', '--quiet']);
  composeStarted = true;
  await step('Pull runtime dependencies', 'docker', ['compose', 'pull', '--ignore-buildable']);
  await step('Build disposable images from refreshed bases', 'docker', [
    'compose',
    'build',
    '--pull',
  ]);
  await step('Start disposable services', 'docker', ['compose', 'up', '-d', '--no-build']);
  await step('Repeat seed without losing existing grants or identities', 'docker', [
    'compose',
    'run',
    '--rm',
    '--no-deps',
    'seed',
  ]);
  await step('Browser and API regression suite', process.execPath, [
    join(root, 'node_modules/@playwright/test/cli.js'),
    'test',
  ]);
  await step('Database isolation, privileges and indexed audit query', 'docker', [
    'compose',
    'run',
    '--rm',
    '--no-deps',
    'seed',
    'node',
    'scripts/test-db.mjs',
  ]);
  // After the browser suite: the demo company adds a second membership to the seed admin.
  await step('ABC Corp demo company seeder is repeat-safe', 'docker', [
    'compose',
    'run',
    '--rm',
    '--no-deps',
    'seed',
    'sh',
    '-c',
    'node scripts/demo-abc-corp.mjs && node scripts/demo-abc-corp.mjs | grep -q "already present"',
  ]);
  await step('Application and identity backup/restore verification', process.execPath, [
    'scripts/backup-local.mjs',
    '--verify',
  ]);
  await step('Offsite encrypted backup, restore drill, monitoring and alerts', process.execPath, [
    'scripts/ops/ops-integration.mjs',
  ]);
  summary.status = 'passed';
} catch (error) {
  summary.status = 'failed';
  summary.error = error.message;
  console.error('[regression] ' + error.message);
  process.exitCode = 1;
} finally {
  // Export only explicit report files: never .env, MFA fixture secrets or database dumps.
  try {
    for (const name of ['playwright-report', 'test-results'])
      if (existsSync(join(workspace, name)))
        cpSync(join(workspace, name), join(report, name), { recursive: true });
    const local = join(workspace, '.local');
    if (existsSync(local))
      for (const file of readdirSync(local))
        if (file.endsWith('.png')) {
          mkdirSync(join(report, 'screenshots'), { recursive: true });
          cpSync(join(local, file), join(report, 'screenshots', file));
        }
    const backups = join(local, 'backups');
    if (existsSync(backups))
      for (const stamp of readdirSync(backups)) {
        const receipt = join(backups, stamp, 'restore-drill.json');
        if (existsSync(receipt)) {
          mkdirSync(join(report, 'restore-verification'), { recursive: true });
          cpSync(receipt, join(report, 'restore-verification', stamp + '.json'));
        }
      }
  } catch (error) {
    summary.status = 'failed';
    summary.artifactError = error.message;
    process.exitCode = 1;
  }
  if (composeStarted) {
    try {
      await cleanupRegression(project, (args, capture = false) =>
        command('docker', args, workspace, capture),
      );
      summary.cleanup = 'passed';
    } catch (error) {
      summary.status = 'failed';
      summary.cleanup = 'failed';
      process.exitCode = 1;
      console.error(
        'Cleanup failed. Retry: docker compose -p ' +
          project +
          ' -f ' +
          join(workspace, 'compose.yaml') +
          ' down --volumes --remove-orphans',
      );
    }
  }
  // Keep private workspace only if Docker cleanup failed so it can be retried safely.
  if (summary.cleanup !== 'failed') rmSync(workspace, { recursive: true, force: true });
  if (interrupted) {
    summary.status = 'interrupted';
    process.exitCode = 1;
  }
  summary.finishedAt = new Date().toISOString();
  writeFileSync(join(report, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`[regression] ${summary.status.toUpperCase()} — reports: ${report}`);
}
