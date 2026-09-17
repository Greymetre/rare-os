# Regression testing — RARE OS

Har feature/change ke baad ye checks purane working flows ko dobara verify karte hain. Ye existing implemented scope cover karte hain; Availability business logic abhi implement nahi hai. Automated pass ko live email delivery, production rollout ya offsite backup approval na samjhein.

## Full regression: ek command

Project folder mein Node 24, installed dependencies, local Docker aur Google Chrome chahiye. Fresh machine par:

```bash
npm ci
npx playwright install --with-deps chrome
```

Uske baad har important change ke liye:

```bash
npm run test:regression
```

`npm run test:e2e` bhi same safe full command chalata hai. Direct `npx playwright test` normal project par intentionally refuse karega: browser tests account setup, permissions, SMTP outages aur MFA credentials modify karte hain.

Runner current source ka snapshot leta hai, including uncommitted changes. Normal `.env`, Compose overrides, `.local` data aur existing databases copy/use nahi hote. Har run ka apna `rare-regression-…` Docker project, random local ports, generated passwords, Mailpit inbox, database volumes aur identity image hoti hai. `localhost:4310` wala manual-testing stack running rehta hai. Isolated stack ke emails Mailpit mein hi rehte hain; real SMTP use nahi hota.

Run order:

1. Formatting, application TypeScript, unit tests aur production build.
2. Fresh Docker build/start; migrations aur seed; seed dobara run karke idempotence.
3. Real Chromium + Keycloak browser/API suite, including plant management.
4. PostgreSQL tenant isolation, denied cross-company writes, runtime privileges aur indexed audit query.
5. Application + identity backup, temporary databases mein actual restore, matching counts aur RLS verification.
6. Offsite encrypted backup, retention, restore drill, monitoring aur alert emails (local S3-compatible server + Mailpit).
7. Sirf current test project's containers/volumes/images cleanup; temporary source, passwords, OTP fixtures aur dumps removal.

Koi stage fail ho to command non-zero exit deti hai. Cleanup failure bhi failed result hai; terminal exact project-specific cleanup command deta hai. Us situation mein private temporary workspace retry ke liye preserved hota hai. Abrupt machine shutdown/forced kill ke baad `docker compose ls` se `rare-regression-…` project identify karein; normal `rare-os` stack ko down/reset na karein.

## Fast checks

```bash
npm run verify:quick
```

Ye format, types, unit tests, `npm audit` dependency vulnerability gate aur production build chalata hai. Docker/browser/DB checks ismein nahi hain; auth, API, permissions, schema, email, deployment ya substantial UI changes ke baad full regression bhi run karein.

## Results kahan milenge

Terminal final report folder deta hai:

```text
.local/regression/<run-id>/summary.json
.local/regression/<run-id>/playwright-report/index.html
.local/regression/<run-id>/test-results/results.xml
.local/regression/<run-id>/test-results/results.json
.local/regression/<run-id>/screenshots/
.local/regression/<run-id>/restore-verification/
```

HTML report kholne ke liye actual run-id use karein:

```bash
npx playwright show-report .local/regression/<run-id>/playwright-report
```

`summary.json` overall result, har stage aur cleanup status deta hai. HTML mein test name, failed assertion aur failure screenshot milenge. Successful screenshots selected UI flows ke hain; traces off hain. JUnit/JSON CI integrations ke liye hain. `.env`, test OTP fixture files aur database dumps report upload mein include nahi hote. Screenshots/reports mein disposable test account information ho sakti hai.

GitHub verify job bhi isi full runner ko use karta hai; reports success/failure dono par `regression-results` artifact mein 7 days rakhe jaate hain. Verify fail ho to dependent deploy job aage nahi chalega. Workflow changes next authorized push ke baad GitHub par apply honge.

## Security / VAPT checks

```bash
npm run security:check
```

