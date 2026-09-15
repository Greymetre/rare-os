import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const revision = 'a'.repeat(40),
  previous = 'b'.repeat(40);
function run(mode = '', command = 'deploy ' + revision) {
  const dir = mkdtempSync(join(tmpdir(), 'rare-deploy-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, '.env'), '');
    writeFileSync(join(dir, 'compose.override.yaml'), '');
    const mock = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$TEST_ROOT/events"
case "$(basename "$0"):$*" in
  'git:status --porcelain --untracked-files=no') [[ "$TEST_MODE" != dirty ]] || echo ' M tracked';;
  'git:rev-parse origin/main') if [[ "$TEST_MODE" == stale ]]; then echo '${previous}'; else echo '${revision}'; fi;;
  'git:rev-parse HEAD') echo '${previous}';;
  'docker:compose build') [[ "$TEST_MODE" != build ]];;
  'docker:compose ps -q '*|'docker:compose ps -a -q '*) echo container;;
  'docker:inspect --format {{.Image}} container') echo 'sha256:fixture';;
  'docker:image inspect sha256:fixture') [[ "$TEST_MODE" != missing-image ]];;
  'docker:compose run --rm --no-deps migrate node scripts/deploy/check-runtime.mjs') [[ "$TEST_MODE" != preflight ]];;
  'docker:image tag '*) [[ "$TEST_MODE" != tag-failure ]];;
  'docker:inspect --format {{.State.Status}}:{{.State.ExitCode}} container') if [[ "$TEST_MODE" == migration ]]; then echo exited:1; else echo exited:0; fi;;
  'docker:inspect --format {{.State.Running}} container') echo true;;
  'node:scripts/backup-local.mjs') [[ "$TEST_MODE" != backup ]] || exit 1; echo /private/backup;;
  curl:*) [[ "$TEST_MODE" != health ]];;
esac
`;
    for (const name of ['git', 'docker', 'node', 'curl', 'flock'])
      writeFileSync(join(bin, name), mock, { mode: 0o700 });
    const source = readFileSync('scripts/deploy/vps-deploy.sh', 'utf8')
      .replace('cd /var/www/rare-os', 'cd "$TEST_ROOT"')
      .replace('/var/lock/rare-os-deploy.lock', `${dir}/deploy.lock`)
      .replace(
        'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'export PATH="$TEST_ROOT/bin:/usr/bin:/bin"',
      );
    const script = join(dir, 'deploy.sh');
    writeFileSync(script, source);
    const result = spawnSync('bash', [script], {
      env: { ...process.env, TEST_ROOT: dir, TEST_MODE: mode, SSH_ORIGINAL_COMMAND: command },
      encoding: 'utf8',
    });
    return {
      ...result,
      events: existsSync(join(dir, 'events')) ? readFileSync(join(dir, 'events'), 'utf8') : '',
      successful: existsSync(join(dir, '.local/deploy/last-success.txt')),
      rollback: existsSync(join(dir, '.local/deploy/rollback-images-' + revision + '.txt'))
        ? readFileSync(join(dir, '.local/deploy/rollback-images-' + revision + '.txt'), 'utf8')
        : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('deploy accepts only a full SHA and skips stale or dirty revisions before mutations', () => {
  assert.equal(run('', 'deploy main; id').status, 64);
  for (const mode of ['stale', 'dirty']) {
    const r = run(mode);
    assert.equal(r.successful, false);
    assert.doesNotMatch(r.events, /docker compose (build|stop|up)/);
    assert.equal(r.status, mode === 'stale' ? 0 : 1);
  }
});
test('deploy builds before downtime and backs up before applying migrations and health checks', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.successful, true);
  const steps = [
    'docker image tag',
    'docker compose build',
    'docker compose run --rm --no-deps migrate node scripts/deploy/check-runtime.mjs',
    'docker compose stop',
    'node scripts/backup-local.mjs',
    'docker compose up',
    'curl',
  ];
  const positions = steps.map((step) => r.events.indexOf(step));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])));
});
test('build failure leaves services running; backup failure restores previous instances', () => {
  const build = run('build');
  assert.notEqual(build.status, 0);
  assert.doesNotMatch(build.events, /docker compose stop/);
  const backup = run('backup');
  assert.notEqual(backup.status, 0);
  assert.match(backup.events, /docker compose start keycloak api worker web/);
  assert.doesNotMatch(backup.events, /docker compose up/);
  assert.equal(backup.successful, false);
});
test('migration or health failure never records success or blindly downgrades the database', () => {
  for (const mode of ['migration', 'health']) {
    const r = run(mode);
    assert.notEqual(r.status, 0);
    assert.equal(r.successful, false);
    assert.doesNotMatch(r.events, /docker compose start|pg_restore|docker compose down/);
  }
});

test('missing old image is recorded without tagging a new image or skipping backup', () => {
  const r = run('missing-image');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.successful, true);
  assert.match(r.rollback, /api sha256:fixture unavailable/);
  assert.match(r.stderr, /Rollback requires rebuilding commit/);
  assert.doesNotMatch(r.events, /docker image tag/);
  assert.match(r.events, /node scripts\/backup-local.mjs/);
  assert.match(r.events, /docker compose up/);
});
test('rollback tag failure stops before build, downtime or database changes', () => {
  const r = run('tag-failure');
  assert.notEqual(r.status, 0);
  assert.equal(r.successful, false);
  assert.doesNotMatch(r.events, /docker compose (build|stop|up)/);
});

test('unreadable packaged source fails preflight before downtime and migration', () => {
  const r = run('preflight');
  assert.notEqual(r.status, 0);
  assert.equal(r.successful, false);
  assert.doesNotMatch(r.events, /docker compose (stop|up)/);
});
