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
    store.recordBlob("sha256-expiring", "path1", 100);
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
