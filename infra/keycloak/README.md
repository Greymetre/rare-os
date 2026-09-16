# RARE OS identity flows and login theme

The `rare-os` theme inherits Keycloak's native login forms. `template.ftl` is adapted from the Keycloak **26.7.3** base template (Apache-2.0); native form sections, session scripts, errors, password visibility, alternate authenticators and required actions remain intact. Review the upstream template when upgrading Keycloak.

Source: https://github.com/keycloak/keycloak/blob/26.7.3/themes/src/main/resources/theme/base/login/template.ftl
Theme documentation: https://www.keycloak.org/ui-customization/themes

Compose mounts this directory's `themes/rare-os` read-only, and the repeat-safe seeder sets `loginTheme` on the application realm only. The master realm and existing credentials are preserved. The seeder registers RARE required actions and binds the application realm to its verified-email reset flow. Theme resources are cached normally; recreate the Keycloak container when changing cached resources during local development.

The app's sign-in link fades the right panel out; Keycloak renders the same split layout with the real login form and a short entrance animation. OTP, recovery, reset and verification pages inherit that shell. Navigation still uses the authentication origin (`localhost:4311` locally, the auth domain when hosted). This is a consistent visual layout, not an embedded iframe or a password form handled by the React app. OIDC code + PKCE and existing security headers remain unchanged.

Motion is disabled for `prefers-reduced-motion`. Browser tests cover desktop/mobile layout, invalid login, password visibility, reset page, real invitation/password setup, OTP enrollment/login and logout revocation. No push or hosted deployment is part of this local delivery.

## MFA reset and device management

Compose builds `infra/keycloak/Dockerfile`: a Java 21 build stage compiles the small provider against the pinned Keycloak 26.7.3 libraries; the runtime contains only the provider jar and optimized Keycloak distribution. Build the identity image before running the seed. Review/test these internal SPI extensions before any Keycloak version upgrade.

- `rare-reset-mfa` is a REQUIRED execution after REQUIRED reset email verification. Existing OTP verification uses the native credential validator and brute-force controls; replacement is authorized by the verified recovery email and explicit confirmation.
- `RARE_RESET_PASSWORD` supplies the same choice for new administrator-issued reset emails. Password validation/update remains native. Invitations without MFA retain their original onboarding actions.
- `RARE_REPLACE_OTP` records the selected owned credential in the server authentication session. Native OTP enrollment must succeed before the old credential is removed in the same transaction. Other authenticators remain. This action cannot be requested as a standalone application-initiated action.
- `RARE_MANAGE_MFA` and `RARE_DISABLE_MFA` require fresh authentication and confirmation. Removing the last device requires the explicit disable action. Disabling removes OTP and recovery credentials; changed-device sessions are revoked. Device IDs are checked against the authenticated user.
- App security actions request `prompt=login` and `max_age=0`; the management provider also enforces max auth age zero at the identity service. Passwords and OTP secrets never go through the application API.

The adapted `login-config-totp.ftl` preserves the custom replacement execution when switching between QR and manual setup. Native Keycloak hardcodes CONFIGURE_TOTP in the manual-mode URL; without this adaptation a replacement could leave its intended flow.

Source references: [native OTP validation](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/authenticators/browser/OTPFormAuthenticator.java), [OTP enrollment](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/requiredactions/UpdateTotp.java), [required-action freshness](https://github.com/keycloak/keycloak/blob/26.7.3/server-spi-private/src/main/java/org/keycloak/authentication/RequiredActionProvider.java).

See `docs/MFA_RESET_HINGLISH.md` for user behavior and manual tests. Existing issued email links retain their original action; use newly requested links to test the updated admin reset. No actual user devices are silently removed during seed/deployment.

Rollback must account for identity configuration as well as application images: once the realm references these providers, keep the matching provider image, or restore reviewed identity configuration/database from the corresponding backup during maintenance. An image-only rollback to stock Keycloak cannot execute the custom actions. Do not automatically downgrade the database.

## Mandatory administrator MFA (Point 2)

Migration010 exposes only `identity_requires_mfa(subject)` to rare_keycloak and rare_app. It reads authoritative active platform/company/access-administrator grants across companies; user-editable identity attributes are not trusted. Keycloak connects to `RARE_POLICY_DB_URL` with its existing database role, which has no SELECT grants on application business tables. Missing/unavailable policy fails closed.

`RARE_ADMIN_MFA` evaluates enrollment on every authorization. The copied native browser flow uses thin OTP/recovery validators that record successful native second-factor validation in a server session note. An ID-token-only mapper signs that proof; API callback and every protected request require it for administrators. The API also checks that an OTP credential still exists, so external credential removal cannot preserve admin workspace access. Older password-only sessions must sign in again. Normal users retain optional MFA. Protected device removal/disable rechecks policy at submission.

Existing MFA devices/passwords are preserved, and shared-account policy applies across active companies. Administrators cannot disable MFA; last-device removal is blocked. Native recovery authentication consumes the code; replay is rejected. Required enrollment supports QR/manual navigation in the theme. Configure this policy DB URL when rolling out the custom identity image; migrate before Keycloak and seed after Keycloak.
