// Runs inside the rare-os ops container: offsite backup, restore drill, monitoring and alert email.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:tls';
import { join } from 'node:path';
import {
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
} from './lib.mjs';

const env = process.env;
const stateDir = env.OPS_STATE_DIR || '/state';
const site = env.OPS_SITE || (env.APP_URL ? new URL(env.APP_URL).host : 'rare-os');
const workDir = '/tmp/rare-os-backup';
const restoreDir = '/tmp/rare-os-drill';

function run(program, args, { input, cwd } = {}) {
  const r = spawnSync(program, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw Error(
      redact(
        `${program} ${args[0] || ''} failed: ${(r.stderr || r.error?.message || '').trim().slice(-600)}`,
        env,
      ),
    );
  return r.stdout.trim();
}
const psql = (db, sql) => run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', db, '-c', sql]);

function readState(name) {
  try {
    return JSON.parse(readFileSync(join(stateDir, name + '.json'), 'utf8'));
  } catch {
    return {};
  }
}
function writeState(name, value) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, name + '.json');
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const quote = (v) => '"' + String(v).replace(/[\\"]/g, (c) => '\\' + c) + '"';

function sendEmail(subject, body) {
  const to = (env.ALERT_EMAIL_TO || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!to.length) {
    console.error('ALERT_EMAIL_TO is not set; alert not emailed: ' + subject);
    return false;
  }
  const from = env.SMTP_FROM || 'no-reply@rareos.local';
  const dir = join('/tmp', 'rare-mail-' + randomBytes(6).toString('hex'));
  mkdirSync(dir, { mode: 0o700 });
  try {
    const message = [
      `From: RARE OS Monitor <${from}>`,
      `To: ${to.join(', ')}`,
      `Subject: ${subject.replace(/[\r\n]/g, ' ')}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      redact(body, env),
      '',
    ].join('\r\n');
    writeFileSync(join(dir, 'message.eml'), message, { mode: 0o600 });
    // Credentials go through a private curl config file, never the process argument list.
    const config = [
      `url = ${quote(`smtp://${env.SMTP_HOST || 'mailpit'}:${env.SMTP_PORT || '1025'}`)}`,
      `mail-from = ${quote(from)}`,
      ...to.map((address) => `mail-rcpt = ${quote(address)}`),
      `upload-file = ${quote(join(dir, 'message.eml'))}`,
      'max-time = 60',
      'silent',
      'show-error',
    ];
    if (env.SMTP_STARTTLS === 'true') config.push('ssl-reqd');
    if (env.SMTP_USER)
      config.push(`user = ${quote(env.SMTP_USER + ':' + (env.SMTP_PASSWORD || ''))}`);
    writeFileSync(join(dir, 'curl.conf'), config.join('\n') + '\n', { mode: 0o600 });
    run('curl', ['--config', join(dir, 'curl.conf')]);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function heartbeat(failing) {
  if (!env.HEARTBEAT_URL) return;
  try {
    await fetch(env.HEARTBEAT_URL + (failing ? '/fail' : ''), {
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error('Heartbeat ping failed: ' + redact(error.message, env));
  }
}

function initRepository() {
  backupConfig(env);
  try {
    run('restic', ['cat', 'config']);
    console.log('Backup repository already initialised.');
  } catch {
    run('restic', ['init']);
    console.log('Encrypted backup repository initialised. Store BACKUP_PASSWORD offline too.');
  }
}

async function backup() {
  const state = readState('backup');
  try {
    const config = backupConfig(env);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const manifest = { createdAt: new Date().toISOString(), site, files: [] };
    for (const database of ['rare_os', 'keycloak']) {
      const file = join(workDir, database + '.dump');
      run('pg_dump', ['-d', database, '-Fc', '-f', file]);
      if (!run('pg_restore', ['--list', file]).includes('TABLE DATA'))
        throw Error(`Backup of ${database} contains no table data`);
      manifest.files.push({
        database,
        file: database + '.dump',
        bytes: statSync(file).size,
        sha256: sha256(file),
      });
    }
    writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    const output = run(
      'restic',
      ['backup', '--json', '--tag', 'rare-os', '--host', 'rare-os', workDir],
      {},
    );
    const summary = output
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {};
        }
      })
      .find((x) => x.message_type === 'summary');
    if (!summary?.snapshot_id) throw Error('Backup finished without a snapshot id');
    run('restic', retentionArgs(config));
    writeState('backup', {
      ...state,
      lastSuccessAt: new Date().toISOString(),
      snapshotId: summary.snapshot_id,
      bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
    });
    console.log(
      `PASS offsite encrypted backup ${summary.snapshot_id.slice(0, 8)}; retention applied.`,
    );
  } catch (error) {
    const message = redact(error.message, env);
    writeState('backup', { ...state, lastFailureAt: new Date().toISOString(), lastError: message });
    try {
      sendEmail(
        `[RARE OS ALERT] Offsite backup failed on ${site}`,
        `The scheduled offsite database backup did not complete.\n\n${message}\n\nPrevious successful backup: ${state.lastSuccessAt || 'none recorded'}\nRunbook: docs/OPERATIONS_HINGLISH.md`,
      );
    } catch (mailError) {
      console.error('Alert email failed: ' + redact(mailError.message, env));
    }
    throw Error(message);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function findManifest(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'manifest.json') return full;
    if (entry.isDirectory()) {
      const found = findManifest(full);
      if (found) return found;
    }
  }
  return null;
}

async function restoreDrill() {
  const state = readState('restore-drill');
  const temporary = [];
  try {
    backupConfig(env);
    const snapshots = JSON.parse(
      run('restic', ['snapshots', '--json', '--tag', 'rare-os', '--host', 'rare-os']),
    );
    const latest = snapshots.at(-1);
    if (!latest) throw Error('No offsite snapshot exists to restore');
    rmSync(restoreDir, { recursive: true, force: true });
    mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
    run('restic', ['restore', latest.id, '--target', restoreDir]);
    const manifestFile = findManifest(restoreDir);
    if (!manifestFile) throw Error('Restored snapshot has no manifest');
    const base = manifestFile.slice(0, -'manifest.json'.length);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const liveMigrations = Number(psql('rare_os', 'SELECT count(*) FROM schema_migrations'));
    const counts = {};
    for (const file of manifest.files) {
      if (!['rare_os', 'keycloak'].includes(file.database))
        throw Error('Unexpected manifest entry');
      if (sha256(join(base, file.file)) !== file.sha256)
        throw Error(`Checksum mismatch for ${file.database}`);
      const target = 'rare_drill_' + randomBytes(6).toString('hex');
      temporary.push(target);
      run('createdb', [target]);
      run('pg_restore', ['--exit-on-error', '-d', target, join(base, file.file)]);
      if (file.database === 'rare_os') {
        const [tenants, users, migrations] = psql(
          target,
          "SELECT (SELECT count(*) FROM tenants)||'|'||(SELECT count(*) FROM app_users)||'|'||(SELECT count(*) FROM schema_migrations)",
        )
          .split('|')
          .map(Number);
        if (!tenants || !users) throw Error('Restored application database has no companies/users');
        if (migrations > liveMigrations)
          throw Error('Restored schema is newer than the live database');
        // RLS must survive restore: the runtime role sees no tenants without a tenant context.
        psql(
          target,
          "BEGIN; SET LOCAL ROLE rare_app; DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenants) THEN RAISE EXCEPTION 'RLS missing after restore'; END IF; END $$; ROLLBACK;",
        );
        counts.rare_os = { companies: tenants, users, migrations };
      } else {
        const [realm, identities] = psql(
          target,
          "SELECT (SELECT count(*) FROM realm WHERE name='rare-os')||'|'||(SELECT count(*) FROM user_entity)",
        )
          .split('|')
          .map(Number);
        if (realm !== 1 || !identities) throw Error('Restored identity database is incomplete');
        counts.keycloak = { identities };
      }
    }
    run('restic', ['check', '--read-data-subset=10%']);
    writeState('restore-drill', {
      ...state,
      lastSuccessAt: new Date().toISOString(),
      snapshotId: latest.id,
      snapshotTime: latest.time,
      counts,
    });
    console.log(
      `PASS restore drill of snapshot ${latest.id.slice(0, 8)} (${latest.time}); checksums, RLS and identity data verified; repository check passed.`,
    );
  } catch (error) {
    const message = redact(error.message, env);
    writeState('restore-drill', {
      ...state,
      lastFailureAt: new Date().toISOString(),
      lastError: message,
    });
    try {
      sendEmail(
        `[RARE OS ALERT] Backup restore drill failed on ${site}`,
        `The weekly restore verification of the latest offsite backup failed.\n\n${message}\n\nRunbook: docs/OPERATIONS_HINGLISH.md`,
      );
    } catch (mailError) {
      console.error('Alert email failed: ' + redact(mailError.message, env));
    }
    throw Error(message);
  } finally {
    for (const target of temporary)
      try {
        run('dropdb', ['--if-exists', target]);
      } catch (error) {
        console.error('Could not drop temporary database ' + target);
      }
    rmSync(restoreDir, { recursive: true, force: true });
  }
}

function certificateExpiry(host) {
  return new Promise((accept, reject) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!socket.authorized)
        reject(Error('certificate not trusted: ' + socket.authorizationError));
      else accept(cert.valid_to);
    });
    socket.on('timeout', () => socket.destroy(Error('TLS connection timed out')));
    socket.on('error', reject);
  });
}

async function monitor() {
  const config = monitorConfig(env);
  const now = Date.now();
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  const host = parseHostFacts(input);
  const results = hostChecks(host, config);
  for (const url of config.urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      results.push({
        id: 'http:' + url,
        ok: response.ok,
        transient: true,
        detail: `HTTP ${response.status}`,
      });
    } catch (error) {
      results.push({ id: 'http:' + url, ok: false, transient: true, detail: error.message });
    }
  }
  for (const tlsHost of config.tlsHosts) {
    try {
      results.push(tlsCheck(tlsHost, await certificateExpiry(tlsHost), config, now));
    } catch (error) {
      results.push({ id: 'tls:' + tlsHost, ok: false, transient: true, detail: error.message });
    }
  }
  if (env.MONITOR_BACKUPS !== 'false')
    results.push(
      ...freshnessChecks(
        { backup: readState('backup'), restoreDrill: readState('restore-drill') },
        config,
        now,
      ),
    );
  const decision = decideAlerts(readState('monitor'), results, config, now);
  const email = alertEmail(decision, site);
  // If the email cannot be sent, keep the old state so the alert is retried next run.
  if (email && !sendEmail(email.subject, email.body) && env.ALERT_EMAIL_TO)
    throw Error('Alert email was not sent');
  writeState('monitor', decision.state);
  const failing = Object.values(decision.state).some((x) => x.alerting);
  for (const r of results)
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} — ${redact(r.detail, env)}`);
  await heartbeat(failing);
  if (failing) process.exitCode = 2;
}

const commands = {
  init: initRepository,
  backup,
  'restore-drill': restoreDrill,
  monitor,
  'test-alert': () => {
    if (
      !sendEmail(
        `[RARE OS TEST] Alert email works for ${site}`,
        'This is a test alert from RARE OS operations.',
      )
    )
      throw Error('ALERT_EMAIL_TO is not set');
    console.log('Test alert sent.');
  },
};
const name = process.argv[2];
if (!commands[name]) {
  console.error('Usage: ops.mjs init|backup|restore-drill|monitor|test-alert');
  process.exit(64);
}
try {
  await commands[name]();
} catch (error) {
  console.error('FAIL ' + redact(error.message, env));
  process.exitCode = 1;
}
