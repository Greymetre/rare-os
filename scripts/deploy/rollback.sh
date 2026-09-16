#!/usr/bin/env bash
# Manual application rollback on the VPS (never an SSH forced command). Install root-owned at
# /usr/local/sbin/rare-os-rollback. Usage:
#   rare-os-rollback <good-sha>
#   rare-os-rollback <good-sha> --restore-backup .local/backups/<stamp> --confirm-data-loss
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
  echo 'Usage: rare-os-rollback <40-char good commit> [--restore-backup .local/backups/<stamp> --confirm-data-loss]' >&2
  exit 64
}
[[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || usage
good=$1
shift
backup=''
confirmed=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore-backup) [[ -n "${2:-}" ]] || usage; backup=$2; shift 2 ;;
    --confirm-data-loss) confirmed=true; shift ;;
    *) usage ;;
  esac
done
[[ -z "$backup" || "$confirmed" == true ]] || { echo 'Restoring a backup discards every change made after it. Re-run with --confirm-data-loss.' >&2; exit 64; }

cd "${RARE_OS_DIR:-/var/www/rare-os}"
exec 9>/var/lock/rare-os-deploy.lock
flock -w 60 9 || { echo 'A deployment is running. Wait for it to finish.' >&2; exit 1; }
[[ -f .env ]] || { echo 'Missing .env' >&2; exit 1; }
git cat-file -e "$good^{commit}" 2>/dev/null || { echo "Commit $good is not available locally." >&2; exit 1; }
current=$(git rev-parse HEAD)
[[ "$current" != "$good" ]] || { echo 'Already on the requested commit.' >&2; exit 1; }
env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
app_url=$(env_value APP_URL)
auth_url=$(env_value AUTH_URL)
[[ -n "$app_url" && -n "$auth_url" ]] || { echo 'APP_URL/AUTH_URL missing in .env' >&2; exit 1; }
files=(-f compose.yaml)
[[ -f compose.override.yaml ]] && files+=(-f compose.override.yaml)
mkdir -p .local/deploy
phase=checks

# 1. Images captured by the deployment that replaced the good commit must still exist.
for service in api worker web keycloak; do
  docker image inspect "rare-os-rollback-$service:$good" >/dev/null 2>&1 || {
    echo "Missing rollback image rare-os-rollback-$service:$good. Rebuild that commit instead; nothing was changed." >&2
    exit 1
  }
done

# 2. Decide whether the data is still compatible with the older code.
applied=$(docker compose "${files[@]}" exec -T db psql -U rare_owner -d rare_os -At -c 'SELECT name FROM schema_migrations ORDER BY name')
expected=$(git ls-tree --name-only "$good" db/migrations/ | sed 's#.*/##' | grep '\.sql$' | sort)
newer=$(comm -23 <(printf '%s\n' "$applied" | sort) <(printf '%s\n' "$expected"))
identity_changed=false
git diff --quiet "$good" "$current" -- infra/keycloak/Dockerfile infra/keycloak/provider || identity_changed=true
if [[ -n "$newer" || "$identity_changed" == true ]]; then
  if [[ -z "$backup" ]]; then
    {
      echo 'Refusing image-only rollback: the running data is not compatible with the older code.'
      [[ -z "$newer" ]] || printf 'Migrations applied after %s:\n%s\n' "$good" "$newer"
      [[ "$identity_changed" != true ]] || echo 'The identity provider (custom Keycloak) changed; its database references the newer login flows.'
      echo 'Use the pre-deployment backup: --restore-backup <path from .local/deploy/last-backup.txt> --confirm-data-loss'
    } >&2
    exit 2
  fi
