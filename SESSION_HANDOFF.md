# Current handoff — 25 November 2026 (RCH-8, the field app, Claude Code)

RCH-6 and RCH-7 went live on 24 November as `bcfd67d` with 35 migrations. This change adds
**RCH-8, the field app**, with migration 036. **Nothing is pushed.**

RCH-8 was the last milestone in the plan. With it, Reach RCH-0 to RCH-8 is complete.

## Read this first: the app was built twice

It was first built as a **PWA**, on the ground that a bare Expo install carried 16 advisories,
5 of them high, which the dependency gate would never accept. That measurement was taken on
**Expo SDK 54**, which was already old. On current Expo the same tree carries **no high
advisories at all** — and with one `overrides` entry it carries none of any severity.

So the PWA was the wrong call, taken from a stale number, and the app is now what the handover
asks for: an **Expo / React Native app**, `expo-router`, offline-first on a local SQLite with an
outbox sync, exactly as `04_TECH_STACK.md` words it.

The PWA is not lost. It is committed on the branch **`rch8-pwa-archive`** — it passed its own
acceptance and a full regression, and roughly half of it (the queue engine, the migration, the
device door, the server routes) is reused unchanged.

**The lesson worth keeping: a measurement has a date on it.** Re-measure before letting an old
number override a plan.

## What the dependency gate now does, and why the app left the workspace

`expo` declares its own command line and bundler as ordinary dependencies, so inside the npm
workspaces they counted as **production dependencies of the API image**, which they are not. The
gate audits production at `low` with no exception path, correctly, and there is no honest way to
describe Metro as something that ships in a container.

So `apps/mobile` is **no longer an npm workspace**. It has its own `package.json` and its own
`package-lock.json`, and `scripts/audit.mjs` grew a third section that audits that tree on its
own terms. Leaving the workspace does not mean leaving the gate:

- the root tree has **no Expo in it at all** (`npm audit --omit=dev`: clean);
- the field app's tree is audited separately (clean);
- **a missing lockfile there fails the gate** rather than passing it — an unaudited tree must
  never read as a clean one. This was tested by removing the lockfile and confirming exit 1.

The one advisory the app's tree would otherwise carry — `GHSA-g3hv-75wg-m249`, a denial of
service in `minimatch` reached through `@expo/fingerprint` — is **fixed** by an override to
`^11.0.9`, not excused. `ACCEPTED_FIELD_APP` is empty, which is the normal state.

A side effect worth having: 502 packages left the container build.

## What RCH-8 adds

**Server side (all of this is reused from the archived branch, unchanged):**

- `db/migrations/036_reach_sync.sql` — `client_ref` on `trade_orders`, `trade_receipts` and
  `stored_files` with **partial** unique indexes (`WHERE client_ref <> ''`), the `device_syncs`
  table, and `visits.file_id`.
- `apps/api/src/device-auth.ts` — a device token is its own Keycloak client, verified on audience
  **and** `azp`, against the same revocation records a browser session checks.
- `apps/api/src/reach-device.controller.ts` — `GET reach/device/day` (the whole day in one
  request), `POST reach/device/heartbeat` (counts, never content), `GET reach/device/seen`.
- `packages/engines/sync-queue.mjs` — every queue rule, pure, 23 tests.

**New in this build:**

- `packages/engines/field-payloads.mjs` + `tests/field-payloads.test.mjs` — **the dry run.**
  Each kind of work's payload is checked against the `body(req, [...])` list of the route that
  receives it, read from the controller source. It found a real fault while being written: the
  receipt route takes `latitude` and `longitude` but **no `accuracy_m`**, so the obvious
  `{ ...fix }` would have blocked every collection a rep took. 12 tests, 4 milliseconds.
- `apps/mobile/` — the Expo app. `expo-sqlite` for the outbox and the day, `expo-secure-store`
  for the refresh token (the keystore, not a database file — the one real security gain from
  leaving the browser), `expo-auth-session` for Authorization Code with PKCE, `expo-location`,
  `expo-image-picker` and `expo-image-manipulator` for the fix and the photo.
- `tests/reach-device.spec.ts` — replaces the PWA's Playwright spec. It signs a phone in through
  the real Keycloak client with PKCE, builds a whole beat with **the engine and payload builders
  that ship**, writes the queue out and reads it back, then drains it against the real routes and
  checks that all seven pieces of work arrive and that deliberate repeats produce one row each.
