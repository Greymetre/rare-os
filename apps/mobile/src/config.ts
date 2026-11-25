// RCH-8: where this app thinks the server is.
//
// The browser version never had to ask: it was served by the same nginx that served the API, so
// every request could be a path. An app installed on a phone has no such anchor and has to be
// told, which is the one genuinely new problem that comes with leaving the browser.
//
// It is read from `EXPO_PUBLIC_API_URL`, which Expo inlines at bundle time, and falls back to
// the production address. The fallback is the safe direction: a build that forgot the variable
// talks to production and fails loudly on sign-in, rather than silently talking to a laptop
// that is not there.
//
// For local work the variable points at the Mac's address on the office network — not
// `localhost`, which on a phone means the phone.

import Constants from 'expo-constants';

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

const configured =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  'https://rare.greymetre.io';

export const SERVER = trimSlash(configured);
export const API = SERVER + '/api/';

// The app's own address, which Keycloak has to be told to send the rep back to. `scheme` in
// app.json is what makes this work on a real install; in Expo Go it comes out as an `exp://`
// address instead, which is why the seed allows both in development.
export const REDIRECT_PATH = 'auth';

export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
