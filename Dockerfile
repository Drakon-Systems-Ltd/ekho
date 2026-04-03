# Stage 1: Build
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/relay/package.json packages/relay/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/sdk/ packages/sdk/
COPY packages/relay/ packages/relay/
RUN npm run build -w @ekho/sdk
RUN npm run ui:build -w @ekho/relay 2>/dev/null || true

# Stage 2: Runtime
FROM node:22-alpine
RUN apk add --no-cache python3 make g++
RUN addgroup -S ekho && adduser -S ekho -G ekho
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/relay/package.json packages/relay/
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/relay/ui-dist packages/relay/ui-dist
COPY packages/relay/src packages/relay/src
COPY packages/relay/migrations packages/relay/migrations
COPY packages/relay/tsconfig.json packages/relay/
COPY tsconfig.base.json ./
RUN mkdir -p /app/data && chown -R ekho:ekho /app/data
USER ekho
EXPOSE 4000
ENV EKHO_HOST=0.0.0.0
ENV EKHO_DB_PATH=/app/data/ekho.sqlite
CMD ["npx", "tsx", "packages/relay/src/server.ts"]
