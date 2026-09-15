# Foundation validation - 14 September 2026

Environment: local Docker Desktop; Node 24 in containers; Chrome desktop/mobile viewport automation.

Passed:

- Access-management browser flow: create/edit/delete custom role, reject unknown permissions and stale edits, protect Main Admin and assigned roles, create user through UI, idempotent creation and case-insensitive email conflict, invitation captured in Mailpit, password setup and real new-user login, privilege escalation denial, deactivate/reactivate session invalidation, reset email cooldown and before/after audit. All four composite browser tests passed together. Test users and identities were cleaned up.
- React, API and worker production builds and strict TypeScript checks.
- Two permission-catalog unit tests.
- Foundation browser tests: unauthenticated denial, CSRF, callback validation, real Keycloak login, session cookie flags, users/roles/permission UI, missing-master messaging, page-size/cursor validation, live permission revoke, disabled account, logout and responsive layout.
- Database seed: one application user, one Main Admin role, 23 permissions.
- Repeated migrations/seed during rebuilds preserve counts and the existing password.
- Database RLS: no context returns no tenants; current tenant cannot read/write another tenant; runtime role cannot modify the seeded permission catalog.
- 100,000 temporary audit rows: EXPLAIN ANALYZE uses an index for recent-page lookup (0.038 ms execution in the observed local run). Fixtures rolled back. This is NOT end-to-end or crore-record load testing.
- Background outbox event dispatched and processed once; processed-event ledger contains one seeded event after repeated startup.
- Hostinger Compose override parses successfully; no remote deployment performed.
- npm install/audit reported zero known vulnerabilities after patched multer override (2.4.0).

Local screenshots are in `.local/dashboard-desktop.png` and `.local/dashboard-mobile.png`.

Open milestones: production email/MFA rollout and master CRUD, Availability engines, real ERP integration, full-scale load tests, offsite backup restore drill and production deployment.

## SaaS company delivery

Five composite browser tests passed together: existing role/user flows, new company creation through UI, duplicate code/idempotency, company-admin invitation/password setup/login, denied platform APIs for company admins, denied cross-company user/role IDs, last-admin protection in a new company, existing identity with a second company, company chooser/switching, inactive company denial, stale version denial, and no session revival after reactivation. Temporary QA companies/identities were cleaned up; existing workspace users were preserved.

Migration 003 preserves existing rows and changes users to company memberships; 004 protects shared identity password resets; 005 indexes global identity/email lookup. Runtime has no direct grants to platform-admin or platform-audit tables. Platform operations use guarded, fixed-operation database functions; normal business APIs continue using tenant RLS.

Company creation, edit/status, onboarding retry and company selection are delivered. Subscription/billing, platform-admin management UI, MFA rollout and production SMTP deployment remain separate work. No crore-record throughput certification is claimed.

Invitation status now records the first successful company login/selection. Migration 006 backfills existing users from tenant-specific login audit evidence; invitation timestamps remain historical records. Users shows Onboarding complete after first login, hides the invitation action, and leaves password reset available. Platform onboarding shows the same completion timestamp. No per-row identity-service calls are added to listings.

## Retained plant/platform review delivery

The opt-in review-delivery browser test passed using real Keycloak invitations/logins and retained two demo companies, three plants, company-specific limited roles and two shared-login demo accounts. It verified platform open, UI plant creation and assignment, timezone/code validation, stale versions, cross-company access denial, direct plant-ID denial, immediate assignment revocation, plant inactive denial, different access per company and platform audit attribution. Private credentials and manual steps are in `.local/PLANT_REVIEW_GUIDE.md`; identifiers are in `.local/PLANT_REVIEW.json`. No retained demo records were deleted. Older disposable suites were not rerun during this retention request.

The rate-limit integration test passed: one session exhausting its API quota does not exhaust another session, anonymous API traffic cannot consume login quota, callback and login quotas are distinct, health is excluded, and an HTML 429 page includes retry guidance. Current limiter storage is process-local for the single API instance.

Migration 007 adds plant metadata/indexes, user-plant grants, platform audit actor and a guarded existing-identity lookup for delegated users. Platform requests recheck the platform grant and active company/version; company-local business reads remain scoped by tenant RLS. Plant endpoints and dashboard enforce assigned-plant visibility in SQL. Future business modules must call requirePlant; plant-level database RLS is not claimed.

Review cleanup completed on user request: removed the two manifest-listed demo companies, their three plants/company memberships/roles, two demo Keycloak identities and four captured invitation emails. Private demo credentials and review screenshots were removed. Actual companies and user records were compared before/after and preserved. Test source files remain. Cleanup receipt: `.local/REVIEW_CLEANUP_RECEIPT.json`.

## Local-only foundation closure

User confirmed local setup only; Availability and business masters were not started. Added Security screen, voluntary authenticator enrollment and recovery setup link, 12-hour absolute session cap, verified signed Keycloak backchannel logout with Redis revocation/replay handling, company-selector recovery and audit actor display. Existing real users' passwords and MFA settings were preserved.

