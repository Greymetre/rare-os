// Temporary MFA exemption for one account, for repeated test logins. Operator-only (database owner
// and Keycloak bootstrap admin); every exemption expires and MFA is required again automatically.
//
//   docker compose run --rm --no-deps seed node scripts/mfa-exemption.mjs add <email> <days> "<reason>"
//   docker compose run --rm --no-deps seed node scripts/mfa-exemption.mjs remove <email>
//   docker compose run --rm --no-deps seed node scripts/mfa-exemption.mjs list
//
// add: records the exemption, removes the account's authenticator devices and recovery codes (so
// the login no longer asks for a code) and signs the account out everywhere.
// remove: ends the exemption and signs the account out; the next login sets up MFA again.
import pg from 'pg';

const env = process.env;
const [command, email, daysText, reason] = process.argv.slice(2);
const usage = 'Usage: mfa-exemption.mjs add <email> <days 1-60> "<reason>" | remove <email> | list';
if (!['add', 'remove', 'list'].includes(command) || (command !== 'list' && !email)) {
  console.error(usage);
  process.exit(2);
}
const days = Number(daysText);
if (command === 'add' && (!Number.isInteger(days) || days < 1 || days > 60 || !reason)) {
  console.error(usage);
  process.exit(2);
}

async function keycloak() {
  const r = await fetch(env.AUTH_INTERNAL_URL + '/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'bootstrap-admin',
      password: env.KC_ADMIN_PASSWORD,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Error('Keycloak admin sign-in failed: ' + r.status);
  const token = (await r.json()).access_token;
  return async (path, method = 'GET') => {
    const res = await fetch(env.AUTH_INTERNAL_URL + '/admin/realms/rare-os' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Error(`Keycloak ${method} ${path}: ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
}

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  if (command === 'list') {
    const rows = (
      await db.query(
        "SELECT email,reason,to_char(expires_at,'YYYY-MM-DD HH24:MI') AS until,expires_at > now() AS active FROM mfa_exemptions ORDER BY expires_at",
      )
    ).rows;
    if (!rows.length) console.log('No MFA exemptions. MFA applies to every administrator.');
    for (const r of rows)
      console.log(
        `${r.email}  until ${r.until} UTC  ${r.active ? 'ACTIVE' : 'expired'}  (${r.reason})`,
      );
  } else {
    const kc = await keycloak();
    const [user] = await kc(`/users?email=${encodeURIComponent(email)}&exact=true`);
    if (!user) throw Error(`No account with email ${email}.`);
    if (command === 'add') {
      const until = (
        await db.query(
          `INSERT INTO mfa_exemptions(identity_id,email,reason,expires_at) VALUES($1,$2,$3,now() + make_interval(days => $4))
           ON CONFLICT (identity_id) DO UPDATE SET reason=excluded.reason,expires_at=excluded.expires_at,created_at=now()
           RETURNING to_char(expires_at,'YYYY-MM-DD HH24:MI') AS until`,
          [user.id, user.email, reason, days],
        )
      ).rows[0].until;
      for (const c of await kc(`/users/${user.id}/credentials`))
        if (c.type === 'otp' || c.type === 'recovery-authn-codes')
          await kc(`/users/${user.id}/credentials/${c.id}`, 'DELETE');
      await kc(`/users/${user.id}/logout`, 'POST');
      console.log(
        `MFA exemption for ${user.email} until ${until} UTC. Authenticator devices and recovery codes removed; signed out everywhere. Sign in with the password only.`,
      );
    } else {
      const removed = await db.query('DELETE FROM mfa_exemptions WHERE identity_id=$1', [user.id]);
      await kc(`/users/${user.id}/logout`, 'POST');
      console.log(
        removed.rowCount
          ? `MFA exemption for ${user.email} removed and the account signed out. The next sign-in asks to set up an authenticator again.`
          : `${user.email} had no MFA exemption. Nothing changed.`,
      );
    }
  }
} finally {
  await db.end();
}
