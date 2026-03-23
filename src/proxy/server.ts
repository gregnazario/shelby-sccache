import { Hono } from "hono";
import { configureLogger } from "../logger";
import { DiskCache } from "../cache/disk-cache";
import { CacheCleaner } from "../cache/cache-cleaner";
import { DedupStore } from "../dedup/dedup-store";
import { ShelbyClient } from "../shelby/client";
import { S3Handlers } from "./s3-handlers";
import { MultipartManager } from "./s3-multipart";
import { createS3Router } from "./s3-router";
import { s3AuthMiddleware } from "./s3-auth";
import { RenewalJob } from "../background/renewal";
import type { ProxyConfig } from "../types";

export function createServer(config: ProxyConfig) {
  configureLogger(config.logging.level, config.logging.format);

  const diskCache = new DiskCache(config.cache.dir, config.cache.maxSizeGb, config.cache.ttlDays);
  const dedupStore = new DedupStore(
    config.dedup.dbPath,
    config.dedup.bloomFilterExpectedItems,
    config.dedup.bloomFilterFpr,
    config.shelby.blobExpiryDays,
  );
  const shelbyClient = new ShelbyClient(config);
  const s3Handlers = new S3Handlers(diskCache, dedupStore, shelbyClient, config.s3.keyPrefix);
  const multipartManager = new MultipartManager(config.cache.stagingDir);
  const cacheCleaner = new CacheCleaner(diskCache, config.cache.cleanupIntervalMinutes);

  const app = new Hono();
  const startTime = Date.now();

  // Health endpoint
  app.get("/health", (c) => {
    const dedupStats = dedupStore.getStats();
    const handlerStats = s3Handlers.stats;
    return c.json({
      status: "healthy",
      shelbyNetwork: config.shelby.network,
      cache: {
        sizeGb: +(diskCache.sizeBytes / 1024 / 1024 / 1024).toFixed(2),
        maxSizeGb: config.cache.maxSizeGb,
        entries: diskCache.entries,
        hitRate1h: handlerStats.gets > 0
          ? +(handlerStats.cacheHits / handlerStats.gets).toFixed(3) : 0,
      },
      dedup: {
        uniqueBlobs: dedupStats.uniqueBlobs,
        totalKeys: dedupStats.totalKeys,
        savingsPct: dedupStats.totalKeys > 0
          ? +((1 - dedupStats.uniqueBlobs / dedupStats.totalKeys) * 100).toFixed(1) : 0,
      },
      shelby: {
        connected: !shelbyClient.circuit.isOpen,
        circuitBreaker: shelbyClient.circuit.state,
      },
    });
  });

  // Stats endpoint
  app.get("/stats", (c) => {
    const handlerStats = s3Handlers.stats;
    const dedupStats = dedupStore.getStats();
    return c.json({
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      requests: {
        total: handlerStats.puts + handlerStats.gets + handlerStats.heads,
        put: handlerStats.puts,
        get: handlerStats.gets,
        head: handlerStats.heads,
      },
      cache: {
        hits: handlerStats.cacheHits,
        misses: handlerStats.cacheMisses,
        hitRate: handlerStats.gets > 0
          ? +(handlerStats.cacheHits / handlerStats.gets).toFixed(3) : 0,
      },
      shelby: {
        circuitBreaker: shelbyClient.circuit.state,
      },
      dedup: {
        uniqueBlobs: dedupStats.uniqueBlobs,
        totalKeys: dedupStats.totalKeys,
        uploadsSkipped: handlerStats.dedupSkips,
        staleEntriesReconciled: handlerStats.staleReconciled,
      },
    });
  });

  // S3 auth middleware
  const isLocalMode = config.server.host === "127.0.0.1" || config.server.host === "localhost";
  app.use("/:bucket/*", s3AuthMiddleware(config.s3.accessKey, config.s3.secretKey, !isLocalMode));

  // S3 routes
  const s3Router = createS3Router(s3Handlers, multipartManager);
  app.route("/", s3Router);

  // Start background jobs
  cacheCleaner.start();
  const renewalJob = new RenewalJob(dedupStore, shelbyClient, config.dedup.renewalThresholdDays);
  renewalJob.start();

  return {
    app,
    port: config.server.port,
    hostname: config.server.host,
    cleanup: () => {
      cacheCleaner.stop();
      renewalJob.stop();
      s3Handlers.close();
    },
  };
}
