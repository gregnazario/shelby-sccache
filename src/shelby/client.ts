import { ShelbyNodeClient } from "@shelby-protocol/sdk/node";
import { Account, Ed25519Account, Ed25519PrivateKey, Network } from "@aptos-labs/ts-sdk";
import { CircuitBreaker } from "./circuit-breaker";
import { logger } from "../logger";
import type { ProxyConfig } from "../types";

function parseNetwork(network: string): Network {
  const lower = network.toLowerCase();
  if (lower === "shelbynet" || lower === "testnet" || lower === "shelby") return Network.SHELBYNET;
  if (lower === "local" || lower === "localhost") return Network.LOCAL;
  if (lower === "mainnet") throw new Error("Shelby mainnet not yet available. Use 'testnet'.");
  throw new Error(`Unsupported network: ${network}. Valid: testnet, shelbynet, local`);
}

export class ShelbyClient {
  private client: ShelbyNodeClient;
  private signer: Account;
  private expirationMs: number;
  private circuitBreaker: CircuitBreaker;
  private maxRetries = 3;
  private retryDelays = [1000, 2000, 4000];

  constructor(config: ProxyConfig) {
    const network = parseNetwork(config.shelby.network);
    this.client = new ShelbyNodeClient({
      network,
      apiKey: config.shelby.apiKey,
      aptos: {
        network: network as unknown as Network,
        clientConfig: {
          ...(config.shelby.apiKey ? { API_KEY: config.shelby.apiKey } : {}),
          http2: false, // Required for Shelbynet — ORIGIN frame mismatch
        },
      },
    });

    this.signer = new Ed25519Account({
      privateKey: new Ed25519PrivateKey(config.shelby.aptosPrivateKey),
    });

    this.expirationMs = config.shelby.blobExpiryDays * 24 * 60 * 60 * 1000;
    this.circuitBreaker = new CircuitBreaker(0.5, 5 * 60 * 1000, 60 * 1000);
  }

  get ownerAddress(): string {
    return this.signer.accountAddress.toString();
  }

  get circuit(): CircuitBreaker {
    return this.circuitBreaker;
  }

  async upload(blobPath: string, data: Uint8Array): Promise<void> {
    if (this.circuitBreaker.isOpen) {
      logger.warn("Circuit breaker open — skipping Shelby upload", { blobPath });
      return;
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.client.upload({
          signer: this.signer,
          blobName: blobPath,
          blobData: data,
          expirationMicros: (Date.now() + this.expirationMs) * 1000,
        });
        this.circuitBreaker.recordSuccess();
        return;
      } catch (err) {
        this.circuitBreaker.recordFailure();
        if (attempt < this.maxRetries) {
          logger.warn("Shelby upload failed, retrying", {
            blobPath, attempt: attempt + 1, error: String(err),
          });
          await new Promise((r) => setTimeout(r, this.retryDelays[attempt]));
        } else {
          logger.error("Shelby upload failed after all retries", { blobPath, error: String(err) });
          throw err;
        }
      }
    }
  }

  async download(blobPath: string): Promise<Buffer | null> {
    if (this.circuitBreaker.isOpen) {
      logger.warn("Circuit breaker open — skipping Shelby download", { blobPath });
      return null;
    }

    try {
      const blob = await this.client.download({
        account: this.signer.accountAddress,
        blobName: blobPath,
      });
      const reader = blob.readable.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = Buffer.alloc(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure();
      logger.error("Shelby download failed", { blobPath, error: String(err) });
      return null;
    }
  }

  async exists(blobPath: string): Promise<boolean> {
    if (this.circuitBreaker.isOpen) return false;
    try {
      const meta = await this.client.coordination.getBlobMetadata({
        account: this.signer.accountAddress,
        name: blobPath,
      });
      if (meta) this.circuitBreaker.recordSuccess();
      return meta !== undefined && meta !== null;
    } catch {
      this.circuitBreaker.recordFailure();
      return false;
    }
  }
}
