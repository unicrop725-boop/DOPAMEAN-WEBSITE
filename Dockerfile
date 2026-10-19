# syntax=docker/dockerfile:1
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# Placeholder env only so build-time module evaluation never needs real secrets (nothing is baked in).
RUN npm run build && node scripts/build-runtime.mjs

FROM node:25-alpine AS prod-deps
WORKDIR /app/worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:25-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
# Web: Next standalone server
COPY --from=build --chown=app:app /app/.next/standalone ./web
COPY --from=build --chown=app:app /app/.next/static ./web/.next/static
COPY --from=build --chown=app:app /app/public ./web/public
# Worker and migration runner: bundled entrypoints + SQL migrations + production node_modules
COPY --from=prod-deps --chown=app:app /app/worker/node_modules ./worker/node_modules
COPY --from=build --chown=app:app /app/dist ./worker/dist
COPY --from=build --chown=app:app /app/drizzle ./worker/drizzle
COPY --chown=app:app package.json ./worker/package.json
USER app
WORKDIR /app/worker
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "/app/web/server.js"]
