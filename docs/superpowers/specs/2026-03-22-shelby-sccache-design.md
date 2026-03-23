# shelby-sccache: Decentralized Build Cache with Shelby Storage

**Date:** 2026-03-22
**Status:** Draft
**Author:** Greg Nazario

## Problem Statement

Build caching for compiled languages (Rust, C/C++, CUDA) typically relies on centralized cloud storage (AWS S3, GCS). This creates vendor lock-in, single points of failure, and recurring costs. Teams need a decentralized alternative that provides equivalent performance while leveraging Shelby's hot storage network.

## Goals

1. Provide a drop-in decentralized build cache for sccache using Shelby storage on Aptos testnet
2. Open source project with team/org shared caching support for multi-language builds (Rust, C/C++, CUDA)
3. Deliver a full toolkit: Docker images, standalone scripts, config templates, CI workflows, and benchmarking tools
4. Sub-second cache reads for local hits, competitive latency for remote hits via Shelby network

## Non-Goals

- Modifying sccache source code (use stock binary)
- Supporting Shelby mainnet initially (testnet first, mainnet when available)
- Replacing centralized caching for latency-critical production pipelines (this is a decentralized alternative, not a replacement)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Developer Machine / CI Runner                                  │
│                                                                 │
│  ┌──────────┐    S3 API     ┌──────────────────────────┐        │
│  │ sccache  │──────────────▶│  shelby-cache-proxy      │        │
│  │ (stock)  │◀──────────────│  (TypeScript/Bun)        │        │
│  └──────────┘               │                          │        │
│                             │  ┌────────────────────┐  │        │
│                             │  │ Read-Through Cache  │  │        │
│                             │  │ (LRU disk, 10GB)   │  │        │
│                             │  └────────────────────┘  │        │
│                             │  ┌────────────────────┐  │        │
│                             │  │ Content-Hash Dedup │  │        │
│                             │  │ (SQLite + bloom)   │  │        │
│                             │  └────────────────────┘  │        │
│                             └──────────┬───────────────┘        │
│                                        │                        │
└────────────────────────────────────────┼────────────────────────┘
                                         │ Shelby TypeScript SDK
                                         ▼
                              ┌─────────────────────┐
                              │  Shelby Network      │
                              │  (Testnet)           │
                              │                      │
                              │  Blobs = cache vals  │
                              │  Aptos addr = bucket │
                              └─────────────────────┘
```

**Core insight:** sccache already supports S3-compatible backends via environment variables. By implementing a lightweight S3-compatible proxy that translates S3 operations to Shelby SDK calls, we get decentralized storage without modifying sccache at all.

## Component Design

### 1. shelby-cache-proxy (Core)

A TypeScript/Bun HTTP server implementing a minimal S3-compatible API surface — only the operations sccache actually uses.

#### S3 API Surface

| S3 Operation | sccache Usage | Implementation |
|---|---|---|
| `PutObject` | Store compiled artifact (< 5MB) | Content-hash dedup check → upload to Shelby → write local cache |
| `CreateMultipartUpload` | Initiate large artifact upload (≥ 5MB) | Return upload ID, create temp staging dir |
| `UploadPart` | Stream part of large artifact | Buffer part to temp staging dir |
| `CompleteMultipartUpload` | Finalize large artifact | Assemble parts → dedup check → upload to Shelby → write local cache |
| `AbortMultipartUpload` | Cancel failed upload | Clean up temp staging dir |
| `GetObject` | Retrieve cached artifact | Local cache check → Shelby download → cache + return |
| `HeadObject` | Check if cache key exists | Bloom filter → local cache → Shelby HEAD |
| `ListObjectsV2` | `sccache --show-stats` / cleanup | Return valid empty XML: `<ListBucketResult><Contents/></ListBucketResult>` |
| `DeleteObject` | (Unused by sccache) | Return 204 No Content (no-op; Shelby blob expiration handles cleanup) |

**Note on multipart uploads:** sccache uses OpenDAL under the hood, which defaults to multipart upload for objects exceeding ~5MB. Since Rust/C++ artifacts commonly exceed this threshold, multipart is a common-path requirement. The proxy buffers parts in a temp directory (`~/.shelby-cache/staging/<upload-id>/`) and assembles them before hashing and uploading to Shelby as a single blob.

#### Prerequisite: S3 API Surface Validation

Before implementation, run sccache against a request-logging proxy (simple Bun server that logs all incoming requests) to empirically capture the exact S3 operations sccache/OpenDAL sends. This validates the API surface table above and catches any additional operations needed (e.g., presigned URLs, chunked transfer encoding).

#### Request Flow: PUT (Cache Store)

```
sccache PUT /bucket/sccache/v1/<key>
    │
    ▼
