# Current handoff — 16 September 2026 (evening, Claude Code)

Point 5 operations (ops image, offsite restic backups, restore drill, monitor, alerts, systemd timers) and Point 4 rollback (`scripts/deploy/rollback.sh` + full local rehearsal) are implemented and verified locally; worker healthcheck defect fixed. Final regression `mu45c9k8-c28461ab` PASSED. Details: docs/VALIDATION.md (last section), runbook docs/OPERATIONS_HINGLISH.md. Still no commit/push/live deployment.

Before push: reinstall `/usr/local/sbin/rare-os-deploy` on the VPS (script changed). No mandatory .env change for deploy (new variables have defaults). After deploy: admins must enroll MFA; this release's rollback must use backup restore. Then VPS Point 5 setup: R2 bucket/keys + BACKUP*\*/ALERT_EMAIL_TO/MONITOR*\* in .env, install rare-os-ops/rare-os-rollback/timers, run init/test-alert/backup/restore-drill/monitor. Availability only after live acceptance and the user's instruction.

---

# Current handoff — 16 September 2026

## VAPT update — 16 September 2026

User requested permanent vulnerability checks plus a VAPT-oriented review of current code. Local work only; nothing committed, pushed or deployed. Added npm advisory gate, source/secret/IaC tests, pinned Trivy source and built-image CI gates, an optional full platform image scan, HTTP attack-surface regression and dated review in `docs/VAPT_REVIEW_2026-09-16.md`.

Fresh results: npm 0 advisories; Trivy source/lockfiles/secrets/IaC 0 HIGH/CRITICAL; rebuilt API, web, Postgres, Mailpit and Redis images 0 HIGH/CRITICAL. API is patched Alpine without npm; web is patched Alpine Nginx/non-root; Postgres is non-root with vulnerable unused gosu removed; Caddy 2.11.4 is pinned/non-root/internal 8080/8443; Keycloak Netty CRITICAL patched to checksum-verified 4.1.137 while preserving indexed filename. Body parsers limit JSON/forms to 64 KiB and safely retain malformed 400 / oversized 413 status.

Full final isolated regression `mu437uf9-f4ec2f5f` PASSED: 23 unit/security, 14/14 browser/API (9.6m), DB tenant isolation/runtime grants/indexed 100k audit, application+identity restore/RLS and scoped cleanup. First run exposed that parser 413 was converted to 503; implementation fixed and full rerun passed. Normal local stack was not restarted or mutated.

Remaining visible upstream scan findings: official latest Caddy 2.11.4 binary has 17 HIGH Go dependency findings; Keycloak image has 2 HIGH (UBI JDK no vendor fix, plus Trivy flags bundled MSSQL artifact even though filename is the fixed `13.2.1.jre11` line and RARE OS uses PostgreSQL). CRITICAL count is now zero. `npm run security:platform` intentionally returns non-zero until upstream releases resolve/review these; no ignore/suppression was added. External live DAST/TLS/network/manual business-logic VAPT remains release acceptance work.

## Current task

Latest request: while user manually tests Point2, add proper automated regression coverage for implemented features and a repeatable workflow for future changes. Implementation is local only; no commit/push/live deployment. Do not proceed to another foundation point or Availability. Do not interrupt/recreate the normal `rare-os` stack or modify real accounts.

Regression implementation: `npm run test:regression` (also `test:e2e`) runs format/types/unit/build, snapshots current source without real .env/overrides, creates a fresh unique Docker project with random ports/generated credentials/private volumes/Mailpit, repeats seed, runs browser/API suites, DB privilege/RLS/index checks and app+identity restore verification, exports reports, then cleans only its own project and exact image tags. Direct Playwright on the real workspace is blocked by config-level marker/context/URL validation. Shared test environment removes hardcoded ports. Former retained-review plant test is now always-run `tests/plants.spec.ts` with fresh fixtures, expanded UI edit/search/pagination checks. Added sticky-header real-page-scroll regression. CI verify uses same runner and uploads explicit report allowlist (including hidden .local parent). Deployment job unchanged. Future-testing policy saved in AGENTS.md and coverage/commands in docs/REGRESSION_TESTING_HINGLISH.md.

Verification COMPLETE: final run `mu403rii-0a014c3b` passed end-to-end: 19 unit/safety tests, 14 browser scenarios (zero skipped, 9.3min), application types/build/format, repeat seed, DB privileges/RLS/indexed100k audit, app+identity restore with matching counts and RLS, and scoped cleanup. HTML/JUnit/JSON/screenshot/restore receipts retained under `.local/regression/mu403rii-0a014c3b/`; workspace, test credentials/dumps, containers/volumes/image tags removed. Prior full run exposed a readiness race in the new header test; fixed by waiting for the actual catalog before scrolling, then desktop/mobile scroll checks passed. Earlier disposable services stopped mid-run; failure reporting/cleanup worked. Cleanup helper also passed an actual stopped-container/volume/image-tag exercise with normal API image preserved. No normal-stack recreation or real-account mutation was performed. Future functional work must add/update relevant tests and use the safe regression command, per AGENTS.md. No push/live rollout.

Point2 mandatory administrator MFA and recovery login was already implemented, verified and deployed to LOCAL Docker in the previous turn. User monitors GitHub Actions themselves.

Actual repo `/Users/apple/Developer/rare-os/RARE_OS_Handover_03Sep2026/rare-os`; Downloads cwd is stale/nonexistent. Use explicit workdir and shell `/bin/bash`, login:false for tools. Repo outside writable roots requires escalated writes. Never print .env, authentication tokens, OTP secrets or recovery codes.

