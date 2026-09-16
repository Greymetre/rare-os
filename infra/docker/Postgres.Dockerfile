FROM postgres:16-alpine3.23
RUN apk upgrade --no-cache && rm -f /usr/local/bin/gosu
USER postgres