shelby-cache-proxy receives S3 PutObject
    │
    ├─ 1. SHA-256 hash the body
    ├─ 2. Check dedup index (SQLite): hash exists?
    │     ├─ YES: Record key→existing_blob_path mapping, skip upload, return 200
    │     └─ NO: Continue
    ├─ 3. Write body to local disk cache (temp file → atomic rename to ~/.shelby-cache/objects/<key>)
    ├─ 4. Upload blob to Shelby via SDK (path: sccache/v1/<key>) — async with retries
    ├─ 5. Record content_hash → blob_path in dedup SQLite
    └─ 6. Return 200 OK (immediately after local cache write; Shelby upload continues async)
```

#### Request Flow: GET (Cache Retrieve)

```
sccache GET /bucket/sccache/v1/<key>
    │
    ▼
shelby-cache-proxy receives S3 GetObject
    │
    ├─ 1. Check local disk cache (~/.shelby-cache/objects/<key>)
    │     ├─ HIT: Return file contents, update LRU timestamp + key_map.last_accessed
    │     └─ MISS: Continue
    ├─ 2. Download from Shelby via SDK (path: sccache/v1/<key>)
    │     ├─ FOUND: Write to local cache (temp → rename), update key_map.last_accessed, return contents
    │     ├─ NOT FOUND: Return 404
    │     └─ ERROR: Return 404, log error (sccache will recompile)
    └─ 3. Return response
