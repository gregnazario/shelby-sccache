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
