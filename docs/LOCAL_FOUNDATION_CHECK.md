# Local foundation cross-check — 14 September 2026

Scope: user ke kehne par sirf local Docker foundation. Availability aur business masters start nahi kiye; real SMTP aur Hostinger deployment is delivery mein nahi hain.

## Ab local par kya ready hai

- Company onboarding, invitations/password setup, company switching aur platform se explicit company access.
- Company-wise roles/users, seeded permission catalog, plants aur per-user plant assignment.
- Tenant isolation, permission checks, stale-edit rejection aur inactive user/company/plant access denial.
- Onboarding complete hone par correct status; audit screen mein actor attribution.
- Login/API ke separate rate limits aur outage/retry messages.
- Security screen: authenticator enrollment status, setup aur recovery-code setup links.
- 30-minute idle session aur 12-hour maximum session. Signed Keycloak logout notification linked app sessions revoke karti hai; forged notification reject hoti hai.
- Application aur identity database ke private local backups aur isolated restore verification.

## Verification

- Unit/integration: permission catalog aur independent rate-limit budgets verified.
- Browser: roles/users, invitation/password setup, company isolation/switching/status, login/logout, live permissions, responsive layout aur gateway retry coverage.
- Security browser test: temporary account par authenticator enrollment, real OTP login, forged logout rejection aur Keycloak admin logout ke baad application 401 verified. Recovery-code login ka automated test abhi included nahi hai.
- Database: tenant read/write isolation aur runtime privilege checks pass. 100,000 temporary audit rows par indexed lookup verified; fixtures rolled back. Yeh crore-record throughput certification nahi hai.
- Backup: both databases restored into separate temporary databases; company/user/role/migration and realm/identity counts matched. Restored application RLS checked. Temporary restore databases removed; live databases untouched.
- Build/type checks aur dependency audit validation recorded in VALIDATION.md.

## Aap kaise check karein

1. http://localhost:4310 par fresh sign-in karein. Purane sessions security upgrade ke baad fresh login maang sakte hain.
2. Companies se company open karein; Users, Roles & permissions, Plants aur Audit log check karein.
3. Security mein apne account ka authenticator status dekhein. Apne phone se enrollment aap khud karein; kisi actual user ka password/MFA automatically change nahi hua.
4. Local invitation/reset emails http://localhost:4312 mein milenge.
5. Project directory se `npm run backup:verify` chalayein. Private backup aur restore receipt `.local/backups/<timestamp>/` mein milenge.

Reviewed demo data already removed tha. Regression tests apne temporary company/user/role fixtures clean karte hain; actual company records preserve hote hain. Test source files future verification ke liye retained hain.

Production ke liye separate SMTP/domain/VPS, mandatory admin MFA, offsite disaster recovery aur realistic load testing abhi baaki hai. Availability ka kaam next explicit instruction ke baad hi start hoga.
