// Pure operations logic: no I/O here, so thresholds and alert decisions are unit tested.

export const REQUIRED_SERVICES = ['db', 'redis', 'keycloak', 'api', 'worker', 'web'];

const positive = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw Error(`${name} must be a positive number`);
  return n;
};

export function backupConfig(env) {
  const missing = ['RESTIC_REPOSITORY', 'RESTIC_PASSWORD', 'PGPASSWORD'].filter((k) => !env[k]);
  if (missing.length)
    throw Error('Offsite backup is not configured. Missing: ' + missing.join(', '));
  if (env.RESTIC_PASSWORD.length < 24)
    throw Error('BACKUP_PASSWORD must be at least 24 characters');
  if (/^(?:\/|local:)/.test(env.RESTIC_REPOSITORY))
    throw Error('BACKUP_REPOSITORY must be off-server (s3:, b2:, azure:, gs:, sftp: or rest:)');
  return {
    keepDaily: positive(env.BACKUP_KEEP_DAILY, 7, 'BACKUP_KEEP_DAILY'),
    keepWeekly: positive(env.BACKUP_KEEP_WEEKLY, 4, 'BACKUP_KEEP_WEEKLY'),
    keepMonthly: positive(env.BACKUP_KEEP_MONTHLY, 6, 'BACKUP_KEEP_MONTHLY'),
  };
}

export function retentionArgs(config) {
  return [
    'forget',
    '--tag',
    'rare-os',
    '--host',
    'rare-os',
    '--keep-daily',
    String(config.keepDaily),
    '--keep-weekly',
    String(config.keepWeekly),
    '--keep-monthly',
    String(config.keepMonthly),
    '--prune',
  ];
}

