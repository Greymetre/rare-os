// RCH-8: signing in once, and staying signed in through a day with no network.
//
// The web keeps a cookie that the server renews on every click. That is the right design for a
// browser and the wrong one for this app: a rep's phone is out of coverage from nine until six,
// and a cookie that rolls every thirty minutes is gone long before the signal comes back.
//
// So the phone does what native apps do. It signs in through Keycloak once, with PKCE, against
// its own public client, and keeps a refresh token. Each request carries a short access token
// minted from it. The refresh token is an *offline* one, which is Keycloak's name for exactly
// this case: a token that does not die when the session goes idle, because the whole point is
// that the session is idle — the rep is in a market with no bars.
//
// What keeps that safe is not the token's lifetime but everything around it. The access token
// lasts five minutes, so a revocation closes the device within five minutes. The client is its
// own, so signing every phone out does not sign out every desk. And the server checks the same
// revocation record for a device that it checks for a browser.

import { clearAuth, readAuth, writeAuth } from './store';

export const CLIENT_ID = 'rare-os-mobile';
const REALM = '/realms/rare-os';
const REDIRECT = location.origin + '/mobile/';

// The sign-in page is a top-level redirect to the real identity server, because a login form
// must show its own address bar and never a borrowed one.
//
// Everything the app calls with `fetch` — swapping the code for tokens, refreshing, signing out
// — goes to the same origin instead, where nginx proxies exactly those two Keycloak endpoints.
// That is one setting in one file, rather than a widened `connect-src` here and a CORS origin
// over in Keycloak, which are two places to drift apart.
const TOKEN_ENDPOINT = '/auth' + REALM + '/protocol/openid-connect/token';
const LOGOUT_ENDPOINT = '/auth' + REALM + '/protocol/openid-connect/logout';

export type Tokens = { access: string; refresh: string; expiresAt: number };

// Where Keycloak lives. The page is served from the app's own origin, so the address of the
// identity server has to come from somewhere — the server puts it in the day payload, and until
// then it is read from where the app last saw it.
export async function authBase(): Promise<string> {
  return (await readAuth<string>('authUrl')) ?? '';
}
export const rememberAuthBase = (url: string) => writeAuth('authUrl', url);

const random = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

function base64url(bytes: Uint8Array | ArrayBuffer) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

// Step one: leave for Keycloak. The verifier is kept on the device and never sent, which is what
// stops somebody who intercepts the returned code from being able to spend it.
export async function beginSignIn(authUrl: string) {
  await rememberAuthBase(authUrl);
  const verifier = random(48);
  const state = random(16);
  await writeAuth('pending', { verifier, state });
  const url = new URL(authUrl + REALM + '/protocol/openid-connect/auth');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('response_type', 'code');
  // `offline_access` is the whole reason a rep is not signed out by lunchtime.
  url.searchParams.set('scope', 'openid offline_access');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url.toString());
}

// Step two: back from Keycloak with a code. Returns true when this call consumed one, so the
// caller knows to clean the address bar.
export async function finishSignIn(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return false;
  const pending = await readAuth<{ verifier: string; state: string }>('pending');
  // A code arriving with a state this device did not issue is not this device's sign-in.
  if (!pending || params.get('state') !== pending.state) {
    history.replaceState({}, '', REDIRECT);
    throw Error('That sign-in did not match this device. Try again.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT,
    code_verifier: pending.verifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  history.replaceState({}, '', REDIRECT);
  if (!res.ok) throw Error('Sign-in could not be completed. Try again.');
  await store(await res.json());
  await writeAuth('pending', null);
  return true;
}

async function store(payload: any) {
  const tokens: Tokens = {
    access: payload.access_token,
    refresh: payload.refresh_token,
    // Thirty seconds of slack, so a request is never sent with a token that expires in flight.
    expiresAt: Date.now() + (Number(payload.expires_in ?? 300) - 30) * 1000,
  };
  await writeAuth('tokens', tokens);
  return tokens;
}

// The access token to put on the next request, refreshed if it has run out.
//
// Returns null rather than throwing when there is no network: being offline is the normal state
// of this app, and it is not a sign-in problem. It throws only when the refresh token itself is
// no longer good, which genuinely means the rep has to sign in again.
export async function accessToken(): Promise<string | null> {
  const tokens = await readAuth<Tokens>('tokens');
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt) return tokens.access;

  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: tokens.refresh,
      }),
    });
  } catch {
    // No line. The queue waits, which is what it is for.
    return null;
  }
  if (!res.ok) {
    await clearAuth();
    throw Error('Your sign-in has ended. Sign in again to send your work.');
  }
  return (await store(await res.json())).access;
}

export async function signedIn(): Promise<boolean> {
  return (await readAuth<Tokens>('tokens')) !== undefined;
}

// Signing out deliberately leaves the outbox alone. Unsent work belongs to the rep, not to the
// session, and throwing away a day because somebody tapped the wrong thing would be the single
// worst bug this app could have.
export async function signOut() {
  const tokens = await readAuth<Tokens>('tokens');
  await clearAuth();
  if (tokens?.refresh)
    await fetch(LOGOUT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, refresh_token: tokens.refresh }),
    }).catch(() => undefined);
}