```

#### Error Handling & Retry Strategy

- **PUT failure policy:** Write to local disk cache immediately, return 200 to sccache. Upload to Shelby asynchronously with retries. If Shelby upload fails after all retries, the artifact is still in local cache and will be retried on the next PUT for the same key.
- **GET failure policy:** If Shelby download fails (network error, timeout), return 404. sccache will recompile the artifact. Log the failure with request ID and error details.
- **Retry strategy:** 3 retries with exponential backoff (1s, 2s, 4s) for transient Shelby errors (network timeouts, 5xx responses).
- **Circuit breaker:** If Shelby returns errors for >50% of requests in a 5-minute window, degrade to local-only cache mode. Log a warning. Re-check Shelby health every 60 seconds and resume when healthy.
- **Stale dedup recovery:** If a GET to Shelby returns 404 for a blob that the dedup DB says should exist (expired or deleted), remove the stale entry from the dedup DB and bloom filter. Log this as a dedup reconciliation event.

### 2. Read-Through Disk Cache (Layer B)

**Purpose:** Avoid redundant Shelby network fetches for recently-used artifacts.

- **Location:** `~/.shelby-cache/objects/` (configurable)
- **Key mapping:** S3 object path maps directly to filesystem path structure. For example, S3 key `sccache/v1/abc123` maps to `~/.shelby-cache/objects/sccache/v1/abc123`. Path separators (`/`) create subdirectories, which preserves debuggability.
- **Eviction:** LRU by access time, configurable max size (default 10GB)
- **TTL:** Configurable per-entry (default 7 days); Shelby blobs expire at 30 days
- **Metadata:** Each cached file has a companion `.meta` JSON file with: `size`, `content_hash`, `cached_at`, `last_accessed`, `shelby_blob_path`
- **Cleanup:** Background sweep every 10 minutes evicts expired/over-limit entries

### 3. Content-Hash Dedup (Layer C)

**Purpose:** When multiple developers or CI runners compile identical dependencies, avoid uploading the same artifact to Shelby multiple times.

- **Storage:** SQLite database at `~/.shelby-cache/dedup.db`
- **Schema:**
  ```sql
  -- Schema version tracking
  PRAGMA user_version = 1;

  CREATE TABLE blobs (
    content_hash    TEXT PRIMARY KEY,  -- SHA-256 of artifact bytes
    shelby_path     TEXT NOT NULL,     -- path in Shelby storage
    size_bytes      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,  -- unix timestamp (when recorded in DB)
    shelby_expires_at INTEGER NOT NULL -- unix timestamp (created_at + blob_expiry_days)
  );

  CREATE TABLE key_map (
    cache_key     TEXT PRIMARY KEY,  -- sccache S3 object key
    content_hash  TEXT NOT NULL,     -- FK to blobs.content_hash
    created_at    INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL   -- unix timestamp, updated on every GET hit
  );
  ```
- **Schema migrations:** The proxy checks `PRAGMA user_version` on startup and runs migrations if the schema version is behind the expected version. This handles upgrades gracefully.
- **Bloom filter:** In-memory bloom filter (~1MB for 1M entries at 1% FPR) for fast negative lookups before hitting SQLite. On startup, the bloom filter is rebuilt by scanning all `content_hash` values from the `blobs` table (takes ~1-2 seconds for 1M entries). If startup time becomes a concern, the bloom filter can be persisted to `~/.shelby-cache/bloom.bin` and reloaded.
- **Blob expiration tracking:** A background job runs every 6 hours, scanning the `blobs` table for entries where `shelby_expires_at` is within `renewal_threshold_days` (configurable, default 5). For actively-used blobs (referenced by `key_map` entries where `last_accessed` is within the last 7 days), the proxy re-uploads them to Shelby using the same `shelby_path`, then updates `shelby_expires_at` in the `blobs` table. Expired and unreferenced blobs are purged from the dedup DB.
- **Dedup scope by deployment mode:**
  - **Local mode (Mode 1):** Dedup only prevents the *same developer* from re-uploading identical artifacts (e.g., after a local cache eviction + rebuild). Cross-developer dedup does not apply since each developer has their own `dedup.db`.
  - **Shared server mode (Mode 2):** The dedup DB is shared across all users, providing true cross-developer dedup. This is where the >25% upload savings target applies.

### 4. S3 Authentication

sccache uses AWS SigV4 signing for S3 requests via OpenDAL.

- **Local mode (Mode 1):** Skip SigV4 validation entirely. The proxy runs on localhost and is not exposed to the network, so signature validation adds complexity without security benefit. Accept any request with valid S3 structure.
- **Shared server mode (Mode 2):** Validate SigV4 signatures using `@smithy/signature-v4` from the AWS SDK for JS. This ensures only authorized team members can read/write the cache.
- **Default credentials:** `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` (matching Shelby S3 Gateway defaults). For shared mode, `shelby-cache-proxy init` generates a random credential pair.
- **Aptos signing:** The proxy holds the Aptos private key for Shelby uploads; sccache users don't need Aptos keys.
- **Team access:** In shared mode, multiple API key pairs can be configured for different team members/roles.

### 5. Concurrency Model

Bun's HTTP server handles concurrent requests on a single JS thread with async I/O:

- **SQLite writes:** Use WAL mode for concurrent read performance. Writes go through a serial queue (Bun's single-threaded JS ensures no true concurrent writes, but async overlaps are possible). `bun:sqlite` handles this natively.
- **Disk cache writes:** Always write to a temp file (`.tmp` suffix), then atomically rename to the final path. This prevents corrupted cache entries from concurrent writes to the same key.
- **Bloom filter:** Safe without locks since Bun executes JS on a single thread. If the process crashes mid-update, the bloom filter is rebuilt from SQLite on restart.
- **Same-key concurrent PUT:** Last-write-wins is acceptable since sccache keys are content-addressed — concurrent writes for the same key produce identical content.
- **Multipart staging:** Each multipart upload uses a unique upload ID, so concurrent multipart uploads don't conflict.

### 6. Dependencies and SDK Requirements

| Dependency | Version | Purpose |
|---|---|---|
| `@shelby-protocol/sdk` | latest | Blob upload, download, existence check |
| `@aptos-labs/ts-sdk` | latest | Aptos account signing for Shelby operations |
| `@smithy/signature-v4` | ^4.x | SigV4 validation (shared mode only) |
| `bun:sqlite` | built-in | Dedup index, schema migrations |
| `hono` | ^4.x | HTTP server framework with S3-compatible routing |

**Shelby SDK methods required:**
- `upload(signer, blobPath, data, options?)` — Upload blob with configurable expiration
- `download(owner, blobPath)` — Download blob by path
- Existence check — Either a native `head()` method or emulated via download with early abort / on-chain partition query

**Note:** If the Shelby SDK does not support a native `head` or existence-check operation, the proxy will emulate it by attempting a download and immediately discarding the body after confirming the blob exists, or by querying on-chain state if available. This will be validated during the prerequisite spike.

## Configuration

```yaml
# shelby-cache-proxy.yaml
server:
  port: 9000
  host: 0.0.0.0

