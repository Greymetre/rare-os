FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/workers/package.json apps/workers/package.json
RUN npm ci
COPY . .
RUN npm run build && chmod -R a+rX /app
FROM build AS runtime
ENV NODE_ENV=production
USER node
CMD ["node", "apps/api/dist/main.js"]
FROM nginx:1.28-alpine AS web
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
