import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  REQUIRED_SERVICES,
  alertEmail,
  backupConfig,
  decideAlerts,
  freshnessChecks,
  hostChecks,
  monitorConfig,
  parseHostFacts,
  redact,
  retentionArgs,
  tlsCheck,
} from '../scripts/ops/lib.mjs';

const hour = 3600000;
const base = Date.parse('2026-09-16T12:00:00Z');
const config = monitorConfig({});
const healthy = REQUIRED_SERVICES.map((s) => `container|${s}|running|healthy`).join('\n');

test('offsite backup refuses missing, weak or on-server repository settings', () => {
  const good = {
    RESTIC_REPOSITORY: 's3:https://example.r2.cloudflarestorage.com/rare-backups',
    RESTIC_PASSWORD: 'x'.repeat(32),
    PGPASSWORD: 'db',
  };
  assert.deepEqual(backupConfig(good), { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
  assert.throws(() => backupConfig({ ...good, RESTIC_PASSWORD: '' }), /Missing: RESTIC_PASSWORD/);
  assert.throws(() => backupConfig({ ...good, RESTIC_PASSWORD: 'short' }), /at least 24/);
  for (const repo of ['/var/backups/rare', 'local:/srv/backup'])
    assert.throws(() => backupConfig({ ...good, RESTIC_REPOSITORY: repo }), /off-server/);
  assert.throws(() => backupConfig({ ...good, BACKUP_KEEP_DAILY: '0' }), /positive/);
  assert.deepEqual(retentionArgs(backupConfig({ ...good, BACKUP_KEEP_MONTHLY: '12' })).slice(-3), [
    '--keep-monthly',
    '12',
    '--prune',
  ]);
});

test('host facts become container and disk checks; missing facts are a failure', () => {
  assert.equal(parseHostFacts(''), null);
  assert.deepEqual(hostChecks(null, config), [
    { id: 'host:facts', ok: false, detail: 'Host container and disk status was not supplied' },
  ]);
  const facts = parseHostFacts(
    healthy.replace('worker|running|healthy', 'worker|exited|') +
      '\ncontainer|api|running|unhealthy\ndisk|/|91\ndisk|/var/lib/docker|40\ngarbage line',
  );
  const byId = Object.fromEntries(hostChecks(facts, config).map((r) => [r.id, r]));
  assert.equal(byId['container:worker'].ok, false);
  assert.match(byId['container:worker'].detail, /exited/);
  assert.equal(byId['container:api'].ok, false, 'later unhealthy row must win');
  assert.equal(byId['container:db'].ok, true);
  assert.equal(byId['disk:/'].ok, false);
  assert.equal(byId['disk:/var/lib/docker'].ok, true);
  const missing = hostChecks(parseHostFacts('container|db|running|healthy'), config);
  assert.equal(missing.find((r) => r.id === 'container:web').detail, 'container not found');
});

test('backup, restore-drill and certificate freshness thresholds', () => {
  const ago = (h) => new Date(base - h * hour).toISOString();
  const fresh = freshnessChecks(
    { backup: { lastSuccessAt: ago(7) }, restoreDrill: { lastSuccessAt: ago(24 * 7) } },
    config,
    base,
  );
  assert.deepEqual(
    fresh.map((r) => r.ok),
    [true, true],
  );
  const stale = freshnessChecks(
    { backup: { lastSuccessAt: ago(9) }, restoreDrill: {} },
    config,
    base,
  );
  assert.deepEqual(
    stale.map((r) => r.ok),
    [false, false],
  );
  assert.match(stale[1].detail, /no successful restore drill/);
  assert.equal(
    tlsCheck('rare.example', new Date(base + 30 * 24 * hour).toString(), config, base).ok,
    true,
  );
  assert.equal(
    tlsCheck('rare.example', new Date(base + 5 * 24 * hour).toString(), config, base).ok,
    false,
  );
  assert.throws(() => monitorConfig({ MONITOR_URLS: 'ftp://x' }), /http/);
});

test('alerts open once, remind after the reminder window and send recovery', () => {
  const down = [
    { id: 'http:https://rare.example/', ok: false, transient: true, detail: 'HTTP 502' },
  ];
  const disk = [{ id: 'disk:/', ok: false, detail: '90% used' }];
  // First transient failure is tolerated; a persistent check alerts immediately.
  let d = decideAlerts({}, [...down, ...disk], config, base);
  assert.deepEqual(
    d.opened.map((r) => r.id),
    ['disk:/'],
  );
  d = decideAlerts(d.state, [...down, ...disk], config, base + 5 * 60000);
  assert.deepEqual(
    d.opened.map((r) => r.id),
    ['http:https://rare.example/'],
  );
  assert.equal(d.reminders.length, 0, 'no duplicate alert inside the reminder window');
  const quiet = decideAlerts(d.state, [...down, ...disk], config, base + hour);
  assert.equal(alertEmail(quiet, 'rare.example'), null);
  const later = decideAlerts(quiet.state, [...down, ...disk], config, base + 7 * hour);
  assert.equal(later.reminders.length, 2);
  assert.match(alertEmail(later, 'rare.example').body, /Still failing/);
  const up = decideAlerts(
    later.state,
    [
      { ...down[0], ok: true, detail: 'HTTP 200' },
      { ...disk[0], ok: true, detail: '50% used' },
    ],
    config,
    base + 8 * hour,
  );
  assert.equal(up.recovered.length, 2);
  const email = alertEmail(up, 'rare.example');
  assert.match(email.subject, /^\[RARE OS RECOVERED\] 2 checks healthy on rare\.example$/);
  // A single blip that recovers never produced an alert, so it must not produce a recovery mail.
  const blip = decideAlerts({}, down, config, base);
  assert.equal(
    alertEmail(decideAlerts(blip.state, [{ ...down[0], ok: true }], config, base + 1), 'x'),
    null,
  );
});

test('secrets are redacted from alert text and logs', () => {
  const env = {
    RESTIC_PASSWORD: 'restic-secret-value-1234567890',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
    SMTP_PASSWORD: 'smtp-pass',
  };
  const text = redact(
    'Fatal: restic-secret-value-1234567890 aws-secret-value smtp-pass https://user:pw@host/x',
    env,
  );
  for (const secret of [...Object.values(env), 'pw@'])
    assert.ok(!text.includes(secret), 'leaked ' + secret);
});

test('operations deployment keeps least privilege and schedules every job', () => {
  const compose = readFileSync('compose.yaml', 'utf8');
  const ops = compose.slice(compose.indexOf('\n  ops:'), compose.indexOf('\nvolumes:'));
  assert.match(ops, /profiles: \[ops\]/);
  assert.match(ops, /no-new-privileges|<<: \*security/);
  assert.doesNotMatch(ops, /ports:|docker\.sock|privileged/);
  const worker = compose.slice(compose.indexOf('\n  worker:'), compose.indexOf('\n  web:'));
  assert.match(
    worker,
    /healthcheck:[\s\S]*rare:worker:heartbeat/,
    'worker must not inherit the API probe',
  );
  const image = readFileSync('infra/ops/Ops.Dockerfile', 'utf8');
  assert.match(image, /apk upgrade --no-cache[\s\S]*USER ops/);
  const host = readFileSync('scripts/ops/host-run.sh', 'utf8');
  assert.match(host, /rare-os-deploy\.lock/, 'monitor must pause during deployments');
  assert.match(host, /\^\(backup\|restore-drill\|monitor\|test-alert\|init\)\$/);
  for (const job of ['backup', 'restore-drill', 'monitor']) {
    assert.match(
      readFileSync(`infra/ops/systemd/rare-os-${job}.service`, 'utf8'),
      new RegExp(`ExecStart=/usr/local/sbin/rare-os-ops ${job}\\n`),
    );
    assert.match(readFileSync(`infra/ops/systemd/rare-os-${job}.timer`, 'utf8'), /\[Timer\]/);
  }
  const ops_ = readFileSync('scripts/ops/ops.mjs', 'utf8');
  assert.doesNotMatch(ops_, /['"]--user['"]|SMTP_PASSWORD[^\n]*spawn/, 'no credentials on argv');
});

test('host disk facts report a shared filesystem only once', () => {
  const host = readFileSync('scripts/ops/host-run.sh', 'utf8');
  const program = host.match(/awk '([^']+)'/)[1];
  const df = [
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/sda1 100 15 85 15% /',
    '/dev/sda1 100 15 85 15% /',
    '/dev/sdb1 100 91 9 91% /var/lib/docker',
  ].join('\n');
  const out = spawnSync('awk', [program], { input: df, encoding: 'utf8' }).stdout.trim();
  assert.deepEqual(out.split('\n'), ['disk|/|15', 'disk|/var/lib/docker|91']);
  assert.deepEqual(parseHostFacts(out).disks, [
    { mount: '/', usedPercent: 15 },
    { mount: '/var/lib/docker', usedPercent: 91 },
  ]);
});
