# syntax=docker/dockerfile:1

# ---- Builder: install all deps (incl. native build toolchain), build backend + frontend ----
FROM node:22-bookworm AS builder
WORKDIR /app

# Manifests first so `npm ci` is cached unless dependencies change.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

# Build: backend tsc -> backend/dist, frontend vue-tsc/vite -> frontend/dist.
COPY . .
RUN npm run build

# Drop dev dependencies. The compiled native PROD modules (isolated-vm, sqlite3) are kept.
RUN npm prune --omit=dev

# ---- Runtime: slim image, no build toolchain ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    LF_STATIC_DIR=/app/frontend/dist \
    LF_DB_PATH=/data/database.sqlite

# App + production node_modules (native addons already compiled in the builder; same Debian
# bookworm base => ABI-compatible).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/package.json ./backend/package.json
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/package.json ./package.json

# Persistent data: SQLite file (+ WAL/-shm) and the binaries table all live in /data.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000

# Lightweight liveness check (Node 22 has global fetch; no curl needed in the slim image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/server.js"]