Final regression: **7 browser tests passed, 1 retained-demo test intentionally skipped**. **3 unit/integration tests passed**, including independent rate-limit quotas. Production container build, strict TypeScript and repository formatting checks passed; npm audit reported zero known runtime vulnerabilities. Security test verifies OTP enrollment/login, forged logout rejection and Keycloak admin logout causing app 401. Recovery-code login is available for manual verification but not covered by this browser test. Test reauthentication was corrected to support Keycloak's password-only confirmation screen.

Local app + Keycloak backup/restore drill passed: restored counts matched (2 companies, 3 memberships, 2 roles, 7 migrations; 2 realms, 5 identities), restored tenant RLS held, isolated restore databases were removed. Private receipt is under `.local/backups/2026-09-14T11-58-55-641Z/restore-drill.json`. This is local database restore validation, not coordinated/offsite disaster recovery. Redis queue/session state is excluded.

Database isolation/write-denial/runtime privilege checks passed. 100,000-row audit fixture used an index (observed 0.054 ms query execution); rolled back. No crore-record/full-system performance claim.

Final containers running; seed/migrate exited 0. After regressions: 2 actual companies, 3 memberships, 2 roles; zero timestamped QA users and zero temporary restore databases. Removed 25 timestamped regression emails only; real recipients preserved. Test source files remain. Earlier retained-demo cleanup still applies.

Manual steps and limitations: [LOCAL_FOUNDATION_CHECK.md](LOCAL_FOUNDATION_CHECK.md). Production SMTP/VPS/domain, mandatory admin MFA, offsite backups and full-scale load testing remain outside the user-approved local scope.

## Permission editor and self-role protection — 15 September 2026

Module cards now separate Dashboard, Users, Roles, Plants and Audit log; reserved future permissions are hidden behind an explicit toggle. Search, selection count, view-only bulk selection, optional clearing and automatic required View selection are available. Existing permission codes/grants are unchanged; Manage remains a combined action permission. Roles Manage description now correctly describes custom role creation/edit/deletion.

Assigned roles are shown as View, and the API blocks own-role edits using the canonical database UUID. Existing own-user role/status changes, system-role protection, tenant checks and grant limits remain enforced. Browser regression verifies own-role read-only UI, uppercase UUID self-edit denial, role navigation hiding and direct role/catalog/create API denial after permission revocation.

Validation: full browser suite 7 passed, retained-demo test skipped; targeted access-management test rerun after final UUID guard change passed. Six unit/integration tests passed, including permission dependency selection and rate limiting. Container production builds, TypeScript, formatting and diff checks passed. Desktop/mobile screenshots inspected; mobile dialog has no horizontal overflow. Temporary test accounts cleaned by test teardown. Live VPS deployment has not been performed for this change.

Usage guide: [ROLE_PERMISSIONS_HINGLISH.md](ROLE_PERMISSIONS_HINGLISH.md).

## Branded authentication layout — 15 September 2026

Local-only custom Keycloak theme adds the RARE OS split layout to native login, MFA and required-action pages. Login button has an outgoing transition; identity forms have an entrance transition with reduced-motion support. Inputs, focus/error states, password visibility and submit buttons are restyled. Authentication still navigates to the identity origin; no direct password grant, iframe embedding or app-side credential handling was added.

Full browser suite: 8 passed, retained-demo test skipped. This includes real account invitation/password setup/login, authenticator enrollment and OTP login, identity logout revocation, invalid credentials, show/hide password, reset form, mobile overflow and reduced-motion checks. Production build and TypeScript checks passed. Theme files are mounted read-only and selected by the seeder; actual account passwords/MFA remain unchanged. No Git push or VPS deployment performed.

## Point 1 — Company admin email correction and invitation delivery — 15 September 2026

Local-only delivery: explicit invitation recipient and contact/login distinction; platform-only unused-admin email correction with stale-version, existing-identity, verified/credentialled-account and first-login guards. Correction detaches the old company identity association, increments auth version, resets invitation history, then provisions a fresh login without sending mail automatically. Old identities are retained and other-company memberships are untouched. Corrections and delivery outcomes include actor and recipient in the tenant audit. Migration 008 indexes the latest per-admin delivery lookup.

Company regression passed after final changes: contact edit preserves admin recipient; UI correction; existing target and stale edit rejection; old identity no longer resolves the company; email-verified identity correction rejected before first login; mismatched identity recipient blocked; real Mailpit SMTP outage records failure without success timestamp; restored SMTP resend captured at corrected recipient; cooldown; corrected account password setup and real login; company-admin API denial; activated-account correction denial; existing company isolation/switching/status checks. Local Mailpit restart polling tolerates transient socket resets. Separate access-management regression passed (roles/users/invitations/activation/access changes). Production image builds and TypeScript checks passed; formatting and diff checks passed. Seed/migration exited 0.

Disposable test company/identity fixtures cleaned by test teardown; actual companies/users preserved. Test source retained. Manual review: EMAIL_SETUP_REVIEW_HINGLISH.md. Microsoft 365 real mailbox delivery and live VPS verification remain pending deployment; no Git push or live changes. Point 2 has not started.

## Existing-email multi-company review — 15 September 2026