fi
if [[ -n "$backup" ]]; then
  backup=$(cd "$backup" && pwd)
  [[ "$backup" == "$PWD/.local/backups/"* && -f "$backup/manifest.json" ]] || { echo 'Backup must be a folder under .local/backups with manifest.json' >&2; exit 1; }
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const dir = process.argv[1];
    const manifest = JSON.parse(readFileSync(dir + "/manifest.json", "utf8"));
    for (const name of ["rare_os", "keycloak"]) {
      const entry = manifest.files.find((f) => f.database === name && f.file === name + ".dump");
      const sum = entry && createHash("sha256").update(readFileSync(dir + "/" + entry.file)).digest("hex");
      if (!entry || sum !== entry.sha256) { console.error("Checksum failed for " + name + " backup"); process.exit(1); }
    }
    console.log("Backup from " + manifest.createdAt + " verified.");
  ' "$backup"
fi

stamp=$(date -u +%Y%m%d%H%M%S)
renamed=false
on_exit() {
  status=$?
  [[ "$status" -eq 0 ]] && return
  printf 'good=%s\nfrom=%s\nphase=%s\nexit=%s\nsafety_backup=%s\n' "$good" "$current" "$phase" "$status" "${safety:-none}" > .local/deploy/last-rollback-failure.txt
  echo "Rollback failed during $phase. Details: .local/deploy/last-rollback-failure.txt" >&2
  [[ "$renamed" != true ]] || echo "Pre-rollback databases are kept as rare_os_before_rollback_$stamp and keycloak_before_rollback_$stamp." >&2
}
trap on_exit EXIT

# 3. Always keep the current state recoverable before changing anything.
phase=safety-backup
safety=$(node scripts/backup-local.mjs | tail -1)
echo "Safety backup of current data: $safety"

phase=stop
docker compose "${files[@]}" stop web api worker keycloak

if [[ -n "$backup" ]]; then
  phase=restore
  psql_admin() { docker compose "${files[@]}" exec -T db psql -U rare_owner -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
  for database in rare_os keycloak; do
    owner=rare_owner
    [[ "$database" == keycloak ]] && owner=rare_keycloak
    psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$database' AND pid<>pg_backend_pid()" >/dev/null
    # Rename, never drop: the pre-rollback data stays available for reconciliation.
    psql_admin "ALTER DATABASE $database RENAME TO ${database}_before_rollback_$stamp"
    renamed=true
    psql_admin "CREATE DATABASE $database OWNER $owner"
    docker compose "${files[@]}" exec -T db pg_restore -U rare_owner --exit-on-error -d "$database" < "$backup/$database.dump"
  done
fi

phase=checkout
(umask 022; git checkout --detach "$good")
[[ ! -f scripts/deploy/prepare-source.mjs ]] || node scripts/deploy/prepare-source.mjs
override=".local/deploy/rollback-$good.yaml"
{
  echo 'services:'
  for service in api worker web keycloak; do
    printf '  %s:\n    image: rare-os-rollback-%s:%s\n' "$service" "$service" "$good"
  done
} > "$override"

phase=start
# No migrate/seed: the older code must not modify the restored or compatible schema.
docker compose "${files[@]}" -f "$override" up -d --no-build --no-deps --force-recreate keycloak api worker web

phase=health
for url in "$app_url/" "$app_url/api/health" "$auth_url/realms/rare-os/.well-known/openid-configuration"; do
  curl --fail --silent --show-error --output /dev/null --max-time 15 --retry 20 --retry-delay 5 --retry-all-errors "$url"
done
printf 'good=%s\nfrom=%s\nrestored_backup=%s\nsafety_backup=%s\ncompleted_at=%s\n' \
  "$good" "$current" "${backup:-none}" "$safety" "$(date -u +%FT%TZ)" > .local/deploy/last-rollback.txt
phase=done
echo "Rollback to $good completed and health checks passed."
echo 'Next: set GitHub variable VPS_DEPLOY_ENABLED=false until the fix is merged, then verify login manually.'
[[ -z "$backup" ]] || echo "Old databases kept as *_before_rollback_$stamp; drop them only after review."
