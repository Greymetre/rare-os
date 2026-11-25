import { verifySession } from './session-security.js';
import { deviceIdentity, isDeviceRequest } from './device-auth.js';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import 'express-session';
import pg, { type PoolClient } from 'pg';
import { createClient } from 'redis';
import { createRemoteJWKSet } from 'jose';
declare module 'express-session' {
  interface SessionData {
    forceLogin?: boolean;
    mfaVerified?: boolean;
    subject?: string;
    identitySid?: string;
    signedInAt?: number;
    tenantId?: string;
    authVersion?: number;
    platformCompanyVersion?: number;
    membershipVersions?: Record<string, number>;
    csrf?: string;
    refreshToken?: string;
    login?: { state: string; nonce: string; verifier: string; created: number };
  }
}
const env = process.env;
for (const k of [
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'OIDC_CLIENT_SECRET',
  'APP_URL',
  'AUTH_URL',
  'AUTH_INTERNAL_URL',
])
  if (!env[k]) throw Error(k + ' is required');
const appUrl = env.APP_URL!,
  authUrl = env.AUTH_URL!,
  internal = env.AUTH_INTERNAL_URL!,
  realm = '/realms/rare-os';
if (env.SESSION_SECRET!.length < 32)
  throw Error('SESSION_SECRET must contain at least 32 characters');
const secure = env.COOKIE_SECURE === 'true';
if (!secure && !appUrl.startsWith('http://localhost:'))
  throw Error('HTTPS and secure cookies are required outside localhost');
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 5000,
});
const redis = createClient({ url: env.REDIS_URL });
redis.on('error', () => console.error('Redis connection unavailable'));
const jwks = createRemoteJWKSet(new URL(internal + realm + '/protocol/openid-connect/certs'));
const fail = (status: number, code: string, message: string) => {
  throw new HttpException({ code, message }, status);
};
const save = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
const regen = (req: Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve())),
  );
const destroy = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.destroy((e) => (e ? reject(e) : resolve())));
async function scoped<T>(tenant: string, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const data = await run(db);
    await db.query('COMMIT');
    return data;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
// Who is asking, from whichever of the two ways in they used.
//
// RCH-8 gave the field force a phone, and a phone cannot keep a browser's cookie alive across a
// day with no signal. So there are now two doors into exactly the same building: a web session,
// and a device token verified in `device-auth.ts`. Everything past this function is identical for
// both — the same permission, the same tenant scope, the same audit row — because a rep taking an
// order at a counter is doing the same thing as a clerk taking one at a desk, and the moment the
// two paths diverge is the moment one of them quietly grows a hole.
//
// The device token is verified once per request and remembered, so asking twice is free. That
// matters because `mutate` checks the permission again inside the transaction, and the two checks
// must never be able to disagree.
async function whoIs(req: Request) {
  const device = await deviceIdentity(req);
  if (device)
    return {
      subject: device.subject as string | undefined,
      tenantId: device.tenantId as string | undefined,
      authVersion: device.authVersion as number | undefined,
      // A phone is never a platform administrator. That work is choosing which company you are
      // looking at across the whole installation, and it belongs at a desk.
      platformCompanyVersion: undefined as number | undefined,
    };
  return {
    subject: req.session.subject,
    tenantId: req.session.tenantId,
    authVersion: req.session.authVersion,
    platformCompanyVersion: req.session.platformCompanyVersion,
  };
}
async function access(req: Request, permission: string) {
  // A device proves itself by its token on every request, which is the check `verifySession`
  // performs for a cookie. Running the session checks against a request that carries no session
  // would only refuse the phone for not being a browser.
  if (!isDeviceRequest(req)) await verifySession(req);
  const who = await whoIs(req);
  if (!who.subject || !who.tenantId)
    fail(401, 'LOGIN_REQUIRED', 'Please sign in to continue. Your session may have expired.');
  return scoped(who.tenantId!, async (db) => {
    return accessDb(db, req, permission);
  });
}
async function accessDb(db: PoolClient, req: Request, permission: string) {
  const who = await whoIs(req);
  if (who.platformCompanyVersion !== undefined) {
    const allowed = (await db.query('SELECT is_platform_admin($1) AS allowed', [who.subject]))
      .rows[0].allowed;
    const tenant = (await db.query('SELECT id,name,version FROM tenants WHERE active')).rows[0];
    if (!allowed || !tenant || tenant.version !== who.platformCompanyVersion)
      fail(
        403,
        'PLATFORM_ACCESS_CHANGED',
        'Company or platform access changed. Select the company again.',
      );
    const permissions = (await db.query('SELECT code FROM permissions')).rows.map(
      (p) => p.code as string,
    );
    if (!permissions.includes(permission))
      fail(403, 'PERMISSION_DENIED', 'Permission is unavailable.');
    return {
      id: null,
      name: 'Platform Admin',
      email: 'Platform access',
      tenant_id: tenant.id,
      role_id: null,
      role: 'Platform Admin',
      company: tenant.name,
      is_system: true,
      platform_access: true,
      actor_subject: who.subject,
      permissions,
    };
  }

  const r = await db.query(
    `SELECT u.id,u.name,u.email,u.tenant_id,u.role_id,u.auth_version,u.version,r.is_system,r.name AS role,t.name AS company
    FROM app_users u JOIN roles r ON r.id=u.role_id AND r.tenant_id=u.tenant_id JOIN tenants t ON t.id=u.tenant_id
    WHERE u.identity_id=$1 AND u.active AND t.active AND (u.sync_state='ready' OR u.identity_id NOT LIKE 'pending:%')`,
    [who.subject],
  );
  if (!r.rowCount)
    fail(
      401,
      'ACCOUNT_UNAVAILABLE',
      'Your account is disabled or no longer has workspace access. Contact your administrator.',
    );
  if (who.authVersion !== r.rows[0].auth_version)
    fail(401, 'SESSION_CHANGED', 'Your account access changed. Please sign in again.');
  const p = await db.query(
    'SELECT permission_code FROM role_permissions WHERE role_id=$1 AND tenant_id=$2',
    [r.rows[0].role_id, r.rows[0].tenant_id],
  );
  const permissions = p.rows.map((x) => x.permission_code as string);
  if (!permissions.includes(permission))
    fail(
      403,
      'PERMISSION_DENIED',
      'You do not have permission for this action. Ask your company administrator for access.',
    );
  return { ...r.rows[0], actor_subject: who.subject, platform_access: false, permissions };
}
// How many rows a page holds. The screens offer a few sizes to choose from; the range is wider
// than those because other callers ask for a single row or a whole short list in one request.
function limitOf(req: Request, fallback = 25) {
  const limit = req.query.limit === undefined ? fallback : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail(400, 'INVALID_PAGE_SIZE', 'Page size must be a whole number between 1 and 100.');
  return limit;
}
function pageArgs(req: Request) {
  const limit = limitOf(req);
  const cursor = req.query.cursor === undefined ? undefined : String(req.query.cursor);
  if (cursor && !/^[1-9][0-9]{0,17}$/.test(cursor))
    fail(
      400,
      'INVALID_CURSOR',
      'This page link is invalid. Return to the first page and try again.',
    );
  return { limit, cursor };
}

export {
  env,
  appUrl,
  authUrl,
  internal,
  realm,
  secure,
  pool,
  redis,
  jwks,
  fail,
  save,
  regen,
  destroy,
  scoped,
  access,
  accessDb,
  pageArgs,
  limitOf,
};
