// Finds logins that no longer belong to anyone, and removes them on request.
//
// A login is created when a user is invited and is meant to disappear with that user. Anything the
// application removed before it learned to do that, and every invitation that failed after the
// login was made, is left behind — and a left-behind login keeps its email taken, so the same
// person can never be invited again. This lists those, and with --remove deletes them.
//
//   docker compose run --rm --no-deps seed node scripts/identity-sweep.mjs
//   docker compose run --rm --no-deps seed node scripts/identity-sweep.mjs --remove
import pg from 'pg';
import { keycloakAdmin, PROTECTED_USERNAMES } from './identity-admin.mjs';

const remove = process.argv.slice(2).includes('--remove');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const kc = await keycloakAdmin();
  // Every identity the application still points at, in any company.
  const used = new Set(
    (await db.query('SELECT DISTINCT identity_id FROM app_users')).rows.map((r) => r.identity_id),
  );
  const orphans = [];
  // Keycloak pages its user list; ask for a page at a time until one comes back short.
  for (let first = 0; ; first += 200) {
    const page = await kc(`/users?first=${first}&max=200`);
    for (const u of page)
      if (!used.has(u.id) && !PROTECTED_USERNAMES.includes(u.username)) orphans.push(u);
    if (page.length < 200) break;
  }
  if (!orphans.length) {
    console.log(`Every login belongs to a user. ${used.size} in use, nothing left over.`);
  } else if (!remove) {
    console.log(
      `${orphans.length} login${orphans.length === 1 ? '' : 's'} with no user (their emails stay taken until these go):`,
    );
    for (const u of orphans) console.log(`  ${u.email || u.username}  ${u.id}`);
    console.log('Run again with --remove to delete them.');
  } else {
    for (const u of orphans) await kc('/users/' + u.id, 'DELETE');
    console.log(
      `Removed ${orphans.length} login${orphans.length === 1 ? '' : 's'}: ${orphans
        .map((u) => u.email || u.username)
        .join(', ')}. These emails can be used again.`,
    );
  }
} finally {
  await db.end();
}
