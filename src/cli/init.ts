import { existsSync, mkdirSync, copyFileSync } from "fs";
import { resolve, join } from "path";

export async function runInit(configDir?: string): Promise<void> {
  const home = process.env.HOME ?? "~";
  const cacheDir = resolve(home, ".shelby-cache");
  const objectsDir = join(cacheDir, "objects");
  const stagingDir = join(cacheDir, "staging");

  mkdirSync(objectsDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  const configPath = configDir
    ? join(configDir, "shelby-cache-proxy.yaml")
    : join(cacheDir, "shelby-cache-proxy.yaml");

  if (!existsSync(configPath)) {
    const examplePath = resolve(import.meta.dir, "../../shelby-cache-proxy.example.yaml");
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, configPath);
    } else {
      await Bun.write(configPath, `# shelby-cache-proxy configuration
server:
  port: 9000
shelby:
  network: testnet
  aptos_private_key: \${APTOS_PRIVATE_KEY}
  api_key: \${SHELBY_API_KEY}
`);
    }
    console.log(`Config written to: ${configPath}`);
  } else {
    console.log(`Config already exists: ${configPath}`);
  }

  console.log(`Cache directory: ${cacheDir}`);
  console.log("\nNext steps:");
  console.log("  1. Set APTOS_PRIVATE_KEY and SHELBY_API_KEY environment variables");
  console.log("  2. Run: shelby-cache-proxy start");
  console.log("  3. Configure sccache:");
  console.log("     export SCCACHE_BUCKET=<your-aptos-address>");
  console.log("     export SCCACHE_ENDPOINT=http://localhost:9000");
  console.log("     export SCCACHE_REGION=shelbyland");
  console.log("     export RUSTC_WRAPPER=sccache");
}
