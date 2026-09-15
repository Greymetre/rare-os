# RARE OS login theme

The `rare-os` theme inherits Keycloak's native login forms. `template.ftl` is adapted from the Keycloak **26.7.3** base template (Apache-2.0); native form sections, session scripts, errors, password visibility, alternate authenticators and required actions remain intact. Review the upstream template when upgrading Keycloak.

Source: https://github.com/keycloak/keycloak/blob/26.7.3/themes/src/main/resources/theme/base/login/template.ftl
Theme documentation: https://www.keycloak.org/ui-customization/themes

Compose mounts this directory's `themes/rare-os` read-only, and the repeat-safe seeder sets `loginTheme` on the application realm only. Credentials, MFA settings and the master realm are not changed. Theme resources are cached normally; recreate the Keycloak container when changing cached resources during local development.

The app's sign-in link fades the right panel out; Keycloak renders the same split layout with the real login form and a short entrance animation. OTP, recovery, reset and verification pages inherit that shell. Navigation still uses the authentication origin (`localhost:4311` locally, the auth domain when hosted). This is a consistent visual layout, not an embedded iframe or a password form handled by the React app. OIDC code + PKCE and existing security headers remain unchanged.

Motion is disabled for `prefers-reduced-motion`. Browser tests cover desktop/mobile layout, invalid login, password visibility, reset page, real invitation/password setup, OTP enrollment/login and logout revocation. No push or hosted deployment is part of this local delivery.
