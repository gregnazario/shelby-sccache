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
    const metaPath = cache["metaPath"]("old");
    const meta = JSON.parse(await Bun.file(metaPath).text());
    meta.cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    await Bun.write(metaPath, JSON.stringify(meta));

    await cache.cleanup();
    expect(await cache.get("old")).toBeNull();
  });
});
