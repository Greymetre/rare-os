import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const good = 'a'.repeat(40),
  current = 'c'.repeat(40);

// Real rehearsal evidence lives in docs/VALIDATION.md; these tests pin the safety ordering.
function run(mode = '', args = [good]) {
  const dir = mkdtempSync(join(tmpdir(), 'rare-rollback-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, '.env'), 'APP_URL=https://app.test\nAUTH_URL=https://auth.test\n');
    writeFileSync(join(dir, 'compose.override.yaml'), '');
    const backup = join(dir, '.local/backups/before-deploy');
    mkdirSync(backup, { recursive: true });
    const files = [];
    for (const name of ['rare_os', 'keycloak']) {
      const content = 'dump-' + name;
      writeFileSync(join(backup, name + '.dump'), mode === 'corrupt' ? 'tampered' : content);
      files.push({
        database: name,
        file: name + '.dump',
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ createdAt: 'fixture', files }));
    const mock = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$TEST_ROOT/events"
case "$(basename "$0"):$*" in
  'git:rev-parse HEAD') echo '${current}';;
  'git:ls-tree --name-only ${good} db/migrations/') printf 'db/migrations/001_a.sql\\ndb/migrations/002_b.sql\\n';;
  'git:diff --quiet '*) [[ "$TEST_MODE" != identity ]];;
  'docker:image inspect '*) [[ "$TEST_MODE" != missing-image ]];;
  *'SELECT name FROM schema_migrations'*) printf '001_a.sql\\n002_b.sql\\n'; [[ "$TEST_MODE" != newer && "$TEST_MODE" != restore && "$TEST_MODE" != corrupt ]] || echo 003_c.sql;;
  'docker:compose '*' pg_restore '*) cat > /dev/null;;
  'node:scripts/backup-local.mjs') echo /safety/backup;;
  node:-e*) exec "${process.execPath}" "$@";;
  curl:*) [[ "$TEST_MODE" != health ]];;
esac
`;
    for (const name of ['git', 'docker', 'node', 'curl', 'flock'])
      writeFileSync(join(bin, name), mock, { mode: 0o700 });
    const source = readFileSync('scripts/deploy/rollback.sh', 'utf8')
      .replace('/var/lock/rare-os-deploy.lock', `${dir}/deploy.lock`)
      .replace(
        'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'export PATH="$TEST_ROOT/bin:/usr/bin:/bin"',
      );
    writeFileSync(join(dir, 'rollback.sh'), source);
    const result = spawnSync(
      'bash',
      [
        join(dir, 'rollback.sh'),
        ...args.map((a) => (a === 'BACKUP' ? '.local/backups/before-deploy' : a)),
      ],
      {
        env: { ...process.env, TEST_ROOT: dir, TEST_MODE: mode, RARE_OS_DIR: dir },
        encoding: 'utf8',
      },
    );
    const events = existsSync(join(dir, 'events')) ? readFileSync(join(dir, 'events'), 'utf8') : '';
    return {
      ...result,
      events,
      done: existsSync(join(dir, '.local/deploy/last-rollback.txt')),
      failure: existsSync(join(dir, '.local/deploy/last-rollback-failure.txt'))
        ? readFileSync(join(dir, '.local/deploy/last-rollback-failure.txt'), 'utf8')
        : '',
      at: (text) => events.indexOf(text),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const restore = [good, '--restore-backup', 'BACKUP', '--confirm-data-loss'];

test('rollback validates input and requires explicit consent before touching anything', () => {
  assert.equal(run('', ['main']).status, 64);
  const unconfirmed = run('restore', [good, '--restore-backup', 'BACKUP']);
  assert.equal(unconfirmed.status, 64);
  assert.match(unconfirmed.stderr, /--confirm-data-loss/);
  assert.equal(unconfirmed.events, '');
});

test('rollback refuses before downtime when images are missing or data is incompatible', () => {
  const missing = run('missing-image');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing rollback image/);
  for (const mode of ['newer', 'identity']) {
    const r = run(mode);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Refusing image-only rollback/);
    assert.match(r.stderr, mode === 'newer' ? /003_c\.sql/ : /identity provider/);
  }
  const corrupt = run('corrupt', restore);
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /Checksum failed for rare_os/);
  for (const r of [missing, run('newer'), corrupt])
    assert.doesNotMatch(r.events, /compose .*(stop|up|ALTER DATABASE)|checkout/);
});

test('compatible rollback backs up first and swaps images without migrations or restore', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.done);
  assert.ok(r.at('node scripts/backup-local.mjs') < r.at('stop web api worker keycloak'));
  assert.ok(r.at('stop web api worker keycloak') < r.at('git checkout --detach ' + good));
  assert.match(r.events, /rollback-a{40}\.yaml up -d --no-build --no-deps --force-recreate/);
  assert.doesNotMatch(r.events, /ALTER DATABASE|pg_restore|migrate|seed/);
});

test('restore rollback renames live databases (never drops) before restoring, then starts old images', () => {
  const r = run('restore', restore);
  assert.equal(r.status, 0, r.stderr);
  const order = [
    'node -e',
    'node scripts/backup-local.mjs',
    'stop web api worker keycloak',
    'ALTER DATABASE rare_os RENAME TO rare_os_before_rollback_',
    'CREATE DATABASE rare_os OWNER rare_owner',
    'pg_restore -U rare_owner --exit-on-error -d rare_os',
    'ALTER DATABASE keycloak RENAME TO keycloak_before_rollback_',
    'CREATE DATABASE keycloak OWNER rare_keycloak',
    'git checkout --detach ' + good,
    'up -d --no-build --no-deps --force-recreate',
    'curl',
  ].map((step) => [step, r.at(step)]);
  for (const [step, index] of order) assert.ok(index >= 0, 'missing step ' + step);
  for (let i = 1; i < order.length; i++)
    assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} must run before ${order[i][0]}`);
  assert.doesNotMatch(r.events, /DROP DATABASE|dropdb|down -v|--volumes/);
});

test('failed health check records the failure and the safety backup', () => {
  const r = run('health');
  assert.notEqual(r.status, 0);
  assert.equal(r.done, false);
  assert.match(r.failure, /phase=health/);
  assert.match(r.failure, /safety_backup=\/safety\/backup/);
});
