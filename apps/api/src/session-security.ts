import type { Request } from 'express';
import { jwtVerify } from 'jose';
import { identity } from './identity.js';
import { redis, jwks, authUrl, realm, fail, pool } from './core.js';
export const sessionLifetimeMs = 12 * 60 * 60 * 1000;
export async function requiresMfa(subject: string) {
  return (await pool.query('SELECT identity_requires_mfa($1) AS required', [subject])).rows[0]
    .required as boolean;
}
export async function verifySession(req: Request) {
  if (!req.session.subject || !req.session.signedInAt || !req.session.identitySid)
    fail(401, 'LOGIN_REQUIRED', 'Please sign in again to continue.');
  if (Date.now() - req.session.signedInAt! > sessionLifetimeMs)
    fail(401, 'SESSION_EXPIRED', 'Your session expired. Please sign in again.');
  if (await requiresMfa(req.session.subject!)) {
    const credentials = req.session.mfaVerified
      ? ((await (
          await identity('/users/' + encodeURIComponent(req.session.subject!) + '/credentials')
        ).json()) as any[])
      : [];
    if (
      !req.session.mfaVerified ||
      !Array.isArray(credentials) ||
      !credentials.some((c) => c.type === 'otp')
    ) {
      req.session.forceLogin = true;
      fail(
        401,
        'ADMIN_MFA_REQUIRED',
        'MFA is required for administrator access. Sign in again to set it up or verify your code.',
      );
    }
  }
  const [sid, subject] = await redis.mGet([
    'rare:revoked:sid:' + req.session.identitySid,
    'rare:revoked:subject:' + req.session.subject,
  ]);
  if (sid || (subject && req.session.signedInAt! <= Number(subject)))
    fail(401, 'SESSION_REVOKED', 'Your identity session was signed out. Please sign in again.');
}
export async function receiveLogout(token: unknown) {
  if (typeof token !== 'string' || token.length > 16000)
    fail(400, 'INVALID_LOGOUT', 'Invalid logout request.');
  let payload;
  try {
    ({ payload } = await jwtVerify(token as string, jwks, {
      issuer: authUrl + realm,
      audience: 'rare-os-web',
      algorithms: ['RS256'],
      maxTokenAge: '2m',
      clockTolerance: 5,
    }));
  } catch {
    fail(400, 'INVALID_LOGOUT', 'Logout token could not be verified.');
  }
  const p = payload!;
  const events = p.events as Record<string, unknown> | undefined;
  if (
    !p.jti ||
    typeof p.iat !== 'number' ||
    p.iat > Date.now() / 1000 + 5 ||
    p.nonce !== undefined ||
    !events ||
    !Object.hasOwn(events, 'http://schemas.openid.net/event/backchannel-logout') ||
    (!p.sub && typeof p.sid !== 'string')
  )
    fail(400, 'INVALID_LOGOUT', 'Invalid logout claims.');
  const ttl = Math.ceil(sessionLifetimeMs / 1000) + 300;
  const key =
    typeof p.sid === 'string' ? 'rare:revoked:sid:' + p.sid : 'rare:revoked:subject:' + p.sub;
  await redis.eval(
    `
    if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
    local value=tonumber(ARGV[1])
    local previous=tonumber(redis.call('GET',KEYS[2]) or '0')
    redis.call('SET',KEYS[2],math.max(value,previous),'EX',ARGV[2])
    redis.call('SET',KEYS[1],'1','EX',180)
    return 1
  `,
    {
      keys: ['rare:logout-jti:' + p.jti, key],
      arguments: [typeof p.sid === 'string' ? '1' : String(p.iat! * 1000 + 999), String(ttl)],
    },
  );
}
