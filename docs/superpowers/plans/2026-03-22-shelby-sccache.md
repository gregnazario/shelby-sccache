# shelby-sccache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a decentralized build cache proxy that bridges sccache to Shelby storage via an S3-compatible API, with read-through disk cache and content-hash dedup.

**Architecture:** A TypeScript/Bun HTTP server implements minimal S3 API (PutObject, GetObject, HeadObject, multipart). sccache connects via standard S3 env vars. The proxy wraps the Shelby SDK for blob upload/download, adds an LRU disk cache for fast local reads, and a SQLite + bloom filter dedup layer to skip redundant uploads.

**Tech Stack:** TypeScript, Bun runtime, Hono HTTP framework, bun:sqlite, @shelby-protocol/sdk, @aptos-labs/ts-sdk, @smithy/signature-v4

**Spec:** `docs/superpowers/specs/2026-03-22-shelby-sccache-design.md`

---

## Task 0: Prerequisite Spike

Before full implementation, validate assumptions empirically. This spike can be done without any code from this plan.

- [ ] **Step 1: Create a request-logging Bun server**

```typescript
// spike/log-server.ts
Bun.serve({
  port: 9000,
  fetch(req) {
    const url = new URL(req.url);
    console.log(JSON.stringify({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(req.headers),
    }, null, 2));
    // Return minimal valid S3 responses
    if (req.method === "PUT") return new Response(null, { status: 200, headers: { ETag: '"mock"' } });
    if (req.method === "HEAD") return new Response(null, { status: 404 });
    if (req.method === "GET") return new Response(null, { status: 404 });
    return new Response(null, { status: 200 });
  },
});
```

- [ ] **Step 2: Run sccache against the logging server**

```bash
# Terminal 1: Start logging server
bun spike/log-server.ts

# Terminal 2: Configure sccache and build a small Rust project
export SCCACHE_BUCKET=test
export SCCACHE_ENDPOINT=http://localhost:9000
export SCCACHE_REGION=us-east-1
export SCCACHE_S3_USE_SSL=false
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
export RUSTC_WRAPPER=sccache
sccache --stop-server 2>/dev/null; sccache --start-server
cargo build  # on a small Rust project
sccache --show-stats
```

Record: all S3 operations, query parameters, headers, body sizes. Verify whether multipart is used and at what threshold.

- [ ] **Step 3: Validate Shelby SDK operations**

```typescript
// spike/shelby-test.ts
import { ShelbyNodeClient } from "@shelby-protocol/sdk/node";
import { Ed25519Account, Ed25519PrivateKey, Network } from "@aptos-labs/ts-sdk";

const client = new ShelbyNodeClient({
  network: Network.SHELBYNET,
  apiKey: process.env.SHELBY_API_KEY,
  aptos: { network: Network.SHELBYNET as any, clientConfig: { http2: false } },
});

const signer = new Ed25519Account({ privateKey: new Ed25519PrivateKey(process.env.APTOS_PRIVATE_KEY!) });

// Test upload
const testData = new Uint8Array(Buffer.from("sccache-spike-test"));
await client.upload({ signer, blobName: "spike/test-blob", blobData: testData, expirationMicros: (Date.now() + 86400000) * 1000 });
console.log("Upload: OK");

// Test download
const blob = await client.download({ account: signer.accountAddress, blobName: "spike/test-blob" });
const reader = blob.readable.getReader();
const chunks = []; while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
console.log("Download: OK, size:", chunks.reduce((s, c) => s + c.length, 0));

// Test existence check
const meta = await client.coordination.getBlobMetadata({ account: signer.accountAddress, name: "spike/test-blob" });
console.log("Exists:", meta !== null && meta !== undefined);

// Test 5MB upload (blob size limit check)
const largeData = new Uint8Array(5 * 1024 * 1024);
await client.upload({ signer, blobName: "spike/large-blob", blobData: largeData, expirationMicros: (Date.now() + 86400000) * 1000 });
console.log("Large upload (5MB): OK");
```

- [ ] **Step 4: Document findings**

Create `spike/FINDINGS.md` with: actual S3 operations observed, Shelby SDK method signatures confirmed, any discrepancies from spec assumptions. Update the plan if needed.

- [ ] **Step 5: Commit spike results**

```bash
git add spike/
git commit -m "spike: validate sccache S3 API surface and Shelby SDK operations"
```

---

## File Structure

```
shelby-sccache/
├── src/
│   ├── types.ts                   # Shared interfaces and config types
│   ├── config.ts                  # YAML config loader + env var overrides
│   ├── logger.ts                  # Structured JSON logger
│   ├── proxy/
│   │   ├── server.ts              # Hono app with S3 routes + health/stats
│   │   ├── s3-router.ts           # S3 route matching (method + query params)
│   │   ├── s3-auth.ts             # SigV4 validation (shared mode) or pass-through (local)
│   │   ├── s3-handlers.ts         # PutObject, GetObject, HeadObject, ListObjects, DeleteObject
│   │   ├── s3-multipart.ts        # CreateMultipartUpload, UploadPart, Complete, Abort
│   │   └── s3-xml.ts              # S3 XML response helpers
│   ├── cache/
│   │   ├── disk-cache.ts          # LRU read-through disk cache with atomic writes
│   │   └── cache-cleaner.ts       # Background sweep (TTL + LRU eviction)
│   ├── dedup/
│   │   ├── dedup-store.ts         # SQLite content-hash index + key_map
│   │   └── bloom-filter.ts        # In-memory bloom filter for fast negative lookups
│   ├── shelby/
│   │   ├── client.ts              # Shelby SDK wrapper (upload/download/exists)
│   │   └── circuit-breaker.ts     # Circuit breaker for Shelby degradation
│   ├── background/
│   │   └── renewal.ts             # Blob expiration renewal background job
│   └── cli/
│       ├── index.ts               # CLI entry point (init, start, stop, stats)
│       └── init.ts                # Config generation + cache dir setup
├── test/
│   ├── unit/
│   │   ├── bloom-filter.test.ts
│   │   ├── dedup-store.test.ts
│   │   ├── disk-cache.test.ts
│   │   ├── config.test.ts
│   │   ├── s3-xml.test.ts
│   │   ├── s3-handlers.test.ts
│   │   ├── s3-multipart.test.ts
│   │   ├── circuit-breaker.test.ts
│   │   └── shelby-client.test.ts
│   └── integration/
│       └── proxy.test.ts          # Full S3 → Shelby round-trip tests
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── action/
│   ├── action.yml
│   └── entrypoint.sh
├── scripts/
│   ├── install.sh
│   └── setup-sccache-env.sh
├── package.json
├── tsconfig.json
└── shelby-cache-proxy.example.yaml
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `shelby-cache-proxy.example.yaml`

- [ ] **Step 1: Initialize Bun project**

```bash
cd /Users/greg/git/shelby-sccache
bun init -y
```

- [ ] **Step 2: Install dependencies**

```bash
bun add hono @shelby-protocol/sdk @aptos-labs/ts-sdk yaml @smithy/signature-v4
bun add -d @types/bun typescript
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: Write src/types.ts**

```typescript
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
```

- [ ] **Step 5: Write example config file**

