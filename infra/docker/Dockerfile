FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/workers/package.json apps/workers/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && chmod -R a+rX /app
FROM node:24-alpine3.23 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Keep the runtime smaller than the build image and install current Alpine security updates.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=node:node /app /app
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]
FROM alpine:3.23 AS web
RUN apk upgrade --no-cache && apk add --no-cache nginx
COPY infra/docker/nginx.conf /etc/nginx/http.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
CMD ["nginx", "-g", "daemon off; pid /tmp/nginx.pid;"]
