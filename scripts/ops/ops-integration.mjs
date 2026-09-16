// Regression stage: real encrypted offsite backup, retention, restore drill, monitoring and alert email
// against the disposable stack plus a local S3-compatible server. Refuses to run anywhere else.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { delimiter, resolve } from 'node:path';
import { REQUIRED_SERVICES } from './lib.mjs';

const project = process.env.COMPOSE_PROJECT_NAME || '';
if (
  process.env.RARE_E2E_DISPOSABLE_STACK !== 'true' ||
  !/^rare-regression-[a-z0-9]+-[a-f0-9]{8}$/.test(project) ||
  !process.env.MAILPIT_URL
)
  throw Error('Operations integration runs only inside npm run test:regression.');

const secret = () => randomBytes(24).toString('hex');
const alertTo = 'ops-alerts@rareos.local';
const backupPassword = secret();
const env = {
  ...process.env,
  COMPOSE_FILE: [resolve('compose.yaml'), resolve('infra/ops/compose.ops-test.yaml')].join(
    delimiter,
  ),
  COMPOSE_PROFILES: 'ops',
  OPS_IMAGE: project + '-ops',
  OPS_SITE: 'regression',
  BACKUP_REPOSITORY: 's3:http://s3test:7070/rare-backups',
  BACKUP_PASSWORD: backupPassword,
  BACKUP_ACCESS_KEY_ID: 'rare' + randomBytes(6).toString('hex'),
  BACKUP_SECRET_ACCESS_KEY: secret(),
  BACKUP_REGION: 'us-east-1',
  ALERT_EMAIL_TO: alertTo,
  MONITOR_URLS: 'http://web:8080/,http://api:4000/api/health',
};

function compose(args, { input, extraEnv = [] } = {}) {
  const r = spawnSync(
    'docker',
    ['compose', ...args.slice(0, 1), ...extraEnv.flatMap((e) => ['-e', e]), ...args.slice(1)],
    { env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return { status: r.status, stdout: r.stdout || '', out: (r.stdout || '') + (r.stderr || '') };
}
const ops = (args, options = {}) =>
  compose(['run', '--rm', '--no-deps', '-T', 'ops', ...args], options);
const restic = (args, extraEnv = []) =>
  compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'restic', 'ops', ...args], {
    extraEnv,
  });
function expectStatus(result, status, label) {
  assert.equal(
    result.status,
    status,
    `${label} exited ${result.status}:\n${result.out.slice(-1500)}`,
  );
  for (const value of [backupPassword, env.BACKUP_SECRET_ACCESS_KEY])
    assert.ok(!result.out.includes(value), `${label} printed a secret`);
  console.log(`PASS ${label}`);
  return result;
}

async function alerts() {
  const list = await (await fetch(process.env.MAILPIT_URL + '/api/v1/messages?limit=200')).json();
  // Mailpit lists newest first; tests reason about the latest alert, so order oldest → newest.
  const mine = (list.messages || [])
    .filter((m) => m.To?.some((to) => to.Address === alertTo))
    .sort((a, b) => Date.parse(a.Created) - Date.parse(b.Created));
  return Promise.all(
    mine.map(async (m) => {
      const full = await (await fetch(process.env.MAILPIT_URL + '/api/v1/message/' + m.ID)).json();
      return { subject: full.Subject, text: full.Text };
    }),
  );
}
async function waitForAlerts(count) {
  for (let i = 0; i < 30; i++) {
    const found = await alerts();
    if (found.length >= count) return found;
    await new Promise((r) => setTimeout(r, 500));
  }
  return alerts();
}
const facts = (overrides = {}) =>
  REQUIRED_SERVICES.map((s) => `container|${s}|${overrides[s] || 'running'}|`).join('\n') +
  '\ndisk|/|40\n';

expectStatus(compose(['build', 'ops']), 0, 'build hardened ops image');
expectStatus(compose(['up', '-d', '--wait', 's3test']), 0, 'start S3-compatible offsite target');

// Repository setup is explicit and idempotent.
assert.match(expectStatus(ops(['init']), 0, 'initialise encrypted repository').out, /initialised/);
assert.match(expectStatus(ops(['init']), 0, 'repeat init is harmless').out, /already initialised/);

expectStatus(ops(['test-alert']), 0, 'send test alert through SMTP');
assert.ok((await waitForAlerts(1)).some((m) => m.subject.startsWith('[RARE OS TEST]')));

// Retention: seed 20 back-dated daily snapshots, then a real backup must prune old ones.
const backdated = Array.from({ length: 20 }, (_, i) => {
  const day = new Date(Date.now() - (i + 1) * 86400000);
  return day.toISOString().slice(0, 10) + ' 12:00:00';
});
expectStatus(
  compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'sh',
    'ops',
    '-c',
    'mkdir -p /tmp/rare-os-backup && echo fixture > /tmp/rare-os-backup/fixture && for t in "$@"; do restic backup -q --time "$t" --tag rare-os --host rare-os /tmp/rare-os-backup || exit 1; done',
    'seed-history',
    ...backdated,
  ]),
  0,
  'seed 20 days of back-dated snapshots',
);
assert.match(expectStatus(ops(['backup']), 0, 'offsite backup').out, /PASS offsite encrypted/);
const snapshots = JSON.parse(
  expectStatus(restic(['snapshots', '--json', '--no-lock']), 0, 'list snapshots').stdout,
);
const days = snapshots.map((x) => x.time.slice(0, 10));
assert.ok(snapshots.length < 21 && snapshots.length <= 17, `retention kept ${snapshots.length}`);
for (const i of [0, 1, 2, 3, 4, 5])
  assert.ok(days.includes(backdated[i].slice(0, 10)), 'recent daily snapshots must be kept');