shelby:
  network: testnet
  api_key: ${SHELBY_API_KEY}
  aptos_private_key: ${APTOS_PRIVATE_KEY}
  blob_expiry_days: 30

s3:
  access_key: AKIAIOSFODNN7EXAMPLE
  secret_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
  region: shelbyland
  key_prefix: sccache/v1

cache:
  enabled: true
  dir: ~/.shelby-cache/objects
  staging_dir: ~/.shelby-cache/staging   # temp dir for multipart upload assembly
  max_size_gb: 10
  ttl_days: 7
  cleanup_interval_minutes: 10

dedup:
  enabled: true
  db_path: ~/.shelby-cache/dedup.db
  bloom_filter_expected_items: 1000000
  bloom_filter_fpr: 0.01
  renewal_threshold_days: 5              # renew blobs within this many days of expiry

logging:
  level: info   # debug | info | warn | error
  format: json  # json | text
```

**Environment variable overrides:** Every config key can be overridden via `SHELBY_CACHE_*` env vars (e.g., `SHELBY_CACHE_SERVER_PORT=9000`).

## Deployment Modes

### Mode 1: Local Developer

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/gregnazario/shelby-sccache/main/install.sh | bash
# Or: bun install -g @gregnazario/shelby-cache-proxy

# Initialize (generates config, creates cache dir)
shelby-cache-proxy init

# Start (background daemon)
shelby-cache-proxy start

# Configure sccache (add to shell profile)
export SCCACHE_BUCKET=<aptos-account-address>
export SCCACHE_ENDPOINT=http://localhost:9000
export SCCACHE_REGION=shelbyland
export SCCACHE_S3_USE_SSL=false
export SCCACHE_S3_NO_CREDENTIALS=false
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
export RUSTC_WRAPPER=sccache
export CC="sccache cc"
export CXX="sccache c++"
```

### Mode 2: Shared Server (Docker)

```yaml
# docker-compose.yml
services:
  shelby-cache-proxy:
    build: .
    image: ghcr.io/gregnazario/shelby-cache-proxy:latest
    ports:
      - "9000:9000"
    volumes:
      - cache-data:/data/cache
      - ./shelby-cache-proxy.yaml:/app/config.yaml:ro
    environment:
      - APTOS_PRIVATE_KEY=${APTOS_PRIVATE_KEY}
      - SHELBY_API_KEY=${SHELBY_API_KEY}
      - SHELBY_CACHE_CACHE_MAX_SIZE_GB=50
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped

volumes:
  cache-data:
    driver: local
```

Team members point sccache at the shared server:
```bash
export SCCACHE_ENDPOINT=http://cache-server.internal:9000
```

