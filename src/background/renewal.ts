import type { DedupStore } from "../dedup/dedup-store";
import type { ShelbyClient } from "../shelby/client";
import { logger } from "../logger";

export class RenewalJob {
  private dedup: DedupStore;
  private shelby: ShelbyClient;
  private thresholdDays: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 6 * 60 * 60 * 1000; // 6 hours

  constructor(dedup: DedupStore, shelby: ShelbyClient, thresholdDays: number) {
    this.dedup = dedup;
    this.shelby = shelby;
    this.thresholdDays = thresholdDays;
  }

  start(): void {
    this.timer = setInterval(() => this.run(), this.intervalMs);
    logger.info("Renewal job started", { intervalHours: 6, thresholdDays: this.thresholdDays });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async run(): Promise<{ renewed: number; purged: number }> {
    let renewed = 0;
    let purged = 0;

    const expiring = this.dedup.findExpiringBlobs(this.thresholdDays);
    if (expiring.length === 0) return { renewed, purged };

    logger.info("Renewal job: found expiring blobs", { count: expiring.length });

    for (const blob of expiring) {
      // Only renew blobs with active references (accessed within last 7 days)
      if (!this.dedup.hasActiveReferences(blob.contentHash, 7)) {
        this.dedup.removeBlob(blob.contentHash);
        purged++;
        logger.debug("Purged unreferenced expiring blob", { path: blob.shelbyPath });
        continue;
      }

      try {
        // Download and re-upload to renew expiration
        const data = await this.shelby.download(blob.shelbyPath);
        if (data) {
          await this.shelby.upload(blob.shelbyPath, data);
          const newExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
          this.dedup.updateBlobExpiry(blob.contentHash, newExpiry);
          renewed++;
        } else {
          // Blob gone from Shelby — purge from dedup
          this.dedup.removeBlob(blob.contentHash);
          purged++;
        }
      } catch (err) {
        logger.error("Renewal failed for blob", { path: blob.shelbyPath, error: String(err) });
      }
    }

    logger.info("Renewal job completed", { renewed, purged });
    return { renewed, purged };
  }
}