- `scripts/seed.mjs` — the mobile client's redirect is now `rareos://*`, with `exp://*` added
  **only outside production** (that is Expo Go's address while developing). `webOrigins` is empty:
  a native app sends no Origin.

**Removed:** the nginx `/mobile/` location, the service worker, the proxied Keycloak token
endpoint, and the Dockerfile's copy of the built PWA. The server-level
`camera=(), microphone=(), geolocation=()` now stands alone again, so `foundation.spec.ts:36`
passes without the scoping workaround the PWA needed.

## The screens

The client's designs give the Field Rep workspace 20 screens. This build has the ones the plan
asks for, under the client's own visual language (indigo `#20264a`, paper `#f2f1ec`, action
orange `#b8571c`, 44 px touch targets, from their `MOBILE_README.md`):

| Prototype screen                                                  | Here               |
| ----------------------------------------------------------------- | ------------------ |
| Start my day, Rep today                                           | `(tabs)/today.tsx` |
| Today's beat                                                      | `(tabs)/beat.tsx`  |
| Outlet, Visit hub, Check in                                       | `stop/[id].tsx`    |
| Take order                                                        | `stop/order.tsx`   |
| (collection — in the v17 reference, not the 73)                   | `stop/collect.tsx` |
| Check out                                                         | `stop/close.tsx`   |
| Tour plan                                                         | `(tabs)/plan.tsx`  |
| Change request                                                    | `change.tsx`       |
| My month                                                          | `month.tsx`        |
| Leave                                                             | `leave.tsx`        |
| Fix a punch                                                       | `regularise.tsx`   |
| (the queue — not in the 73; the app cannot be trusted without it) | `queue.tsx`        |
| Me and performance (the "Me" half only)                           | `(tabs)/me.tsx`    |

**Deliberately not built:** Survey, Market intel, Leads, Lead detail, and the performance half of
"Me and performance". The Reach plan names surveys, competitor intelligence, market signals,
leads and pipeline, and targets and achievement among the things that are **not** in this plan.

**Still missing, and it needs server work first:** _Stock and display_ (`RepStock`). There is no
stock-capture route or table anywhere in the build — not on the web either — so it is new product
work, not a screen. Also absent from the phone: **KYC and tag outlet**, which the client's
`MOBILE_README.md` points to as the newer reference. Those routes exist and work on the desk app;
only the phone screens are missing.

## Offline, and what is not

The day's work is queued and survives the app being closed: start the day, photo, check in, order,
collect, check out, end the day. That is the plan's acceptance and it is what the spec exercises.

The month, leave, a missed punch and the tour plan **read and write online**, and say so plainly
when there is no line. That is a decision: queueing a write means a reference column, a unique
index and a migration so a retry cannot duplicate it. Applying for leave twice because a bus went
through a tunnel is worse than being told to try again where there is signal.

## Where it runs

Expo Go, on a real handset, from the repo root:

```sh
npm run mobile:install
EXPO_PUBLIC_API_URL=http://<this-machine-on-the-phone's-wifi>:4000 npm run mobile:start
```

Not `localhost` — on a phone that means the phone. Without the variable the app talks to
production, which is the safe direction: it fails loudly at sign-in rather than quietly talking to
a laptop that is not there.

**It is not on a store.** That needs Apple and Google developer accounts and a build service, and
it is its own piece of work. An internal APK is the other route.

## State of the checks

- `npm run verify:quick` — **287 unit tests pass**, both dependency trees clean, builds fine.
- `expo-doctor` — **20/20**.
- `tests/field-payloads.test.mjs` — 12 tests. Proved it can fail, by reintroducing the
  `accuracy_m` fault and watching it go red with the route's own accepted list in the message.
- `scripts/audit.mjs` — proved the new section can fail, by removing the field app's lockfile
  (exit 1) and by resolving a known-vulnerable package into a scratch tree (5 advisories found
  through the new `cwd` path).
- Full regression: **not yet run against this build.** `tests/reach-device.spec.ts` is new and is
  being iterated on in a disposable stack with `npm run test:regression -- --grep "RCH-8 the
field app"`.

## What the client has to be told

The handover asks for Expo and now gets Expo, so there is nothing to explain there any more. Two
things do need saying:

1. **The app is not on a store yet.** It installs through Expo Go today.
2. **Stock and display, KYC and tag outlet are not on the phone.** The first needs new server
   work; the other two exist on the desk app and need phone screens.

## Nothing new to grant

Using the app from a phone is deliberately **not** a separate right. A rep whose login is linked
to a field rep record signs in and works. The RCH-6 hand-grants still stand — see
`docs/ROLE_PERMISSIONS_HINGLISH.md` and the project status memory.
