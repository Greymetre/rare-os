import { Controller, Get, Post, Patch, Delete, Req, Param, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { access, accessDb, scoped, pool, fail, env } from './core.js';
import { syncIdentity, sendActionEmail } from './identity.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value))
    fail(400, 'INVALID_ID', 'Invalid record identifier. Refresh this page and try again.');
  return value as string;
}
function text(value: unknown, label: string, min = 2, max = 80) {
  if (
    typeof value !== 'string' ||
    value.trim().length < min ||
    value.trim().length > max ||
    /[\x00-\x1f]/.test(value)
  )
    fail(400, 'VALIDATION_ERROR', `${label} must contain ${min}-${max} characters.`);
  return (value as string).trim();
}
function body(req: Request, keys: string[]) {
  if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object')
    fail(400, 'VALIDATION_ERROR', 'Provide the required form fields.');
  for (const key of Object.keys(req.body))
    if (!keys.includes(key)) fail(400, 'VALIDATION_ERROR', 'Unsupported field: ' + key);
  return req.body;
}
function version(v: unknown) {
  if (!Number.isInteger(v) || Number(v) < 1)
    fail(400, 'VERSION_REQUIRED', 'Record version is missing. Refresh before saving.');
  return Number(v);
}
function pagination(req: Request) {
  const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail(400, 'INVALID_PAGE_SIZE', 'Page size must be between 1 and 100.');
  const after = req.query.after === undefined ? null : id(req.query.after);
  const q = req.query.q === undefined ? '' : text(req.query.q, 'Search', 0, 80).toLowerCase();
  return { limit, after, q };
}
async function audit(
  db: PoolClient,
  actor: any,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await db.query(
    'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,details,actor_subject) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      actor.tenant_id,
      actor.id,
      action,
      entity,
      entityId,
      JSON.stringify({ before, after }),
      actor.actor_subject ?? null,
    ],
  );
}
async function mutate<T>(
  req: Request,
  permission: string,
  fn: (db: PoolClient, actor: any) => Promise<T>,
) {
  const actor = await access(req, permission);
  try {
    return await scoped(actor.tenant_id, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,71))', [actor.tenant_id]);
      const current = await accessDb(db, req, permission);
      return fn(db, current);
    });
  } catch (e: any) {
    if (e.code === '23505')
      fail(
        409,
        'ALREADY_EXISTS',
        'A record with this name or email already exists. Choose another value.',
      );
    if (e.code === '23503')
      fail(409, 'RECORD_IN_USE', 'This record is in use. Reassign its users before deleting.');
    throw e;
  }
}
async function role(db: PoolClient, roleId: string) {
  const r = await db.query('SELECT * FROM roles WHERE id=$1', [roleId]);
  if (!r.rowCount)
    fail(404, 'ROLE_NOT_FOUND', 'Role not found in your company. Refresh and choose another role.');
  const p = await db.query(
    'SELECT permission_code FROM role_permissions WHERE role_id=$1 ORDER BY permission_code',
    [roleId],
  );
  return { ...r.rows[0], permissions: p.rows.map((x) => x.permission_code as string) };
}
function canGrant(actor: any, permissions: string[]) {
  if (permissions.some((p) => !actor.permissions.includes(p)))
    fail(
      403,
      'GRANT_DENIED',
      'You can only assign permissions that you currently have. Ask a Main Admin for help.',
    );
}
async function chosenPermissions(db: PoolClient, actor: any, value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 200 ||
    value.some((p) => typeof p !== 'string')
  )
    fail(400, 'PERMISSIONS_REQUIRED', 'Select at least one permission.');
  const list = [...new Set(value as string[])];
  const known = await db.query('SELECT code FROM permissions WHERE code=ANY($1)', [list]);
  if (known.rowCount !== list.length)
    fail(
      400,
      'UNKNOWN_PERMISSION',
      'One or more permissions are invalid. Refresh the permission catalog.',
    );
  if (!list.includes('dashboard.read'))
    fail(
      400,
      'DASHBOARD_REQUIRED',
      'Dashboard access is required so users can enter their workspace.',
    );
  for (const [action, required] of [
    ['users.manage', 'users.read'],
    ['users.manage', 'roles.read'],
    ['roles.manage', 'roles.read'],
    ['sites.manage', 'sites.read'],
  ])
    if (list.includes(action) && !list.includes(required))
      fail(
        400,
        'DEPENDENCY_REQUIRED',
        action + ' also requires ' + required + '. Select both permissions.',
      );
  canGrant(actor, list);
  return list;
}
async function account(db: PoolClient, userId: string) {
  const r = await db.query('SELECT * FROM app_users WHERE id=$1', [userId]);
  if (!r.rowCount) fail(404, 'USER_NOT_FOUND', 'User not found in your company.');
  return r.rows[0];
}
function safeAccount(u: any) {
  const { identity_id, created_by, ...rest } = u;
  return { ...rest, emailEditable: u.identity_id.startsWith('pending:') };
}
async function protectAdmin(db: PoolClient, target: any, newRole: string, active: boolean) {
  const current = await role(db, target.role_id);
  if (current.is_system && target.active && (!active || newRole !== target.role_id)) {
    const others = await db.query(
      "SELECT 1 FROM app_users u JOIN roles r ON r.id=u.role_id AND r.tenant_id=u.tenant_id WHERE r.is_system AND u.active AND u.sync_state='ready' AND u.id<>$1 LIMIT 1",
      [target.id],
    );
    if (!others.rowCount)
      fail(
        409,
        'LAST_ADMIN',
        'Keep at least one active Main Admin. Assign and activate another Main Admin first.',
      );
  }
}
// Provisioning state is durable: a timeout/crash can be retried without duplicate identity users.
async function provision(tenant: string, userId: string, actor: any) {
  const lock = await pool.connect();
  try {
    const got = await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,72)) AS locked', [
      userId,
    ]);
    if (!got.rows[0].locked)
      return { ready: false, message: 'Account setup is already running. Refresh shortly.' };
    const user = await scoped(tenant, (db) => account(db, userId));
    if (user.sync_state === 'ready') return { ready: true, message: 'Account is ready.' };
    try {
      const identityId = await syncIdentity(user);
      const changed = await scoped(tenant, async (db) => {
        const result = await db.query(
          "UPDATE app_users SET identity_id=$1,sync_state='ready',sync_error=NULL WHERE id=$2 AND version=$3 RETURNING id",
          [identityId, userId, user.version],
        );
        if (result.rowCount)
          await audit(
            db,
            actor,
            'user.identity_synced',
            'user',
            userId,
            { sync_state: user.sync_state },
            { sync_state: 'ready' },
          );
        return !!result.rowCount;
      });
      return {
        ready: changed,
        message: changed
          ? 'Account is ready.'
          : 'User changed during setup. Retry account setup to apply the latest changes.',
      };
    } catch (e) {
      const message =
        e instanceof HttpException
          ? (e.getResponse() as any).message
          : 'Account setup failed. Retry shortly.';
      await scoped(tenant, (db) =>
        db.query(
          "UPDATE app_users SET sync_state='failed',sync_error=$1 WHERE id=$2 AND version=$3",
          [message, userId, user.version],
        ),
      );
      return { ready: false, message };
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,72))', [userId]);
    lock.release();
  }
}
async function email(req: Request, userId: string, invite: boolean) {
  const saved = await mutate(req, 'users.manage', async (db, actor) => {
    const user = await account(db, userId);
    canGrant(actor, (await role(db, user.role_id)).permissions);
    const shared = (await db.query('SELECT identity_is_shared($1) AS shared', [user.identity_id]))
      .rows[0].shared;
    if (shared && !invite)
      fail(
        409,
        'SHARED_LOGIN',
        'This login is shared across companies. Ask the user to use Forgot password on the sign-in screen.',
      );
    if (!user.active || user.sync_state !== 'ready')
      fail(
        409,
        'ACCOUNT_NOT_READY',
        'Activate this user and complete account setup before sending email.',
      );
    if (env.EMAIL_ENABLED !== 'true')
      fail(
        409,
        'EMAIL_NOT_CONFIGURED',
        'Email delivery is not configured. Ask the system administrator to configure SMTP.',
      );
    if (user.email_attempt_at && Date.now() - new Date(user.email_attempt_at).getTime() < 60000)
      fail(
        429,
        'EMAIL_COOLDOWN',
        'An email was requested recently. Wait one minute before sending again.',
      );
    await db.query(
      'UPDATE app_users SET email_attempt_at=now(),auth_version=auth_version+$2 WHERE id=$1',
      [userId, invite ? 0 : 1],
    );
    await audit(
      db,
      actor,
      invite ? 'user.invite_requested' : 'user.reset_requested',
      'user',
      userId,
      null,
      { channel: env.LOCAL_EMAIL === 'true' ? 'local-inbox' : 'email' },
    );
    return { user, actor, shared };
  });
  try {
    await sendActionEmail(saved.user.identity_id, invite, saved.shared);
    await scoped(saved.actor.tenant_id, async (db) => {
      if (invite)
        await db.query('UPDATE app_users SET invitation_sent_at=now() WHERE id=$1', [userId]);
      await audit(
        db,
        saved.actor,
        invite ? 'user.invite_sent' : 'user.reset_sent',
        'user',
        userId,
        null,
        { accepted: true },
      );
    });
    return {
      message:
        env.LOCAL_EMAIL === 'true'
          ? 'Email captured in the local test inbox. Open the inbox to continue.'
          : 'Email accepted by the configured SMTP server. Ask the user to check their inbox.',
    };
  } catch (e) {
    await scoped(saved.actor.tenant_id, (db) =>
      audit(db, saved.actor, 'user.email_failed', 'user', userId, null, {
        kind: invite ? 'invitation' : 'password-reset',
      }),
    );
    throw e;
  }
}
@Controller('api')
export class AccessController {
  @Get('permissions') async permissions(@Req() req: Request) {
    const actor = await access(req, 'roles.read');
    return scoped(actor.tenant_id, async (db) => ({
      items: (
        await db.query('SELECT code,module,description FROM permissions ORDER BY module,code')
      ).rows,
    }));
  }
  @Get('access-settings') async settings(@Req() req: Request) {
    await access(req, 'users.read');
    return {
      emailEnabled: env.EMAIL_ENABLED === 'true',
      localEmail: env.LOCAL_EMAIL === 'true',
      inboxUrl: env.LOCAL_EMAIL === 'true' ? 'http://localhost:4312' : null,
    };
  }
  @Get('roles') async listRoles(@Req() req: Request) {
    const actor = await access(req, 'roles.read');
    const { limit, after, q } = pagination(req);
    return scoped(actor.tenant_id, async (db) => {
      const rows = await db.query(
        `SELECT r.*,(SELECT count(*)::int FROM role_permissions p WHERE p.role_id=r.id AND p.tenant_id=r.tenant_id) AS permission_count,EXISTS(SELECT 1 FROM app_users u WHERE u.role_id=r.id AND u.tenant_id=r.tenant_id) AS assigned FROM roles r WHERE ($1::uuid IS NULL OR r.id>$1) AND starts_with(lower(r.name),$2) ORDER BY r.id LIMIT $3`,
        [after, q, limit + 1],
      );
      return {
        items: rows.rows.slice(0, limit),
        nextCursor: rows.rows.length > limit ? rows.rows[limit - 1].id : null,
      };
    });
  }
  @Get('roles/:id') async getRole(@Req() req: Request, @Param('id') rid: string) {
    const actor = await access(req, 'roles.read');
    return scoped(actor.tenant_id, (db) => role(db, id(rid)));
  }
  @Post('roles') async createRole(@Req() req: Request) {
    const b = body(req, ['name', 'permissions']);
    const name = text(b.name, 'Role name');
    return mutate(req, 'roles.manage', async (db, actor) => {
      const perms = await chosenPermissions(db, actor, b.permissions);
      const rid = randomUUID();
      await db.query('INSERT INTO roles(id,tenant_id,name) VALUES($1,$2,$3)', [
        rid,
        actor.tenant_id,
        name,
      ]);
      for (const p of perms)
        await db.query(
          'INSERT INTO role_permissions(tenant_id,role_id,permission_code) VALUES($1,$2,$3)',
          [actor.tenant_id, rid, p],
        );
      await audit(db, actor, 'role.created', 'role', rid, null, { name, permissions: perms });
      return { id: rid, message: 'Role created successfully.' };
    });
  }
  @Patch('roles/:id') async updateRole(@Req() req: Request, @Param('id') rid: string) {
    id(rid);
    const b = body(req, ['name', 'permissions', 'version']),
      v = version(b.version),
      name = text(b.name, 'Role name');
    return mutate(req, 'roles.manage', async (db, actor) => {
      const old = await role(db, rid);
      if (old.is_system)
        fail(
          409,
          'SYSTEM_ROLE',
          'Main Admin is a protected system role. Create a custom role to change permissions.',
        );
      if (old.version !== v)
        fail(
          409,
          'STALE_RECORD',
          'This role was changed by another administrator. Refresh and review before saving.',
        );
      canGrant(actor, old.permissions);
      const perms = await chosenPermissions(db, actor, b.permissions);
      await db.query('UPDATE roles SET name=$1,version=version+1 WHERE id=$2', [name, rid]);
      await db.query('DELETE FROM role_permissions WHERE role_id=$1', [rid]);
      for (const p of perms)
        await db.query(
          'INSERT INTO role_permissions(tenant_id,role_id,permission_code) VALUES($1,$2,$3)',
          [actor.tenant_id, rid, p],
        );
      await audit(
        db,
        actor,
        'role.updated',
        'role',
        rid,
        { name: old.name, permissions: old.permissions },
        { name, permissions: perms },
      );
      return { message: 'Role updated. Assigned users now have the selected permissions.' };
    });
  }
  @Delete('roles/:id') async deleteRole(@Req() req: Request, @Param('id') rid: string) {
    id(rid);
    const b = body(req, ['version']),
      v = version(b.version);
    return mutate(req, 'roles.manage', async (db, actor) => {
      const old = await role(db, rid);
      if (old.is_system) fail(409, 'SYSTEM_ROLE', 'Main Admin cannot be deleted.');
      if (old.version !== v)
        fail(409, 'STALE_RECORD', 'This role changed. Refresh before deleting.');
      canGrant(actor, old.permissions);
      if ((await db.query('SELECT 1 FROM app_users WHERE role_id=$1 LIMIT 1', [rid])).rowCount)
        fail(
          409,
          'ROLE_ASSIGNED',
          'This role is assigned to users. Reassign all users, including inactive users, before deleting it.',
        );
      await db.query('DELETE FROM role_permissions WHERE role_id=$1', [rid]);
      await db.query('DELETE FROM roles WHERE id=$1', [rid]);
      await audit(
        db,
        actor,
        'role.deleted',
        'role',
        rid,
        { name: old.name, permissions: old.permissions },
        null,
      );
      return { message: 'Role deleted.' };
    });
  }
  @Get('users') async listUsers(@Req() req: Request) {
    const actor = await access(req, 'users.read');
    const { limit, after, q } = pagination(req);
    return scoped(actor.tenant_id, async (db) => {
      const rows = await db.query(
        `SELECT u.id,u.name,u.email,u.role_id,u.active,u.version,u.sync_state,u.sync_error,u.invitation_sent_at,u.first_login_at,r.name AS role FROM app_users u JOIN roles r ON r.id=u.role_id AND r.tenant_id=u.tenant_id WHERE ($1::uuid IS NULL OR u.id>$1) AND starts_with(lower(u.email),$2) ORDER BY u.id LIMIT $3`,
        [after, q, limit + 1],
      );
      return {
        items: rows.rows.slice(0, limit),
        nextCursor: rows.rows.length > limit ? rows.rows[limit - 1].id : null,
      };
    });
  }
  @Get('users/:id') async getUser(@Req() req: Request, @Param('id') uid: string) {
    const actor = await access(req, 'users.read');
    return scoped(actor.tenant_id, async (db) => safeAccount(await account(db, id(uid))));
  }
  @Post('users') async createUser(@Req() req: Request) {
    const b = body(req, ['name', 'email', 'roleId', 'requestId']);
    const name = text(b.name, 'Full name', 2, 120),
      emailAddress = text(b.email, 'Email', 3, 254).toLowerCase(),
      roleId = id(b.roleId),
      userId = id(b.requestId);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress))
      fail(400, 'INVALID_EMAIL', 'Enter a valid email address, for example name@company.com.');
    const saved = await mutate(req, 'users.manage', async (db, actor) => {
      const selected = await role(db, roleId);
      canGrant(actor, selected.permissions);
      const existing = await db.query('SELECT * FROM app_users WHERE id=$1', [userId]);
      if (existing.rowCount) {
        const old = existing.rows[0];
        if (old.email !== emailAddress || old.name !== name || old.role_id !== roleId)
          fail(
            409,
            'REQUEST_REUSED',
            'This request was already used with different details. Reopen the create form.',
          );
        return { actor, existing: true };
      }
      const linkedIdentity = actor.platform_access
        ? (
            await db.query('SELECT platform_existing_identity($1,$2) AS id', [
              req.session.subject,
              emailAddress,
            ])
          ).rows[0].id
        : null;
      await db.query(
        'INSERT INTO app_users(id,tenant_id,identity_id,email,name,role_id,active,sync_state,created_by) VALUES($1,$2,$3,$4,$5,$6,true,$8,$7)',
        [
          userId,
          actor.tenant_id,
          linkedIdentity || 'pending:' + userId,
          emailAddress,
          name,
          roleId,
          actor.id,
          linkedIdentity ? 'ready' : 'pending',
        ],
      );
      await audit(db, actor, 'user.created', 'user', userId, null, {
        name,
        email: emailAddress,
        roleId,
        active: true,
      });
      return { actor, existing: false };
    });
    const result = await provision(saved.actor.tenant_id, userId, saved.actor);
    let inviteMessage = '';
    if (result.ready && !saved.existing) {
      try {
        inviteMessage = (await email(req, userId, true)).message;
      } catch (e) {
        inviteMessage =
          e instanceof HttpException
            ? (e.getResponse() as any).message
            : 'Invitation could not be sent. Use Send invitation to retry.';
      }
    }
    return {
      id: userId,
      ready: result.ready,
      message: result.ready ? 'User created. ' + inviteMessage : 'User saved. ' + result.message,
    };
  }
  @Patch('users/:id') async updateUser(@Req() req: Request, @Param('id') uid: string) {
    id(uid);
    const b = body(req, ['name', 'email', 'roleId', 'active', 'version']),
      v = version(b.version),
      name = text(b.name, 'Full name', 2, 120),
      roleId = id(b.roleId);
    if (typeof b.active !== 'boolean') fail(400, 'VALIDATION_ERROR', 'Choose Active or Inactive.');
    const saved = await mutate(req, 'users.manage', async (db, actor) => {
      const old = await account(db, uid);
      if (old.version !== v)
        fail(
          409,
          'STALE_RECORD',
          'This user was updated elsewhere. Refresh and review before saving.',
        );
      canGrant(actor, (await role(db, old.role_id)).permissions);
      canGrant(actor, (await role(db, roleId)).permissions);
      await protectAdmin(db, old, roleId, b.active);
      if (uid === actor.id && (!b.active || old.role_id !== roleId))
        fail(
          409,
          'SELF_ACCESS_CHANGE',
          'Ask another Main Admin to change your own role or deactivate your account.',
        );
      let emailAddress = old.email;
      if (b.email !== undefined) {
        emailAddress = text(b.email, 'Email', 3, 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress))
          fail(400, 'INVALID_EMAIL', 'Enter a valid email address.');
        if (emailAddress !== old.email && !old.identity_id.startsWith('pending:'))
          fail(
            409,
            'EMAIL_IMMUTABLE',
            'An active identity email cannot be changed here. Contact your system administrator.',
          );
      }
      const changed = await db.query(
        "UPDATE app_users SET name=$1,email=$2,role_id=$3,active=$4,version=version+1,auth_version=auth_version+$5,sync_state='pending',sync_error=NULL WHERE id=$6 RETURNING *",
        [
          name,
          emailAddress,
          roleId,
          b.active,
          old.role_id !== roleId || old.active !== b.active ? 1 : 0,
          uid,
        ],
      );
      await audit(
        db,
        actor,
        'user.updated',
        'user',
        uid,
        { name: old.name, email: old.email, roleId: old.role_id, active: old.active },
        { name, email: emailAddress, roleId, active: b.active },
      );
      return { actor, user: changed.rows[0] };
    });
    const result = await provision(saved.actor.tenant_id, uid, saved.actor);
    return {
      message: result.ready
        ? 'User updated. Access changes are effective immediately.'
        : 'Changes saved. ' + result.message,
      ready: result.ready,
    };
  }
  @Post('users/:id/retry') async retry(@Req() req: Request, @Param('id') uid: string) {
    id(uid);
    const actor = await access(req, 'users.manage');
    await scoped(actor.tenant_id, async (db) =>
      canGrant(actor, (await role(db, (await account(db, uid)).role_id)).permissions),
    );
    return provision(actor.tenant_id, uid, actor);
  }
  @Post('users/:id/invite') async invite(@Req() req: Request, @Param('id') uid: string) {
    return email(req, id(uid), true);
  }
  @Post('users/:id/reset-password') async reset(@Req() req: Request, @Param('id') uid: string) {
    return email(req, id(uid), false);
  }
}

export { id, text, body, version, pagination, provision, mutate, audit, account, role, canGrant };
