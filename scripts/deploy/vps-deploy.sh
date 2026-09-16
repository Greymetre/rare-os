#!/usr/bin/env bash
# Install root-owned at /usr/local/sbin/rare-os-deploy; used as an SSH forced command.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
command_text=${SSH_ORIGINAL_COMMAND:-}
if [[ ! "$command_text" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only deploy followed by a full commit SHA is allowed.' >&2
  exit 64
fi
target=${BASH_REMATCH[1]}
cd /var/www/rare-os
exec 9>/var/lock/rare-os-deploy.lock
flock -w 1800 9
[[ -f .env && -f compose.override.yaml ]] || { echo 'Missing server environment/override.' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'Tracked server changes must be reviewed before deployment.' >&2; exit 1; }
git fetch origin main
if [[ "$(git rev-parse origin/main)" != "$target" ]]; then
  echo 'Skipped: a newer main commit exists. Only the latest checked commit can deploy.'
  exit 0
fi
previous=$(git rev-parse HEAD)
mkdir -p .local/deploy
phase=prepare
stopped=false
applying=false
finished=false
on_exit() {
  status=$?
  if [[ "$finished" != true ]]; then
    printf 'commit=%s\nprevious=%s\nphase=%s\nexit=%s\n' "$target" "$previous" "$phase" "$status" > .local/deploy/last-failure.txt
    if [[ "$applying" != true ]]; then
      # No migration has run. Restore the checkout and existing container instances.
      (umask 022; git checkout --detach "$previous") || true
      if [[ "$stopped" == true ]]; then docker compose start keycloak api worker web || true; fi
    fi
    echo "Deployment failed during $phase. See .local/deploy/last-failure.txt and the backup path in this run. No database downgrade was attempted." >&2
  fi
}
trap on_exit EXIT
printf 'commit=%s\nprevious=%s\n' "$target" "$previous" > .local/deploy/current-attempt.txt
# Capture the running images before build moves the service tags. The old image
# may already be missing after a previous build/prune; never substitute :latest.
phase=rollback-images
rollback_record=".local/deploy/rollback-images-$target.txt"
: > "$rollback_record"
for service in api worker web keycloak; do
  container=$(docker compose ps -q "$service")
  if [[ -n "$container" ]]; then
    image_id=$(docker inspect --format '{{.Image}}' "$container")
    rollback_tag="rare-os-rollback-$service:$previous"
    if docker image inspect "$image_id" >/dev/null 2>&1; then
      docker image tag "$image_id" "$rollback_tag"
      printf '%s %s %s\n' "$service" "$image_id" "$rollback_tag" >> "$rollback_record"
    else
      # A running container can outlive its image-store reference. Database backup
      # is still mandatory; application rollback will require rebuilding previous.
      printf '%s %s unavailable\n' "$service" "$image_id" >> "$rollback_record"
      echo "Warning: running $service image is unavailable for tagging. Rollback requires rebuilding commit $previous; continuing with mandatory database backup." >&2
    fi
  fi
done
# Exact commit tested by this workflow, never an unchecked pull of a newer revision.
(umask 022; git checkout --detach "$target")
node scripts/deploy/prepare-source.mjs
docker compose config --quiet
phase=build
docker compose pull --ignore-buildable
docker compose build --pull
# Scheduled backup/monitor jobs must run the same release, so rebuild the profiled ops image too.
docker compose --profile ops build --pull ops
# Read every migration and executable entry point as the actual runtime user before downtime.
phase=preflight
docker compose run --rm --no-deps migrate node scripts/deploy/check-runtime.mjs
phase=backup
stopped=true
docker compose stop web api worker keycloak
# Both application and identity writes are paused while the existing dump validator runs.
node scripts/backup-local.mjs | tee .local/deploy/last-backup.txt
phase=apply
applying=true
docker compose up -d --no-build
for service in migrate seed; do
  container=$(docker compose ps -a -q "$service")
  [[ -n "$container" ]] || { echo "Missing $service container" >&2; exit 1; }
  [[ "$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$container")" == 'exited:0' ]] || { echo "$service did not complete successfully" >&2; exit 1; }
done
phase=health
for service in web worker keycloak; do
  container=$(docker compose ps -q "$service")
  [[ -n "$container" ]] || { echo "$service is not running" >&2; exit 1; }
  [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]] || exit 1
done
curl --fail --silent --show-error --output /dev/null --max-time 15 --retry 8 --retry-delay 5 --retry-all-errors https://rare.greymetre.io/
curl --fail --silent --show-error --output /dev/null --max-time 15 --retry 8 --retry-delay 5 --retry-all-errors https://rare.greymetre.io/api/health
curl --fail --silent --show-error --output /dev/null --max-time 15 --retry 8 --retry-delay 5 --retry-all-errors https://auth.rare.greymetre.io/realms/rare-os/.well-known/openid-configuration
printf 'commit=%s\nprevious=%s\ncompleted_at=%s\n' "$target" "$previous" "$(date -u +%FT%TZ)" > .local/deploy/last-success.txt
finished=true
echo "Deployment and HTTPS checks passed: $target"
