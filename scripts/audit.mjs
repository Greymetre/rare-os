#!/usr/bin/env node
// The dependency gate.
//
// `npm audit` has no way to say "we have looked at this one and here is why it stands". Without
// that, a single unfixable advisory in a build tool either turns the whole gate red for weeks —
// at which point people stop reading it — or gets quietly dropped by lowering the threshold,
// which hides every future advisory too. Both are worse than writing the decision down.
//
// So this runs the audit twice and treats the two halves differently.
//
//   * **Production dependencies** — what actually ships inside the containers — are audited at
//     `low` with **no exceptions at all**. Nothing in this file can let a shipped vulnerability
//     through; there is no code path that would.
//   * **Everything, including the build toolchain** — is audited at `low` as well, and only here
//     may an advisory be accepted, by name, with a reason and a date it has to be looked at
//     again. An accepted advisory that nobody revisits turns the gate red by itself.
//
// Adding an entry below is a decision somebody owns. It is not a way to make a red build green.
import { spawnSync } from 'node:child_process';

// Advisories looked at and accepted, for the build toolchain only. Empty is the normal state:
// an entry here is a decision somebody owns, and it is removed the moment upstream fixes the
// advisory — which this script says plainly when it happens.
const ACCEPTED = [];

const today = new Date().toISOString().slice(0, 10);

function audit(extra) {
  const r = spawnSync('npm', ['audit', '--json', ...extra], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm exits non-zero when it finds something, which is not an error here; a crash is.
  if (!r.stdout) {
    console.error(r.stderr || 'npm audit produced no output.');
    process.exit(1);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    console.error('npm audit did not return JSON:\n' + r.stdout.slice(0, 2000));
    process.exit(1);
  }
}

// Every distinct advisory in a report, by its GHSA id. npm nests them: a package's `via` is
// either another package's name or the advisory itself.
function advisoriesOf(report) {
  const found = new Map();
  for (const [name, row] of Object.entries(report.vulnerabilities ?? {}))
    for (const via of row.via ?? []) {
      if (typeof via === 'string') continue;
      const id = /GHSA-[0-9a-z-]+/.exec(String(via.url ?? ''))?.[0] ?? String(via.url ?? via.title);
      const seen = found.get(id) ?? {
        id,
        title: via.title,
        severity: via.severity,
        url: via.url,
        packages: new Set(),
      };
      seen.packages.add(via.name ?? name);
      found.set(id, seen);
    }
  return [...found.values()];
}

let failed = false;

// ---------- What ships ----------
const production = advisoriesOf(audit(['--omit=dev', '--audit-level=low']));
if (production.length) {
  failed = true;
  console.error('Production dependencies carry advisories. These are never accepted here:\n');
  for (const a of production)
    console.error(
      `  ${a.severity.padEnd(8)} ${a.id}  ${[...a.packages].join(', ')}\n    ${a.title}\n    ${a.url}`,
    );
} else {
  console.log('Production dependencies: no advisories.');
}

// ---------- Everything, build toolchain included ----------
const all = advisoriesOf(audit(['--audit-level=low']));
const accepted = new Map(ACCEPTED.map((a) => [a.id, a]));
const unaccepted = all.filter((a) => !accepted.has(a.id));

if (unaccepted.length) {
  failed = true;
  console.error('\nAdvisories nobody has accepted:\n');
  for (const a of unaccepted)
    console.error(
      `  ${a.severity.padEnd(8)} ${a.id}  ${[...a.packages].join(', ')}\n    ${a.title}\n    ${a.url}`,
    );
  console.error(
    '\nFix them, or add the advisory to ACCEPTED in scripts/audit.mjs with a reason and a date.',
  );
}

for (const entry of ACCEPTED) {
  const live = all.find((a) => a.id === entry.id);
  if (!live) {
    // Not a failure: the advisory is gone, which is the outcome we wanted. It is still dead
    // weight in the file, and dead exceptions are how a gate rots.
    console.log(`\nNo longer present: ${entry.id} (${entry.package}). Remove it from ACCEPTED.`);
    continue;
  }
  if (entry.until < today) {
    failed = true;
    console.error(
      `\nThe exception for ${entry.id} (${entry.package}) was to be revisited by ${entry.until}. Look at it again.`,
    );
    continue;
  }
  console.log(`\nAccepted until ${entry.until}: ${entry.id} — ${live.severity}, ${entry.package}`);
  console.log('  ' + entry.why.replace(/(.{1,96})(\s|$)/g, '$1\n  ').trim());
}

process.exit(failed ? 1 : 0);
