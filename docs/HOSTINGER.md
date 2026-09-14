# Hostinger VPS deployment - prepared, not deployed

Same Docker build VPS par use hoga. Current configuration local development ke liye tested hai; real DNS/TLS cutover requires VPS and domain access.

## Before first production release

1. Choose VPS based on measured load; planning starting budget 4-8 vCPU / 16 GB RAM, not a throughput guarantee.
2. Separate staging/prod environments. Install supported Docker/Compose. Restrict SSH to authorised keys/IPs.
3. Set DNS for app and auth domains. Allow 80/443; DB/Redis ports private.
4. Generate separate production env outside git: all secrets fresh; APP_URL=https://app.example.com, AUTH_URL=https://auth.example.com, APP_DOMAIN=app.example.com, AUTH_DOMAIN=auth.example.com.
5. Set a real admin email. Never reuse local seed password. Provision SMTP, MFA, account disable/revoke lifecycle and backup storage before real users.
6. Build release-tagged images in CI; source-build Compose is supplied for initial staging setup. Review image vulnerabilities before release.

```sh
docker compose --env-file .env.production -f compose.yaml -f compose.hostinger.yaml config --quiet
docker compose --env-file .env.production -f compose.yaml -f compose.hostinger.yaml up -d --build
```

Production override removes local web/auth published ports. Caddy terminates HTTPS and proxies API directly, so secure session cookies see the correct forwarded protocol. Keycloak admin endpoint is blocked publicly. An SSH tunnel or secured admin access route is required for Keycloak administration. Scope trusted proxy access to this private network.

## Database and recovery

App DB and Keycloak DB both need nightly off-VPS encrypted backups. Preserve uploads when implemented, infrastructure settings and deployment secrets separately. A realm JSON export is not a database backup.

Example manual database backup (run from project, creates local private files):

```sh
mkdir -p .local/backups
chmod 700 .local/backups
docker compose exec -T db pg_dump -U rare_owner -d rare_os -Fc > .local/backups/rare_os.dump
docker compose exec -T db pg_dump -U rare_owner -d keycloak -Fc > .local/backups/keycloak.dump
chmod 600 .local/backups/*.dump
```

Automated encrypted offsite transfer, retention, restore drills and monitoring alerts remain deployment tasks. Never restore over a live database without a planned cutover. Restore into isolated databases, verify roles/migrations/identity linkage, log in and reconcile counts first.

RPO/RTO are business targets, not yet demonstrated. Single VPS is a failure domain. Use Hostinger snapshot as an additional layer, not the only backup.

## Update/rollback

Back up databases before migrations. Deploy reviewed additive migrations, then compatible images. Keep previous image tags. App rollback requires compatible schema; don't blindly reverse destructive migrations or reset a production volume. Queue schema/version changes need worker coordination.

## Go-live gate

- HTTPS cookies/redirects and CSRF tested on real domains.
- SMTP reset/invite and MFA configured and tested.
- User/role management and session revocation hardened for actual onboarding.
- Seed disabled as an automatic privileged production startup task after bootstrap; run controlled migrations/seeds separately in release process.
- Database/Redis/API and Keycloak management stay private.
- Automated offsite backup and successful restore drill.
- Monitoring alerts and incident owner.
- Agreed Availability workflow and realistic load tests before operational use.

References: https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/ and https://www.keycloak.org/server/reverseproxy .

## Invitation / reset email configuration

Set a fresh `IDENTITY_CLIENT_SECRET` in production; the seeder configures a dedicated Keycloak service account with user-management permissions. Do not reuse bootstrap-admin credentials in the API.

In the production env set `SMTP_HOST`, `SMTP_PORT` (usually 587), `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_STARTTLS=true` and `EMAIL_ENABLED=true`. Run the controlled seed step to apply SMTP and client settings. Verify invite, password setup, login and reset using a real mailbox on staging. Mailpit is disabled by the production override; local captured messages are not real delivery evidence. Leave `EMAIL_ENABLED=false` until SMTP is configured.

If identity provisioning fails, the app keeps the saved user with a visible setup error and retry action. Fix the identity service configuration and retry from Users. Passwords are set by users through Keycloak links, never displayed by the app.
