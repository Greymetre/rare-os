# Current handoff — 24 November 2026 (RCH-8, the field app, Claude Code)

RCH-6 and RCH-7 went live on 24 November as `bcfd67d` with 35 migrations. This change adds
**RCH-8, the field app**, with migration 036. **Nothing is pushed.**

RCH-8 was the last milestone in the plan. With it, Reach RCH-0 to RCH-8 is complete.

## The one decision that shaped everything

The plan asks for a **React Native / Expo** app. It is not one, and the reason is worth keeping.

A bare Expo install — `expo`, `react-native`, `react-native-web` and their trees — is 378
packages and 293 MB, and `npm audit` reports **16 advisories, 5 of them high**. The dependency
gate (`scripts/audit.mjs`) reads production dependencies at `low` **with no exception path at
all**, by design, and `react-native-web` ships into the production bundle. Taking the plan
literally would have meant either weakening the gate or committing a list of accepted
vulnerabilities — the exact thing `docs/REGRESSION_TESTING_HINGLISH.md` tells us not to do.

So the field app is a **PWA built on the stack that is already here**: React 19.3 and Vite 8.3.5,
the same versions `apps/web` uses. **Zero new dependencies.** It installs to a phone's home
screen, runs full-screen, uses the camera and GPS through the browser, and works with no network
through a service worker and IndexedDB.

What this costs: it is not a store app, and a rep installs it from a link rather than from Expo
Go. What it buys, besides the gate: the whole offline promise is exercised by Playwright inside
the regression suite, which a native app could not have been.

**This was put to the user as a choice, with the numbers, and they chose it.**

## What RCH-8 added

### The queue, which is the whole milestone

`packages/engines/sync-queue.mjs` — pure, no database, no HTTP, no clock of its own, 22 tests.
Everything about what goes first, what waits, what is retried and what has stopped lives here,
so that none of it has to be exercised by flying a phone to a market. Four rules:

- **The phone mints the reference, before anything is sent, and never changes it on a retry.**
- **An unknown outcome is retried; a refusal the server understood is not.** A request that died
  in the air teaches the phone nothing and must be sent again. A 400 means the server read it,
  understood it and said no — more tries change nothing, so it stops and the rep is told.
- **Work that refers to earlier work waits for it.** An order taken during a visit points at a
  visit that has no server identity yet. It waits, and the phone's local id is swapped for the
  real one. Nothing is invented on the device; the only ids it makes up are marked `local:`.
- **Nothing is ever quietly dropped.** Three named states, counts on every screen, and anything
  that stopped says why in words a rep can act on.

### Migration `036_reach_sync.sql`

`client_ref` on `trade_orders`, `trade_receipts` and `stored_files`, each with a **partial**
unique index (`WHERE client_ref <> ''`), because the web writes no reference and every one of
those rows would otherwise collide.

Three records needed it and the rest did not, which is written into the migration so nobody has
to rediscover it. An order is not unique in itself — a rep may take two identical orders at one
counter. A receipt is worse: two collections of the same amount on one day are ordinary, and
getting it wrong credits a shop twice. A stored file kept its _bytes_ once already (the path is
their sha256) but not its _row_, so a retried photo left an orphan. Starting a day, ending one
and checking out are each unique by nature, and the server already answers a repeat with a 409
that carries the same information a reference would have.

Also `device_syncs`: a heartbeat of **counts, never content**, so that "my day never arrived"
can be answered with evidence. No DELETE granted.

### A phone gets in on its own token

`apps/api/src/device-auth.ts`, and `access()` in `core.ts` now resolves an identity from either
a web session or a device token. Everything past that point is identical for both — same
permission, same tenant scope, same audit row — because the moment the two paths diverge, one of
them grows a hole.

- Its own Keycloak client, `rare-os-mobile`: public, PKCE, no secret, **offline** refresh token.
  A secret shipped inside something anybody can download is not a secret.
- Audience **and** `azp` both checked, so a token minted for the browser cannot open this door.
- The same Redis revocation record a browser session checks, so signing a device out works.
- An account that **requires a second factor is refused**, not let past it. A phone cannot ask
  for an OTP mid-request, and skipping the check silently would make the mobile app the way
  around MFA. In practice this never touches a rep; MFA is on administrators.
- **One login, one company.** Two memberships is a refusal, not a guess about whose books a
  day belongs in.
- CSRF is skipped for bearer requests alone, with the reasoning in the code: a token read from
  the app's own storage is never spent on a third party's behalf, and a phone has no Origin to
  match and no CSRF token to have been handed.

### Taking the day with you

`GET /api/reach/device/day` — the round, the shops, **those shops' prices for today**, the visit
form per customer type, each shop's outstanding, and what this login may actually do. One
request, not eight: on a weak line, eight requests is eight chances to end up holding half a day.

The outstanding is read through `outstandingFor`, the one function that defines it. Computing it
in SQL here would have been a second definition that agreed with the web right up until somebody
changed how ageing works.

### Three changes outside the module

- **`nginx.conf`** — `Permissions-Policy` widened from `camera=(), geolocation=()` to `(self)`
  for both. `camera=()` means not even our own page may ask. `(self)` is not a grant: the browser
  still asks the rep. The microphone stays shut.
- **`nginx.conf`** — the two Keycloak endpoints the app calls with `fetch` (token, logout) are
  proxied same-origin, so neither `connect-src` nor Keycloak's CORS had to be widened. The
  sign-in page itself remains a top-level redirect to the real identity server, as a login form
  should be.
- **`seed.mjs`** — the `rare-os-mobile` client and an **audience mapper**, without which
  Keycloak's access token names `account` rather than this API.

## Verification

- **274 unit tests** (22 new), **13 security-baseline suites** (one new).
- `tests/reach-mobile.spec.ts` — the plan's own acceptance, carried out literally: a whole beat
  in airplane mode, the page **reloaded while still offline** (the app closed and reopened), then
  the network allowed back. It then sends the same order and the same collection twice on purpose
  and asserts one record each, and checks that a write with no reference still behaves exactly as
  it did before RCH-8.
- A dry run of the device layer against the real schema, in a rolled-back transaction: 26 checks.
  **It was skipped at first and that cost two full regression cycles.** Two mistyped column
  names — `items.unit_id` (it is `base_unit_id`) and `attendance_days.start_time` (it is
  `started_at`) — are invisible to TypeScript and to the unit tests, and surfaced only as a 500
  at the far end of a ten-minute browser run, where the symptom was "the rep's day will not load
  onto the phone". The dry run finds both in a second, and it is how this codebase has always
  caught that class.
- Full regression: see the memory note for the run id.

## Open, unchanged

Legal GST tax invoice or numbered record (RCH-5); out-of-radius check-in block or flag (RCH-4);
whether a rep who works a week-off earns a daily allowance (RCH-6).

## After deploying

1. The three RCH-6 rights, if they are still ungranted: `reach.expense`, `reach.expense_approve`
   and `reach.expense_finance` — **the last two to different people**.
2. Every rep's `hq_town`, or every daily allowance reads as out-of-headquarters.
3. Nothing new for RCH-8. Using the app from a phone is deliberately **not** a separate right: a
   rep who may take an order may take it at the counter. A rep whose login is linked to a field
   rep record can open `/mobile/` and sign in.
