import { DiskCache } from "./disk-cache";
import { logger } from "../logger";

export class CacheCleaner {
  private cache: DiskCache;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cache: DiskCache, intervalMinutes: number) {
    this.cache = cache;
    this.intervalMs = intervalMinutes * 60 * 1000;
  }

  start(): void {
    this.timer = setInterval(async () => {
      try {
        const evicted = await this.cache.cleanup();
        if (evicted > 0) {
          logger.info("Cache cleanup completed", { evicted, sizeBytes: this.cache.sizeBytes });
        }
      } catch (err) {
        logger.error("Cache cleanup failed", { error: String(err) });
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
