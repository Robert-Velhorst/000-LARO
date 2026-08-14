# Phase 032 — Docker & deployment readiness.
#
# This image runs the LARO **API server** (server/index.ts) standalone — the
# same Express + tRPC backend the desktop app embeds. It does NOT ship the
# Electron desktop UI. Persistence is SQLite (better-sqlite3), which is compiled
# for Node in this image (no Electron rebuild).
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Build toolchain for the better-sqlite3 native module.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install all dependencies for compilation, then build the standalone server.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY tsconfig*.json ./
COPY server ./server
COPY shared ./shared
COPY drizzle ./drizzle
COPY assets ./assets
COPY scripts ./scripts
RUN npm run build:server && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SERVER_ONLY=true

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server
COPY scripts/run-built-operation.mjs ./scripts/run-built-operation.mjs
COPY drizzle ./drizzle
COPY assets ./assets

# Runtime config.
ENV PORT=3000
ENV HOST=0.0.0.0
# Persist the SQLite DB and local evidence outside the container via volumes.
ENV DATABASE_URL=/data/laro-server.sqlite
ENV LOCAL_STORAGE_DIR=/data/uploads
VOLUME ["/data"]
EXPOSE 3000

# Container healthcheck hits the real health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/server/index.js"]
