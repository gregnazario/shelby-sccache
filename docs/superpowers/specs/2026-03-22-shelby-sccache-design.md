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
| `PutObject` | Store compiled artifact | Content-hash dedup check → upload to Shelby → write local cache |
| `GetObject` | Retrieve cached artifact | Local cache check → Shelby download → cache + return |
| `HeadObject` | Check if cache key exists | Bloom filter → local cache → Shelby HEAD |
| `ListObjectsV2` | (Unused by sccache) | No-op / empty response |
| `DeleteObject` | (Unused by sccache) | Optional no-op |

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
    ├─ 3. Upload blob to Shelby via SDK (path: sccache/v1/<key>)
    ├─ 4. Write body to local disk cache (~/.shelby-cache/objects/<key>)
    ├─ 5. Record content_hash → blob_path in dedup SQLite
    └─ 6. Return 200 OK
```

#### Request Flow: GET (Cache Retrieve)

```
sccache GET /bucket/sccache/v1/<key>
    │
    ▼
shelby-cache-proxy receives S3 GetObject
    │
    ├─ 1. Check local disk cache (~/.shelby-cache/objects/<key>)
    │     ├─ HIT: Return file contents immediately, update LRU timestamp
    │     └─ MISS: Continue
    ├─ 2. Download from Shelby via SDK (path: sccache/v1/<key>)
    │     ├─ FOUND: Write to local cache, return contents
    │     └─ NOT FOUND: Return 404
    └─ 3. Return response
```

### 2. Read-Through Disk Cache (Layer B)

**Purpose:** Avoid redundant Shelby network fetches for recently-used artifacts.

- **Location:** `~/.shelby-cache/objects/` (configurable)
- **Key mapping:** S3 object path → filesystem path (URL-safe encoding)
- **Eviction:** LRU by access time, configurable max size (default 10GB)
- **TTL:** Configurable per-entry (default 7 days); Shelby blobs expire at 30 days
- **Metadata:** Each cached file has a companion `.meta` JSON file with: `size`, `content_hash`, `cached_at`, `last_accessed`, `shelby_blob_path`
- **Cleanup:** Background sweep every 10 minutes evicts expired/over-limit entries

### 3. Content-Hash Dedup (Layer C)

**Purpose:** When multiple developers or CI runners compile identical dependencies, avoid uploading the same artifact to Shelby multiple times.

- **Storage:** SQLite database at `~/.shelby-cache/dedup.db`
- **Schema:**
  ```sql
  CREATE TABLE blobs (
    content_hash TEXT PRIMARY KEY,  -- SHA-256 of artifact bytes
    shelby_path  TEXT NOT NULL,     -- path in Shelby storage
    size_bytes   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL   -- unix timestamp
  );

  CREATE TABLE key_map (
    cache_key    TEXT PRIMARY KEY,  -- sccache S3 object key
    content_hash TEXT NOT NULL,     -- FK to blobs.content_hash
    created_at   INTEGER NOT NULL
  );
  ```
- **Bloom filter:** In-memory bloom filter (~1MB for 1M entries at 1% FPR) for fast negative lookups before hitting SQLite
- **Shared mode:** In shared server deployments, the dedup DB is shared across all users, maximizing dedup savings

### 4. S3 Authentication

sccache uses AWS SigV4 signing for S3 requests. The proxy must validate these signatures.

- **Access Key / Secret Key:** Shared credentials configured in both sccache and the proxy (not real AWS creds)
- **Default credentials:** `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` (matching Shelby S3 Gateway defaults)
- **Aptos signing:** The proxy holds the Aptos private key for Shelby uploads; sccache users don't need Aptos keys
- **Team access:** Multiple API key pairs can be configured for different team members/roles

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
  max_size_gb: 10
  ttl_days: 7
  cleanup_interval_minutes: 10

dedup:
  enabled: true
  db_path: ~/.shelby-cache/dedup.db
  bloom_filter_expected_items: 1000000
  bloom_filter_fpr: 0.01

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
`GET /stats` returns detailed metrics for the benchmarking tool and monitoring dashboards.

### Structured Logging
JSON-formatted logs with request IDs, operation types, latencies, and cache hit/miss indicators.

## Project Structure

```
shelby-sccache/
├── src/
│   ├── proxy/
│   │   ├── server.ts              # Bun HTTP server, S3 route handling
│   │   ├── s3-auth.ts             # SigV4 signature validation
│   │   ├── s3-handlers.ts         # PutObject, GetObject, HeadObject handlers
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

**Blob expiration:** 30 days (Shelby default). The proxy will auto-renew blobs that are still in active use before expiration.

**Migration path:** When Shelby mainnet launches, change `network: testnet` to `network: mainnet` in config. No code changes needed.

## Security Considerations

1. **Aptos private key isolation:** Only the proxy holds the Aptos key. End users authenticate with S3 credentials only.
2. **Cache poisoning:** sccache keys are content-addressed (compiler + flags + source hash), making poisoning impractical. Optionally, the proxy can verify artifact integrity on download.
3. **Network exposure:** In shared mode, the proxy should be behind a firewall or VPN. The S3 API credentials provide a basic auth layer.
4. **Secrets management:** Private keys and API keys loaded from environment variables, never stored in config files.

## Success Criteria

1. **Functional:** sccache stores/retrieves artifacts via Shelby testnet with zero sccache modifications
2. **Performance:** Warm builds with local cache hit < 15s for a medium Rust project; Shelby-only hits add < 100ms average per artifact
3. **Dedup:** > 25% upload savings for a team of 3+ developers working on the same project
4. **Deployable:** Working Docker image, GitHub Action, and local install script
5. **Observable:** Health endpoint, cache stats, structured logs

## Open Questions

1. **Shelby testnet rate limits:** Need to verify testnet throughput limits for bulk uploads during cold cache population
2. **Blob size limits:** Verify max blob size on Shelby testnet (sccache artifacts are typically 1-50MB)
3. **S3 multipart upload:** sccache may use multipart for large artifacts — need to verify and potentially implement
4. **Shelby API key provisioning:** Document how team members get testnet API keys
