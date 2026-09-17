#!/usr/bin/env bash
# Host entry point for systemd timers: rare-os-ops backup|restore-drill|monitor|test-alert|init
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
job=${1:-}
[[ "$job" =~ ^(backup|restore-drill|monitor|test-alert|init)$ ]] || { echo 'Usage: rare-os-ops backup|restore-drill|monitor|test-alert|init' >&2; exit 64; }
cd "${RARE_OS_DIR:-/var/www/rare-os}"
compose=(docker compose --profile ops)
exec 8>"/var/lock/rare-os-ops-$job.lock"
flock -n 8 || { echo "$job is already running; skipped."; exit 0; }
if [[ "$job" == monitor ]]; then
  # A deployment intentionally stops services; do not page anyone for planned downtime.
  exec 9>/var/lock/rare-os-deploy.lock
  flock -n 9 || { echo 'Deployment in progress; monitor skipped.'; exit 0; }
  {
    docker compose ps -a --format 'container|{{.Service}}|{{.State}}|{{.Health}}'
    # /var/lib/docker is often on the root filesystem; report each mount point only once.
    df -P / /var/lib/docker 2>/dev/null | awk 'NR>1 && !seen[$6]++ {gsub("%","",$5); print "disk|" $6 "|" $5}'
  } | "${compose[@]}" run --rm --no-deps -T ops monitor
else
  "${compose[@]}" run --rm --no-deps -T ops "$job"
fi
