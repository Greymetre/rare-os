// Keycloak administration for the operator scripts. The application talks to Keycloak through its
// own service account; these scripts run as the bootstrap administrator, because removing an
// identity is an operator's job, not the application's.
//
// Two identities are never touched, whatever a caller asks: the bootstrap administrator lives in
// the master realm, and the service account is how the application signs in at all.
const env = process.env;
export const PROTECTED_USERNAMES = ['service-account-rare-os-identity', 'bootstrap-admin'];

export async function keycloakAdmin() {
  const r = await fetch(env.AUTH_INTERNAL_URL + '/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'bootstrap-admin',
      password: env.KC_ADMIN_PASSWORD || '',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok)
    throw Error(
      `Keycloak admin sign-in failed (${r.status}). Check AUTH_INTERNAL_URL and KC_ADMIN_PASSWORD.`,
    );
  const token = (await r.json()).access_token;
  return async (path, method = 'GET') => {
    const res = await fetch(env.AUTH_INTERNAL_URL + '/admin/realms/rare-os' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000),
    });
    // An identity that is already gone is the state the caller wanted, so it is not an error.
    if (res.status === 404 && method === 'DELETE') return null;
    if (!res.ok) throw Error(`Keycloak ${method} ${path}: ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
}

// Removes the identities behind a set of app users. A caller passes the identity ids it has just
// deleted from the database; anything still in use, pending or protected is left alone.
export async function removeIdentities(kc, identities) {
  const done = [];
  for (const { id, email } of identities) {
    if (!id || id.startsWith('pending:')) continue;
    const user = await kc('/users/' + id).catch(() => null);
    if (!user) continue;
    if (PROTECTED_USERNAMES.includes(user.username)) continue;
    await kc('/users/' + id, 'DELETE');
    done.push(email || user.email || user.username);
  }
  return done;
}
