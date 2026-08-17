# =========================================
# Bindarr Dockerfile
# Stage 1: Build Frontend Assets
# =========================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Copy frontend packages and lockfiles
COPY frontend/package*.json ./
RUN npm ci

# Copy frontend source files
COPY frontend/ ./
# Shared JSON tables imported via ../../../shared/*.json (resolves to /app/shared)
COPY shared/ /app/shared/
# Build production bundles
RUN npm run build

# =========================================
# Stage 2: Set up Production Server
# =========================================
# Debian (glibc), NOT alpine: onnxruntime-node (pulled in by
# @huggingface/transformers for CLIP inference during the global-index build)
# ships glibc-linked prebuilt binaries and fails to dlopen on alpine/musl
# (ERR_DLOPEN_FAILED, issue #19).
FROM node:20-slim AS production
WORKDIR /app

# Native build tools for SQLite3, gosu to drop root in the entrypoint, plus
# wget (healthcheck) and ca-certificates (HTTPS to the card APIs + model host).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ gosu wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3001
# Card scanning needs a secure context, and a container reached at
# http://<host>:3001 is not one, so TLS is served alongside HTTP. The cert is
# self-signed into /app/database/ssl on first start (persisted with the volume)
# unless SSL_CERT_PATH/SSL_KEY_PATH point at a real one. Set HTTPS_PORT="" to
# serve plain HTTP only.
ENV HTTPS_PORT=3443
# Upgrades from an image that used pokemon_cards.db keep their data: the app
# renames the old file (and its WAL sidecars) into place on first start.
ENV DB_PATH=/app/database/bindarr.db
# Set indexes live on the persisted volume too, else they rebuild every redeploy
ENV SETS_DIR=/app/database/sets
# Global scan indexes (embed/orb bins) also live on the persisted volume, both so
# a rebuild has a writable target under the non-root `node` user and so the
# multi-GB output survives redeploys instead of being rebuilt each time.
ENV INDEX_DATA_DIR=/app/database/index

# Create database volume mount target directory (+ the global-index subdir)
RUN mkdir -p /app/database/index

# Copy backend configuration
COPY backend/package*.json ./backend/
WORKDIR /app/backend
# Install production backend dependencies (prebuilt native binaries).
RUN npm ci --omit=dev
# Recompile ONLY sqlite3 from source: its node-pre-gyp prebuilt is linked
# against a newer glibc (GLIBC_2.38) than this Debian base provides, so the
# prebuilt aborts at startup with ERR_DLOPEN_FAILED. Building here links against
# the image's own glibc. Scoped to sqlite3 so sharp/onnxruntime-node keep their
# prebuilts (sharp can't build from source without libvips-dev).
RUN npm rebuild sqlite3 --build-from-source

# Copy backend source files
COPY backend/src/ ./src/

# build-card-embeddings.mjs is spawned by src/globalIndex.js at runtime (Rebuild
# Global Index Cache), and imports ../src/utils/clipPreprocess.js — the shared
# preprocessing definition — so both trees must be present. Omitting scripts/
# breaks that feature in the image. The ORB half needs no script: it is assembled
# from the per-set indexes by src/orbUnion.js.
COPY backend/scripts/ ./scripts/

# Shared JSON tables required at runtime by backend/src/utils/compartmentSort.js
# via ../../../shared/*.json (resolves to /app/shared)
COPY shared/ /app/shared/

# Copy compiled frontend assets from Stage 1 to the location server.js expects
# (../../frontend/dist relative to backend/src, i.e. /app/frontend/dist)
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Ownership of the app + database dirs set here so a fresh named volume mounted
# at /app/database inherits node-writable permissions on first init.
RUN chown -R node:node /app

# The container starts as root and the entrypoint drops to the unprivileged
# `node` user AFTER chowning the mounted volume (a legacy root-owned volume
# would otherwise be unwritable). sed strips any CRLF so the shebang works when
# the file is checked out on Windows.
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

# Expose ports (HTTP + the TLS listener used for camera scanning)
EXPOSE 3001 3443

# Liveness/readiness probe. start-period covers startup (set sync + price job).
# wget is installed above (slim has no wget by default).
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# Command to start Express server
CMD ["node", "src/server.js"]
