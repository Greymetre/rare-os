FROM caddy:2.11.4-alpine
RUN apk upgrade --no-cache \
  && addgroup -S caddy \
  && adduser -S -D -H -s /sbin/nologin -G caddy caddy \
  && chown -R caddy:caddy /data /config
USER caddy
