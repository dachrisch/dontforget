# syntax=docker/dockerfile:1
#
# Single container that serves both the Fastify/TypeScript backend and the
# built Vite frontend (see src/server.ts: in NODE_ENV=production the backend
# registers @fastify/static against ../web/dist relative to dist/server.js).

# ---- deps: install all dependencies (incl. dev) for both npm packages ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

# ---- build: compile backend (tsc) and frontend (vite) ----
FROM deps AS build
COPY . .
RUN npm run build
RUN npm --prefix web run build

# ---- prod-deps: production-only backend dependencies (no typescript/vitest/etc) ----
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: slim image with only what's needed to run the server ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

EXPOSE 3000

# Node 24's global fetch avoids needing curl/wget in the alpine image.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/server.js"]