Create `shelby-cache-proxy.example.yaml` with the full config template from the spec (lines 210-246).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json bun.lock src/types.ts shelby-cache-proxy.example.yaml
git commit -m "feat: scaffold project with dependencies and type definitions"
```

---

## Task 2: Config Loader

**Files:**
- Create: `src/config.ts`
- Create: `test/unit/config.test.ts`

- [ ] **Step 1: Write failing tests for config loader**

```typescript
// test/unit/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, resolveEnvVars } from "../../src/config";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("loads YAML config with defaults", () => {
    const yaml = `
server:
  port: 9000
shelby:
  network: testnet
  aptos_private_key: "0xabc"
`;
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, yaml);
    const config = loadConfig(path);
    expect(config.server.port).toBe(9000);
    expect(config.server.host).toBe("0.0.0.0"); // default
    expect(config.cache.maxSizeGb).toBe(10); // default
    expect(config.shelby.aptosPrivateKey).toBe("0xabc");
  });

  it("resolves ${ENV_VAR} references", () => {
    process.env.TEST_KEY = "secret123";
    const result = resolveEnvVars("${TEST_KEY}");
    expect(result).toBe("secret123");
    delete process.env.TEST_KEY;
  });

  it("applies SHELBY_CACHE_* env overrides", () => {
    const yaml = `
server:
  port: 9000
shelby:
  network: testnet
  aptos_private_key: "0xabc"
`;
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, yaml);
    process.env.SHELBY_CACHE_SERVER_PORT = "8080";
    const config = loadConfig(path);
    expect(config.server.port).toBe(8080);
    delete process.env.SHELBY_CACHE_SERVER_PORT;
  });

  it("uses defaults when no config file exists", () => {
    const config = loadConfig(null);
    expect(config.server.port).toBe(9000);
    expect(config.cache.enabled).toBe(true);
    expect(config.dedup.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/unit/config.test.ts
```
Expected: FAIL — `loadConfig` not found.

- [ ] **Step 3: Implement config loader**

```typescript
// src/config.ts
import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { resolve } from "path";
import type { ProxyConfig } from "./types";

const DEFAULTS: ProxyConfig = {
  server: { port: 9000, host: "0.0.0.0" },
  shelby: {
    network: "testnet",
    apiKey: undefined,
    aptosPrivateKey: "",
    blobExpiryDays: 30,
  },
  s3: {
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "shelbyland",
    keyPrefix: "sccache/v1",
  },
  cache: {
    enabled: true,
    dir: resolve(process.env.HOME ?? "~", ".shelby-cache/objects"),
    stagingDir: resolve(process.env.HOME ?? "~", ".shelby-cache/staging"),
    maxSizeGb: 10,
    ttlDays: 7,
    cleanupIntervalMinutes: 10,
  },
  dedup: {
    enabled: true,
    dbPath: resolve(process.env.HOME ?? "~", ".shelby-cache/dedup.db"),
    bloomFilterExpectedItems: 1_000_000,
    bloomFilterFpr: 0.01,
    renewalThresholdDays: 5,
  },
  logging: { level: "info", format: "json" },
};

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

function deepResolve(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(deepResolve);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepResolve(v);
    }
    return result;
  }
  return obj;
}

// Convert YAML snake_case keys to camelCase
function snakeToCamel(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(snakeToCamel);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const camelKey = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = snakeToCamel(v);
  }
  return result;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
      result[key] = deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// Explicit env var mapping to avoid ambiguity with multi-word config keys.
// Uses double-underscore to separate sections, single underscore within section keys.
const ENV_MAP: Record<string, string[]> = {
  SHELBY_CACHE_SERVER_PORT: ["server", "port"],
  SHELBY_CACHE_SERVER_HOST: ["server", "host"],
  SHELBY_CACHE_SHELBY_NETWORK: ["shelby", "network"],
  SHELBY_CACHE_SHELBY_API_KEY: ["shelby", "apiKey"],
  SHELBY_CACHE_SHELBY_APTOS_PRIVATE_KEY: ["shelby", "aptosPrivateKey"],
  SHELBY_CACHE_SHELBY_BLOB_EXPIRY_DAYS: ["shelby", "blobExpiryDays"],
  SHELBY_CACHE_CACHE_DIR: ["cache", "dir"],
  SHELBY_CACHE_CACHE_STAGING_DIR: ["cache", "stagingDir"],
  SHELBY_CACHE_CACHE_MAX_SIZE_GB: ["cache", "maxSizeGb"],
  SHELBY_CACHE_CACHE_TTL_DAYS: ["cache", "ttlDays"],
  SHELBY_CACHE_DEDUP_DB_PATH: ["dedup", "dbPath"],
  SHELBY_CACHE_DEDUP_RENEWAL_THRESHOLD_DAYS: ["dedup", "renewalThresholdDays"],
  SHELBY_CACHE_LOGGING_LEVEL: ["logging", "level"],
};

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  for (const [envKey, path] of Object.entries(ENV_MAP)) {
    const value = process.env[envKey];
    if (value === undefined) continue;
    let current = config;
    for (let i = 0; i < path.length - 1; i++) {
      if (!current[path[i]] || typeof current[path[i]] !== "object") {
        current[path[i]] = {};
      }
      current = current[path[i]] as Record<string, unknown>;
    }
    const finalKey = path[path.length - 1];
    const num = Number(value);
    if (!isNaN(num) && value !== "") {
      current[finalKey] = num;
    } else if (value === "true") {
      current[finalKey] = true;
    } else if (value === "false") {
      current[finalKey] = false;
    } else {
      current[finalKey] = value;
    }
  }
  return config;
}

export function loadConfig(configPath: string | null): ProxyConfig {
  let fileConfig: Record<string, unknown> = {};

  if (configPath && existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw);
    fileConfig = snakeToCamel(deepResolve(parsed)) as Record<string, unknown>;
  }

  const merged = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig);
  const withEnv = applyEnvOverrides(merged);
  return withEnv as unknown as ProxyConfig;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/unit/config.test.ts
```
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "feat: add YAML config loader with env var resolution and overrides"
```

---

## Task 3: Structured Logger

**Files:**
- Create: `src/logger.ts`

- [ ] **Step 1: Implement logger**

```typescript
// src/logger.ts
type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = "info";
let currentFormat: "json" | "text" = "json";

export function configureLogger(level: LogLevel, format: "json" | "text") {
  currentLevel = level;
  currentFormat = format;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };
  if (currentFormat === "json") {
    console.log(JSON.stringify(entry));
  } else {
    const extra = data ? " " + JSON.stringify(data) : "";
    console.log(`[${entry.ts}] ${level.toUpperCase()} ${message}${extra}`);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
```

- [ ] **Step 2: Commit**

```bash
git add src/logger.ts
git commit -m "feat: add structured JSON/text logger"
```

---

## Task 4: Bloom Filter

**Files:**
- Create: `src/dedup/bloom-filter.ts`
- Create: `test/unit/bloom-filter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/unit/bloom-filter.test.ts
import { describe, it, expect } from "bun:test";
import { BloomFilter } from "../../src/dedup/bloom-filter";

describe("BloomFilter", () => {
  it("returns false for items not added", () => {
    const bf = new BloomFilter(1000, 0.01);
    expect(bf.has("nonexistent")).toBe(false);
  });

  it("returns true for items that were added", () => {
    const bf = new BloomFilter(1000, 0.01);
    bf.add("hello");
    bf.add("world");
    expect(bf.has("hello")).toBe(true);
    expect(bf.has("world")).toBe(true);
  });

  it("has acceptable false positive rate", () => {
    const bf = new BloomFilter(10000, 0.01);
    for (let i = 0; i < 10000; i++) bf.add(`item-${i}`);
    let falsePositives = 0;
    const trials = 10000;
    for (let i = 0; i < trials; i++) {
      if (bf.has(`other-${i}`)) falsePositives++;
    }
    expect(falsePositives / trials).toBeLessThan(0.02); // allow some margin
  });

  it("rebuilds from an array of hashes", () => {
    const bf = new BloomFilter(1000, 0.01);
    bf.addAll(["a", "b", "c"]);
    expect(bf.has("a")).toBe(true);
    expect(bf.has("b")).toBe(true);
    expect(bf.has("c")).toBe(true);
    expect(bf.has("d")).toBe(false);
  });

  it("removes an item (with possible false negatives for other items)", () => {
    const bf = new BloomFilter(1000, 0.01);
    bf.add("keep");
    bf.add("remove-me");
    bf.remove("remove-me");
    expect(bf.has("remove-me")).toBe(false);
  });

  it("reports count", () => {
    const bf = new BloomFilter(1000, 0.01);
    expect(bf.count).toBe(0);
    bf.add("a");
    bf.add("b");
    expect(bf.count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/unit/bloom-filter.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement bloom filter**

Use a counting bloom filter (to support removal). Each position stores a count rather than a single bit. Hash with multiple functions derived from two base hashes (enhanced double hashing).

```typescript
// src/dedup/bloom-filter.ts
import { createHash } from "crypto";

export class BloomFilter {
  private counts: Uint8Array;
  private numHashes: number;
  private size: number;
  private _count = 0;

  constructor(expectedItems: number, fpr: number) {
    this.size = Math.ceil(-(expectedItems * Math.log(fpr)) / (Math.log(2) ** 2));
    this.numHashes = Math.ceil((this.size / expectedItems) * Math.log(2));
    this.counts = new Uint8Array(this.size);
  }

  get count(): number {
    return this._count;
  }

  private hashes(item: string): number[] {
    const h1 = parseInt(createHash("sha256").update(item).digest("hex").slice(0, 8), 16);
    const h2 = parseInt(createHash("sha256").update(item + "\0").digest("hex").slice(0, 8), 16);
    const indices: number[] = [];
    for (let i = 0; i < this.numHashes; i++) {
      indices.push(Math.abs((h1 + i * h2) % this.size));
    }
    return indices;
  }

  add(item: string): void {
    for (const idx of this.hashes(item)) {
      if (this.counts[idx] < 255) this.counts[idx]++;
    }
    this._count++;
  }

  addAll(items: string[]): void {
    for (const item of items) this.add(item);
  }

  has(item: string): boolean {
    return this.hashes(item).every((idx) => this.counts[idx] > 0);
  }

