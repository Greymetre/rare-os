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
