# RARE OS Field — the rep's app (RCH-8)

An Expo / React Native app, as `04_TECH_STACK.md` and the Reach milestone plan both ask for. It
installs on a phone; it is not served from this origin and none of it ships in the containers.

## Why it is not an npm workspace

`expo` declares its own command line and bundler (`@expo/cli`, Metro, `postcss`, `image-size`) as
ordinary dependencies, so in the root tree they would count as **production dependencies of the
API image**, which they are not. `scripts/audit.mjs` audits production dependencies at `low` with
no exception path at all, and rightly so.

So the field app keeps its own `package.json` and its own `package-lock.json`, and
`scripts/audit.mjs` audits that tree separately — same discipline, applied to the phone. Leaving
the workspace does not mean leaving the gate: a missing lockfile there is a failure, not a pass.

Both trees are clean. The one advisory this tree would otherwise carry
(`GHSA-g3hv-75wg-m249`, a denial of service in `minimatch`, reached through
`@expo/fingerprint`) is **fixed** by an override to `minimatch ^11.0.9` rather than excused.

## Running it

```sh
npm run mobile:install          # from the repo root, once
EXPO_PUBLIC_API_URL=http://192.168.1.x:4000 npm run mobile:start
```

`EXPO_PUBLIC_API_URL` must be the machine's address **on the network the phone is on** — not
`localhost`, which on a phone means the phone. Without it the app talks to production.

Then open Expo Go on the handset and scan the code. Keycloak has to allow the `exp://` address
the development server prints, which `scripts/seed.mjs` arranges outside production.

## How it is built

| Part                                  | What it is                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/engines/sync-queue.mjs`     | **Every rule** about what goes first, what waits, what is retried, what has stopped. Pure, 23 tests.                  |
| `packages/engines/field-payloads.mjs` | Exactly what each kind of work sends. Checked against the routes by `tests/field-payloads.test.mjs`.                  |
| `src/sync.ts`                         | The hands. Reads the queue, asks the engine what may go, puts it on the wire, hands the answer back. Decides nothing. |
| `src/db.ts`                           | SQLite: the outbox and the day. Never a token.                                                                        |
| `src/auth.ts`                         | Keycloak, Authorization Code with PKCE. The refresh token lives in the OS keystore.                                   |
| `src/net.ts`                          | The few screens that genuinely need a network, and say so.                                                            |
| `app/`                                | The screens, by `expo-router`.                                                                                        |

The app has **no write path of its own**: it calls the same routes the desk app does. Only two
routes are its own — `GET reach/device/day` (the whole day in one request, because eight requests
on a weak line is eight chances to hold half a day) and `POST reach/device/heartbeat` (counts,
never content).

## What is offline and what is not

The day's work — start the day, photo, check in, order, collect, check out, end the day — is
queued on the phone and survives being closed, exactly as the plan's acceptance requires.

The month's register, leave, a missed punch and the tour plan are **not** queued, and that is a
decision rather than an omission: queueing a write means a reference column, a unique index and a
migration so a retry cannot duplicate it. Applying for leave twice because a bus went through a
tunnel is worse than being told to try again where there is signal.

## Testing it

| What                                               | Where                                                       |
| -------------------------------------------------- | ----------------------------------------------------------- |
| The queue's rules                                  | `tests/sync-queue.test.mjs` — 23 tests, no phone needed     |
| The payload shapes, against the real routes        | `tests/field-payloads.test.mjs` — the dry run, milliseconds |
| The whole beat, offline then arriving exactly once | `tests/reach-device.spec.ts` — in the regression stack      |
| The screens on a real handset                      | `docs/REACH_TEST_GUIDE_HINGLISH.md`                         |