Company creation returns explicit shared-login status and existing-password guidance; Admin setup displays separate company role/plant scope, fresh-sign-in requirement and global password-reset effect. Shared logins do not show the unused-account correction form. Platform user creation reports when an existing identity was linked. No actual account email/password/membership was changed by this delivery.

Local Docker build/TypeScript passed. Three browser regressions passed: access management; company onboarding/correction/SMTP failure and resend plus existing-password login/company selection/isolation; rejected-login recovery. Shared-company creation message/status assertions were added. Test fixture teardown preserves real users. Manual instructions added to EMAIL_SETUP_REVIEW_HINGLISH.md. No Git push/live deployment; real SMTP is still deferred.

## Point 3 — Separate action permissions and matrix editor — 15 September 2026

Local Docker delivery replaces combined Users/Roles/Plants Manage grants with separate actions. Migration 009 preserves existing access, retires legacy codes and increments migrated role versions. Shared dependency definitions drive both editor selection and API validation. Role Create/Edit/Delete are independent; user role/status/invitation/reset/retry/plant assignment have separate checks. Plant editing respects assigned scope; all-plant visibility is explicit. Own-role, protected-role, grant-limit and tenant protections remain.

Validation: 11 unit tests passed; TypeScript, Docker production build, formatting and diff checks passed. Full browser suite: 11 passed, 1 retained-demo test skipped. New regression tests cover legacy grant conversion without expanded plant assignment, independent role actions, sensitive user-action denials and assigned-plant enforcement. Desktop matrix screenshot inspected; responsive dialog test passed. Database checks passed for seed preservation, tenant isolation, cross-tenant writes and runtime privileges. A 100,000-row audit fixture used an index (observed 0.038 ms); this is not a full-system or crore-record load test.

Backup taken before local migration at .local/backups/2026-09-15T12-04-13-112Z. Seed/migrate exited 0; local API healthy. Disposable regression fixtures cleaned; real accounts retained. Manual review steps: ROLE_PERMISSIONS_HINGLISH.md. No Git push or VPS deployment for Point 3. After migration 009, rollback to legacy permission code requires compatibility review.

## CI fresh-database failure — 15 September 2026

Investigated supplied Foundation checks #5 logs for a7ff6e1. Reproduced the same five failing test cases in a separate Docker project using that commit and fresh volumes (only local ports/project name changed; temporary failure diagnostics added). Migration 003 runs before seeding on a clean install, so the old tenant insert received a random company code. The company test expected RARE during switching; later logins reached company selection instead of the expected dashboard.

Seeder now supplies the default RARE code explicitly and repairs an existing default tenant's eight-character generated code when RARE is free. Company regression checks this seed contract before creating shared memberships. Browser actions have a 15-second bound so missing controls fail before the full test timeout. CI retains failure screenshots/context as a seven-day artifact.

Verification with the corrected working tree, including Point 3, on new isolated Docker volumes: production build passed; 11 browser tests passed, one retained-demo test skipped; database checks passed; backup restore verified for both application and identity databases including row counts and RLS. Formatting, TypeScript, 11 unit tests and diff checks passed. The normal local stack and real accounts were not modified for reproduction. No push or live deployment performed; a new GitHub run after pushing remains to be verified.

## VPS rollback-image capture repair — 15 September 2026

GitHub run 34972235927: verify succeeded; Deploy Hostinger VPS failed after build with `No such image` while tagging a running container's previous image ID. The failure log shows checkout restoration to a7ff6e1; service stop/backup/migration had not been reached. Move running-image capture before checkout/build. If an old image-store reference is already missing, record it as unavailable and explain that application rollback requires rebuilding the reviewed prior commit; never tag the newly built service image as the old image. Database backup remains mandatory before apply. Other tagging errors still fail before downtime.

Six deployment lifecycle tests pass, covering ordering, stale/dirty/invalid inputs, missing image, failed tag, failed build, backup restoration and migration/health failures. Shell syntax and diff checks pass. These are isolated command-mock tests; installed VPS script update and a successful real deployment remain required. Direct SSH from this workstation was denied; provide exact script-install commands to the user rather than claiming the VPS was patched.

## Migration EACCES deployment repair — 15 September 2026

VPS migration log reports EACCES opening migration 009; database and Redis are healthy while app services remain stopped/Created after failed apply. Deployment's umask 077 makes newly checked-out source root-only, and Docker COPY retained these modes while runtime runs as node. Checkout now uses scoped umask 022 (including checkout recovery); tracked-source normalization also repairs existing restrictive modes and the bind-mounted login theme without altering private untracked configuration. Docker build normalizes read/traverse permissions inside /app. A runtime preflight reads all migrations and entry points without database access before downtime.

Validation: 15 unit/lifecycle tests passed, including real filesystem mode/idempotence checks and preservation of private .env/backup modes. Built a separate actual Docker image from source files set to 0600 and directories set to 0700; running check-runtime.mjs explicitly as node passed for all migrations and runtime entry points. Application production build passed. Shell syntax and formatting/diff checks passed. This repairs packaging and deployment; production recovery still requires installing the updated deploy command and rebuilding the VPS images. No database reset/restore/downgrade was performed.
