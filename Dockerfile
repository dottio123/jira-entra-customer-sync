# -----------------------------------------------------------------------------
# Stage 1: Build & Compile TypeScript
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# better-sqlite3 may need to compile when a matching prebuilt binary is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies required for compilation)
RUN npm ci

# Copy configuration and TypeScript source code
COPY tsconfig.json ./
COPY src ./src

# Build production TypeScript output into dist/
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: Minimal Production Runner
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

LABEL org.opencontainers.image.title="Entra to Jira Customer Sync" \
      org.opencontainers.image.description="Keeps Jira Service Management customer details in sync with Microsoft Entra ID" \
      org.opencontainers.image.licenses="UNLICENSED"

WORKDIR /app

ENV NODE_ENV=production

# Install tini for proper signal handling and container lifecycle management
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

# Keep the native SQLite module built against the same Node and Linux base.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
# package.json also supplies the application version at runtime.
COPY --chown=node:node package.json package-lock.json ./

# Copy compiled JavaScript from builder stage
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node src/web/assets ./web/assets
COPY --chown=node:node src/web/views ./web/views

RUN mkdir -p /app/data /app/secrets /app/reports && chown -R node:node /app/data /app/secrets /app/reports

ENV WEB_ASSET_ROOT=/app/web

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as non-root user
USER node

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/web/index.js"]
