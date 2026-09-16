import { verifySession } from './session-security.js';
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
async function access(req: Request, permission: string) {
  await verifySession(req);
  if (!req.session.subject || !req.session.tenantId)
    fail(401, 'LOGIN_REQUIRED', 'Please sign in to continue. Your session may have expired.');
  return scoped(req.session.tenantId!, async (db) => {
    return accessDb(db, req, permission);
  });
}
async function accessDb(db: PoolClient, req: Request, permission: string) {
  if (req.session.platformCompanyVersion !== undefined) {
    const allowed = (
      await db.query('SELECT is_platform_admin($1) AS allowed', [req.session.subject])
    ).rows[0].allowed;
    const tenant = (await db.query('SELECT id,name,version FROM tenants WHERE active')).rows[0];
    if (!allowed || !tenant || tenant.version !== req.session.platformCompanyVersion)
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
      actor_subject: req.session.subject,
      permissions,
    };
  }

  const r = await db.query(
    `SELECT u.id,u.name,u.email,u.tenant_id,u.role_id,u.auth_version,u.version,r.is_system,r.name AS role,t.name AS company
    FROM app_users u JOIN roles r ON r.id=u.role_id AND r.tenant_id=u.tenant_id JOIN tenants t ON t.id=u.tenant_id
    WHERE u.identity_id=$1 AND u.active AND t.active AND (u.sync_state='ready' OR u.identity_id NOT LIKE 'pending:%')`,
    [req.session.subject],
  );
  if (!r.rowCount)
    fail(
      401,
      'ACCOUNT_UNAVAILABLE',
      'Your account is disabled or no longer has workspace access. Contact your administrator.',
    );
  if (req.session.authVersion !== r.rows[0].auth_version)
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
  return { ...r.rows[0], actor_subject: req.session.subject, platform_access: false, permissions };
}
function pageArgs(req: Request) {
  const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
  const cursor = req.query.cursor === undefined ? undefined : String(req.query.cursor);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail(400, 'INVALID_PAGE_SIZE', 'Page size must be a whole number between 1 and 100.');
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
};
