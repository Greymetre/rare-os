# RARE OS development checks

- Preserve existing user data and local manual-testing sessions. Browser/API fixtures must run through `npm run test:regression`, which creates its own disposable Docker stack. Do not run fixture SQL, MFA enrollment, SMTP-outage tests or cleanup against the normal `rare-os` project or production.
- For behavior-changing features and bug fixes, add or update meaningful regression tests alongside the change. Cover successful behavior and relevant rejection cases. Permissions, user/company membership and tenant-scoped data need direct API denial/isolation checks as well as UI checks.
- Use `npm run verify:quick` for formatting, application types, unit tests and builds. Run `npm run test:regression` for functional changes to authentication/MFA, APIs, permissions, database, email flows, deployment packaging or substantial UI behavior. Small cosmetic changes can use the relevant existing checks; avoid tests that only mirror implementation.
- Fix the cause of failures. Do not weaken authorization, silently skip coverage, or remove useful assertions to obtain a passing run. Report what actually passed and any unverified scope; local tests do not certify live SMTP delivery, production rollback or offsite operations.
- Keep reports and test secrets out of Git. Update the coverage guide when adding a module or changing the verification workflow: `docs/REGRESSION_TESTING_HINGLISH.md`.
- Check `SESSION_HANDOFF.md` for the current task and deployment status. Respect the user's current push/deployment instructions.