## Delivered

- Earlier MFA work: verified reset email offers Keep (existing OTP required) or Replace (explicit warning + verified new device before deleting selected old entry). Others remain. New admin reset emails use same choice. Native password/OTP processing remains in Keycloak.
- Security lists own authenticators; add multiple/remove one. Off removes OTP/recovery credentials and revokes other sessions; now allowed only for non-admins. Management requires fresh authentication.
- Point2: platform admins, active company system/Main Admin roles and delegated users/roles administrative permission holders require MFA. Any active company grant applies to entire login.
- Migration010 `identity_requires_mfa(subject)` is SECURITY DEFINER with fixed search path and EXECUTE grants only to rare_app/rare_keycloak. Identity DB role has no SELECT access to application business tables. Keycloak uses existing credentials and explicit RARE_POLICY_DB_URL; unavailable policy fails closed.
- RARE_ADMIN_MFA required action forces native OTP enrollment before workspace entry if missing. Custom native OTP/recovery wrappers mark successful verification; signed ID-token session-note mapper carries boolean rare_mfa_verified. API callback and protected API requests enforce proof; API also checks OTP still exists. Old password-only sessions are denied immediately upon admin promotion, including another company.
- Admin off hidden in Security and disabled in identity form; forged POST still denied. Last admin device cannot be removed. Normal users retain optional off flow.
- Recovery login succeeds once; same consumed code rejected. User chooses Try another way → Recovery Authentication Code and enters requested numbered code.

## Verified

Fresh isolated stack: 13 browser tests PASS, 1 optional retained-demo skipped, 9.1min. Final targeted admin test after UX/forged-form assertions PASS (2min). Covers enrollment/invalid OTP/pre-enrollment API denial, cross-company promotion, server disable/last-device denial, recovery login/reuse denial, active platform/delegated policy, normal-user off, narrow DB privileges. Existing company/role/permission/invitation/login-recovery and Keep/Replace tests pass.

15 unit/deployment tests PASS; TypeScript/build/format/diff checks PASS. DB tenant isolation/runtime privileges/indexed100k audit PASS. Application+identity isolated restore matched counts/RLS; temporary restore DBs removed. Backup `.local/backups/2026-09-16T10-16-53-637Z` (before-change backup09-51-57 too). Repeat seed fixed mapper representation ID, then two consecutive seeds PASS. Actual users' passwords/devices not auto-enrolled or changed. Local api/db/redis healthy and services running.

UI reviewed `.local/admin-mfa-security.png`; mandatory message and off-link absence verified even while selected company role is Reader and another company grants admin. Temporary `rare-point2-qa` Docker containers and volumes removed. Full suite used ports4410/11/12 and fresh generated credentials in `/tmp/rare-point2-qa`, preserving normal localhost4310 accounts. Test helper `tests/helpers/mfa.ts` requires RARE_E2E_DISPOSABLE_STACK=true before enrolling test accounts, keeps private fixtures under ignored .local. CI sets flag and repeats seed. Never run full enrollment suite on real local accounts; targeted admin-mfa test creates/cleans its own disposable identities.

## Implementation notes

Provider jar builds against pinned Keycloak26.7.3 with Java21 in infra/keycloak/Dockerfile. Native UpdatePassword.create() returns a BASE instance; custom ResetPassword overrides create() to retain implementation. Manage/Disable enforce getMaxAuthAge=0. Adapted login-config-totp.ftl preserves RARE_REPLACE_OTP and RARE_ADMIN_MFA on QR/manual links (native URL hardcodes CONFIGURE_TOTP). Browser copy rare-browser-mfa-v1 retains native conditional second-factor execution; thin wrappers preserve native brute-force/recovery consumption. Reset copy rare-reset-credentials-v1 requires email before MFA choice and omits native reset-otp automatic duplicate enrollment.

Seeder mapper UPDATE must include the existing ID in both URL and JSON. This was found by repeat-seed verification and fixed. Auth browser tests wait for UI navigation completion before API probes to avoid cookie races. Recovery input name is recoveryCodeInput, displayed list includes a numbered prefix that tests strip.

## Next scope (only on user instruction)

Original five points: Point1 local invitation/contact-vs-login/reset flow done; live SMTP reset receipt/login confirmed, corrected-recipient invitation acceptance still needs live confirmation. Point2 now local complete. Point3 action permission matrix delivered/tested. Point4 earlier automatic deployment succeeded; NEW custom identity image/config-compatible rollback and deployment rehearsal remains. Point5 automated encrypted offsite backup/retention/monitoring/alerts and production restore remains. User wants remaining local work before combined server deployment.

Last pushed revision remains ddc668ad2c7a6e53c489a1429adc10b4e58e405f. VPS187.127.186.131 /var/www/rare-os, rare.greymetre.io and auth.rare.greymetre.io. Preserve .env/compose.override.yaml. Migration before custom Keycloak startup; seed after provider loaded. Check production override does not pin stock identity image and includes policy DB URL. Realm references custom providers: rollback needs matching provider image/config or reviewed identity DB restore, never blind DB downgrade. Root-owned deploy script `/usr/local/sbin/rare-os-deploy` is installed snapshot, not replaced by git pull. No Point4 deploy-script changes were made in this task.

Manual guide: docs/MFA_RESET_HINGLISH.md; architecture: infra/keycloak/README.md; evidence: docs/VALIDATION.md.
