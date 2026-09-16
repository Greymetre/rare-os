# VAPT-oriented security review — 16 September 2026

This is an engineering security review and automated scan record, not an external VAPT certificate. It covers the current local source tree, npm dependencies, Docker/IaC configuration, built application images and selected HTTP attack-surface behavior. Live public DNS/TLS/WAF/network exposure and authenticated manual penetration testing remain external acceptance work.

## Automated gates added

- `npm audit --audit-level=low` blocks any published npm advisory.
- `tests/security-baseline.test.mjs` blocks committed secret patterns, dynamic evaluation/unsafe HTML, weak SQL/RLS grants, missing request/CSRF/token controls, public service ports, privileged containers and missing gateway/image hardening.
- GitHub CI uses pinned Trivy `0.74.0` for source dependencies, secrets and Docker/IaC misconfiguration and fails on HIGH/CRITICAL findings.
- `npm run security:containers` rebuilds and scans the deployable API and web images and fails on HIGH/CRITICAL findings.
- `npm run security:platform` scans application plus Postgres, Keycloak, Caddy, Redis and Mailpit images. It checks every image before returning failure, so one upstream finding cannot hide the others.
- Browser/API regression checks security headers, stack-trace suppression, CSRF/origin rejection, canonical-host redirect, unsupported TRACE, malformed JSON and the 64 KiB request-body limit.

Scanner reports stay under ignored `.local/vapt/`; no vulnerability ignore file or blanket suppression is used.

## Fixes made from this review

- API JSON/form bodies are limited to 64 KiB before session/auth work. Parser errors retain safe `400`/`413` responses instead of becoming generic `503` errors.
- Nginx and Caddy set HSTS/CSP/clickjacking/content-type/referrer/permissions headers as applicable and hide server identification.
- API uses a minimal patched Alpine runtime without npm tooling. Web uses patched Alpine Nginx as a non-root user. Postgres runs as `postgres`, removes the unused runtime `gosu` binary and uses current Alpine packages.
- Containers use `no-new-privileges`; application/database/identity ports remain loopback-only outside the production TLS gateway.
- Caddy is pinned to official `2.11.4`, runs as a non-root user on internal ports 8080/8443 and receives current Alpine security updates.
- Mailpit is updated to `1.31.1`; deployment and regression builds pull refreshed bases.
- Keycloak stays on official `26.7.3`; the fixable Netty handler CRITICAL advisory is replaced with checksum-verified `4.1.137.Final` while preserving Keycloak's indexed distribution filename.

## Verified results

Using the current Trivy database and freshly rebuilt images:

| Target                       | CRITICAL | HIGH | Result                   |
| ---------------------------- | -------: | ---: | ------------------------ |
| Source/lockfiles/secrets/IaC |        0 |    0 | pass                     |
| npm dependency tree          |        0 |    0 | pass                     |
| `rare-os-api`                |        0 |    0 | pass                     |
| `rare-os-web`                |        0 |    0 | pass                     |
| `rare-os-postgres`           |        0 |    0 | pass                     |
| Mailpit 1.31.1               |        0 |    0 | pass                     |
| Redis 7 Alpine               |        0 |    0 | pass                     |
| `rare-os-keycloak`           |        0 |    2 | upstream review required |
| `rare-os-caddy`              |        0 |   17 | upstream review required |

The two Keycloak image findings are the UBI OpenJDK package advisory `CVE-2026-22020` with no vendor fix and Trivy's `CVE-2025-59250` classification for the bundled Microsoft JDBC artifact. RARE OS uses PostgreSQL, not MSSQL; the artifact filename is already `13.2.1.jre11`, which Trivy also lists as a fixed line, but the finding remains visible rather than suppressed.

The Caddy findings are in the Go standard library and compiled Go modules inside official latest `2.11.4`. Rebuilding a TLS gateway from unreleased dependency combinations would move security ownership into this repository and was not treated as a safe automatic fix. Track the next official Caddy/Keycloak releases and rerun `npm run security:platform` before production release.

## Commands

```bash
npm run security:check
npm run security:containers
npm run security:platform   # currently returns non-zero for the documented upstream findings
npm run test:regression
```

A clean application scan does not prove absence of unknown vulnerabilities. Production release still needs authenticated manual business-logic testing, live endpoint/TLS/header scanning, infrastructure exposure review and retesting after upstream image updates.