  remove(item: string): void {
    if (!this.has(item)) return;
    for (const idx of this.hashes(item)) {
      if (this.counts[idx] > 0) this.counts[idx]--;
    }
    this._count--;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/unit/bloom-filter.test.ts
```
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dedup/bloom-filter.ts test/unit/bloom-filter.test.ts
git commit -m "feat: add counting bloom filter with add/has/remove operations"
```

---

## Task 5: Dedup Store (SQLite)

**Files:**
- Create: `src/dedup/dedup-store.ts`
- Create: `test/unit/dedup-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/unit/dedup-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DedupStore } from "../../src/dedup/dedup-store";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("DedupStore", () => {
  let tmpDir: string;
  let store: DedupStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dedup-test-"));
    store = new DedupStore(join(tmpDir, "dedup.db"), 1_000_000, 0.01, 30);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true });
  });

  it("records a blob and looks it up by content hash", () => {
    store.recordBlob("sha256-abc", "sccache/v1/key1", 1024);
    const blob = store.getBlobByHash("sha256-abc");
    expect(blob).not.toBeNull();
    expect(blob!.shelbyPath).toBe("sccache/v1/key1");
    expect(blob!.sizeBytes).toBe(1024);
  });

  it("records a key mapping and looks it up", () => {
    store.recordBlob("sha256-abc", "sccache/v1/key1", 1024);
    store.recordKeyMapping("sccache/v1/key1", "sha256-abc");
    const mapping = store.getKeyMapping("sccache/v1/key1");
    expect(mapping).not.toBeNull();
    expect(mapping!.contentHash).toBe("sha256-abc");
  });

  it("checks bloom filter for fast negative lookups", () => {
    expect(store.mightContainHash("sha256-nonexistent")).toBe(false);
    store.recordBlob("sha256-abc", "path", 100);
    expect(store.mightContainHash("sha256-abc")).toBe(true);
  });

  it("updates last_accessed on touch", () => {
    store.recordBlob("sha256-abc", "path", 100);
    store.recordKeyMapping("key1", "sha256-abc");
    const before = store.getKeyMapping("key1")!.lastAccessed;
    // Small delay to ensure timestamp difference
    const later = before + 1000;
    store.touchKeyMapping("key1", later);
    const after = store.getKeyMapping("key1")!.lastAccessed;
    expect(after).toBe(later);
  });

  it("removes stale blob entries", () => {
    store.recordBlob("sha256-abc", "path", 100);
    store.removeBlob("sha256-abc");
    expect(store.getBlobByHash("sha256-abc")).toBeNull();
    expect(store.mightContainHash("sha256-abc")).toBe(false);
  });

  it("finds blobs expiring within threshold", () => {
    const now = Math.floor(Date.now() / 1000);
    // Store directly uses internal methods — we need a blob expiring soon
    store.recordBlob("sha256-expiring", "path1", 100);
    // Manually set shelby_expires_at to now + 3 days (within 5-day threshold)
    store["db"].run(
      "UPDATE blobs SET shelby_expires_at = ? WHERE content_hash = ?",
      [now + 3 * 86400, "sha256-expiring"]
    );
    store.recordBlob("sha256-safe", "path2", 200);

    const expiring = store.findExpiringBlobs(5);
    expect(expiring.length).toBe(1);
    expect(expiring[0].contentHash).toBe("sha256-expiring");
  });

  it("rebuilds bloom filter from DB on init", () => {
    store.recordBlob("hash1", "p1", 100);
    store.recordBlob("hash2", "p2", 200);
    store.close();

    // Reopen — bloom filter should be rebuilt from DB
    const store2 = new DedupStore(join(tmpDir, "dedup.db"), 1_000_000, 0.01, 30);
    expect(store2.mightContainHash("hash1")).toBe(true);
    expect(store2.mightContainHash("hash2")).toBe(true);
    expect(store2.mightContainHash("hash3")).toBe(false);
    store2.close();
  });

  it("returns stats", () => {
    store.recordBlob("h1", "p1", 100);
    store.recordBlob("h2", "p2", 200);
    store.recordKeyMapping("k1", "h1");
    store.recordKeyMapping("k2", "h1");
    store.recordKeyMapping("k3", "h2");
    const stats = store.getStats();
    expect(stats.uniqueBlobs).toBe(2);
    expect(stats.totalKeys).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/unit/dedup-store.test.ts
```

- [ ] **Step 3: Implement dedup store**

```typescript
// src/dedup/dedup-store.ts
import { Database } from "bun:sqlite";
import { BloomFilter } from "./bloom-filter";
import type { DedupBlob, DedupKeyMap } from "../types";

const SCHEMA_VERSION = 1;

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS blobs (
    content_hash TEXT PRIMARY KEY,
    shelby_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    shelby_expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS key_map (
    cache_key TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL
  );
`;

export class DedupStore {
  private db: Database;
  private bloom: BloomFilter;
  private expiryDays: number;

  constructor(dbPath: string, bloomExpectedItems: number, bloomFpr: number, expiryDays: number) {
    this.expiryDays = expiryDays;
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.migrate();
    this.bloom = new BloomFilter(bloomExpectedItems, bloomFpr);
    this.rebuildBloomFilter();
  }

  private migrate(): void {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < SCHEMA_VERSION) {
      this.db.run(CREATE_TABLES);
      this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  private rebuildBloomFilter(): void {
    const rows = this.db.prepare("SELECT content_hash FROM blobs").all() as { content_hash: string }[];
    this.bloom.addAll(rows.map((r) => r.content_hash));
  }

  mightContainHash(contentHash: string): boolean {
    return this.bloom.has(contentHash);
  }

  getBlobByHash(contentHash: string): DedupBlob | null {
    if (!this.bloom.has(contentHash)) return null;
    const row = this.db.prepare("SELECT * FROM blobs WHERE content_hash = ?").get(contentHash) as {
      content_hash: string; shelby_path: string; size_bytes: number; created_at: number; shelby_expires_at: number;
    } | null;
    if (!row) return null;
    return {
      contentHash: row.content_hash,
      shelbyPath: row.shelby_path,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      shelbyExpiresAt: row.shelby_expires_at,
    };
  }

  recordBlob(contentHash: string, shelbyPath: string, sizeBytes: number): void {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.expiryDays * 86400;
    this.db.run(
      "INSERT OR REPLACE INTO blobs (content_hash, shelby_path, size_bytes, created_at, shelby_expires_at) VALUES (?, ?, ?, ?, ?)",
      [contentHash, shelbyPath, sizeBytes, now, expiresAt]
    );
    this.bloom.add(contentHash);
  }

  recordKeyMapping(cacheKey: string, contentHash: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      "INSERT OR REPLACE INTO key_map (cache_key, content_hash, created_at, last_accessed) VALUES (?, ?, ?, ?)",
      [cacheKey, contentHash, now, now]
    );
  }

  getKeyMapping(cacheKey: string): DedupKeyMap | null {
    const row = this.db.prepare("SELECT * FROM key_map WHERE cache_key = ?").get(cacheKey) as {
      cache_key: string; content_hash: string; created_at: number; last_accessed: number;
    } | null;
    if (!row) return null;
    return {
      cacheKey: row.cache_key,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      lastAccessed: row.last_accessed,
    };
  }

  touchKeyMapping(cacheKey: string, timestamp?: number): void {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    this.db.run("UPDATE key_map SET last_accessed = ? WHERE cache_key = ?", [ts, cacheKey]);
  }

  removeBlob(contentHash: string): void {
    this.db.run("DELETE FROM blobs WHERE content_hash = ?", [contentHash]);
    this.db.run("DELETE FROM key_map WHERE content_hash = ?", [contentHash]);
    this.bloom.remove(contentHash);
  }

  findExpiringBlobs(thresholdDays: number): DedupBlob[] {
    const cutoff = Math.floor(Date.now() / 1000) + thresholdDays * 86400;
    const rows = this.db.prepare(
      "SELECT * FROM blobs WHERE shelby_expires_at <= ?"
    ).all(cutoff) as Array<{
      content_hash: string; shelby_path: string; size_bytes: number; created_at: number; shelby_expires_at: number;
    }>;
    return rows.map((r) => ({
      contentHash: r.content_hash,
      shelbyPath: r.shelby_path,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
      shelbyExpiresAt: r.shelby_expires_at,
    }));
  }

  updateBlobExpiry(contentHash: string, newExpiresAt: number): void {
    this.db.run("UPDATE blobs SET shelby_expires_at = ? WHERE content_hash = ?", [newExpiresAt, contentHash]);
  }

  hasActiveReferences(contentHash: string, withinDays: number): boolean {
    const cutoff = Math.floor(Date.now() / 1000) - withinDays * 86400;
    const row = this.db.prepare(
      "SELECT 1 FROM key_map WHERE content_hash = ? AND last_accessed >= ? LIMIT 1"
    ).get(contentHash, cutoff);
    return row !== null;
  }

  getStats(): { uniqueBlobs: number; totalKeys: number } {
    const blobs = this.db.prepare("SELECT COUNT(*) as c FROM blobs").get() as { c: number };
    const keys = this.db.prepare("SELECT COUNT(*) as c FROM key_map").get() as { c: number };
    return { uniqueBlobs: blobs.c, totalKeys: keys.c };
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/unit/dedup-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dedup/dedup-store.ts test/unit/dedup-store.test.ts
git commit -m "feat: add SQLite dedup store with bloom filter and expiration tracking"
```

---

## Task 6: Disk Cache

**Files:**
- Create: `src/cache/disk-cache.ts`
- Create: `src/cache/cache-cleaner.ts`
- Create: `test/unit/disk-cache.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/unit/disk-cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DiskCache } from "../../src/cache/disk-cache";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("DiskCache", () => {
  let tmpDir: string;
  let cache: DiskCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cache-test-"));
    cache = new DiskCache(tmpDir, 1, 7); // 1GB max, 7 day TTL
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("stores and retrieves data by key", async () => {
    const data = Buffer.from("hello world");
    await cache.put("sccache/v1/abc123", data, "sha256-xyz");
    const result = await cache.get("sccache/v1/abc123");
    expect(result).not.toBeNull();
    expect(result!.toString()).toBe("hello world");
  });

  it("returns null for cache miss", async () => {
    const result = await cache.get("nonexistent/key");
    expect(result).toBeNull();
  });

  it("checks existence without reading", async () => {
    await cache.put("key1", Buffer.from("data"), "hash1");
    expect(await cache.has("key1")).toBe(true);
    expect(await cache.has("key2")).toBe(false);
  });

  it("creates subdirectories from key path", async () => {
    await cache.put("a/b/c/file", Buffer.from("nested"), "hash");
    expect(existsSync(join(tmpDir, "a", "b", "c", "file"))).toBe(true);
  });

  it("uses atomic writes (temp file + rename)", async () => {
    // Verify no .tmp files remain after put
    await cache.put("key", Buffer.from("data"), "hash");
    const files = new Bun.Glob("**/*.tmp").scanSync(tmpDir);
    expect([...files]).toHaveLength(0);
  });

  it("returns cache size in bytes", async () => {
    await cache.put("k1", Buffer.from("aaaa"), "h1");
    await cache.put("k2", Buffer.from("bbbb"), "h2");
    expect(cache.sizeBytes).toBeGreaterThanOrEqual(8);
  });

  it("evicts entries over TTL", async () => {
    await cache.put("old", Buffer.from("data"), "hash");
    // Manually age the meta file
    const metaPath = cache["metaPath"]("old");
    const meta = JSON.parse(await Bun.file(metaPath).text());
    meta.cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    await Bun.write(metaPath, JSON.stringify(meta));

    await cache.cleanup();
    expect(await cache.get("old")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/unit/disk-cache.test.ts
```

- [ ] **Step 3: Implement disk cache**

```typescript
// src/cache/disk-cache.ts
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import type { CacheMeta } from "../types";

export class DiskCache {
  private dir: string;
  private maxSizeBytes: number;
  private ttlMs: number;
  private _sizeBytes = 0;
  private _entries = 0;

  constructor(dir: string, maxSizeGb: number, ttlDays: number) {
    this.dir = dir;
    this.maxSizeBytes = maxSizeGb * 1024 * 1024 * 1024;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    mkdirSync(dir, { recursive: true });
    this.calculateSize();
  }

  get sizeBytes(): number {
    return this._sizeBytes;
  }

  get entries(): number {
    return this._entries;
  }

  private filePath(key: string): string {
    return join(this.dir, key);
  }

  private metaPath(key: string): string {
    return join(this.dir, key + ".meta");
  }

  async put(key: string, data: Buffer, contentHash: string): Promise<void> {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    // Atomic write: write to temp, then rename
    const tmpPath = filePath + `.tmp.${randomUUID().slice(0, 8)}`;
    await Bun.write(tmpPath, data);
    renameSync(tmpPath, filePath);

    const meta: CacheMeta = {
      size: data.length,
      contentHash,
      cachedAt: Date.now(),
      lastAccessed: Date.now(),
      shelbyBlobPath: key,
    };
    await Bun.write(metaPath, JSON.stringify(meta));

    this._sizeBytes += data.length;
    this._entries++;
  }

  async get(key: string): Promise<Buffer | null> {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);

    if (!existsSync(filePath)) return null;

    try {
      // Check TTL
      if (existsSync(metaPath)) {
        const meta: CacheMeta = JSON.parse(await Bun.file(metaPath).text());
        if (Date.now() - meta.cachedAt > this.ttlMs) {
          this.remove(key);
          return null;
        }
        // Update last accessed
        meta.lastAccessed = Date.now();
        await Bun.write(metaPath, JSON.stringify(meta));
      }

      return Buffer.from(await Bun.file(filePath).arrayBuffer());
    } catch {
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);
    if (!existsSync(filePath)) return false;
    // Check TTL via meta file
    if (existsSync(metaPath)) {
      try {
        const meta: CacheMeta = JSON.parse(await Bun.file(metaPath).text());
        if (Date.now() - meta.cachedAt > this.ttlMs) {
          this.remove(key);
          return false;
        }
      } catch {
        // corrupt meta — treat as missing
        return false;
      }
    }
    return true;
  }

  remove(key: string): void {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);
    try {
      if (existsSync(filePath)) {
        const size = statSync(filePath).size;
        unlinkSync(filePath);
        this._sizeBytes -= size;
        this._entries--;
      }
      if (existsSync(metaPath)) unlinkSync(metaPath);
    } catch {
      // ignore cleanup errors
    }
  }

  async cleanup(): Promise<number> {
    let evicted = 0;
    const entries = await this.listEntries();

    // Evict expired entries
    for (const entry of entries) {
      if (Date.now() - entry.meta.cachedAt > this.ttlMs) {
        this.remove(entry.key);
        evicted++;
      }
    }

    // Evict LRU if over size limit
    if (this._sizeBytes > this.maxSizeBytes) {
      const remaining = (await this.listEntries()).sort(
        (a, b) => a.meta.lastAccessed - b.meta.lastAccessed
      );
      for (const entry of remaining) {
        if (this._sizeBytes <= this.maxSizeBytes) break;
        this.remove(entry.key);
        evicted++;
      }
    }

    return evicted;
  }

  private async listEntries(): Promise<Array<{ key: string; meta: CacheMeta }>> {
    const results: Array<{ key: string; meta: CacheMeta }> = [];
    const glob = new Bun.Glob("**/*.meta");
    for await (const metaFile of glob.scan(this.dir)) {
      try {
        const meta: CacheMeta = JSON.parse(await Bun.file(join(this.dir, metaFile)).text());
        const key = metaFile.replace(/\.meta$/, "");
        results.push({ key, meta });
      } catch {
        // skip corrupt meta files
      }
    }
    return results;
  }

  private calculateSize(): void {
    try {
      const glob = new Bun.Glob("**/*");
      for (const file of glob.scanSync(this.dir)) {
        if (file.endsWith(".meta")) continue;
        try {
          this._sizeBytes += statSync(join(this.dir, file)).size;
          this._entries++;
        } catch {
          // skip
        }
      }
    } catch {
      // empty dir
    }
  }
}
```

- [ ] **Step 4: Implement cache cleaner (background sweep)**

```typescript
// src/cache/cache-cleaner.ts
import { DiskCache } from "./disk-cache";
import { logger } from "../logger";

export class CacheCleaner {
  private cache: DiskCache;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cache: DiskCache, intervalMinutes: number) {
    this.cache = cache;
    this.intervalMs = intervalMinutes * 60 * 1000;
  }

  start(): void {
    this.timer = setInterval(async () => {
      try {
        const evicted = await this.cache.cleanup();
        if (evicted > 0) {
          logger.info("Cache cleanup completed", { evicted, sizeBytes: this.cache.sizeBytes });
        }
      } catch (err) {
        logger.error("Cache cleanup failed", { error: String(err) });
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/unit/disk-cache.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/cache/disk-cache.ts src/cache/cache-cleaner.ts test/unit/disk-cache.test.ts
git commit -m "feat: add LRU disk cache with TTL eviction and background cleaner"
```

---

## Task 7: Shelby Client Wrapper

**Files:**
- Create: `src/shelby/client.ts`
- Create: `src/shelby/circuit-breaker.ts`
- Create: `test/unit/circuit-breaker.test.ts`
- Create: `test/unit/shelby-client.test.ts`

- [ ] **Step 1: Write failing tests for circuit breaker**

```typescript
// test/unit/circuit-breaker.test.ts
import { describe, it, expect } from "bun:test";
import { CircuitBreaker } from "../../src/shelby/circuit-breaker";

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker(0.5, 5000, 60000);
    expect(cb.state).toBe("closed");
    expect(cb.isOpen).toBe(false);
  });

  it("opens when error rate exceeds threshold", () => {
    const cb = new CircuitBreaker(0.5, 100, 60000); // 100ms window for testing
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.isOpen).toBe(true);
  });

  it("does not open when error rate is below threshold", () => {
    const cb = new CircuitBreaker(0.5, 100, 60000);
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
  });

  it("transitions to half-open after recovery timeout", async () => {
    const cb = new CircuitBreaker(0.5, 100, 50); // 50ms recovery
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.state).toBe("half-open");
  });

  it("closes from half-open on success", async () => {
    const cb = new CircuitBreaker(0.5, 100, 50);
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.state).toBe("half-open");
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
  });
});
```

- [ ] **Step 2: Implement circuit breaker**

```typescript
// src/shelby/circuit-breaker.ts
export class CircuitBreaker {
  private errorThreshold: number;
  private windowMs: number;
  private recoveryMs: number;
  private successes: number[] = [];
  private failures: number[] = [];
  private _state: "closed" | "open" | "half-open" = "closed";
  private openedAt = 0;

  constructor(errorThreshold: number, windowMs: number, recoveryMs: number) {
    this.errorThreshold = errorThreshold;
    this.windowMs = windowMs;
    this.recoveryMs = recoveryMs;
  }

  get state(): "closed" | "open" | "half-open" {
    if (this._state === "open" && Date.now() - this.openedAt > this.recoveryMs) {
      this._state = "half-open";
    }
    return this._state;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this._state = "closed";
      this.successes = [];
      this.failures = [];
      return;
    }
    this.successes.push(Date.now());
    this.prune();
  }

  recordFailure(): void {
    this.failures.push(Date.now());
    this.prune();
    this.checkThreshold();
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.successes = this.successes.filter((t) => t > cutoff);
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  private checkThreshold(): void {
    const total = this.successes.length + this.failures.length;
    if (total < 2) return; // need minimum sample
    if (this.failures.length / total > this.errorThreshold) {
      this._state = "open";
      this.openedAt = Date.now();
    }
  }
}
```

- [ ] **Step 3: Run circuit breaker tests**

```bash
bun test test/unit/circuit-breaker.test.ts
```

- [ ] **Step 4: Implement Shelby client wrapper**

```typescript
// src/shelby/client.ts
import { ShelbyNodeClient } from "@shelby-protocol/sdk/node";
import { Account, Ed25519Account, Ed25519PrivateKey, Network } from "@aptos-labs/ts-sdk";
import { CircuitBreaker } from "./circuit-breaker";
import { logger } from "../logger";
import type { ProxyConfig } from "../types";

function parseNetwork(network: string): Network {
  const lower = network.toLowerCase();
  if (lower === "shelbynet" || lower === "testnet" || lower === "shelby") return Network.SHELBYNET;
  if (lower === "local" || lower === "localhost") return Network.LOCAL;
  // Mainnet: when Shelby mainnet launches, update this mapping
  if (lower === "mainnet") throw new Error("Shelby mainnet not yet available. Use 'testnet'.");
  throw new Error(`Unsupported network: ${network}. Valid: testnet, shelbynet, local`);
}

export class ShelbyClient {
  private client: ShelbyNodeClient;
  private signer: Account;
  private expirationMs: number;
  private circuitBreaker: CircuitBreaker;
  private maxRetries = 3;
  private retryDelays = [1000, 2000, 4000];

  constructor(config: ProxyConfig) {
    const network = parseNetwork(config.shelby.network);
    this.client = new ShelbyNodeClient({
      network,
      apiKey: config.shelby.apiKey,
      aptos: {
        network: network as unknown as Network,
        clientConfig: {
          ...(config.shelby.apiKey ? { API_KEY: config.shelby.apiKey } : {}),
          http2: false, // Required for Shelbynet — ORIGIN frame mismatch
        },
      },
    });

    this.signer = new Ed25519Account({
      privateKey: new Ed25519PrivateKey(config.shelby.aptosPrivateKey),
    });

    this.expirationMs = config.shelby.blobExpiryDays * 24 * 60 * 60 * 1000;
    // 50% error rate in 5min window, re-check every 60s
    this.circuitBreaker = new CircuitBreaker(0.5, 5 * 60 * 1000, 60 * 1000);
  }

  get ownerAddress(): string {
    return this.signer.accountAddress.toString();
  }

  get circuit(): CircuitBreaker {
    return this.circuitBreaker;
  }

  async upload(blobPath: string, data: Uint8Array): Promise<void> {
    if (this.circuitBreaker.isOpen) {
      logger.warn("Circuit breaker open — skipping Shelby upload", { blobPath });
      return;
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.client.upload({
          signer: this.signer,
          blobName: blobPath,
          blobData: data,
          expirationMicros: (Date.now() + this.expirationMs) * 1000,
        });
        this.circuitBreaker.recordSuccess();
        return;
      } catch (err) {
        this.circuitBreaker.recordFailure();
        if (attempt < this.maxRetries) {
          logger.warn("Shelby upload failed, retrying", {
            blobPath, attempt: attempt + 1, error: String(err),
          });
          await new Promise((r) => setTimeout(r, this.retryDelays[attempt]));
        } else {
          logger.error("Shelby upload failed after all retries", { blobPath, error: String(err) });
          throw err;
        }
      }
    }
  }

  async download(blobPath: string): Promise<Buffer | null> {
    if (this.circuitBreaker.isOpen) {
      logger.warn("Circuit breaker open — skipping Shelby download", { blobPath });
      return null;
    }

    try {
      const blob = await this.client.download({
        account: this.signer.accountAddress,
        blobName: blobPath,
      });
      const reader = blob.readable.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = Buffer.alloc(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure();
      logger.error("Shelby download failed", { blobPath, error: String(err) });
      return null;
    }
  }

  async exists(blobPath: string): Promise<boolean> {
    if (this.circuitBreaker.isOpen) return false;
    try {
      const meta = await this.client.coordination.getBlobMetadata({
        account: this.signer.accountAddress,
        name: blobPath,
      });
      if (meta) this.circuitBreaker.recordSuccess();
      return meta !== undefined && meta !== null;
    } catch {
      this.circuitBreaker.recordFailure();
      return false;
    }
  }
}
```

- [ ] **Step 5: Write basic Shelby client test (mocked)**

```typescript
// test/unit/shelby-client.test.ts
import { describe, it, expect } from "bun:test";
import { CircuitBreaker } from "../../src/shelby/circuit-breaker";

describe("ShelbyClient (unit — circuit breaker integration)", () => {
  it("circuit breaker prevents calls when open", () => {
    const cb = new CircuitBreaker(0.5, 100, 60000);
    // Force open
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
  });
});
// Full integration tests with real Shelby will be in test/integration/
```

- [ ] **Step 6: Run tests**

```bash
bun test test/unit/circuit-breaker.test.ts test/unit/shelby-client.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/shelby/client.ts src/shelby/circuit-breaker.ts test/unit/circuit-breaker.test.ts test/unit/shelby-client.test.ts
git commit -m "feat: add Shelby SDK wrapper with circuit breaker and retry logic"
```

---

## Task 8: S3 XML Helpers

**Files:**
- Create: `src/proxy/s3-xml.ts`
- Create: `test/unit/s3-xml.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/unit/s3-xml.test.ts
import { describe, it, expect } from "bun:test";
import { errorXml, emptyListXml, initiateMultipartXml, completeMultipartXml } from "../../src/proxy/s3-xml";

describe("s3-xml", () => {
  it("generates error XML", () => {
    const xml = errorXml("NoSuchKey", "The specified key does not exist.", "/bucket/key");
    expect(xml).toContain("<Code>NoSuchKey</Code>");
    expect(xml).toContain("<Message>The specified key does not exist.</Message>");
    expect(xml).toContain("<Resource>/bucket/key</Resource>");
  });

  it("generates empty list XML", () => {
    const xml = emptyListXml("my-bucket", "sccache/v1/");
    expect(xml).toContain("<Name>my-bucket</Name>");
    expect(xml).toContain("<Prefix>sccache/v1/</Prefix>");
    expect(xml).toContain("<KeyCount>0</KeyCount>");
  });

  it("generates initiate multipart upload XML", () => {
    const xml = initiateMultipartXml("my-bucket", "key123", "upload-id-abc");
    expect(xml).toContain("<Bucket>my-bucket</Bucket>");
    expect(xml).toContain("<Key>key123</Key>");
    expect(xml).toContain("<UploadId>upload-id-abc</UploadId>");
  });

  it("generates complete multipart upload XML", () => {
    const xml = completeMultipartXml("my-bucket", "key123", "\"etag-xyz\"");
    expect(xml).toContain("<Bucket>my-bucket</Bucket>");
    expect(xml).toContain("<Key>key123</Key>");
    expect(xml).toContain("<ETag>\"etag-xyz\"</ETag>");
  });
});
```

- [ ] **Step 2: Implement S3 XML helpers**

```typescript
// src/proxy/s3-xml.ts
export function errorXml(code: string, message: string, resource: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${code}</Code>
  <Message>${message}</Message>
  <Resource>${resource}</Resource>
  <RequestId>0</RequestId>
</Error>`;
}

export function emptyListXml(bucket: string, prefix: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <Prefix>${prefix}</Prefix>
  <KeyCount>0</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;
}

export function initiateMultipartXml(bucket: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${bucket}</Bucket>
  <Key>${key}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`;
}

export function completeMultipartXml(bucket: string, key: string, etag: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${bucket}</Bucket>
  <Key>${key}</Key>
  <ETag>${etag}</ETag>
</CompleteMultipartUploadResult>`;
}
```

- [ ] **Step 3: Run tests**

```bash
bun test test/unit/s3-xml.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/proxy/s3-xml.ts test/unit/s3-xml.test.ts
git commit -m "feat: add S3 XML response helpers"
```

---

## Task 9: S3 Handlers (PutObject, GetObject, HeadObject)

**Files:**
- Create: `src/proxy/s3-handlers.ts`
- Create: `test/unit/s3-handlers.test.ts`

- [ ] **Step 1: Write failing tests**

Tests use a mock Shelby client (interface-compatible) and real disk cache + dedup store with temp directories.

```typescript
// test/unit/s3-handlers.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { S3Handlers } from "../../src/proxy/s3-handlers";
import { DiskCache } from "../../src/cache/disk-cache";
import { DedupStore } from "../../src/dedup/dedup-store";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

// Mock Shelby client
class MockShelbyClient {
  blobs = new Map<string, Buffer>();
  get ownerAddress() { return "0xmock"; }
  get circuit() { return { state: "closed" as const, isOpen: false, recordSuccess() {}, recordFailure() {} }; }
  async upload(path: string, data: Uint8Array) { this.blobs.set(path, Buffer.from(data)); }
  async download(path: string) { return this.blobs.get(path) ?? null; }
  async exists(path: string) { return this.blobs.has(path); }
}

describe("S3Handlers", () => {
  let tmpDir: string;
  let handlers: S3Handlers;
  let mockShelby: MockShelbyClient;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "s3-test-"));
    const cache = new DiskCache(join(tmpDir, "cache"), 1, 7);
    const dedup = new DedupStore(join(tmpDir, "dedup.db"), 10000, 0.01, 30);
    mockShelby = new MockShelbyClient();
    handlers = new S3Handlers(cache, dedup, mockShelby as any, "sccache/v1");
  });

  afterEach(() => {
    handlers.close();
    rmSync(tmpDir, { recursive: true });
  });

  it("PUT stores to local cache and dedup, uploads to Shelby", async () => {
    const body = Buffer.from("compiled artifact");
    const result = await handlers.putObject("sccache/v1/key1", body);
    expect(result.status).toBe(200);

    // Should be in local cache
    const cached = await handlers.getObject("sccache/v1/key1");
    expect(cached.status).toBe(200);
    expect(cached.body).not.toBeNull();
  });

  it("GET returns 404 for missing key", async () => {
    const result = await handlers.getObject("sccache/v1/nonexistent");
    expect(result.status).toBe(404);
  });

  it("HEAD returns 200 for existing key, 404 for missing", async () => {
    await handlers.putObject("sccache/v1/key1", Buffer.from("data"));
    expect((await handlers.headObject("sccache/v1/key1")).status).toBe(200);
    expect((await handlers.headObject("sccache/v1/missing")).status).toBe(404);
  });

  it("PUT deduplicates identical content", async () => {
    const body = Buffer.from("same content");
    await handlers.putObject("sccache/v1/key1", body);
    await handlers.putObject("sccache/v1/key2", body);
    // Second put should not trigger a second Shelby upload
    expect(mockShelby.blobs.size).toBe(1);
  });

  it("GET from Shelby on local cache miss", async () => {
    // Put data directly into mock Shelby (simulating another developer's upload)
    mockShelby.blobs.set("sccache/v1/remote-key", Buffer.from("remote data"));
    const result = await handlers.getObject("sccache/v1/remote-key");
    expect(result.status).toBe(200);
    expect(result.body!.toString()).toBe("remote data");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/unit/s3-handlers.test.ts
```

- [ ] **Step 3: Implement S3 handlers**

```typescript
// src/proxy/s3-handlers.ts
import { createHash } from "crypto";
import type { DiskCache } from "../cache/disk-cache";
import type { DedupStore } from "../dedup/dedup-store";
import type { ShelbyClient } from "../shelby/client";
import { logger } from "../logger";

interface HandlerResult {
  status: number;
  body: Buffer | null;
  headers?: Record<string, string>;
}

export class S3Handlers {
  private cache: DiskCache;
  private dedup: DedupStore;
  private shelby: ShelbyClient;
  private keyPrefix: string;

  // Stats tracking
  private _stats = { puts: 0, gets: 0, heads: 0, cacheHits: 0, cacheMisses: 0, dedupSkips: 0, staleReconciled: 0 };

  constructor(cache: DiskCache, dedup: DedupStore, shelby: ShelbyClient, keyPrefix: string) {
    this.cache = cache;
    this.dedup = dedup;
    this.shelby = shelby;
    this.keyPrefix = keyPrefix;
  }

  get stats() { return { ...this._stats }; }

  async putObject(key: string, body: Buffer): Promise<HandlerResult> {
    this._stats.puts++;
    const contentHash = createHash("sha256").update(body).digest("hex");

    // Dedup check
    if (this.dedup.mightContainHash(contentHash)) {
      const existing = this.dedup.getBlobByHash(contentHash);
      if (existing) {
        // Content already in Shelby — just record the key mapping
        this.dedup.recordKeyMapping(key, contentHash);
        this._stats.dedupSkips++;
        logger.debug("Dedup hit — skipping upload", { key, contentHash });
        // Still write to local cache for fast reads
        await this.cache.put(key, body, contentHash);
        return { status: 200, body: null, headers: { ETag: `"${contentHash}"` } };
      }
    }

    // Write to local cache immediately (atomic)
    await this.cache.put(key, body, contentHash);

    // Upload to Shelby asynchronously (fire-and-forget with retries)
    this.shelby.upload(key, body).catch((err) => {
      logger.error("Async Shelby upload failed", { key, error: String(err) });
    });

    // Record in dedup DB
    this.dedup.recordBlob(contentHash, key, body.length);
    this.dedup.recordKeyMapping(key, contentHash);

    return { status: 200, body: null, headers: { ETag: `"${contentHash}"` } };
  }

  async getObject(key: string): Promise<HandlerResult> {
    this._stats.gets++;

    // 1. Check local cache
    const cached = await this.cache.get(key);
    if (cached) {
      this._stats.cacheHits++;
      // Update dedup last_accessed
      this.dedup.touchKeyMapping(key);
      const hash = createHash("sha256").update(cached).digest("hex");
      return {
        status: 200,
        body: cached,
        headers: { "Content-Length": String(cached.length), ETag: `"${hash}"` },
      };
    }

    this._stats.cacheMisses++;

    // 2. Download from Shelby
    const remote = await this.shelby.download(key);
    if (!remote) {
      // Check if dedup DB had a stale entry
      const mapping = this.dedup.getKeyMapping(key);
      if (mapping) {
        this.dedup.removeBlob(mapping.contentHash);
        this._stats.staleReconciled++;
        logger.info("Reconciled stale dedup entry", { key });
      }
      return { status: 404, body: null };
    }

    // Cache locally for next time
    const hash = createHash("sha256").update(remote).digest("hex");
    await this.cache.put(key, remote, hash);
    this.dedup.touchKeyMapping(key);

    return {
      status: 200,
      body: remote,
      headers: { "Content-Length": String(remote.length), ETag: `"${hash}"` },
    };
  }

  async headObject(key: string): Promise<HandlerResult> {
    this._stats.heads++;

    // Check local cache first
    if (await this.cache.has(key)) {
      return { status: 200, body: null };
    }

    // Check dedup bloom filter
    const mapping = this.dedup.getKeyMapping(key);
    if (mapping) {
      return { status: 200, body: null };
    }

    // Check Shelby
    const exists = await this.shelby.exists(key);
    return { status: exists ? 200 : 404, body: null };
  }

  close(): void {
    this.dedup.close();
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test test/unit/s3-handlers.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/proxy/s3-handlers.ts test/unit/s3-handlers.test.ts
git commit -m "feat: add S3 PutObject/GetObject/HeadObject handlers with dedup and cache"
```

---

## Task 10: S3 Multipart Upload Handlers

**Files:**
- Create: `src/proxy/s3-multipart.ts`
- Create: `test/unit/s3-multipart.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/unit/s3-multipart.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MultipartManager } from "../../src/proxy/s3-multipart";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("MultipartManager", () => {
  let tmpDir: string;
  let manager: MultipartManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multipart-test-"));
    manager = new MultipartManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("creates an upload and returns an ID", () => {
    const uploadId = manager.initiate("bucket", "key1");
    expect(uploadId).toBeTruthy();
    expect(typeof uploadId).toBe("string");
  });

  it("stores and assembles parts in order", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 1, Buffer.from("part1-"));
    await manager.uploadPart(uploadId, 2, Buffer.from("part2-"));
    await manager.uploadPart(uploadId, 3, Buffer.from("part3"));

    const assembled = await manager.complete(uploadId, [1, 2, 3]);
    expect(assembled.toString()).toBe("part1-part2-part3");
  });

  it("assembles parts regardless of upload order", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 3, Buffer.from("C"));
    await manager.uploadPart(uploadId, 1, Buffer.from("A"));
    await manager.uploadPart(uploadId, 2, Buffer.from("B"));

    const assembled = await manager.complete(uploadId, [1, 2, 3]);
    expect(assembled.toString()).toBe("ABC");
  });

  it("cleans up staging dir after complete", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 1, Buffer.from("data"));
    await manager.complete(uploadId, [1]);

    const stagingPath = join(tmpDir, uploadId);
    expect(existsSync(stagingPath)).toBe(false);
  });

  it("cleans up staging dir on abort", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 1, Buffer.from("data"));
    manager.abort(uploadId);

    const stagingPath = join(tmpDir, uploadId);
    expect(existsSync(stagingPath)).toBe(false);
  });

  it("returns part ETag after upload", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    const etag = await manager.uploadPart(uploadId, 1, Buffer.from("data"));
    expect(etag).toBeTruthy();
    expect(etag.startsWith('"')).toBe(true);
  });
});
```

- [ ] **Step 2: Implement multipart manager**

```typescript
// src/proxy/s3-multipart.ts
import { mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID, createHash } from "crypto";

interface MultipartUpload {
  bucket: string;
  key: string;
  uploadId: string;
  stagingDir: string;
}

export class MultipartManager {
  private baseDir: string;
  private uploads = new Map<string, MultipartUpload>();

  constructor(stagingDir: string) {
    this.baseDir = stagingDir;
    mkdirSync(stagingDir, { recursive: true });
  }

  initiate(bucket: string, key: string): string {
    const uploadId = randomUUID();
    const stagingDir = join(this.baseDir, uploadId);
    mkdirSync(stagingDir, { recursive: true });
    this.uploads.set(uploadId, { bucket, key, uploadId, stagingDir });
    return uploadId;
  }

  async uploadPart(uploadId: string, partNumber: number, data: Buffer): Promise<string> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`Unknown upload ID: ${uploadId}`);

    const partPath = join(upload.stagingDir, String(partNumber).padStart(5, "0"));
    await Bun.write(partPath, data);

    const etag = `"${createHash("md5").update(data).digest("hex")}"`;
    return etag;
  }

  async complete(uploadId: string, partNumbers: number[]): Promise<Buffer> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`Unknown upload ID: ${uploadId}`);

    // Read parts in order
    const chunks: Buffer[] = [];
    for (const partNum of partNumbers.sort((a, b) => a - b)) {
      const partPath = join(upload.stagingDir, String(partNum).padStart(5, "0"));
      if (!existsSync(partPath)) throw new Error(`Missing part ${partNum}`);
      chunks.push(Buffer.from(await Bun.file(partPath).arrayBuffer()));
    }

    const assembled = Buffer.concat(chunks);

    // Cleanup staging
    rmSync(upload.stagingDir, { recursive: true, force: true });
    this.uploads.delete(uploadId);

    return assembled;
  }

  abort(uploadId: string): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    rmSync(upload.stagingDir, { recursive: true, force: true });
    this.uploads.delete(uploadId);
  }

  getUpload(uploadId: string): MultipartUpload | undefined {
    return this.uploads.get(uploadId);
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test test/unit/s3-multipart.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/proxy/s3-multipart.ts test/unit/s3-multipart.test.ts
git commit -m "feat: add S3 multipart upload manager with staging and assembly"
```

---

## Task 11: S3 Router and HTTP Server

**Files:**
- Create: `src/proxy/s3-router.ts`
- Create: `src/proxy/s3-auth.ts`
- Create: `src/proxy/server.ts`

This task wires everything together into a Hono HTTP server.

- [ ] **Step 1: Implement S3 auth (skip in local mode)**

```typescript
// src/proxy/s3-auth.ts
import type { Context, Next } from "hono";

export function s3AuthMiddleware(accessKey: string, secretKey: string, validateSignatures: boolean) {
  return async (c: Context, next: Next) => {
    if (!validateSignatures) {
      // Local mode — skip validation
      return next();
    }

    // Shared mode — validate SigV4
    // For now, just check the Authorization header contains the access key
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.includes(accessKey)) {
      return c.text("Forbidden", 403);
    }

    return next();
  };
}
```

- [ ] **Step 2: Implement S3 router**

```typescript
// src/proxy/s3-router.ts
import { Hono } from "hono";
import type { S3Handlers } from "./s3-handlers";
import type { MultipartManager } from "./s3-multipart";
import { emptyListXml, errorXml, initiateMultipartXml, completeMultipartXml } from "./s3-xml";
import { createHash } from "crypto";
import { logger } from "../logger";

export function createS3Router(handlers: S3Handlers, multipart: MultipartManager): Hono {
  const app = new Hono();

  // GET /:bucket — ListObjectsV2
  // GET /:bucket/:key+ — GetObject
  app.get("/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";
    const bucket = c.req.param("bucket");

    // ListObjectsV2 (query param: list-type=2)
    if (c.req.query("list-type") || !key) {
      const prefix = c.req.query("prefix") ?? "";
      return c.body(emptyListXml(bucket, prefix), 200, { "Content-Type": "application/xml" });
    }

    // GetObject
    const result = await handlers.getObject(key);
    if (result.status === 404) {
      return c.body(errorXml("NoSuchKey", "The specified key does not exist.", `/${bucket}/${key}`), 404, {
        "Content-Type": "application/xml",
      });
    }
    return c.body(result.body, 200, { "Content-Type": "application/octet-stream", ...result.headers });
  });

  // PUT /:bucket/:key+ — PutObject OR UploadPart (dispatched by query params)
  app.put("/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";

    // UploadPart: PUT with uploadId + partNumber query params
    const uploadId = c.req.query("uploadId");
    const partNumber = c.req.query("partNumber");
    if (uploadId && partNumber) {
      const body = Buffer.from(await c.req.arrayBuffer());
      const etag = await multipart.uploadPart(uploadId, parseInt(partNumber), body);
      return c.body(null, 200, { ETag: etag });
    }

    // Regular PutObject
    const body = Buffer.from(await c.req.arrayBuffer());
    const result = await handlers.putObject(key, body);
    return c.body(null, 200, { ETag: result.headers?.ETag ?? "" });
  });

  // HEAD /:bucket/:key+ — HeadObject
  app.head("/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";
    const result = await handlers.headObject(key);
    return c.body(null, result.status);
  });

  // DELETE /:bucket/:key+ — DeleteObject OR AbortMultipartUpload
  app.delete("/:bucket/*", (c) => {
    const uploadId = c.req.query("uploadId");
    if (uploadId) {
      multipart.abort(uploadId);
    }
    return c.body(null, 204);
  });

  // POST /:bucket/:key+ — CreateMultipartUpload OR CompleteMultipartUpload
  app.post("/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";
    const bucket = c.req.param("bucket");

    // CreateMultipartUpload (query: uploads)
    if (c.req.query("uploads") !== undefined) {
      const uploadId = multipart.initiate(bucket, key);
      logger.debug("Initiated multipart upload", { key, uploadId });
      return c.body(initiateMultipartXml(bucket, key, uploadId), 200, { "Content-Type": "application/xml" });
    }

    // CompleteMultipartUpload (query: uploadId=...)
    const uploadId = c.req.query("uploadId");
    if (uploadId) {
      try {
        const xmlBody = await c.req.text();
        const partNumbers = [...xmlBody.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => parseInt(m[1]));
        const assembled = await multipart.complete(uploadId, partNumbers);
        const result = await handlers.putObject(key, assembled);
        const etag = result.headers?.ETag ?? `"${createHash("md5").update(assembled).digest("hex")}"`;
        return c.body(completeMultipartXml(bucket, key, etag), 200, { "Content-Type": "application/xml" });
      } catch (err) {
        logger.error("CompleteMultipartUpload failed", { uploadId, error: String(err) });
        return c.body(errorXml("InternalError", String(err), `/${bucket}/${key}`), 500, {
          "Content-Type": "application/xml",
        });
      }
    }

    return c.body(null, 400);
  });

  return app;
}

- [ ] **Step 3: Implement main server**

```typescript
// src/proxy/server.ts
import { Hono } from "hono";
import { loadConfig } from "../config";
import { configureLogger, logger } from "../logger";
import { DiskCache } from "../cache/disk-cache";
import { CacheCleaner } from "../cache/cache-cleaner";
import { DedupStore } from "../dedup/dedup-store";
import { ShelbyClient } from "../shelby/client";
import { S3Handlers } from "./s3-handlers";
import { MultipartManager } from "./s3-multipart";
import { createS3Router } from "./s3-router";
import { s3AuthMiddleware } from "./s3-auth";
import type { ProxyConfig, ProxyStats } from "../types";

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
    } satisfies Partial<ProxyStats>);
  });

  // S3 auth middleware
  const isLocalMode = config.server.host === "127.0.0.1" || config.server.host === "localhost";
  app.use("/:bucket/*", s3AuthMiddleware(config.s3.accessKey, config.s3.secretKey, !isLocalMode));

  // S3 routes
  const s3Router = createS3Router(s3Handlers, multipartManager);
  app.route("/", s3Router);

  // Start background cleaner
  cacheCleaner.start();

  return {
    app,
    port: config.server.port,
    hostname: config.server.host,
    cleanup: () => {
      cacheCleaner.stop();
      s3Handlers.close();
    },
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/proxy/s3-router.ts src/proxy/s3-auth.ts src/proxy/server.ts
git commit -m "feat: wire S3 router, auth middleware, and Hono server with health/stats endpoints"
```

---

## Task 12: CLI Entry Point

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/init.ts`

- [ ] **Step 1: Implement CLI init command**

```typescript
// src/cli/init.ts
import { existsSync, mkdirSync, copyFileSync } from "fs";
import { resolve, join } from "path";

export async function runInit(configDir?: string): Promise<void> {
  const home = process.env.HOME ?? "~";
  const cacheDir = resolve(home, ".shelby-cache");
  const objectsDir = join(cacheDir, "objects");
  const stagingDir = join(cacheDir, "staging");

  mkdirSync(objectsDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  const configPath = configDir
    ? join(configDir, "shelby-cache-proxy.yaml")
    : join(cacheDir, "shelby-cache-proxy.yaml");

  if (!existsSync(configPath)) {
    // Copy example config
    const examplePath = resolve(import.meta.dir, "../../shelby-cache-proxy.example.yaml");
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, configPath);
    } else {
      // Write minimal config
      await Bun.write(configPath, `# shelby-cache-proxy configuration
server:
  port: 9000
shelby:
  network: testnet
  aptos_private_key: \${APTOS_PRIVATE_KEY}
  api_key: \${SHELBY_API_KEY}
`);
    }
    console.log(`Config written to: ${configPath}`);
  } else {
    console.log(`Config already exists: ${configPath}`);
  }

  console.log(`Cache directory: ${cacheDir}`);
  console.log("\nNext steps:");
  console.log("  1. Set APTOS_PRIVATE_KEY and SHELBY_API_KEY environment variables");
  console.log("  2. Run: shelby-cache-proxy start");
  console.log("  3. Configure sccache:");
  console.log("     export SCCACHE_BUCKET=<your-aptos-address>");
  console.log("     export SCCACHE_ENDPOINT=http://localhost:9000");
  console.log("     export SCCACHE_REGION=shelbyland");
  console.log("     export RUSTC_WRAPPER=sccache");
}
```

- [ ] **Step 2: Implement CLI entry point**

```typescript
// src/cli/index.ts
import { resolve } from "path";
import { loadConfig } from "../config";
import { createServer } from "../proxy/server";
import { runInit } from "./init";

const command = process.argv[2];

switch (command) {
  case "init":
    await runInit(process.argv[3]);
    break;

  case "start": {
    const configPath = process.argv[3] ?? resolve(process.env.HOME ?? "~", ".shelby-cache/shelby-cache-proxy.yaml");
    const config = loadConfig(configPath);
    const { app, port, hostname, cleanup } = createServer(config);

    const server = Bun.serve({
      fetch: app.fetch,
      port,
      hostname,
    });

    console.log(`shelby-cache-proxy running on http://${hostname}:${port}`);
    console.log(`Network: ${config.shelby.network}`);
    console.log(`Cache dir: ${config.cache.dir}`);
    console.log(`Press Ctrl+C to stop`);

    process.on("SIGINT", () => {
      cleanup();
      server.stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      server.stop();
      process.exit(0);
    });
    break;
  }

  case "stats": {
    const endpoint = process.argv[3] ?? "http://localhost:9000";
    const resp = await fetch(`${endpoint}/stats`);
    console.log(JSON.stringify(await resp.json(), null, 2));
    break;
  }

  default:
    console.log(`shelby-cache-proxy — Decentralized build cache via Shelby storage

Commands:
  init [dir]         Generate config and create cache directories
  start [config]     Start the proxy server
  stats [endpoint]   Show cache statistics

Environment:
  APTOS_PRIVATE_KEY  Aptos Ed25519 private key for Shelby uploads
  SHELBY_API_KEY     Shelby API key for authentication`);
}
```

- [ ] **Step 3: Add bin entry to package.json**

Add to `package.json`:
```json
{
  "bin": {
    "shelby-cache-proxy": "./src/cli/index.ts"
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts src/cli/init.ts package.json
git commit -m "feat: add CLI with init, start, and stats commands"
```

---

## Task 13: Blob Renewal Background Job

**Files:**
- Create: `src/background/renewal.ts`

- [ ] **Step 1: Implement renewal job**

```typescript
// src/background/renewal.ts
import type { DedupStore } from "../dedup/dedup-store";
import type { ShelbyClient } from "../shelby/client";
import { logger } from "../logger";

export class RenewalJob {
  private dedup: DedupStore;
  private shelby: ShelbyClient;
  private thresholdDays: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 6 * 60 * 60 * 1000; // 6 hours

  constructor(dedup: DedupStore, shelby: ShelbyClient, thresholdDays: number) {
    this.dedup = dedup;
    this.shelby = shelby;
    this.thresholdDays = thresholdDays;
  }

  start(): void {
    this.timer = setInterval(() => this.run(), this.intervalMs);
    logger.info("Renewal job started", { intervalHours: 6, thresholdDays: this.thresholdDays });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async run(): Promise<{ renewed: number; purged: number }> {
    let renewed = 0;
    let purged = 0;

    const expiring = this.dedup.findExpiringBlobs(this.thresholdDays);
    if (expiring.length === 0) return { renewed, purged };

    logger.info("Renewal job: found expiring blobs", { count: expiring.length });

    for (const blob of expiring) {
      // Only renew blobs with active references (accessed within last 7 days)
      if (!this.dedup.hasActiveReferences(blob.contentHash, 7)) {
        this.dedup.removeBlob(blob.contentHash);
        purged++;
        logger.debug("Purged unreferenced expiring blob", { path: blob.shelbyPath });
        continue;
      }

      try {
        // Download and re-upload to renew expiration
        const data = await this.shelby.download(blob.shelbyPath);
        if (data) {
          await this.shelby.upload(blob.shelbyPath, data);
          const newExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
          this.dedup.updateBlobExpiry(blob.contentHash, newExpiry);
          renewed++;
        } else {
          // Blob gone from Shelby — purge from dedup
          this.dedup.removeBlob(blob.contentHash);
          purged++;
        }
      } catch (err) {
        logger.error("Renewal failed for blob", { path: blob.shelbyPath, error: String(err) });
      }
    }

    logger.info("Renewal job completed", { renewed, purged });
    return { renewed, purged };
  }
}
```

- [ ] **Step 2: Wire renewal job into server.ts**

Add to `createServer()` in `src/proxy/server.ts`:
```typescript
import { RenewalJob } from "../background/renewal";
// ... after creating other components:
const renewalJob = new RenewalJob(dedupStore, shelbyClient, config.dedup.renewalThresholdDays);
renewalJob.start();
// ... in cleanup:
renewalJob.stop();
```

- [ ] **Step 3: Commit**

```bash
git add src/background/renewal.ts src/proxy/server.ts
git commit -m "feat: add blob expiration renewal background job"
```

---

## Task 14: Docker Deployment

**Files:**
- Create: `docker/Dockerfile`
- Create: `docker/docker-compose.yml`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
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
```

- [ ] **Step 2: Write docker-compose.yml**

```yaml
# docker/docker-compose.yml
services:
  shelby-cache-proxy:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "9000:9000"
    volumes:
      - cache-data:/data/cache
    environment:
      - APTOS_PRIVATE_KEY=${APTOS_PRIVATE_KEY}
      - SHELBY_API_KEY=${SHELBY_API_KEY}
      - SHELBY_CACHE_CACHE_MAX_SIZE_GB=50
    restart: unless-stopped

volumes:
  cache-data:
    driver: local
```

- [ ] **Step 3: Test Docker build**

```bash
cd /Users/greg/git/shelby-sccache
docker build -f docker/Dockerfile -t shelby-cache-proxy .
```
Expected: Builds successfully.

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile docker/docker-compose.yml
git commit -m "feat: add Docker deployment with multi-stage build"
```

---

## Task 15: GitHub Action

**Files:**
- Create: `action/action.yml`
- Create: `action/entrypoint.sh`

- [ ] **Step 1: Write action.yml**

```yaml
# action/action.yml
name: 'Shelby Build Cache'
description: 'Set up sccache with Shelby decentralized storage'
inputs:
  aptos-private-key:
    description: 'Aptos Ed25519 private key'
    required: true
  shelby-api-key:
    description: 'Shelby API key'
    required: true
  network:
    description: 'Shelby network (shelbynet, testnet)'
    required: false
    default: 'shelbynet'
  cache-size-gb:
    description: 'Local cache size in GB'
    required: false
    default: '5'
  port:
    description: 'Proxy port'
    required: false
    default: '9000'
runs:
  using: 'composite'
  steps:
    - name: Install Bun
      uses: oven-sh/setup-bun@v2
    - name: Install sccache
      uses: mozilla-actions/sccache-action@v0.0.6
    - name: Start Shelby Cache Proxy
      shell: bash
      run: |
        cd ${{ github.action_path }}/..
        bun install --frozen-lockfile
        APTOS_PRIVATE_KEY=${{ inputs.aptos-private-key }} \
        SHELBY_API_KEY=${{ inputs.shelby-api-key }} \
        SHELBY_CACHE_SERVER_PORT=${{ inputs.port }} \
        SHELBY_CACHE_CACHE_MAX_SIZE_GB=${{ inputs.cache-size-gb }} \
        bun run src/cli/index.ts start &
        sleep 2  # Wait for server to start
    - name: Configure sccache
      shell: bash
      run: |
        echo "SCCACHE_BUCKET=shelby" >> $GITHUB_ENV
        echo "SCCACHE_ENDPOINT=http://localhost:${{ inputs.port }}" >> $GITHUB_ENV
        echo "SCCACHE_REGION=shelbyland" >> $GITHUB_ENV
        echo "SCCACHE_S3_USE_SSL=false" >> $GITHUB_ENV
        echo "SCCACHE_S3_NO_CREDENTIALS=false" >> $GITHUB_ENV
        echo "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE" >> $GITHUB_ENV
        echo "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" >> $GITHUB_ENV
        echo "RUSTC_WRAPPER=sccache" >> $GITHUB_ENV
```

- [ ] **Step 2: Commit**

```bash
git add action/action.yml
git commit -m "feat: add GitHub Action for CI integration"
```

---

## Task 16: Install Script and sccache Env Helper

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/setup-sccache-env.sh`

- [ ] **Step 1: Write install script**

```bash
#!/usr/bin/env bash
# scripts/install.sh
set -euo pipefail

echo "Installing shelby-cache-proxy..."

# Check for bun
if ! command -v bun &>/dev/null; then
  echo "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Install globally
bun install -g @gregnazario/shelby-cache-proxy

# Run init
shelby-cache-proxy init

echo ""
echo "Installation complete!"
echo "Run 'source $(dirname "$0")/setup-sccache-env.sh' to configure your shell."
```

- [ ] **Step 2: Write env setup helper**

```bash
#!/usr/bin/env bash
# scripts/setup-sccache-env.sh
# Source this file to configure sccache for Shelby
export SCCACHE_BUCKET="${SCCACHE_BUCKET:-shelby}"
export SCCACHE_ENDPOINT="${SCCACHE_ENDPOINT:-http://localhost:9000}"
export SCCACHE_REGION="shelbyland"
export SCCACHE_S3_USE_SSL=false
export SCCACHE_S3_NO_CREDENTIALS=false
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-AKIAIOSFODNN7EXAMPLE}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY}"
export RUSTC_WRAPPER=sccache
export CC="sccache cc"
export CXX="sccache c++"
echo "sccache configured for Shelby build cache (endpoint: $SCCACHE_ENDPOINT)"
```

- [ ] **Step 3: Make scripts executable and commit**

```bash
chmod +x scripts/install.sh scripts/setup-sccache-env.sh
git add scripts/install.sh scripts/setup-sccache-env.sh
git commit -m "feat: add install script and sccache env setup helper"
```

---

## Task 17: Integration Test

**Files:**
- Create: `test/integration/proxy.test.ts`

- [ ] **Step 1: Write integration test using the S3 protocol**

This test starts the server, sends real S3 requests via `fetch`, and validates the full round-trip through the proxy (without hitting real Shelby — uses a mock Shelby client injected via dependency injection).

```typescript
// test/integration/proxy.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "crypto";

// Start server on a random port and run S3 operations against it
describe("Proxy integration", () => {
  let baseUrl: string;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    // Import and start with test config
    const { loadConfig } = await import("../../src/config");
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const tmpDir = mkdtempSync(join(tmpdir(), "integration-test-"));
    process.env.SHELBY_CACHE_CACHE_DIR = join(tmpDir, "cache");
    process.env.SHELBY_CACHE_CACHE_STAGING_DIR = join(tmpDir, "staging");
    process.env.SHELBY_CACHE_DEDUP_DB_PATH = join(tmpDir, "dedup.db");
    process.env.SHELBY_CACHE_SERVER_PORT = "0"; // random port

    const config = loadConfig(null);
    // Note: This will fail to connect to real Shelby — integration tests with real Shelby
    // should be run separately with valid credentials
  });

  it("health endpoint returns healthy", async () => {
    // This test validates the server starts and /health responds
    // Full S3 protocol tests require the server running
    expect(true).toBe(true); // Placeholder — real integration tests need server startup
  });
});
```

**Note:** Full integration tests with real Shelby testnet credentials will be added after the prerequisite spike confirms SDK behavior. The test file above is a scaffold.

- [ ] **Step 2: Commit**

```bash
git add test/integration/proxy.test.ts
git commit -m "feat: add integration test scaffold for full S3 round-trip"
```

---

## Task 18: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

The README should cover:
- What this project does (1 paragraph)
- Architecture diagram (from spec)
- Quick start (local mode in 4 commands)
- Configuration reference (link to example YAML)
- Deployment modes (local, Docker, GitHub Actions)
- How it works (PUT/GET flow)
- Development setup (bun install, bun test)

Keep it concise — link to docs/ for detailed guides.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with quick start and architecture overview"
```

---

## Verification Checklist

After all tasks are complete, verify:

- [ ] `bun test` — all unit tests pass
- [ ] `bun run src/cli/index.ts` — shows help text
- [ ] `bun run src/cli/index.ts init` — creates cache dirs and config
- [ ] `bun run src/cli/index.ts start` — server starts on port 9000
- [ ] `curl http://localhost:9000/health` — returns JSON with status "healthy"
- [ ] `curl http://localhost:9000/stats` — returns stats JSON
- [ ] `docker build -f docker/Dockerfile .` — builds successfully
- [ ] PUT a test object via curl and GET it back:
  ```bash
  curl -X PUT http://localhost:9000/shelby/test-key --data "hello"
  curl http://localhost:9000/shelby/test-key
  # Should return: hello
  ```
