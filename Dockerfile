# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Hosted server never touches the caller's local disk.
ENV CAPTAIN_MCP_ALLOW_LOCAL_FILES=false
ENV PORT=8080

# Only production deps + built output.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run as the built-in non-root node user.
USER node

EXPOSE 8080
# Streamable-HTTP MCP endpoint at /mcp, health at /health.
CMD ["node", "dist/httpServer.js"]