Ye command complete npm dependency tree ko LOW ya usse upar published advisory par fail karti hai aur permanent source/config security tests chalati hai. `npm test`, `verify:quick` aur CI mein ye invariants cover hain: high-confidence committed secrets, dynamic code execution/unsafe HTML, SQL RLS + narrow `SECURITY DEFINER` grants, non-root/health-checked images, no-new-privileges, private service ports, CSP/clickjacking/browser headers, bounded request bodies, CSRF/origin rejection, canonical-host redirect, malformed payload handling aur stack-trace leakage.

GitHub CI pinned Trivy `0.74.0` se source lockfiles, secrets aur Docker/IaC misconfiguration ko HIGH/CRITICAL finding par block karti hai. Deployment aur disposable regression base/runtime images ko fresh pull karte hain, taaki stale vulnerable base layers silently reuse na hon. Local built application images ke liye `npm run security:containers` chalayein. Puri runtime supply chain ke liye `npm run security:platform` chalayein; ye har image check karke kisi bhi HIGH/CRITICAL finding par non-zero return karti hai. Current dated findings aur remediation record `docs/VAPT_REVIEW_2026-09-16.md` mein hai. Local reports ignored `.local/vapt/` mein rakhein; report ya vulnerability ignore ko commit karke check bypass na karein.

Automated scan complete VAPT certificate nahi hai. Authenticated business-logic penetration test, live TLS/DNS configuration, external network exposure aur upstream image advisories ko release ke time separately review karna zaroori hai. Unfixed upstream finding ko suppress karke clean result report nahi karna.

## Implemented feature coverage

