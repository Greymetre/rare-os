// RCH-8: signing a phone in, and keeping it signed in through a day with no coverage.
//
// The rep signs in on Keycloak's own page, in a real browser view with a real address bar, and
// comes back with a code this app exchanges for tokens. Authorization Code with PKCE, which is
// the only correct flow for a public client: there is no secret in an app a rep can install, so
// the proof is the verifier this app generated and kept.
//
// Three things are worth saying out loud.
//
// **The refresh token is in the operating system's keystore** — `expo-secure-store`, which is
// the iOS keychain and Android's EncryptedSharedPreferences. The browser version had to keep it
// in IndexedDB, where any script in the page could read it. This is a real improvement that
// comes with leaving the browser, and it is the reason a long-lived refresh token is defensible
// here at all.
//
// **It is long-lived on purpose.** A rep leaves the depot at nine and sees a network at six.
// `offline_access` plus the client's thirty-day idle window is what makes that work. The access
// token stays short — five minutes, the realm default — so revoking a device still closes it
// within five minutes.
//
// **`accessToken()` has three outcomes and the difference matters.** A string means go. `null`
// means the refresh could not be reached, which is the normal state of this app and must never
// be shown to a rep as an error. A thrown error means the server said no — the token is dead,
// and only signing in again will fix it. `sync.ts` depends on exactly this distinction.

import * as AuthSession from 'expo-auth-session';
import { TokenTypeHint } from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { API, REDIRECT_PATH } from './config';

const REFRESH_KEY = 'rare.refresh';
const SUBJECT_KEY = 'rare.subject';

// The access token never touches storage. It lives five minutes; keeping it would buy nothing
// and would put a bearer token on disk for no reason.
let access: { token: string; expiresAt: number } | null = null;

export type ServerConfig = { authUrl: string; clientId: string; realm: string };

let configured: ServerConfig | null = null;
let discovery: AuthSession.DiscoveryDocument | null = null;

// Which identity server, which client. Asked of our own API rather than compiled in, so that a
// client who moves their Keycloak does not need a new app build.
export async function serverConfig(): Promise<ServerConfig> {
  if (configured) return configured;
  const res = await fetch(API + 'mobile/config');
  if (!res.ok) throw Error('The server did not say where to sign in.');
  configured = (await res.json()) as ServerConfig;
  return configured;
}

async function discover(): Promise<AuthSession.DiscoveryDocument> {
  if (discovery) return discovery;
  const cfg = await serverConfig();
  discovery = await AuthSession.fetchDiscoveryAsync(
    `${cfg.authUrl.replace(/\/+$/, '')}/realms/${cfg.realm}`,
  );
  return discovery;
}

export function redirectUri(): string {
  // In a real install this is `rareos://auth`. In Expo Go it is the `exp://` address of the
  // development server, which is why both are allowed in a development seed.
  return AuthSession.makeRedirectUri({ scheme: 'rareos', path: REDIRECT_PATH });
}

export async function isSignedIn(): Promise<boolean> {
  return (await SecureStore.getItemAsync(REFRESH_KEY)) !== null;
}

export async function signedInSubject(): Promise<string | null> {
  return SecureStore.getItemAsync(SUBJECT_KEY);
}

// Open Keycloak, come back with tokens. Throws with something a rep can read if the sign-in was
// dismissed or refused.
export async function signIn(): Promise<void> {
  const cfg = await serverConfig();
  const doc = await discover();
  const request = await AuthSession.loadAsync(
    {
      clientId: cfg.clientId,
      redirectUri: redirectUri(),
      // `offline_access` is what makes a refresh token outlive the day. Without it the rep is
      // signed out by Keycloak's ordinary session idle timeout somewhere in the second beat.
      scopes: ['openid', 'offline_access'],
      usePKCE: true,
    },
    doc,
  );
  const result = await request.promptAsync(doc);
  if (result.type === 'cancel' || result.type === 'dismiss')
    throw Error('Sign-in was closed before it finished.');
  if (result.type !== 'success')
    throw Error(
      (result as { params?: Record<string, string> }).params?.error_description ||
        'Sign-in did not complete.',
    );

  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId: cfg.clientId,
      code: result.params.code,
      redirectUri: redirectUri(),
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
    },
    doc,
  );
  await keep(tokens);
}

async function keep(tokens: AuthSession.TokenResponse): Promise<void> {
  if (tokens.refreshToken) await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken);
  access = {
    token: tokens.accessToken,
    // A minute of headroom, so a token does not expire between the check and the request.
    expiresAt: Date.now() + ((tokens.expiresIn ?? 300) - 60) * 1000,
  };
  const subject = subjectOf(tokens.idToken ?? tokens.accessToken);
  if (subject) await SecureStore.setItemAsync(SUBJECT_KEY, subject);
}

// `sub` out of a JWT, for showing who is signed in. Not a verification — the server verifies;
// this is only so the app can say a name without another round trip.
function subjectOf(jwt: string | undefined): string | null {
  if (!jwt) return null;
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

// A usable access token, or `null` when there is no line, or a throw when the refresh token is
// dead. See the note at the top of this file: the three outcomes are not interchangeable.
export async function accessToken(): Promise<string | null> {
  if (access && access.expiresAt > Date.now()) return access.token;

  const refresh = await SecureStore.getItemAsync(REFRESH_KEY);
  if (!refresh) throw Error('This phone is not signed in.');

  const cfg = await serverConfig().catch(() => null);
  if (!cfg) return null; // could not reach our own server: offline
  const doc = await discover().catch(() => null);
  if (!doc) return null; // could not reach the identity server: offline

  try {
    const tokens = await AuthSession.refreshAsync(
      { clientId: cfg.clientId, refreshToken: refresh },
      doc,
    );
    await keep(tokens);
    return access?.token ?? null;
  } catch (error) {
    // Keycloak answering "no" is different from not answering. A refused refresh means the
    // session was revoked, the rep was removed, or the token finally expired — all of which need
    // a fresh sign-in. A network failure throws something without a response, and that is an
    // offline, not a sign-out.
    if (isRefusal(error)) {
      await SecureStore.deleteItemAsync(REFRESH_KEY);
      throw Error('This phone has been signed out. Sign in again to send your work.');
    }
    return null;
  }
}

function isRefusal(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  return (
    code === 'invalid_grant' ||
    code === 'invalid_token' ||
    code === 'unauthorized_client' ||
    code === 'invalid_client'
  );
}

// Signing out forgets who the rep is. It deliberately leaves the outbox alone: unsent work is
// the rep's, not the session's, and it is still theirs when they sign back in. `db.clearDay`
// takes the round, because that is a read and can be fetched again.
export async function signOut(): Promise<void> {
  const refresh = await SecureStore.getItemAsync(REFRESH_KEY);
  access = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY);
  await SecureStore.deleteItemAsync(SUBJECT_KEY);
  if (!refresh) return;
  // Tell Keycloak as well, so the refresh token is dead server-side and not merely forgotten
  // here. Best effort: a rep signing out on a train must not be left on a spinner.
  try {
    const cfg = await serverConfig();
    const doc = await discover();
    if (doc.revocationEndpoint)
      await AuthSession.revokeAsync(
        { clientId: cfg.clientId, token: refresh, tokenTypeHint: TokenTypeHint.RefreshToken },
        doc,
      );
  } catch {
    // ignored on purpose
  }
}
