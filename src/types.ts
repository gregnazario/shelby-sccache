export interface ProxyConfig {
  server: {
    port: number;
    host: string;
  };
  shelby: {
    network: string;
    apiKey?: string;
    aptosPrivateKey: string;
    blobExpiryDays: number;
  };
  s3: {
    accessKey: string;
    secretKey: string;
    region: string;
    keyPrefix: string;
  };
  cache: {
    enabled: boolean;
    dir: string;
    stagingDir: string;
    maxSizeGb: number;
    ttlDays: number;
    cleanupIntervalMinutes: number;
  };
  dedup: {
    enabled: boolean;
    dbPath: string;
    bloomFilterExpectedItems: number;
    bloomFilterFpr: number;
    renewalThresholdDays: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "json" | "text";
  };
}

export interface CacheMeta {
  size: number;
  contentHash: string;
  cachedAt: number;
  lastAccessed: number;
  shelbyBlobPath: string;
}

export interface DedupBlob {
  contentHash: string;
  shelbyPath: string;
  sizeBytes: number;
  createdAt: number;
  shelbyExpiresAt: number;
}

export interface DedupKeyMap {
  cacheKey: string;
  contentHash: string;
  createdAt: number;
  lastAccessed: number;
}

export interface ProxyStats {
  uptimeSeconds: number;
  requests: { total: number; put: number; get: number; head: number };
  cache: { hits: number; misses: number; hitRate: number; evictions1h: number };
  shelby: {
    uploads: number;
    downloads: number;
    uploadLatencyMs: { avg: number; p50: number; p95: number; p99: number };
    downloadLatencyMs: { avg: number; p50: number; p95: number; p99: number };
    errors1h: number;
    circuitBreaker: "closed" | "open" | "half-open";
  };
  dedup: {
    uniqueBlobs: number;
    totalKeys: number;
    uploadsSkipped: number;
    savingsPct: number;
    staleEntriesReconciled: number;
  };
}
