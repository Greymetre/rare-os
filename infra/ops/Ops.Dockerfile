FROM alpine:3.23
# Operations tooling only: PostgreSQL 16 client, restic (encrypted offsite backups), curl (SMTP alerts) and Node.
# The appdata group is gid 1000, the group the photo and document volume belongs to: the backup job
# joins it so it can read the volume without running as root. The mount itself is read-only, so it
# still cannot change a photo.
RUN apk upgrade --no-cache \
  && apk add --no-cache ca-certificates curl nodejs postgresql16-client restic tzdata \
  && adduser -D -H -u 10001 ops \
  && mkdir -p /state /home/ops && chown ops:ops /state /home/ops \
  && addgroup -g 1000 appdata \
  && addgroup ops appdata
ENV HOME=/home/ops RESTIC_CACHE_DIR=/tmp/restic-cache
COPY --chown=root:root scripts/ops/lib.mjs scripts/ops/ops.mjs /ops/
USER ops
WORKDIR /home/ops
# One-shot jobs started by systemd timers; there is no long-running process to probe.
HEALTHCHECK NONE
ENTRYPOINT ["node", "/ops/ops.mjs"]
