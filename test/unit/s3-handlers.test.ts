import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { S3Handlers } from "../../src/proxy/s3-handlers";
import { DiskCache } from "../../src/cache/disk-cache";
import { DedupStore } from "../../src/dedup/dedup-store";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
    // Allow the fire-and-forget async upload to resolve
    await new Promise((r) => setTimeout(r, 10));
    await handlers.putObject("sccache/v1/key2", body);
    await new Promise((r) => setTimeout(r, 10));
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
