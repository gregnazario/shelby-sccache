import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, resolveEnvVars } from "../../src/config";
import type { ProxyConfig } from "../../src/types";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import os from "os";

const TMP_DIR = os.tmpdir();

function writeTempYaml(content: string): string {
  const path = join(TMP_DIR, `shelby-config-test-${Date.now()}.yaml`);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("resolveEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_VAR_GREETING = "hello";
    process.env.TEST_VAR_NAME = "world";
  });

  afterEach(() => {
    delete process.env.TEST_VAR_GREETING;
    delete process.env.TEST_VAR_NAME;
  });

  it("resolves a single env var reference", () => {
    expect(resolveEnvVars("${TEST_VAR_GREETING}")).toBe("hello");
  });

  it("resolves multiple env var references in one string", () => {
    expect(resolveEnvVars("${TEST_VAR_GREETING} ${TEST_VAR_NAME}")).toBe("hello world");
  });

  it("leaves string unchanged when no references are present", () => {
    expect(resolveEnvVars("no references here")).toBe("no references here");
  });

  it("leaves unresolvable references as empty string", () => {
    expect(resolveEnvVars("${UNDEFINED_VAR_12345}")).toBe("");
  });
});

describe("loadConfig", () => {
  let tmpFile: string | null = null;

  afterEach(() => {
    if (tmpFile) {
      try { unlinkSync(tmpFile); } catch {}
      tmpFile = null;
    }
    // Clean up any env overrides set during tests
    for (const key of [
      "SHELBY_CACHE_SERVER_PORT",
      "SHELBY_CACHE_SERVER_HOST",
      "SHELBY_CACHE_SHELBY_NETWORK",
      "SHELBY_CACHE_SHELBY_API_KEY",
      "SHELBY_CACHE_SHELBY_APTOS_PRIVATE_KEY",
      "SHELBY_CACHE_SHELBY_BLOB_EXPIRY_DAYS",
      "SHELBY_CACHE_CACHE_DIR",
      "SHELBY_CACHE_CACHE_STAGING_DIR",
      "SHELBY_CACHE_CACHE_MAX_SIZE_GB",
      "SHELBY_CACHE_CACHE_TTL_DAYS",
      "SHELBY_CACHE_DEDUP_DB_PATH",
      "SHELBY_CACHE_DEDUP_RENEWAL_THRESHOLD_DAYS",
      "SHELBY_CACHE_LOGGING_LEVEL",
    ]) {
      delete process.env[key];
    }
  });

  it("returns all defaults when config path is null", () => {
    const config = loadConfig(null);
    expect(config.server.port).toBe(9000);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.shelby.network).toBe("testnet");
    expect(config.cache.maxSizeGb).toBe(10);
    expect(config.dedup.enabled).toBe(true);
    expect(config.logging.level).toBe("info");
    expect(config.logging.format).toBe("json");
  });

  it("loads YAML config and deep-merges with defaults for missing fields", () => {
    tmpFile = writeTempYaml(`
server:
  port: 8080
`);
    const config = loadConfig(tmpFile);
    // Overridden value
    expect(config.server.port).toBe(8080);
    // Default value preserved for missing field
    expect(config.server.host).toBe("0.0.0.0");
    // Defaults for untouched sections
    expect(config.cache.maxSizeGb).toBe(10);
    expect(config.logging.level).toBe("info");
  });

  it("deep-merges nested partial config with defaults", () => {
    tmpFile = writeTempYaml(`
cache:
  max_size_gb: 50
  ttl_days: 14
`);
    const config = loadConfig(tmpFile);
    expect(config.cache.maxSizeGb).toBe(50);
    expect(config.cache.ttlDays).toBe(14);
    // defaults preserved for untouched fields
    expect(config.cache.enabled).toBe(true);
    expect(config.cache.dir).toBe("~/.shelby-cache/objects");
  });

  it("converts snake_case YAML keys to camelCase", () => {
    tmpFile = writeTempYaml(`
shelby:
  aptos_private_key: "my-secret-key"
  blob_expiry_days: 60
dedup:
  db_path: "/custom/path/dedup.db"
  renewal_threshold_days: 10
`);
    const config = loadConfig(tmpFile);
    expect(config.shelby.aptosPrivateKey).toBe("my-secret-key");
    expect(config.shelby.blobExpiryDays).toBe(60);
    expect(config.dedup.dbPath).toBe("/custom/path/dedup.db");
    expect(config.dedup.renewalThresholdDays).toBe(10);
  });

  it("resolves ${ENV_VAR} references in YAML string values", () => {
    process.env.MY_API_KEY = "super-secret-api-key";
    tmpFile = writeTempYaml(`
shelby:
  api_key: "\${MY_API_KEY}"
`);
    const config = loadConfig(tmpFile);
    expect(config.shelby.apiKey).toBe("super-secret-api-key");
    delete process.env.MY_API_KEY;
  });

  it("applies SHELBY_CACHE_SERVER_PORT env override", () => {
    process.env.SHELBY_CACHE_SERVER_PORT = "7777";
    const config = loadConfig(null);
    expect(config.server.port).toBe(7777);
  });

  it("applies SHELBY_CACHE_SERVER_HOST env override", () => {
    process.env.SHELBY_CACHE_SERVER_HOST = "127.0.0.1";
    const config = loadConfig(null);
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("applies SHELBY_CACHE_SHELBY_NETWORK env override", () => {
    process.env.SHELBY_CACHE_SHELBY_NETWORK = "mainnet";
    const config = loadConfig(null);
    expect(config.shelby.network).toBe("mainnet");
  });

  it("applies SHELBY_CACHE_CACHE_MAX_SIZE_GB env override as number", () => {
    process.env.SHELBY_CACHE_CACHE_MAX_SIZE_GB = "25";
    const config = loadConfig(null);
    expect(config.cache.maxSizeGb).toBe(25);
  });

  it("applies SHELBY_CACHE_LOGGING_LEVEL env override", () => {
    process.env.SHELBY_CACHE_LOGGING_LEVEL = "debug";
    const config = loadConfig(null);
    expect(config.logging.level).toBe("debug");
  });

  it("applies SHELBY_CACHE_DEDUP_DB_PATH env override", () => {
    process.env.SHELBY_CACHE_DEDUP_DB_PATH = "/tmp/custom-dedup.db";
    const config = loadConfig(null);
    expect(config.dedup.dbPath).toBe("/tmp/custom-dedup.db");
  });

  it("env overrides take precedence over YAML file values", () => {
    tmpFile = writeTempYaml(`
server:
  port: 8080
`);
    process.env.SHELBY_CACHE_SERVER_PORT = "9999";
    const config = loadConfig(tmpFile);
    expect(config.server.port).toBe(9999);
  });

  it("applies multiple env overrides simultaneously", () => {
    process.env.SHELBY_CACHE_SERVER_PORT = "8888";
    process.env.SHELBY_CACHE_SHELBY_NETWORK = "mainnet";
    process.env.SHELBY_CACHE_CACHE_TTL_DAYS = "30";
    const config = loadConfig(null);
    expect(config.server.port).toBe(8888);
    expect(config.shelby.network).toBe("mainnet");
    expect(config.cache.ttlDays).toBe(30);
  });
});
