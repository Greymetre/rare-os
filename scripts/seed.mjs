import pg from 'pg';
import { permissions } from '../packages/schema/permissions.mjs';
const env = process.env;
for (const key of [
  'SEED_ADMIN_EMAIL',
  'SEED_ADMIN_PASSWORD',
  'KC_ADMIN_PASSWORD',
  'OIDC_CLIENT_SECRET',
])
  if (!env[key]) throw Error(key + ' is required');
const base = env.AUTH_INTERNAL_URL;
let token;
for (let i = 0; i < 90; i++) {
  try {
    const r = await fetch(base + '/realms/master/protocol/openid-connect/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'bootstrap-admin',
        password: env.KC_ADMIN_PASSWORD,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      token = (await r.json()).access_token;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
}
if (!token) throw Error('Keycloak did not become ready. Check keycloak logs.');
const admin = async (path, method = 'GET', body) => {
  const r = await fetch(base + '/admin' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok && r.status !== 404)
    throw Error('Keycloak admin ' + method + ' ' + path + ': ' + r.status);
  return r;
};
if ((await admin('/realms/rare-os')).status === 404)
  await admin('/realms', 'POST', {
    realm: 'rare-os',
    enabled: true,
    displayName: 'RARE OS',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    bruteForceProtected: true,
    loginWithEmailAllowed: true,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
  });
await admin('/realms/rare-os', 'PUT', { loginTheme: 'rare-os' });
const client = {
  clientId: 'rare-os-web',
  name: 'RARE OS Web',
  enabled: true,
  publicClient: false,
  secret: env.OIDC_CLIENT_SECRET,
  standardFlowEnabled: true,
  directAccessGrantsEnabled: false,
  redirectUris: [env.APP_URL + '/api/auth/callback', env.APP_URL + '/api/auth/login'],
  webOrigins: [env.APP_URL],
  attributes: {
    'pkce.code.challenge.method': 'S256',
    'post.logout.redirect.uris': env.APP_URL + '/',
    'backchannel.logout.url': 'http://api:4000/api/auth/backchannel-logout',
    'backchannel.logout.session.required': 'true',
  },
};
let clients = await (await admin('/realms/rare-os/clients?clientId=rare-os-web')).json();
if (!clients.length) await admin('/realms/rare-os/clients', 'POST', client);
else await admin('/realms/rare-os/clients/' + clients[0].id, 'PUT', client);

if (!env.IDENTITY_CLIENT_SECRET) throw Error('IDENTITY_CLIENT_SECRET is required');
const adminClient = {
  clientId: 'rare-os-identity',
  enabled: true,
  publicClient: false,
  secret: env.IDENTITY_CLIENT_SECRET,
  serviceAccountsEnabled: true,
  standardFlowEnabled: false,
  directAccessGrantsEnabled: false,
};
let ac = await (await admin('/realms/rare-os/clients?clientId=rare-os-identity')).json();
if (!ac.length) {
  await admin('/realms/rare-os/clients', 'POST', adminClient);
  ac = await (await admin('/realms/rare-os/clients?clientId=rare-os-identity')).json();
} else await admin('/realms/rare-os/clients/' + ac[0].id, 'PUT', adminClient);
const serviceUser = await (
  await admin('/realms/rare-os/clients/' + ac[0].id + '/service-account-user')
).json();
const management = (
  await (await admin('/realms/rare-os/clients?clientId=realm-management')).json()
)[0];
const managedRoles = [];
for (const code of ['manage-users', 'view-users', 'query-users'])
  managedRoles.push(
    await (await admin('/realms/rare-os/clients/' + management.id + '/roles/' + code)).json(),
  );
await admin(
  '/realms/rare-os/users/' + serviceUser.id + '/role-mappings/clients/' + management.id,
  'POST',
  managedRoles,
);
if (env.SMTP_HOST && env.SMTP_FROM) {
  const smtpServer = {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT || '587',
    from: env.SMTP_FROM,
    fromDisplayName: 'RARE OS',
    starttls: env.SMTP_STARTTLS || 'false',
    auth: env.SMTP_USER ? 'true' : 'false',
  };
  if (env.SMTP_USER) {
    smtpServer.user = env.SMTP_USER;
    smtpServer.password = env.SMTP_PASSWORD;
  }
  await admin('/realms/rare-os', 'PUT', {
    smtpServer,
    resetPasswordAllowed: true,
    passwordPolicy: 'length(12) and notUsername(undefined)',
  });
}
await admin(
  '/realms/rare-os/authentication/required-actions/CONFIGURE_RECOVERY_AUTHN_CODES',
  'PUT',
  {
    alias: 'CONFIGURE_RECOVERY_AUTHN_CODES',
    name: 'Recovery authentication codes',
    providerId: 'CONFIGURE_RECOVERY_AUTHN_CODES',
    enabled: true,
    defaultAction: false,
    priority: 70,
  },
);
const browserSteps = await (
  await admin('/realms/rare-os/authentication/flows/browser/executions')
).json();
for (const step of browserSteps.filter(
  (x) => x.displayName === 'Recovery Authentication Code Form' && x.requirement === 'DISABLED',
))
  await admin('/realms/rare-os/authentication/flows/browser/executions', 'PUT', {
    ...step,
    requirement: 'ALTERNATIVE',
  });
let users = await (
  await admin(
    '/realms/rare-os/users?exact=true&username=' + encodeURIComponent(env.SEED_ADMIN_EMAIL),
  )
).json();
if (!users.length) {
  await admin('/realms/rare-os/users', 'POST', {
    username: env.SEED_ADMIN_EMAIL,
    email: env.SEED_ADMIN_EMAIL,
    firstName: 'Main',
    lastName: 'Admin',
    emailVerified: true,
    enabled: true,
    credentials: [{ type: 'password', value: env.SEED_ADMIN_PASSWORD, temporary: false }],
  });
  users = await (
    await admin(
      '/realms/rare-os/users?exact=true&username=' + encodeURIComponent(env.SEED_ADMIN_EMAIL),
    )
  ).json();
}
if (users.length !== 1) throw Error('Expected one admin identity');
const tenant = '10000000-0000-4000-8000-000000000001',
  role = '20000000-0000-4000-8000-000000000001',
  user = '30000000-0000-4000-8000-000000000001';
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(421110)');
  await db.query('INSERT INTO tenants(id,name,code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
    tenant,
    'RARE OS Workspace',
    'RARE',
  ]);
  // Fresh databases ran 003_companies before this tenant existed and received a random default code.
  await db.query(
    "UPDATE tenants SET code='RARE' WHERE id=$1 AND code ~ '^[0-9A-F]{8}$' AND NOT EXISTS(SELECT 1 FROM tenants WHERE lower(code)='rare')",
    [tenant],
  );
  for (const [code, module, description] of permissions)
    await db.query(
      'INSERT INTO permissions(code,module,description) VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET module=excluded.module,description=excluded.description',
      [code, module, description],
    );
  await db.query(
    'INSERT INTO roles(id,tenant_id,name,is_system) VALUES($1,$2,$3,true) ON CONFLICT(id) DO UPDATE SET is_system=true',
    [role, tenant, 'Main Admin'],
  );
  for (const [code] of permissions)
    await db.query(
      'INSERT INTO role_permissions(tenant_id,role_id,permission_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [tenant, role, code],
    );
  const added = await db.query(
    'INSERT INTO app_users(id,tenant_id,identity_id,email,name,role_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id',
    [user, tenant, users[0].id, env.SEED_ADMIN_EMAIL, 'Main Admin', role],
  );
  const current = await db.query('SELECT identity_id FROM app_users WHERE id=$1', [user]);
  if (current.rows[0].identity_id !== users[0].id)
    throw Error('Admin identity mismatch. Reconcile instead of resetting data.');
  await db.query('INSERT INTO platform_admins(identity_id) VALUES($1) ON CONFLICT DO NOTHING', [
    users[0].id,
  ]);
  await db.query(
    'INSERT INTO role_permissions(tenant_id,role_id,permission_code) SELECT r.tenant_id,r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.is_system ON CONFLICT DO NOTHING',
  );
  if (added.rowCount) {
    await db.query(
      "INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id) VALUES($1,$2::uuid,'admin.seeded','user',$2::text)",
      [tenant, user],
    );
    await db.query(
      "INSERT INTO outbox_events(tenant_id,kind,payload) VALUES($1,'foundation.seeded',$2)",
      [tenant, JSON.stringify({ userId: user })],
    );
  }
  await db.query('COMMIT');
  console.log(
    `Seed ready: ${permissions.length} permissions, Main Admin role, one application admin. Existing password and data preserved.`,
  );
} catch (e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  await db.end();
}