| Feature                            | Automated checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Main test files                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Login, logout, session and gateway | Real Keycloak login, CSRF/callback rejection, cookie attributes, inactive user denial, sign-out, outage/retry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `foundation.spec.ts`, `login-recovery.spec.ts`, `security.spec.ts`                                |
| Company onboarding                 | Create/edit, idempotence, contact vs invitation recipient, email correction restrictions, shared identity, switching and isolation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `companies.spec.ts`                                                                               |
| Invitation/email status            | Correct Mailpit recipient, password setup, resend/cooldown, SMTP outage/failure handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `access-management.spec.ts`, `companies.spec.ts`, `plants.spec.ts`                                |
| Users and roles                    | Create/edit, protected/assigned roles, stale writes, activation, privilege escalation rejection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `access-management.spec.ts`, `action-permissions.spec.ts`                                         |
| Action-level permissions           | Separate create/edit/delete/sensitive actions, UI and direct API denial, legacy migration, dependencies and bulk selection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `action-permissions.spec.ts`, `permission-selection.test.mjs`                                     |
| Plants and scoped access           | UI create/edit/search, duplicate code, invalid timezone, pagination, assignments, stale updates, inactive/revoked access, cross-company denial, shared-login roles                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `plants.spec.ts`, `action-permissions.spec.ts`                                                    |
| Admin MFA                          | Mandatory enrollment, platform/company/delegated admin policy, promotion in another company, denied old session, no admin disable/last-device removal, recovery login and consumed-code reuse denial                                                                                                                                                                                                                                                                                                                                                                                                                       | `admin-mfa.spec.ts`                                                                               |
| MFA/password reset                 | Keep existing OTP, verified replacement and warning, invalid code, setup failure preserves old device, reset link replay, multiple devices, fresh authentication, normal-user disable and session revocation                                                                                                                                                                                                                                                                                                                                                                                                               | `mfa-management.spec.ts`, `security.spec.ts`                                                      |
| Responsive UI                      | Login/reset/password visibility, mobile overflow, role picker, plant views, sticky header during actual page scrolling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `login-theme.spec.ts`, `foundation.spec.ts`, `access-management.spec.ts`, `plants.spec.ts`        |
| Database and audit                 | RLS, cross-tenant write denial, runtime grants, audit events, 100k-row indexed query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `scripts/test-db.mjs`, company/access/plant/MFA suites                                            |
| Backup/restore                     | Both application and identity archives, checksum validation, restored row counts, restored RLS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `backup-local.mjs`, `restore-drill.mjs`                                                           |
| Availability foundation (AV-0)     | Readiness checklist, units create/edit/duplicate/stale, CSV template, upload rejections (header, content type, 5 MB), staged validation with in-file duplicates and error file (formula-safe), commit refused with errors, preview counts, commit, same-file rejection, unchanged re-import, duplicate commit event, 10,000-row import, cross-company batch denial, role dependency, read-only masters user (UI + API), DB RLS/grants/number series, repeat-safe demo seeder                                                                                                                                               | `availability-foundation.spec.ts`, `imports.test.mjs`, `quantity.test.mjs`, `scripts/test-db.mjs` |
| Item masters (AV-1)                | Items/suppliers/customers/item sourcing/unit conversions via UI and API, field-level errors, missing/inactive references, MAKE-item sourcing refusal, purchase-unit conversion requirement, unit-decimal MOQ checks, one-direction conversions, preferred supplier switching, immutable codes, stale edits, used-unit deactivation guard, imports with reference/duplicate/preferred errors, commit refused after a referenced supplier is deactivated, 10,000 items, code-order paging and cursor validation, cross-company denial, purchase-only role (UI + API), DB FK/uniqueness/no-delete rules, extended demo seeder | `availability-masters.spec.ts`, `masters.test.mjs`, `imports.test.mjs`, `scripts/test-db.mjs`     |
| Offsite backup and monitoring      | Real encrypted restic backup to S3-compatible target, retention pruning, wrong-password rejection, restore drill (checksums, RLS, identity realm), real container health, alert/reminder/recovery email, stale backup, missing host facts, redacted failed-backup alert                                                                                                                                                                                                                                                                                                                                                    | `ops.test.mjs`, `scripts/ops/ops-integration.mjs`                                                 |
| Rollback script                    | Consent/input checks, missing images, incompatible schema or identity provider refusal before downtime, checksum failure, safety backup, rename-not-drop restore ordering, failure record                                                                                                                                                                                                                                                                                                                                                                                                                                  | `rollback.test.mjs`                                                                               |
| Existing deploy script             | Stage ordering, unsafe/stale input, missing images, build/backup/migration/health/preflight failures, private file permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `deploy.test.mjs`, `source-permissions.test.mjs`                                                  |
| Runner safety and limits           | Reject real/live targets and wrong Compose context; independent API/session/login rate limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `regression-safety.test.mjs`, `rate-limits.test.mjs`                                              |

Plant coverage ab default suite mein run hoti hai; purana opt-in retained-review test fresh disposable fixtures wala `plants.spec.ts` ban gaya hai. Kisi feature ko silently skip karke regression pass na maan lein.

## Future changes ka process

- Behavior-changing feature ke saath meaningful happy-path aur failure/permission regression add karein. Bug fix ka test original failure reproduce kare aur fix ke baad pass ho.
- Tenant/user/role changes ke liye unauthorized direct API request aur cross-company access bhi assert karein. UI button hide hona akela authorization test nahi hai.
- Auth/MFA changes ke liye actual identity flow test karein; assertion hata kar ya security guard bypass karke suite green na karein.
- Test accounts `example.test` domain aur generated IDs use karein; real account credentials/devices use na karein. Shared stack state badalne par `finally` mein restore karein.
- Fast checks aur applicable full regression result record karein. Skipped/failed/unverified scope clearly likhein. `.only` committed tests config reject karta hai.
- Cosmetic/reversible low-impact edits ke liye brittle implementation-mirroring tests add karne ki zarurat nahi; existing relevant UI checks enough ho sakte hain.

External acceptance alag rahegi: actual mailbox/spam delivery, production TLS/proxy, VPS-specific deployment/rollback, off-server backup retention/alerts aur production restore drill. Local regression in sabko automatically complete certify nahi karti.