### Mode 3: GitHub Actions

Custom action that starts the proxy as a background service:

```yaml
# .github/workflows/build.yml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Shelby Build Cache
        uses: gregnazario/shelby-sccache-action@v1
        with:
          aptos-private-key: ${{ secrets.APTOS_PRIVATE_KEY }}
          shelby-api-key: ${{ secrets.SHELBY_API_KEY }}
          network: testnet
          cache-size-gb: 5

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Build
        run: cargo build --release
        env:
          RUSTC_WRAPPER: sccache

      - name: Show Cache Stats
        run: sccache --show-stats
```

## Benchmarking Tool

Built-in CLI for measuring cache effectiveness:

```bash
shelby-cache-proxy benchmark \
  --project /path/to/project \
  --runs 3 \
  --compare local,shelby,both   # test different cache configurations
```

**Output format:**
```
Benchmark Results: my-rust-project
═══════════════════════════════════════════════════
                    Cold Build    Warm Build    Hit Rate
Local cache only    2m 34s        0m 12s        94.2%
Shelby only         2m 34s        0m 28s        94.2%
Local + Shelby      2m 34s        0m 11s        94.2%
═══════════════════════════════════════════════════
Shelby Upload:      avg 45ms/obj  p99 120ms/obj
Shelby Download:    avg 22ms/obj  p99 85ms/obj
Dedup Savings:      142 objects skipped (38%)
Local Cache Size:   1.2 GB (of 10 GB limit)
```

## Monitoring & Observability

### Health Endpoint
`GET /health` returns:
```json
{
  "status": "healthy",
  "shelby_network": "testnet",
  "cache": {
    "size_gb": 3.2,
    "max_size_gb": 10,
    "entries": 4521,
    "hit_rate_1h": 0.87
  },
  "dedup": {
    "unique_blobs": 3102,
    "total_keys": 4521,
    "savings_pct": 31.4
  },
  "shelby": {
    "connected": true,
    "avg_upload_ms": 45,
    "avg_download_ms": 22
  }
}
```

### Stats Endpoint
`GET /stats` returns detailed metrics:
```json
{
  "uptime_seconds": 3600,
  "requests": {
    "total": 12500,
    "put": 3200,
    "get": 8100,
    "head": 1200
  },
  "cache": {
    "hits": 7100,
    "misses": 1000,
    "hit_rate": 0.876,
    "evictions_1h": 42
  },
  "shelby": {
    "uploads": 2800,
    "downloads": 1000,
    "upload_latency_ms": { "avg": 45, "p50": 38, "p95": 95, "p99": 120 },
    "download_latency_ms": { "avg": 22, "p50": 18, "p95": 55, "p99": 85 },
    "errors_1h": 3,
    "circuit_breaker": "closed"
  },
  "dedup": {
    "unique_blobs": 3102,
    "total_keys": 4521,
    "uploads_skipped": 1419,
    "savings_pct": 31.4,
    "stale_entries_reconciled": 5
  }
}
```

### Structured Logging
JSON-formatted logs with request IDs, operation types, latencies, and cache hit/miss indicators.

## Project Structure

