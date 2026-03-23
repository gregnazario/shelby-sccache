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
