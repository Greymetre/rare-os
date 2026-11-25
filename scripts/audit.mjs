#!/usr/bin/env node
// The dependency gate.
//
// `npm audit` has no way to say "we have looked at this one and here is why it stands". Without
// that, a single unfixable advisory in a build tool either turns the whole gate red for weeks —
// at which point people stop reading it — or gets quietly dropped by lowering the threshold,
// which hides every future advisory too. Both are worse than writing the decision down.
//
// So this audits three trees and treats them differently.
//
//   * **Production dependencies** — what actually ships inside the containers — are audited at
//     `low` with **no exceptions at all**. Nothing in this file can let a shipped vulnerability
//     through; there is no code path that would.
//   * **Everything, including the build toolchain** — is audited at `low` as well, and only here
//     may an advisory be accepted, by name, with a reason and a date it has to be looked at
//     again. An accepted advisory that nobody revisits turns the gate red by itself.
//   * **The field app** (`apps/mobile`) — RCH-8's Expo app, which is deliberately not an npm
//     workspace: Expo's bundler and CLI are not what ships inside the containers, so keeping
//     them in the root tree would have meant calling a build tool a production dependency. It
//     has its own package.json and lockfile, and it is audited here so that leaving the
//     workspace does not mean leaving the gate. Same rule as the toolchain half: an advisory
//     may be accepted by name, with a reason and a date.
//
// Adding an entry below is a decision somebody owns. It is not a way to make a red build green.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Advisories looked at and accepted, for the build toolchain only. Empty is the normal state:
// an entry here is a decision somebody owns, and it is removed the moment upstream fixes the
// advisory — which this script says plainly when it happens.
const ACCEPTED = [];

// The same, for the field app's own tree. npm cannot tell us which half of that tree an
// advisory sits in — the `expo` package declares its own CLI and bundler as dependencies — so
// an entry here has to say in `why` whether the code can reach a rep's phone at all, and a
// fix always beats an entry: `apps/mobile/package.json` carries an override that lifts
// minimatch past GHSA-g3hv-75wg-m249 rather than excusing it.
const ACCEPTED_FIELD_APP = [];

const FIELD_APP = 'apps/mobile';

const today = new Date().toISOString().slice(0, 10);

function audit(extra, cwd) {
  const r = spawnSync('npm', ['audit', '--json', ...extra], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
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

// One advisory, printed the way both halves below print it.
function show(a) {
  console.error(
    `  ${a.severity.padEnd(8)} ${a.id}  ${[...a.packages].join(', ')}\n    ${a.title}\n    ${a.url}`,
  );
}

// A tree that is allowed named exceptions: anything nobody has accepted fails, every accepted
// entry is read back out loud, an entry past its date fails, and an entry whose advisory is
// gone is reported as dead weight.
function reviewTree(advisories, exceptions, listName) {
  const accepted = new Map(exceptions.map((a) => [a.id, a]));
  const unaccepted = advisories.filter((a) => !accepted.has(a.id));

  if (unaccepted.length) {
    failed = true;
    console.error('\nAdvisories nobody has accepted:\n');
    for (const a of unaccepted) show(a);
    console.error(
      `\nFix them, or add the advisory to ${listName} in scripts/audit.mjs with a reason and a date.`,
    );
  }

  for (const entry of exceptions) {
    const live = advisories.find((a) => a.id === entry.id);
    if (!live) {
      // Not a failure: the advisory is gone, which is the outcome we wanted. It is still dead
      // weight in the file, and dead exceptions are how a gate rots.
      console.log(
        `\nNo longer present: ${entry.id} (${entry.package}). Remove it from ${listName}.`,
      );
      continue;
    }
    if (entry.until < today) {
      failed = true;
      console.error(
        `\nThe exception for ${entry.id} (${entry.package}) was to be revisited by ${entry.until}. Look at it again.`,
      );
      continue;
    }
    console.log(
      `\nAccepted until ${entry.until}: ${entry.id} — ${live.severity}, ${entry.package}`,
    );
    console.log('  ' + entry.why.replace(/(.{1,96})(\s|$)/g, '$1\n  ').trim());
  }
}

// ---------- Everything, build toolchain included ----------
reviewTree(advisoriesOf(audit(['--audit-level=low'])), ACCEPTED, 'ACCEPTED');

// ---------- The field app's own tree ----------
// It is not a workspace, so neither audit above has seen a single package of it. A missing
// lockfile here means nobody has installed the app yet, and that is a failure rather than a
// silent pass: an unaudited tree must never read as a clean one.
if (!existsSync(`${FIELD_APP}/package-lock.json`)) {
  failed = true;
  console.error(
    `\nThe field app has no lockfile at ${FIELD_APP}/package-lock.json, so its dependencies ` +
      'cannot be audited. Run `npm run mobile:install` and commit the lockfile.',
  );
} else {
  console.log(`\nThe field app (${FIELD_APP}), audited on its own:`);
  reviewTree(
    advisoriesOf(audit(['--audit-level=low'], FIELD_APP)),
    ACCEPTED_FIELD_APP,
    'ACCEPTED_FIELD_APP',
  );
  if (!failed) console.log('  no advisories.');
}

process.exit(failed ? 1 : 0);
