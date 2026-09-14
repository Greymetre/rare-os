# RARE OS - Local foundation

React + TypeScript, NestJS, PostgreSQL, Redis/BullMQ aur Keycloak ka working first milestone. Existing handover/prototype folder separate aur unchanged hai.

## Start

Requirements: Docker Engine/Desktop with Compose v2.24+ (production override tags ke liye), Node 24 LTS for local tooling. Existing apps se alag Compose project `rare-os` hai.

```sh
node scripts/setup.mjs
docker compose up -d --build
```

Open **http://localhost:4310**. Keycloak local endpoint: **http://localhost:4311**.

Admin email `.env` ke `SEED_ADMIN_EMAIL` mein hai (initially `admin@rareos.local`). Generated password `.env` ke `SEED_ADMIN_PASSWORD` mein hai. Password git mein commit nahi karna. Same `.env` preserve rakhein: app/identity database passwords usi se initially provision hue hain.

`Sign in securely` click karke Keycloak par email/password enter karein. Application has one seeded Main Admin role, one application admin, 23 permissions and one workspace tenant. Keycloak bootstrap-admin is a separate infrastructure account, not a second application user.

Seeder repeat-safe hai: re-run par admin duplicates/password reset nahi. Roles/catalog updated; existing admin disabled state preserved. Seed and migrate one-shot containers exit 0 normally. Other seven containers keep running.

```sh
docker compose ps -a
docker compose logs --tail=50 api worker
docker compose run --rm seed
```

Local ports loopback-only bind hain. PostgreSQL/Redis/API host par expose nahi. Containers and volumes use `rare-os` prefix. Other projects are not stopped.

## Implemented

- Branded responsive login landing and operations dashboard.
- Keycloak Authorization Code + PKCE, state/nonce/JWT validation.
- Redis-backed HttpOnly application session, CSRF/origin protection and logout.
- Database-side roles/permissions with current active membership checked on every protected request.
- Tenant RLS and non-owner runtime database account.
- Seeded Main Admin and permission catalog; searchable, paginated role/user management and audit screens.
- Role create/edit/delete, permission selection, protected system role and assigned-role deletion checks.
- User creation, role assignment, activation/deactivation, invitation/reset emails and identity setup retry.
- Last-admin protection, version conflict detection, privilege escalation prevention and audited before/after changes.
- Readiness checklist with clear missing-site/master messages; no fake production KPIs.
- Audited login/logout; transactional seed event and retry-safe BullMQ foundation worker.
- Versioned SQL migrations with checksum/advisory lock and parameterised SQL.
- Health checks, container restart policies, log rotation, persistent data volumes.

## Not yet implemented

Enforced MFA rollout, master CRUD, inventory transactions, Availability calculations, ERP integration, exports, native Expo app and hosted production release. Seeded permissions are an access contract; they do not imply all these workflows already exist. Missing modules show setup-pending messages.

Login has a 30-minute idle timeout and a 12-hour absolute lifetime. Signed Keycloak backchannel logout invalidates linked application sessions through Redis. Accounts disabled in the app are rejected on the next API request. App-admin deactivate, role change and password-reset actions invalidate existing app sessions. After this security upgrade, older sessions require a fresh login. Security screen supports voluntary authenticator enrollment and recovery-code setup; production-wide MFA enforcement remains a separate rollout.

Local invitations and password resets are captured in Mailpit at **http://localhost:4312**; they do not reach real email inboxes. Open the captured invitation, set a password, then sign in. Production requires real SMTP settings. Changing SEED_ADMIN_PASSWORD after first boot does NOT rotate the existing identity password.

## Project folders

- `apps/web`: React/Vite UI.
- `apps/api`: NestJS BFF/API and permission enforcement.
- `apps/workers`: outbox dispatch and foundation event consumer.
- `apps/mobile`: future Expo workspace placeholder.
- `packages/schema`: authoritative seed permission catalog.
- `packages/engines`: Availability engine placeholder.
- `db/migrations`: transactional SQL schema and RLS.
- `scripts`: environment setup, migrations, seed and database tests.
- `infra/docker`: image, reverse proxy and Hostinger configuration.

Foundation uses pg + reviewed SQL migrations instead of the planning document's suggested Prisma: explicit RLS/roles and SQL are currently the implementation source of truth. ORM introduction later must preserve these migrations/policies.

