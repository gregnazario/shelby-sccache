import { resolve } from "path";
import { loadConfig } from "../config";
import { createServer } from "../proxy/server";
import { runInit } from "./init";

const command = process.argv[2];

switch (command) {
  case "init":
    await runInit(process.argv[3]);
    break;

  case "start": {
    const configPath = process.argv[3] ?? resolve(process.env.HOME ?? "~", ".shelby-cache/shelby-cache-proxy.yaml");
    const config = loadConfig(configPath);
    const { app, port, hostname, cleanup } = createServer(config);

    const server = Bun.serve({
      fetch: app.fetch,
      port,
      hostname,
    });

    console.log(`shelby-cache-proxy running on http://${hostname}:${port}`);
    console.log(`Network: ${config.shelby.network}`);
    console.log(`Cache dir: ${config.cache.dir}`);
    console.log(`Press Ctrl+C to stop`);

    process.on("SIGINT", () => {
      cleanup();
      server.stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      server.stop();
      process.exit(0);
    });
    break;
  }

  case "stats": {
    const endpoint = process.argv[3] ?? "http://localhost:9000";
    const resp = await fetch(`${endpoint}/stats`);
    console.log(JSON.stringify(await resp.json(), null, 2));
    break;
  }

  default:
    console.log(`shelby-cache-proxy — Decentralized build cache via Shelby storage

Commands:
  init [dir]         Generate config and create cache directories
  start [config]     Start the proxy server
  stats [endpoint]   Show cache statistics

Environment:
  APTOS_PRIVATE_KEY  Aptos Ed25519 private key for Shelby uploads
  SHELBY_API_KEY     Shelby API key for authentication`);
}
