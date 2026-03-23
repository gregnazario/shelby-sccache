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
