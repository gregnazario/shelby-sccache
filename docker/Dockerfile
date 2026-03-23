# docker/Dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json shelby-cache-proxy.example.yaml ./

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/ .
RUN mkdir -p /data/cache/objects /data/cache/staging

ENV SHELBY_CACHE_CACHE_DIR=/data/cache/objects
ENV SHELBY_CACHE_CACHE_STAGING_DIR=/data/cache/staging
ENV SHELBY_CACHE_DEDUP_DB_PATH=/data/cache/dedup.db

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:9000/health || exit 1

CMD ["bun", "run", "src/cli/index.ts", "start", "/app/shelby-cache-proxy.example.yaml"]