assert.ok(
  backdated.slice(7, 13).some((t) => !days.includes(t.slice(0, 10))),
  'older mid-week snapshots must be pruned',
);
assert.ok(snapshots.every((x) => x.tags?.includes('rare-os') && x.hostname === 'rare-os'));
console.log(`PASS retention pruned 21 snapshots to ${snapshots.length}`);

// Data is encrypted: the wrong password cannot open the repository.
const wrong = restic(['snapshots', '--no-lock'], ['RESTIC_PASSWORD=' + secret()]);
assert.notEqual(wrong.status, 0);
assert.match(wrong.out, /wrong password/);
console.log('PASS repository rejects a wrong encryption password');

assert.match(
  expectStatus(ops(['restore-drill']), 0, 'restore drill from offsite snapshot').out,
  /PASS restore drill/,
);
const drill = JSON.parse(
  expectStatus(
    compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'cat',
      'ops',
      '/state/restore-drill.json',
    ]),
    0,
    'read restore drill receipt',
  ).stdout,
);
assert.ok(drill.counts.rare_os.companies >= 1 && drill.counts.keycloak.identities >= 1);

// Real host facts from this stack (same commands as host-run.sh) must report every service healthy.
let real = '';
for (let i = 0; i < 40; i++) {
  real = compose(['ps', '-a', '--format', 'container|{{.Service}}|{{.State}}|{{.Health}}']).stdout;
  if (!/\|(?:starting|unhealthy)\n/.test(real + '\n')) break;
  await new Promise((r) => setTimeout(r, 3000));
}
const realRun = ops(['monitor'], {
  input: real + 'disk|/|10\n',
  extraEnv: ['MONITOR_BACKUPS=false'],
});
assert.doesNotMatch(realRun.out, /FAIL container:/, 'real containers must be healthy:\n' + real);
expectStatus(realRun, 0, 'monitor accepts real stack container health');

// Monitoring: healthy run stays quiet.
let before = (await alerts()).length;
expectStatus(ops(['monitor'], { input: facts() }), 0, 'healthy monitor run');
assert.equal((await alerts()).length, before, 'healthy run must not email');

// A stopped worker alerts on the second consecutive failure, once, then recovers.
expectStatus(
  ops(['monitor'], { input: facts({ worker: 'exited' }) }),
  0,
  'first worker blip tolerated',
);
assert.equal((await alerts()).length, before);
expectStatus(ops(['monitor'], { input: facts({ worker: 'exited' }) }), 2, 'worker outage alerts');
let mail = await waitForAlerts(before + 1);
assert.equal(mail.length, before + 1);
assert.match(mail.at(-1).subject, /^\[RARE OS ALERT\] 1 problem on regression$/);
assert.match(mail.at(-1).text, /container:worker: state exited/);
expectStatus(ops(['monitor'], { input: facts({ worker: 'exited' }) }), 2, 'ongoing outage');
assert.equal((await alerts()).length, before + 1, 'no duplicate alert inside reminder window');
expectStatus(ops(['monitor'], { input: facts() }), 0, 'worker recovery');
mail = await waitForAlerts(before + 2);
assert.match(mail.at(-1).subject, /^\[RARE OS RECOVERED\]/);

// Missing host facts and stale backups alert immediately.
before = mail.length;
expectStatus(
  ops(['monitor'], { input: '', extraEnv: ['BACKUP_MAX_AGE_HOURS=0.00001'] }),
  2,
  'missing host facts and stale backup alert',
);
mail = await waitForAlerts(before + 1);
assert.match(mail.at(-1).text, /host:facts/);
assert.match(mail.at(-1).text, /backup:offsite/);
expectStatus(ops(['monitor'], { input: facts() }), 0, 'recovery after stale-backup check');

// Backup failure emails a redacted alert and records the failure.
before = (await waitForAlerts(before + 2)).length;
const badPassword = secret();
const failed = ops(['backup'], { extraEnv: ['RESTIC_PASSWORD=' + badPassword] });
assert.equal(failed.status, 1);
assert.ok(!failed.out.includes(badPassword));
mail = await waitForAlerts(before + 1);
assert.match(mail.at(-1).subject, /Offsite backup failed on regression/);
for (const value of [badPassword, backupPassword, env.BACKUP_SECRET_ACCESS_KEY])
  assert.ok(!mail.at(-1).text.includes(value), 'alert email leaked a secret');
console.log('PASS failed backup sends a redacted alert');

expectStatus(compose(['rm', '-sf', 's3test']), 0, 'stop offsite target');
console.log('PASS operations: encrypted offsite backup, retention, restore drill and alerts');
