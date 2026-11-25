// RCH-8: how a phone proves who it is.
//
// The web signs in through Keycloak and keeps a cookie. That works because a browser is sitting
// in front of the server: the cookie is short, it is renewed on every click, and if it lapses the
// person signs in again in five seconds. A field rep's phone is the opposite case. It spends the
// day in a pocket with no network, in a market where there is none, and the sign-in it needs has
// to still be good when the signal comes back at six in the evening.
//
// So the phone does not use a cookie. It holds an OAuth refresh token from Keycloak and sends a
// short-lived access token with each request, and this file is the part that believes it.
//
// The rules it keeps, and why each one is here:
//
// **A device token is not a web session.** It is issued to its own Keycloak client, with its own
// audience, and a token minted for the browser will not open this door. That keeps a stolen web
// token from becoming a permanent field login, and it makes "revoke every phone" a thing an
// administrator can actually do.
//
// **Signing out still works.** The same revocation record the web checks is checked here, so an
// administrator who signs a rep out, or a rep who loses a handset, closes the phone too. Without
// this, a long-lived field login would be a door with no lock.
//
// **A login that needs a second factor cannot come in this way.** The phone has no path for
// entering a one-time code mid-request, and silently skipping the check would make the mobile
// app the easy way around it. Those accounts use the web, and are told so in plain words. In
// practice this never touches a field rep: the requirement is on administrators.
//
// **One login, one company.** A rep belongs to one company and the phone carries no company
// picker. An identity that somehow belongs to two is refused rather than guessed at, because
// guessing would file a day's work against the wrong company.
import type { Request } from 'express';
import { jwtVerify } from 'jose';
import { authUrl, fail, jwks, pool, realm, redis } from './core.js';
import { requiresMfa } from './session-security.js';

// The phone's own Keycloak client. Public, PKCE, no secret — a secret shipped inside an app that
// anybody can download is not a secret, and pretending otherwise is worse than not having one.
export const DEVICE_CLIENT_ID = 'rare-os-mobile';

export type DeviceIdentity = {
  subject: string;
  identitySid: string | null;
  tenantId: string;
  authVersion: number;
  signedInAt: number;
};

// Verified once per request. A route that checks a permission twice — and `mutate` does, once
// outside the transaction and once inside it — must not pay for the signature twice, and must
// not be able to see two different answers.
const CACHE = new WeakMap<Request, DeviceIdentity>();

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  // A bearer header that is present but unusable is a mistake worth naming, not a silent fall
  // back to cookies: falling back would make a broken phone look like an anonymous browser.
  if (!token || token.length > 8000) fail(401, 'LOGIN_REQUIRED', 'That sign-in could not be read.');
  return token;
}

export const isDeviceRequest = (req: Request) => bearerToken(req) !== null;

export async function deviceIdentity(req: Request): Promise<DeviceIdentity | null> {
  const cached = CACHE.get(req);
  if (cached) return cached;
  const token = bearerToken(req);
  if (!token) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: authUrl + realm,
      audience: DEVICE_CLIENT_ID,
      algorithms: ['RS256'],
      clockTolerance: 5,
    }));
  } catch {
    fail(401, 'LOGIN_REQUIRED', 'Your sign-in has expired. Open the app to sign in again.');
  }
  const p = payload!;

  // `azp` is the client that asked for the token. Checking it as well as the audience means a
  // token minted for another client, with this one merely listed as an audience, is refused.
  if (p.azp !== DEVICE_CLIENT_ID || p.typ !== 'Bearer' || typeof p.sub !== 'string')
    fail(401, 'LOGIN_REQUIRED', 'That sign-in was not issued for this app.');

  const subject = p.sub as string;
  const identitySid = typeof p.sid === 'string' ? p.sid : null;

  // The same two revocation records the web session checks. `iat` stands in for the session's
  // signed-in moment: a subject-wide sign-out revokes every token minted before it.
  const issuedAtMs = typeof p.iat === 'number' ? p.iat * 1000 : Date.now();
  const [bySid, bySubject] = await redis.mGet([
    'rare:revoked:sid:' + (identitySid ?? '-'),
    'rare:revoked:subject:' + subject,
  ]);
  if (bySid || (bySubject && issuedAtMs <= Number(bySubject)))
    fail(401, 'SESSION_REVOKED', 'This device was signed out. Sign in again to continue.');

  if (await requiresMfa(subject))
    fail(
      403,
      'MFA_NOT_SUPPORTED_ON_DEVICE',
      'This account needs a second factor, which the mobile app cannot ask for. Use the web app.',
    );

  const memberships = (await pool.query('SELECT * FROM session_memberships($1)', [subject])).rows;
  if (memberships.length !== 1)
    fail(
      403,
      'ACCOUNT_UNAVAILABLE',
      memberships.length === 0
        ? 'Your account no longer has access to a company. Contact your administrator.'
        : 'This login belongs to more than one company. Use the web app.',
    );

  const identity: DeviceIdentity = {
    subject,
    identitySid,
    tenantId: memberships[0].tenant_id,
    authVersion: memberships[0].auth_version,
    signedInAt: issuedAtMs,
  };
  CACHE.set(req, identity);
  return identity;
}