export function monitorConfig(env) {
  const list = (value) =>
    (value || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const urls = list(env.MONITOR_URLS);
  for (const url of urls)
    if (!/^https?:\/\//.test(url)) throw Error('MONITOR_URLS entries must be http(s) URLs');
  return {
    urls,
    tlsHosts: list(env.MONITOR_TLS_HOSTS),
    diskPercent: positive(env.MONITOR_DISK_PERCENT, 85, 'MONITOR_DISK_PERCENT'),
    tlsDays: positive(env.MONITOR_TLS_DAYS, 14, 'MONITOR_TLS_DAYS'),
    backupHours: positive(env.BACKUP_MAX_AGE_HOURS, 8, 'BACKUP_MAX_AGE_HOURS'),
    drillDays: positive(env.RESTORE_DRILL_MAX_AGE_DAYS, 8, 'RESTORE_DRILL_MAX_AGE_DAYS'),
    reminderHours: positive(env.ALERT_REMINDER_HOURS, 6, 'ALERT_REMINDER_HOURS'),
  };
}

// Host facts arrive as plain lines from scripts/ops/host-run.sh, never via docker.sock:
//   container|<service>|<state>|<health>   and   disk|<mount>|<used percent>
export function parseHostFacts(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const facts = { containers: [], disks: [] };
  for (const line of lines) {
    const [kind, name, value, health = ''] = line.split('|');
    if (kind === 'container' && name)
      facts.containers.push({ Service: name, State: value, Health: health });
    else if (kind === 'disk' && name && /^\d+$/.test(value))
      facts.disks.push({ mount: name, usedPercent: Number(value) });
  }
  return facts;
}
export function hostChecks(host, config) {
  const results = [];
  if (!host) {
    results.push({
      id: 'host:facts',
      ok: false,
      detail: 'Host container and disk status was not supplied',
    });
    return results;
  }
  const containers = new Map((host.containers || []).map((c) => [c.Service, c]));
  for (const service of REQUIRED_SERVICES) {
    const c = containers.get(service);
    const ok = !!c && c.State === 'running' && c.Health !== 'unhealthy';
    results.push({
      id: 'container:' + service,
      ok,
      transient: true,
      detail: ok
        ? 'running'
        : c
          ? `state ${c.State}${c.Health ? ', health ' + c.Health : ''}`
          : 'container not found',
    });
  }
  for (const disk of host.disks || []) {
    const ok = disk.usedPercent < config.diskPercent;
    results.push({
      id: 'disk:' + disk.mount,
      ok,
      detail: `${disk.usedPercent}% used (alert at ${config.diskPercent}%)`,
    });
  }
  return results;
}

export function freshnessChecks(state, config, now) {
  const hours = (iso) => (now - Date.parse(iso)) / 3600000;
  const backup = state.backup?.lastSuccessAt;
  const drill = state.restoreDrill?.lastSuccessAt;
  return [
    {
      id: 'backup:offsite',
      ok: !!backup && hours(backup) <= config.backupHours,
      detail: backup
        ? `last successful offsite backup ${hours(backup).toFixed(1)}h ago (limit ${config.backupHours}h)`
        : 'no successful offsite backup recorded',
    },
    {
      id: 'backup:restore-drill',
      ok: !!drill && hours(drill) <= config.drillDays * 24,
      detail: drill
        ? `last verified restore ${(hours(drill) / 24).toFixed(1)} days ago (limit ${config.drillDays} days)`
        : 'no successful restore drill recorded',
    },
  ];
}

export function tlsCheck(host, validTo, config, now) {
  const days = (Date.parse(validTo) - now) / 86400000;
  return {
    id: 'tls:' + host,
    ok: days >= config.tlsDays,
    detail: `certificate expires in ${Math.floor(days)} days (alert below ${config.tlsDays})`,
  };
}

// Transient checks (HTTP/containers) must fail twice in a row so a restart blip does not page anyone.
export function decideAlerts(previous, results, config, now) {
  const next = {};
  const opened = [],
    reminders = [],
    recovered = [];
  const nowIso = new Date(now).toISOString();
  for (const r of results) {
    const old = previous[r.id] || { failures: 0, alerting: false };
    const failures = r.ok ? 0 : old.failures + 1;
    const failing = !r.ok && failures >= (r.transient ? 2 : 1);
    const item = {
      failures,
      alerting: failing,
      since: failing ? old.since || nowIso : undefined,
      lastAlertAt: failing ? old.lastAlertAt : undefined,
      detail: r.detail,
    };
    if (failing && !old.alerting) {
      opened.push(r);
      item.lastAlertAt = nowIso;
    } else if (
      failing &&
      (!old.lastAlertAt || now - Date.parse(old.lastAlertAt) >= config.reminderHours * 3600000)
    ) {
      reminders.push(r);
      item.lastAlertAt = nowIso;
    } else if (!failing && old.alerting) recovered.push(r);
    next[r.id] = item;
  }
  // Checks that disappeared (e.g. a removed URL) are dropped rather than alerting forever.
  return { state: next, opened, reminders, recovered };
}

export function alertEmail({ opened, reminders, recovered }, site) {
  const problems = [...opened, ...reminders];
  if (!problems.length && !recovered.length) return null;
  const subject = problems.length
    ? `[RARE OS ALERT] ${problems.length} problem${problems.length > 1 ? 's' : ''} on ${site}`
    : `[RARE OS RECOVERED] ${recovered.length} check${recovered.length > 1 ? 's' : ''} healthy on ${site}`;
  const lines = [];
  if (opened.length)
    lines.push('New problems:', ...opened.map((r) => `- ${r.id}: ${r.detail}`), '');
  if (reminders.length)
    lines.push('Still failing:', ...reminders.map((r) => `- ${r.id}: ${r.detail}`), '');
  if (recovered.length)
    lines.push('Recovered:', ...recovered.map((r) => `- ${r.id}: ${r.detail}`), '');
  lines.push('Runbook: docs/OPERATIONS_HINGLISH.md');
  return { subject, body: lines.join('\n') };
}

// Never let a secret reach an email body or log line.
export function redact(text, env) {
  let out = String(text);
  for (const key of [
    'RESTIC_PASSWORD',
    'PGPASSWORD',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'SMTP_PASSWORD',
    'B2_ACCOUNT_KEY',
  ])
    if (env[key] && env[key].length >= 4) out = out.split(env[key]).join('[redacted]');
  return out.replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, '$1[redacted]@');
}
