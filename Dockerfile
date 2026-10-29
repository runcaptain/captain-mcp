# Pinned to an exact Node release so a rebuild never silently drops a security
# fix. 22.23.4 patches CVE-2026-111497 (Brotli) and bundles OpenSSL 3.5.9.
# Alpine instead of Debian slim: no perl or util-linux in the image.
ARG NODE_IMAGE=node:22.23.4-alpine

# ---- build stage ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- production deps ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime stage ----
FROM ${NODE_IMAGE} AS runtime
# The server runs with plain `node`. npm, corepack and yarn ship their own
# dependency trees (pacote, brace-expansion, sigstore, ...) that scanners flag,
# so they are not left in the runtime image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production
# Hosted server never touches the caller's local disk.
ENV CAPTAIN_MCP_ALLOW_LOCAL_FILES=false
ENV PORT=8080

# Only production deps + built output.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Run as the built-in non-root node user.
USER node

EXPOSE 8080
# Streamable-HTTP MCP endpoint at /mcp, health at /health.
CMD ["node", "dist/httpServer.js"]