## Tests

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
docker compose run --rm seed node scripts/test-db.mjs
```

Browser tests use installed Google Chrome (`channel: chrome`). If absent, install Chrome or change to Playwright Chromium after `npx playwright install chromium`. Browser tests need Docker CLI access to temporarily revoke/restore admin permissions for denial tests. Run only against this isolated LOCAL seeded workspace, not a production deployment. DB tests perform 100k-row transactional fixtures and roll back.

Screenshots after browser tests: `.local/dashboard-desktop.png` and `.local/dashboard-mobile.png` (git ignored).

## Everyday operations

```sh
docker compose stop
docker compose start
# Rebuild after source changes:
docker compose up -d --build
```

Do not use `docker compose down -v` unless you intentionally want to erase this project's data. A normal stop/rebuild preserves PostgreSQL and Redis volumes.

Generated env values are local bootstrap credentials. Production needs new secrets, TLS, SMTP, MFA, backups and restore validation; see `docs/HOSTINGER.md`. This foundation has not been certified for crore-record production traffic.

## Admin workflow

1. Open Roles & permissions, create a role and select seeded permissions. Main Admin is protected.
2. Open Users, create a user and assign a role. Open the invitation in the local Mailpit inbox to set their password.
3. Edit a user to change role or active status. Failed identity setup has a retry action; pending new identities cannot log in.
4. Audit activity records changes. Assigned roles cannot be deleted, and the last active Main Admin cannot be disabled.

User email is fixed after identity setup; a pending setup can have its email corrected. Site/plant assignment is available from Users → Plant access.

## SaaS company management

Sign out/in after upgrading, then use **Companies** in the header. The seeded owner has a separate Platform Admin grant; company roles cannot grant platform access. Existing company users and data are preserved.

Platform Admin can create a company with a unique code, contact email and initial admin; edit its name/contact/status; inspect onboarding and retry setup/invitation. Each company receives its own protected Main Admin role and seeded permissions. Company codes are immutable. Company deletion and billing/subscriptions are not included.

An existing admin email can be assigned to a new company through platform onboarding. It retains its password. Login with multiple active memberships shows a company chooser; company switching reloads workspace data and rotates the CSRF token. Newly granted or reactivated access requires a fresh sign-in. Company status changes invalidate old membership sessions. Company-local deactivation does not disable the shared Keycloak identity. Company admins cannot send admin-triggered resets for shared logins; those users use Forgot password.

Platform Admin can explicitly open an active company using Companies → Open company. Every request rechecks platform status and selected company status/version; it runs within that company’s tenant context. Opening is audited, and changes include the platform identity as actor_subject. Platform lifecycle changes are recorded in `platform_audit`; company actions remain in tenant audit logs. Platform admin grant/revoke is a controlled database operation, not a company role checkbox. Production platform admin MFA and credential recovery remain deployment requirements.

Plants and per-user plant assignment are available. Company list uses bounded cursor pagination and prefix search; realistic production load testing is still required.

## Plants and delegated company access

Platform Admin opens a company, creates company-local roles/users, then assigns plants from Users → Plant access. Platform access is not granted to those users. Platform Admin can reuse an existing email in another company with a different role; the password is preserved. Normal company admins do not get cross-company identity lookup.

Main Admin and roles with `sites.manage` can access all plants in their company. Limited roles need `sites.read` and explicit assigned plants; no assignment means no plant access. `users.manage` plus `sites.manage` is required to assign plant access. Revocation is checked on each request. Inactive plants are hidden from limited users. Plant codes are unique per company and immutable; names, locations, IANA timezones and active status are editable with version conflict checks.

Tenant isolation remains PostgreSQL RLS. Plant isolation is enforced in plant endpoints and dashboard queries; future inventory/planning/export endpoints must use `requirePlant` before querying plant data. Those business modules are not implemented yet. Directory permissions such as users.read and audit.read intentionally expose company-wide administration information; avoid granting them to plant-only viewers.

Login/callback have separate IP quotas; signed-in API quotas are per server-side session. Health probes consume neither budget. The rate limiter uses process memory on this single-API deployment; multiple replicas will need a shared limiter store.

Retained review demo: run `RARE_REVIEW_DEMO=1 npx playwright test tests/review-delivery.spec.ts`. It preserves its companies, identities, roles and plants and saves `.local/PLANT_REVIEW.json` (private, git-ignored). Do not run the older disposable fixture suites during this review period: their cleanup predates the user's retention instruction. Cleanup retained fixtures only when the user requests it or provides the next task; preserve actual customer companies/users.

Review status: the user completed verification and requested cleanup. The retained plant/platform demo has now been removed; actual companies/users are preserved. Previous private review-guide links no longer apply. Running the opt-in review test again intentionally creates a new demo; do so only when needed for a new authorized test.

## Local security and backup verification

Security → Set up authenticator se apne phone ka authenticator link karein. Setup ke baad recovery codes private jagah save karein. Existing real accounts ka password ya MFA automatically change nahi kiya gaya.

```sh
npm run backup:local
# Fresh backup plus isolated restore verification:
npm run backup:verify
# Verify an existing backup while source record counts are unchanged:
node scripts/restore-drill.mjs .local/backups/<timestamp>
```

Backups contain both application and Keycloak databases, SHA-256 checksums and a private manifest. Restore verification creates temporary databases, checks record counts and tenant RLS, then drops only those temporary databases. The live databases are not overwritten. A source count change since backup causes verification to fail for review. Files live under private `.local/backups/`; protect them like credentials. They are local copies, not offsite disaster recovery. Separate database dumps are not a coordinated cross-database snapshot; run while onboarding/admin changes are idle.

New-host recovery also needs the preserved private environment, database roles/bootstrap and matching application version. Redis sessions and pending queue state are not included; this drill does not certify full production disaster recovery. Keep actual deployment, real SMTP and mandatory MFA rollout separate from the current local-only delivery.

Current local cross-check: [LOCAL_FOUNDATION_CHECK.md](docs/LOCAL_FOUNDATION_CHECK.md). Availability and business masters have not been started.
