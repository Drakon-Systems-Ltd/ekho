# Stage 1: Build
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/relay/package.json packages/relay/
COPY packages/openclaw-plugin/package.json packages/openclaw-plugin/
COPY packages/shieldcortex-bridge/package.json packages/shieldcortex-bridge/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/ packages/
RUN npm run build -w @drakon-systems/ekho-sdk
RUN npm run ui:build -w @ekho/relay 2>/dev/null || true

# Stage 2: Runtime
FROM node:22-alpine
RUN apk add --no-cache python3 make g++
RUN addgroup -S ekho && adduser -S ekho -G ekho
WORKDIR /app

# Copy package files and install production deps (need build tools for better-sqlite3)
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/relay/package.json packages/relay/
COPY packages/openclaw-plugin/package.json packages/openclaw-plugin/
COPY packages/shieldcortex-bridge/package.json packages/shieldcortex-bridge/
RUN npm ci --omit=dev

# Install tsx globally for runtime TypeScript execution
RUN npm install -g tsx

# Clean up build tools
RUN apk del python3 make g++

# Copy built assets from build stage
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/relay/ui-dist packages/relay/ui-dist

# Copy relay source, migrations, and configs
COPY packages/relay/src packages/relay/src
COPY packages/relay/migrations packages/relay/migrations
COPY packages/relay/tsconfig.json packages/relay/
COPY tsconfig.base.json ./
COPY LICENSE ./

RUN mkdir -p /app/data && chown -R ekho:ekho /app/data
USER ekho

EXPOSE 4000
ENV EKHO_HOST=0.0.0.0
ENV EKHO_DB_PATH=/app/data/ekho.sqlite

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/healthz || exit 1

CMD ["tsx", "packages/relay/src/server.ts"]