```
shelby-sccache/
├── src/
│   ├── proxy/
│   │   ├── server.ts              # Bun HTTP server, S3 route handling
│   │   ├── s3-auth.ts             # SigV4 signature validation
│   │   ├── s3-handlers.ts         # PutObject, GetObject, HeadObject, ListObjects, DeleteObject
│   │   ├── s3-multipart.ts        # CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload
│   │   └── s3-xml.ts              # S3 XML response formatting
│   ├── cache/
│   │   ├── disk-cache.ts          # LRU read-through disk cache
│   │   └── cache-cleaner.ts       # Background eviction sweep
│   ├── dedup/
│   │   ├── dedup-store.ts         # SQLite content-hash index
│   │   └── bloom-filter.ts        # In-memory bloom filter
│   ├── shelby/
│   │   ├── client.ts              # Shelby SDK wrapper (upload/download/head)
│   │   └── config.ts              # Network config (testnet endpoints)
│   ├── cli/
│   │   ├── index.ts               # CLI entry point (init, start, stop, stats, benchmark)
│   │   ├── init.ts                # Config generation + cache dir setup
│   │   └── benchmark.ts           # Benchmarking tool
│   └── config.ts                  # YAML config loader + env var overrides
├── docker/
│   ├── Dockerfile                 # Multi-stage Bun build
│   └── docker-compose.yml         # Shared server deployment
├── action/
│   ├── action.yml                 # GitHub Actions metadata
│   └── entrypoint.sh              # Action startup script
├── scripts/
│   ├── install.sh                 # One-line installer
│   └── setup-sccache-env.sh       # Shell env var setup helper
├── test/
│   ├── unit/                      # Unit tests for each component
│   ├── integration/               # End-to-end S3 → Shelby tests
│   └── benchmark/                 # Performance test fixtures
├── docs/
│   ├── getting-started.md
│   ├── configuration.md
│   ├── deployment-guide.md
│   ├── ci-integration.md
│   └── benchmarking.md
├── package.json
├── tsconfig.json
├── bunfig.toml
├── shelby-cache-proxy.example.yaml
└── README.md
```

## Shelby Network Configuration (Testnet)

Using the Shelby testnet endpoints:
- **Shelby RPC:** Testnet endpoint (via SDK)
- **Aptos Full Node:** Testnet endpoint (via SDK)
- **Smart Contract:** `0xc63d6a5efb0080a6029403131715bd4971e1149f7cc099aac69bb0069b3ddbf5`

**Blob expiration:** 30 days (Shelby default). The proxy tracks `shelby_expires_at` per blob in the dedup DB and runs a background renewal job every 6 hours to re-upload blobs approaching expiration that are still actively referenced.

**Migration path:** When Shelby mainnet launches, change `network: testnet` to `network: mainnet` in config. No code changes needed.

## Security Considerations

1. **Aptos private key isolation:** Only the proxy holds the Aptos key. End users authenticate with S3 credentials only.
2. **Cache poisoning:** sccache keys are content-addressed (compiler + flags + source hash), making poisoning impractical. Optionally, the proxy can verify artifact integrity on download.
3. **Network exposure:** In shared mode, the proxy should be behind a firewall or VPN. The S3 API credentials provide a basic auth layer.
4. **Secrets management:** Private keys and API keys loaded from environment variables, never stored in config files.

## Success Criteria

1. **Functional:** sccache stores/retrieves artifacts via Shelby testnet with zero sccache modifications
2. **Performance:** Warm builds with local cache hit < 15s for a medium Rust project; Shelby-only hits add < 100ms average per artifact
3. **Dedup:** > 25% upload savings in shared server mode (Mode 2) for a team of 3+ developers working on the same project. In local mode, dedup provides per-developer savings only.
4. **Deployable:** Working Docker image, GitHub Action, and local install script
5. **Observable:** Health endpoint, cache stats, structured logs

## Prerequisite Spike

Before full implementation, complete a validation spike (~1-2 days):

1. **S3 API surface capture:** Run sccache against a request-logging Bun server to empirically capture all S3 operations used by sccache/OpenDAL (validates multipart assumption and catches any additional operations).
2. **Shelby SDK validation:** Verify `@shelby-protocol/sdk` supports: `upload()`, `download()`, existence check (head or equivalent), and confirm blob size limits.
3. **Shelby testnet throughput:** Test bulk upload performance (100 x 5MB blobs) to establish baseline latency and identify rate limits.

## Open Questions

1. **Shelby testnet rate limits:** Need to verify testnet throughput limits for bulk uploads during cold cache population
2. **Blob size limits:** Verify max blob size on Shelby testnet (sccache artifacts are typically 1-50MB)
3. **Shelby SDK head operation:** Confirm whether the SDK has a native blob existence check or if it needs to be emulated
4. **Shelby API key provisioning:** Document how team members get testnet API keys
