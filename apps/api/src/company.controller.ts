import { verifySession } from './session-security.js';
import { Controller, Get, Post, Patch, Req, Param } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { pool, fail, save, scoped, env } from './core.js';
import { id, text, body, version, pagination, provision } from './access.controller.js';
import { sendActionEmail, identity } from './identity.js';
export async function sessionContext(req: Request) {
  await verifySession(req);
  if (!req.session.subject) fail(401, 'LOGIN_REQUIRED', 'Please sign in to continue.');
  const memberships = (
    await pool.query('SELECT * FROM session_memberships($1)', [req.session.subject])
  ).rows;
  const platformAdmin = (
    await pool.query('SELECT is_platform_admin($1) AS allowed', [req.session.subject])
  ).rows[0].allowed;
  return {
    memberships: memberships.filter(
      (m) => req.session.membershipVersions?.[m.tenant_id] === m.auth_version,
    ),
    platformAdmin,
  };
}
async function platform(req: Request) {
  if (!(await sessionContext(req)).platformAdmin)
    fail(403, 'PLATFORM_REQUIRED', 'Only the Platform Admin can manage companies.');
}
async function operation(req: Request, action: string, data: unknown) {
  await platform(req);
  try {
    return (
      await pool.query('SELECT platform_company($1,$2,$3) AS data', [
        req.session.subject,
        action,
        JSON.stringify(data),
      ])
    ).rows[0].data;
  } catch (e: any) {
    if (e.code === '23505')
      fail(
        409,
        'COMPANY_EXISTS',
        'Company code or request already exists. Refresh and review the existing company.',
      );
    if (e.code === '40001')
      fail(409, 'STALE_RECORD', 'Company changed elsewhere. Refresh before saving.');
    throw e;
  }
}
function email(value: unknown) {
  const result = text(value, 'Email', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    fail(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  return result;
}
async function onboard(req: Request, companyId: string, send: boolean) {
  const account = await operation(req, 'onboarding', { id: companyId });
  if (!account) fail(404, 'COMPANY_NOT_FOUND', 'Company admin not found.');
  const actor = { tenant_id: companyId, id: null };
  const result = await provision(companyId, account.id, actor);
  if (!result.ready || !send) return result;
  if (env.EMAIL_ENABLED !== 'true')
    return {
      ready: true,
      message: 'Company and admin saved. Configure SMTP, then send the invitation.',
    };
  const current = await operation(req, 'onboarding', { id: companyId });
  const acquired = await scoped(companyId, (db) =>
    db.query(
      "UPDATE app_users SET email_attempt_at=now() WHERE id=$1 AND (email_attempt_at IS NULL OR email_attempt_at < now()-interval '60 seconds') RETURNING id",
      [current.id],
    ),
  );
  if (!acquired.rowCount)
    fail(429, 'EMAIL_COOLDOWN', 'Wait one minute before sending another invitation.');
  try {
    const kc = (await (
      await identity('/users/' + encodeURIComponent(current.identity_id))
    ).json()) as any;
    // Existing shared accounts retain their password and other company sessions.
    await sendActionEmail(
      current.identity_id,
      true,
      kc.attributes?.rare_user_id?.[0] !== current.id,
    );
    await scoped(companyId, async (db) => {
      await db.query('UPDATE app_users SET invitation_sent_at=now() WHERE id=$1', [current.id]);
      await db.query(
        "INSERT INTO audit_log(tenant_id,action,entity_type,entity_id) VALUES($1,'company.admin_invited','user',$2)",
        [companyId, current.id],
      );
    });
    return {
      ready: true,
      message:
        env.LOCAL_EMAIL === 'true'
          ? 'Company ready. Invitation captured in the local inbox.'
          : 'Company ready. Invitation accepted by SMTP.',
    };
  } catch (e: any) {
    return {
      ready: true,
      message: 'Company saved; invitation failed. Check SMTP and retry the invitation.',
    };
  }
}
@Controller('api')
export class CompanyController {
  @Get('session/companies') async memberships(@Req() req: Request) {
    return sessionContext(req);
  }
  @Post('session/company') async switchCompany(@Req() req: Request) {
    const b = body(req, ['companyId']),
      companyId = id(b.companyId);
    const context = await sessionContext(req);
    const membership = context.memberships.find((m) => m.tenant_id === companyId);
    if (!membership)
      fail(
        403,
        'COMPANY_ACCESS_DENIED',
        'Company access is unavailable or changed. Sign in again or contact your administrator.',
      );
    delete req.session.platformCompanyVersion;
    req.session.tenantId = companyId;
    req.session.authVersion = membership.auth_version;
    req.session.csrf = randomBytes(32).toString('hex');
    await scoped(companyId, async (db) => {
      await db.query(
        'UPDATE app_users SET first_login_at=now() WHERE identity_id=$1 AND first_login_at IS NULL',
        [req.session.subject],
      );
      return db.query(
        "INSERT INTO audit_log(tenant_id,actor_id,action,entity_type) SELECT tenant_id,id,'company.selected','session' FROM app_users WHERE identity_id=$1",
        [req.session.subject],
      );
    });
    await save(req);
    return { message: 'Company selected.' };
  }

  @Post('platform/companies/:id/open') async openCompany(
    @Req() req: Request,
    @Param('id') companyId: string,
  ) {
    await platform(req);
    id(companyId);
    const company = await scoped(companyId, async (db) => {
      const t = (await db.query('SELECT id,name,version FROM tenants WHERE active')).rows[0];
      if (!t)
        fail(
          404,
          'COMPANY_UNAVAILABLE',
          'Company not found or inactive. Activate it before opening.',
        );
      await db.query(
        "INSERT INTO audit_log(tenant_id,actor_subject,action,entity_type,entity_id) VALUES($1::uuid,$2,'platform.company_opened','company',$1::text)",
        [companyId, req.session.subject],
      );
      return t;
    });
    req.session.tenantId = companyId;
    req.session.platformCompanyVersion = company.version;
    delete req.session.authVersion;
    req.session.csrf = randomBytes(32).toString('hex');
    await save(req);
    return { message: 'Company opened with Platform Admin access.' };
  }
  @Get('platform/companies') async list(@Req() req: Request) {
    const { limit, after, q } = pagination(req);
    const rows = await operation(req, 'list', { limit: limit + 1, after, q });
    return {
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
  @Post('platform/companies') async create(@Req() req: Request) {
    const b = body(req, ['requestId', 'name', 'code', 'contactEmail', 'adminName', 'adminEmail']);
    const code = text(b.code, 'Company code', 2, 30).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]+$/.test(code))
      fail(400, 'INVALID_CODE', 'Use letters, numbers, hyphens or underscores for company code.');
    const data = {
      id: id(b.requestId),
      name: text(b.name, 'Company name', 2, 120),
      code,
      contactEmail: email(b.contactEmail),
      adminName: text(b.adminName, 'Admin name', 2, 120),
      adminEmail: email(b.adminEmail),
    };
    const created = await operation(req, 'create', data);
    if (created.existing)
      return {
        ...created,
        message: 'Company already saved. Use Retry setup or Send invitation if needed.',
      };
    return { ...created, ...(await onboard(req, data.id, true)) };
  }
  @Patch('platform/companies/:id') async update(
    @Req() req: Request,
    @Param('id') companyId: string,
  ) {
    const b = body(req, ['name', 'contactEmail', 'active', 'version']);
    if (typeof b.active !== 'boolean') fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    const result = await operation(req, 'update', {
      id: id(companyId),
      name: text(b.name, 'Company name', 2, 120),
      contactEmail: email(b.contactEmail),
      active: b.active,
      version: version(b.version),
    });
    if (!result) fail(404, 'COMPANY_NOT_FOUND', 'Company not found.');
    return {
      message:
        'Company updated. Status changes apply immediately; users must sign in again after reactivation.',
    };
  }
  @Get('platform/companies/:id/onboarding') async status(
    @Req() req: Request,
    @Param('id') companyId: string,
  ) {
    const data = await operation(req, 'onboarding', { id: id(companyId) });
    if (!data) fail(404, 'COMPANY_NOT_FOUND', 'Company not found.');
    const { identity_id, ...safe } = data;
    const login = await scoped(companyId, (db) =>
      db.query('SELECT first_login_at FROM app_users WHERE id=$1', [data.id]),
    );
    return { ...safe, first_login_at: login.rows[0]?.first_login_at ?? null };
  }
  @Post('platform/companies/:id/invite') async invite(
    @Req() req: Request,
    @Param('id') companyId: string,
  ) {
    return onboard(req, id(companyId), true);
  }
  @Post('platform/companies/:id/retry') async retry(
    @Req() req: Request,
    @Param('id') companyId: string,
  ) {
    return onboard(req, id(companyId), false);
  }
}
