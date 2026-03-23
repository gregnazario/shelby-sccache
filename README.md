# shelby-cache-proxy

A decentralized build cache proxy that bridges [sccache](https://github.com/mozilla/sccache) to [Shelby](https://shelby.dev/) decentralized storage on the [Aptos](https://aptos.dev/) blockchain. It exposes an S3-compatible API locally so sccache can read and write cache artifacts, while transparently persisting them to the Shelby network with content-addressed deduplication and a fast local disk cache.

## Architecture

```
sccache  -->  S3 API  -->  shelby-cache-proxy  -->  Shelby Network (Aptos)
                                |
                          [Disk Cache + Dedup DB]
```

**Components:**

- **S3 proxy** (Hono) -- Accepts PutObject, GetObject, HeadObject, and multipart uploads via AWS Signature V4
- **Disk cache** -- LRU file cache with configurable max size and TTL eviction
- **Dedup store** -- SQLite database with a counting bloom filter to skip redundant Shelby uploads
- **Shelby client** -- Uploads/downloads blobs via the Shelby SDK with circuit breaker and retry logic
- **Renewal job** -- Background task that renews Shelby blob leases before they expire

## Quick Start (Local Mode)

```bash
# 1. Install dependencies
bun install

# 2. Initialize config and cache directories
bun run src/cli/index.ts init

# 3. Start the proxy (set your credentials first)
export APTOS_PRIVATE_KEY="your-ed25519-private-key"
export SHELBY_API_KEY="your-shelby-api-key"
bun run src/cli/index.ts start

# 4. Configure sccache to use the proxy
source scripts/setup-sccache-env.sh
```

After step 4, any `sccache`-wrapped compilation will route through the proxy.

## Configuration

Configuration is loaded from YAML with environment variable overrides. See [`shelby-cache-proxy.example.yaml`](./shelby-cache-proxy.example.yaml) for the full reference.

Key environment variables:

| Variable | Description |
|---|---|
| `APTOS_PRIVATE_KEY` | Ed25519 private key for Shelby uploads |
| `SHELBY_API_KEY` | Shelby API key for authentication |
| `SHELBY_CACHE_SERVER_PORT` | Proxy listen port (default: `9000`) |
| `SHELBY_CACHE_CACHE_DIR` | Disk cache directory |
| `SHELBY_CACHE_CACHE_MAX_SIZE_GB` | Max local cache size in GB (default: `10`) |
| `SHELBY_CACHE_LOGGING_LEVEL` | Log level: `debug`, `info`, `warn`, `error` |

All `SHELBY_CACHE_*` environment variables override their corresponding YAML fields.

## Deployment Modes

### Local Developer

Run directly with Bun on your machine. Cache stays in `~/.shelby-cache/`. Best for individual developers who want persistent build caches across projects.

```bash
bun run src/cli/index.ts start
```

### Docker (Shared Server)

Deploy as a shared cache server for a team. The Docker image uses a multi-stage build and persists cache data in a volume.

```bash
cd docker
docker compose up -d
```

Configure with environment variables in `docker-compose.yml`. See [`docker/`](./docker/) for the Dockerfile and compose file.

### GitHub Actions

Use the bundled action to add Shelby-backed sccache to your CI pipelines:

```yaml
- uses: gregnazario/shelby-cache-proxy/action@main
  with:
    aptos-private-key: ${{ secrets.APTOS_PRIVATE_KEY }}
    shelby-api-key: ${{ secrets.SHELBY_API_KEY }}
```

This installs Bun, starts the proxy in the background, and configures `RUSTC_WRAPPER=sccache` automatically. See [`action/action.yml`](./action/action.yml) for all inputs.

## How It Works

### PUT Flow (Cache Write)

1. sccache sends a `PutObject` request with compiled artifact data
2. The proxy computes a SHA-256 content hash
3. **Dedup check:** If the bloom filter and SQLite DB confirm the hash already exists in Shelby, the upload is skipped (only the key mapping is recorded)
4. The artifact is written to the local disk cache atomically
5. The artifact is uploaded to Shelby asynchronously (fire-and-forget with retry)
6. The content hash, key mapping, and blob metadata are recorded in the dedup DB

### GET Flow (Cache Read)

1. sccache sends a `GetObject` request for a cache key
2. **Local cache hit:** If the artifact is on disk, it is returned immediately
3. **Shelby fallback:** If not cached locally, the proxy downloads from Shelby, caches the result on disk, and returns it
4. **Miss:** If the artifact is not found in either location, a 404 is returned. Stale dedup entries are reconciled.

### Background Jobs

- **Cache cleaner** evicts expired and over-capacity entries from the disk cache on a configurable interval
- **Renewal job** extends Shelby blob leases for artifacts that are approaching expiration

## Development

```bash
# Install dependencies
bun install

# Run unit tests
bun test

# Run a specific test file
bun test test/unit/disk-cache.test.ts

# Start in development mode
SHELBY_CACHE_LOGGING_LEVEL=debug bun run src/cli/index.ts start
```

## Technologies

- **Runtime:** [Bun](https://bun.sh/)
- **HTTP framework:** [Hono](https://hono.dev/)
- **Storage:** [Shelby SDK](https://shelby.dev/) on Aptos
- **Database:** bun:sqlite (dedup tracking)
- **Auth:** AWS Signature V4 (S3 compatibility)

## License

By Greg Nazario.
