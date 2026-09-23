import 'reflect-metadata';
import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Module,
  HttpException,
  Catch,
  ArgumentsHost,
  ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { json, text, urlencoded, type Request, type Response } from 'express';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import pg, { type PoolClient } from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import helmet from 'helmet';
import { receiveLogout, requiresMfa } from './session-security.js';
import { identity } from './identity.js';
import { requestLimits } from './rate-limits.js';

import {
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
  pageArgs,
} from './core.js';
import { CompanyController, sessionContext } from './company.controller.js';
import { PlantsController, allPlants } from './plants.controller.js';
import { AvailabilityController } from './availability.controller.js';
import { MastersController } from './masters.controller.js';
import { PlantModelController } from './plant-model.controller.js';
import { DemandStockController } from './demand-stock.controller.js';
import { PlanningController } from './planning.controller.js';
import { PurchaseController } from './purchase.controller.js';
import { ScheduleController } from './schedule.controller.js';
import { MaterialsDecisionsController } from './materials-decisions.controller.js';
import { ExecutionController } from './execution.controller.js';
import { AccessController } from './access.controller.js';
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp(),
      req = ctx.getRequest<Request>(),
      res = ctx.getResponse<Response>();
    const middlewareStatus =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      Number.isInteger(error.status) &&
      Number(error.status) >= 400 &&
      Number(error.status) < 500
        ? Number(error.status)
        : undefined;
    const status = error instanceof HttpException ? error.getStatus() : (middlewareStatus ?? 503);
    const detail =
      error instanceof HttpException
        ? error.getResponse()
        : middlewareStatus
          ? {
              code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST_BODY',
              message:
                status === 413 ? 'The request body is too large.' : 'The request body is invalid.',
            }
          : {
              code: 'SERVICE_UNAVAILABLE',
              message:
                'The service is temporarily unavailable. Please retry. If it continues, share the request ID with your administrator.',
            };
    const data = typeof detail === 'string' ? { message: detail } : detail;
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'request.failed',
          requestId: res.getHeader('X-Request-ID'),
          path: req.path,
          error: error instanceof Error ? error.name : 'Unknown',
        }),
      );
    res.status(status).json({
      error: {
        code: 'REQUEST_FAILED',
        ...(data as object),
        requestId: res.getHeader('X-Request-ID'),
      },
    });
  }
}
@Controller('api')
class AppController {
  @Get('health') async health() {
    await pool.query('SELECT 1');
    await redis.ping();
    return { status: 'ok', service: 'rare-os-api' };
  }
  @Post('auth/backchannel-logout') async backchannel(@Req() req: Request, @Res() res: Response) {
    await receiveLogout(req.body?.logout_token);
    return res.status(200).end();
  }
  @Get('security') async security(@Req() req: Request) {
    await sessionContext(req);
    const credentials = (await (
      await identity('/users/' + encodeURIComponent(req.session.subject!) + '/credentials')
    ).json()) as any[];
    return {
      mfaRequired: await requiresMfa(req.session.subject!),
      mfaEnabled: credentials.some((c) => c.type === 'otp'),
      devices: credentials
        .filter((c) => c.type === 'otp')
        .map((c) => ({
          id: c.id,
          name: c.userLabel || 'Unnamed authenticator',
          createdAt: c.createdDate,
        })),
      setupUrl: '/api/auth/login?action=CONFIGURE_TOTP',
      manageUrl: '/api/auth/login?action=RARE_MANAGE_MFA',
      disableUrl: '/api/auth/login?action=RARE_DISABLE_MFA',
      recoveryUrl: '/api/auth/login?action=CONFIGURE_RECOVERY_AUTHN_CODES',
      sessionHours: 12,
    };
  }
  @Get('auth/login') async login(@Req() req: Request, @Res() res: Response) {
    if (req.get('host') !== new URL(appUrl).host) return res.redirect(appUrl + '/api/auth/login');
    const forceLogin = req.session.forceLogin || req.query.switchAccount === 'true';
    await regen(req);
    if (forceLogin) req.session.forceLogin = true;
    const verifier = randomBytes(48).toString('base64url'),
      state = randomBytes(32).toString('hex'),
      nonce = randomBytes(32).toString('hex');
    req.session.login = { state, nonce, verifier, created: Date.now() };
    await save(req);
    const query = new URLSearchParams({
      client_id: 'rare-os-web',
      redirect_uri: appUrl + '/api/auth/callback',
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    if (forceLogin) query.set('prompt', 'login');
    if (
      req.query.action === 'CONFIGURE_TOTP' ||
      req.query.action === 'CONFIGURE_RECOVERY_AUTHN_CODES' ||
      req.query.action === 'RARE_MANAGE_MFA' ||
      req.query.action === 'RARE_DISABLE_MFA'
    ) {
      query.set('prompt', 'login');
      query.set('kc_action', String(req.query.action));
      query.set('max_age', '0');
    }
    res.redirect(authUrl + realm + '/protocol/openid-connect/auth?' + query);
  }
  @Get('auth/callback') async callback(@Req() req: Request, @Res() res: Response) {
    const tx = req.session.login;
    delete req.session.login;
    await save(req);
    if (
      !tx ||
      tx.state !== req.query.state ||
      Date.now() - tx.created > 300000 ||
      typeof req.query.code !== 'string'
    )
      return res.redirect('/?authError=expired');
    try {
      const tr = await fetch(internal + realm + '/protocol/openid-connect/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: req.query.code,
          client_id: 'rare-os-web',
          client_secret: env.OIDC_CLIENT_SECRET!,
          redirect_uri: appUrl + '/api/auth/callback',
          code_verifier: tx.verifier,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!tr.ok) throw Error('Token exchange failed');
      const tokens = (await tr.json()) as { id_token: string; refresh_token: string };
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer: authUrl + realm,
        audience: 'rare-os-web',
        algorithms: ['RS256'],
      });
      if (payload.nonce !== tx.nonce || !payload.sub) throw Error('Identity validation failed');
      const lookup = await pool.query('SELECT tenant_id FROM resolve_identity($1)', [payload.sub]);
      const platform = (await pool.query('SELECT is_platform_admin($1) AS allowed', [payload.sub]))
        .rows[0].allowed;
      if (!lookup.rowCount && !platform) {
        // Rejected identities must not trap the browser in an automatic SSO retry loop.
        await regen(req);
        req.session.forceLogin = true;
        await save(req);
        try {
          await fetch(internal + realm + '/protocol/openid-connect/logout', {
            method: 'POST',
            body: new URLSearchParams({
              client_id: 'rare-os-web',
              client_secret: env.OIDC_CLIENT_SECRET!,
              refresh_token: tokens.refresh_token,
            }),
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          /* A forced interactive login still provides recovery if logout is unavailable. */
        }
        return res.redirect('/?authError=access');
      }
      if ((await requiresMfa(payload.sub)) && payload.rare_mfa_verified !== true) {
        await regen(req);
        req.session.forceLogin = true;
        await save(req);
        return res.redirect('/?authError=mfa');
      }
      const memberships = (await pool.query('SELECT * FROM session_memberships($1)', [payload.sub]))
        .rows;
      await regen(req);
      if (typeof payload.sid !== 'string') throw Error('Missing identity session');
      req.session.subject = payload.sub;
      req.session.mfaVerified = payload.rare_mfa_verified === true;
      req.session.identitySid = payload.sid;
      req.session.signedInAt = Date.now();
      req.session.membershipVersions = Object.fromEntries(
        memberships.map((m) => [m.tenant_id, m.auth_version]),
      );
      req.session.tenantId = lookup.rowCount === 1 ? lookup.rows[0].tenant_id : undefined;
      req.session.csrf = randomBytes(32).toString('hex');
      req.session.refreshToken = tokens.refresh_token;
      if (req.session.tenantId)
        await scoped(req.session.tenantId, async (db) => {
          const account = await db.query(
            `SELECT auth_version FROM app_users WHERE identity_id=$1 AND active AND (sync_state='ready' OR identity_id NOT LIKE 'pending:%')`,
            [payload.sub],
          );
          if (!account.rowCount) throw Error('Account unavailable');
          req.session.authVersion = account.rows[0].auth_version;
          await db.query(
            'UPDATE app_users SET first_login_at=now() WHERE identity_id=$1 AND first_login_at IS NULL',
            [payload.sub],
          );
          await db.query(
            "INSERT INTO audit_log(tenant_id,actor_id,action,entity_type) SELECT tenant_id,id,'auth.login','session' FROM app_users WHERE identity_id=$1",
            [payload.sub],
          );
        });
      await save(req);
      res.redirect('/');
    } catch {
      await destroy(req);
      res.redirect('/?authError=service');
    }
  }
  @Post('auth/logout') async logout(@Req() req: Request, @Res() res: Response) {
    const subject = req.session.subject,
      tenant = req.session.tenantId,
      refresh = req.session.refreshToken;
    if (tenant && subject)
      await scoped(tenant, async (db) => {
        await db.query(
          "INSERT INTO audit_log(tenant_id,actor_id,action,entity_type) SELECT tenant_id,id,'auth.logout','session' FROM app_users WHERE identity_id=$1",
          [subject],
        );
      });
    let identityLogout = true;
    if (refresh) {
      try {
        const r = await fetch(internal + realm + '/protocol/openid-connect/logout', {
          method: 'POST',
          body: new URLSearchParams({
            client_id: 'rare-os-web',
            client_secret: env.OIDC_CLIENT_SECRET!,
            refresh_token: refresh,
          }),
          signal: AbortSignal.timeout(5000),
        });
        identityLogout = r.ok;
      } catch {
        identityLogout = false;
      }
    }
    await destroy(req);
    res.clearCookie('rare.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure });
    res.json({
      message: identityLogout
        ? 'Signed out successfully.'
        : 'Signed out of the workspace. Identity service was unavailable; close this browser to end any remaining identity session.',
    });
  }
  @Get('me') async me(@Req() req: Request) {
    const context = await sessionContext(req);
    let user = null;
    try {
      user = req.session.tenantId ? await access(req, 'dashboard.read') : null;
    } catch (e) {
      if (
        e instanceof HttpException &&
        (e.getResponse() as any).code === 'PLATFORM_ACCESS_CHANGED'
      ) {
        delete req.session.tenantId;
        delete req.session.platformCompanyVersion;
        await save(req);
      } else throw e;
    }
    return { user, ...context, csrfToken: req.session.csrf };
  }
  @Get('dashboard') async dashboard(@Req() req: Request) {
    const user = await access(req, 'dashboard.read');
    return scoped(user.tenant_id, async (db) => {
      const sites = await db.query(
        'SELECT s.id,s.name,s.code FROM sites s WHERE s.active AND ($2::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.tenant_id=s.tenant_id AND us.user_id=$1)) ORDER BY s.id LIMIT 100',
        [user.id, allPlants(user)],
      );
      const permissions = await db.query(
        'SELECT code,module,description FROM permissions WHERE code=ANY($1) ORDER BY module,code',
        [user.permissions],
      );
      const heartbeat = await redis.get('rare:worker:heartbeat');
      return {
        sites: sites.rows,
        permissions: permissions.rows,
        workerReady: !!heartbeat,
        setup: [
          {
            title: 'Secure workspace',
            done: true,
            detail: 'Keycloak login and server-side permission checks are active.',
          },
          {
            title: 'Main Admin seeded',
            done: true,
            detail: 'Your initial role and permission catalog are ready.',
          },
          {
            title: 'Add your first plant',
            done: sites.rowCount! > 0,
            detail: 'Create plants and assign user access from Plants and Users.',
          },
          {
            title: 'Import planning masters',
            done: false,
            detail: 'Products, BOM, routing, shifts and opening stock are needed before planning.',
          },
        ],
      };
    });
  }
  @Get('audit') async audit(@Req() req: Request) {
    const user = await access(req, 'audit.read'),
      { limit, cursor } = pageArgs(req);
    return scoped(user.tenant_id, async (db) => {
      const r = await db.query(
        `SELECT a.id,a.action,a.entity_type,a.entity_id,a.actor_id,a.actor_subject,a.details,a.created_at,coalesce(u.name,CASE WHEN a.actor_subject IS NOT NULL THEN 'Platform Admin' ELSE 'System' END) AS actor_name FROM audit_log a LEFT JOIN app_users u ON u.id=a.actor_id AND u.tenant_id=a.tenant_id WHERE ($1::bigint IS NULL OR a.id<$1::bigint) ORDER BY a.id DESC LIMIT $2`,
        [cursor ?? null, limit + 1],
      );
      return {
        items: r.rows.slice(0, limit),
        nextCursor: r.rows.length > limit ? r.rows[limit - 1].id : null,
      };
    });
  }
}
@Module({
  controllers: [
    AppController,
    AccessController,
    CompanyController,
    PlantsController,
    AvailabilityController,
    MastersController,
    PlantModelController,
    DemandStockController,
    PlanningController,
    PurchaseController,
    ScheduleController,
    MaterialsDecisionsController,
    ExecutionController,
  ],
})
class AppModule {}
await redis.connect();
const app = await NestFactory.create(AppModule, {
  logger: ['error', 'warn', 'log'],
  bodyParser: false,
});
app.getHttpAdapter().getInstance().set('trust proxy', 1);
app.use(helmet());
// Keep request parsing bounded before session/auth work. The current API only accepts small JSON
// and form payloads (including the identity provider's back-channel logout token).
// CSV imports are the only larger body: text/csv on /api/imports, capped at the import file limit.
app.use('/api/imports', text({ type: 'text/csv', limit: '5mb' }));
app.use(json({ limit: '64kb' }));
app.use(urlencoded({ extended: false, limit: '64kb' }));
app.use((req: Request, res: Response, next: () => void) => {
  res.setHeader('X-Request-ID', randomUUID());
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(
  session({
    name: 'rare.sid',
    secret: env.SESSION_SECRET!,
    store: new RedisStore({ client: redis, prefix: 'rare:session:' }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure, maxAge: 30 * 60 * 1000 },
  }),
);
app.use(...requestLimits());
app.use((req: Request, res: Response, next: () => void) => {
  if (req.path === '/api/auth/backchannel-logout' && req.method === 'POST') return next();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (
      req.headers.origin !== appUrl ||
      !req.session.csrf ||
      req.headers['x-csrf-token'] !== req.session.csrf
    )
      return res.status(403).json({
        error: {
          code: 'CSRF_REJECTED',
          message: 'Your action could not be verified. Refresh the page and try again.',
        },
      });
  }
  next();
});
app.useGlobalFilters(new Errors());
app.enableShutdownHooks();
await app.listen(4000, '0.0.0.0');
for (const sig of ['SIGTERM', 'SIGINT'])
  process.once(sig, async () => {
    await app.close();
    await pool.end();
    await redis.quit();
    process.exit(0);
  });
