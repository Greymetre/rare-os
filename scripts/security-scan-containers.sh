#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
# Trivy runs as root inside Docker; on Linux CI its cache becomes unreadable to later steps
# (prettier scans the workspace), so CI points TRIVY_CACHE_DIR outside the checkout.
TRIVY_CACHE_DIR=${TRIVY_CACHE_DIR:-$ROOT/.local/trivy-cache}
mkdir -p "$TRIVY_CACHE_DIR"
# CI has no .env. Image builds never read runtime secrets, but Compose validates the
# required-variable syntax, so supply a non-secret placeholder only when .env is absent.
if [ ! -f .env ]; then
  export IDENTITY_CLIENT_SECRET=image-scan-placeholder
fi
TRIVY_IMAGE=ghcr.io/aquasecurity/trivy:0.74.0

images='rare-os-api:latest rare-os-web:latest rare-os-ops:latest'
docker compose --profile ops build --pull api web ops

if [ "${1:-}" = '--platform' ]; then
  docker compose build --pull db keycloak
  APP_DOMAIN=scan.example.test AUTH_DOMAIN=auth.scan.example.test \
    docker compose -f compose.yaml -f compose.hostinger.yaml build --pull caddy
  docker compose pull mailpit redis
  images="$images rare-os-postgres:latest rare-os-keycloak:latest rare-os-caddy:latest axllent/mailpit:v1.31.1 redis:7-alpine"
elif [ "$#" -ne 0 ]; then
  echo 'Usage: scripts/security-scan-containers.sh [--platform]' >&2
  exit 64
fi

status=0
for image in $images; do
  echo "[security] Scanning $image for HIGH/CRITICAL vulnerabilities"
  if ! docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$TRIVY_CACHE_DIR:/root/.cache/trivy" \
    "$TRIVY_IMAGE" image \
    --quiet \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --exit-code 1 \
    "$image"; then
    status=1
  fi
done
exit "$status"
