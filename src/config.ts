import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import type { ProxyConfig } from "./types";

// ---------------------------------------------------------------------------
// ENV → config path mapping (explicit, no auto-splitting)
// ---------------------------------------------------------------------------
const ENV_MAP: Record<string, string[]> = {
  SHELBY_CACHE_SERVER_PORT: ["server", "port"],
  SHELBY_CACHE_SERVER_HOST: ["server", "host"],
  SHELBY_CACHE_SHELBY_NETWORK: ["shelby", "network"],
  SHELBY_CACHE_SHELBY_API_KEY: ["shelby", "apiKey"],
  SHELBY_CACHE_SHELBY_APTOS_PRIVATE_KEY: ["shelby", "aptosPrivateKey"],
  SHELBY_CACHE_SHELBY_BLOB_EXPIRY_DAYS: ["shelby", "blobExpiryDays"],
  SHELBY_CACHE_CACHE_DIR: ["cache", "dir"],
  SHELBY_CACHE_CACHE_STAGING_DIR: ["cache", "stagingDir"],
  SHELBY_CACHE_CACHE_MAX_SIZE_GB: ["cache", "maxSizeGb"],
  SHELBY_CACHE_CACHE_TTL_DAYS: ["cache", "ttlDays"],
  SHELBY_CACHE_DEDUP_DB_PATH: ["dedup", "dbPath"],
  SHELBY_CACHE_DEDUP_RENEWAL_THRESHOLD_DAYS: ["dedup", "renewalThresholdDays"],
  SHELBY_CACHE_LOGGING_LEVEL: ["logging", "level"],
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULTS: ProxyConfig = {
  server: { port: 9000, host: "0.0.0.0" },
  shelby: {
    network: "testnet",
    apiKey: undefined,
    aptosPrivateKey: "",
    blobExpiryDays: 30,
  },
  s3: {
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "shelbyland",
    keyPrefix: "sccache/v1",
  },
  cache: {
    enabled: true,
    dir: "~/.shelby-cache/objects",
    stagingDir: "~/.shelby-cache/staging",
    maxSizeGb: 10,
    ttlDays: 7,
    cleanupIntervalMinutes: 10,
  },
  dedup: {
    enabled: true,
    dbPath: "~/.shelby-cache/dedup.db",
    bloomFilterExpectedItems: 1_000_000,
    bloomFilterFpr: 0.01,
    renewalThresholdDays: 5,
  },
  logging: { level: "info", format: "json" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve ${ENV_VAR} placeholders in a string value.
 * Unknown variables are replaced with an empty string.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? "";
  });
}

/**
 * Convert a snake_case string to camelCase.
 * e.g. "aptos_private_key" → "aptosPrivateKey"
 */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/**
 * Recursively walk a plain object:
 *  - Rename snake_case keys to camelCase
 *  - Resolve ${ENV_VAR} in string values
 */
function normalizeObject(obj: unknown): unknown {
  if (typeof obj === "string") {
    return resolveEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeObject);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamel(key)] = normalizeObject(value);
    }
    return result;
  }
  return obj;
}

/**
 * Deep-merge `overrides` into `base`. Returns a new object.
 * Only plain objects are merged recursively; all other values are overwritten.
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overrides: Record<string, unknown>
): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = result[key];
    if (
      overrideValue !== null &&
      typeof overrideValue === "object" &&
      !Array.isArray(overrideValue) &&
      baseValue !== null &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>
      );
    } else {
      result[key] = overrideValue;
    }
  }
  return result as T;
}

/**
 * Coerce a string from an env var to the same type as the existing value
 * in the config object at the given path.
 */
function coerceEnvValue(raw: string, existing: unknown): unknown {
  if (typeof existing === "number") {
    const n = Number(raw);
    return isNaN(n) ? existing : n;
  }
  if (typeof existing === "boolean") {
    return raw.toLowerCase() === "true" || raw === "1";
  }
  return raw;
}

/**
 * Apply ENV_MAP overrides onto a fully-merged config object (mutates a copy).
 */
function applyEnvOverrides(config: ProxyConfig): ProxyConfig {
  // Work on a shallow clone at the top level; sections will be cloned on write
  let result = { ...config };

  for (const [envKey, path] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw === undefined) continue;

    if (path.length === 2) {
      const [section, field] = path;
      const sectionObj = result[section as keyof ProxyConfig] as Record<string, unknown>;
      const existing = sectionObj[field];
      const coerced = coerceEnvValue(raw, existing);
      result = {
        ...result,
        [section]: { ...sectionObj, [field]: coerced },
      };
    }
  }

  return result as ProxyConfig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a YAML config from `configPath` (or use defaults when `null`),
 * deep-merge with DEFAULTS, then apply SHELBY_CACHE_* env overrides.
 */
export function loadConfig(configPath: string | null): ProxyConfig {
  let fileConfig: Record<string, unknown> = {};

  if (configPath !== null && existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw);
    if (parsed !== null && typeof parsed === "object") {
      fileConfig = normalizeObject(parsed) as Record<string, unknown>;
    }
  }

  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    fileConfig
  ) as unknown as ProxyConfig;

  return applyEnvOverrides(merged);
}
