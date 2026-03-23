import { existsSync, mkdirSync, statSync, unlinkSync, renameSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import type { CacheMeta } from "../types";

export class DiskCache {
  private dir: string;
  private maxSizeBytes: number;
  private ttlMs: number;
  private _sizeBytes = 0;
  private _entries = 0;

  constructor(dir: string, maxSizeGb: number, ttlDays: number) {
    this.dir = dir;
    this.maxSizeBytes = maxSizeGb * 1024 * 1024 * 1024;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    mkdirSync(dir, { recursive: true });
    this.calculateSize();
  }

  get sizeBytes(): number {
    return this._sizeBytes;
  }

  get entries(): number {
    return this._entries;
  }

  private filePath(key: string): string {
    return join(this.dir, key);
  }

  private metaPath(key: string): string {
    return join(this.dir, key + ".meta");
  }

  async put(key: string, data: Buffer, contentHash: string): Promise<void> {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    const tmpPath = filePath + `.tmp.${randomUUID().slice(0, 8)}`;
    await Bun.write(tmpPath, data);
    renameSync(tmpPath, filePath);

    const meta: CacheMeta = {
      size: data.length,
      contentHash,
      cachedAt: Date.now(),
      lastAccessed: Date.now(),
      shelbyBlobPath: key,
    };
    await Bun.write(metaPath, JSON.stringify(meta));

    this._sizeBytes += data.length;
    this._entries++;
  }

  async get(key: string): Promise<Buffer | null> {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);

    if (!existsSync(filePath)) return null;

    try {
      if (existsSync(metaPath)) {
        const meta: CacheMeta = JSON.parse(await Bun.file(metaPath).text());
        if (Date.now() - meta.cachedAt > this.ttlMs) {
          this.remove(key);
          return null;
        }
        meta.lastAccessed = Date.now();
        await Bun.write(metaPath, JSON.stringify(meta));
      }

      return Buffer.from(await Bun.file(filePath).arrayBuffer());
    } catch {
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);
    if (!existsSync(filePath)) return false;
    if (existsSync(metaPath)) {
      try {
        const meta: CacheMeta = JSON.parse(await Bun.file(metaPath).text());
        if (Date.now() - meta.cachedAt > this.ttlMs) {
          this.remove(key);
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  remove(key: string): void {
    const filePath = this.filePath(key);
    const metaPath = this.metaPath(key);
    try {
      if (existsSync(filePath)) {
        const size = statSync(filePath).size;
        unlinkSync(filePath);
        this._sizeBytes -= size;
        this._entries--;
      }
      if (existsSync(metaPath)) unlinkSync(metaPath);
    } catch {
      // ignore cleanup errors
    }
  }

  async cleanup(): Promise<number> {
    let evicted = 0;
    const entries = await this.listEntries();

    for (const entry of entries) {
      if (Date.now() - entry.meta.cachedAt > this.ttlMs) {
        this.remove(entry.key);
        evicted++;
      }
    }

    if (this._sizeBytes > this.maxSizeBytes) {
      const remaining = (await this.listEntries()).sort(
        (a, b) => a.meta.lastAccessed - b.meta.lastAccessed
      );
      for (const entry of remaining) {
        if (this._sizeBytes <= this.maxSizeBytes) break;
        this.remove(entry.key);
        evicted++;
      }
    }

    return evicted;
  }

  private async listEntries(): Promise<Array<{ key: string; meta: CacheMeta }>> {
    const results: Array<{ key: string; meta: CacheMeta }> = [];
    const glob = new Bun.Glob("**/*.meta");
    for await (const metaFile of glob.scan(this.dir)) {
      try {
        const meta: CacheMeta = JSON.parse(await Bun.file(join(this.dir, metaFile)).text());
        const key = metaFile.replace(/\.meta$/, "");
        results.push({ key, meta });
      } catch {
        // skip corrupt meta files
      }
    }
    return results;
  }

  private calculateSize(): void {
    try {
      const glob = new Bun.Glob("**/*");
      for (const file of glob.scanSync(this.dir)) {
        if (file.endsWith(".meta")) continue;
        try {
          this._sizeBytes += statSync(join(this.dir, file)).size;
          this._entries++;
        } catch {
          // skip
        }
      }
    } catch {
      // empty dir
    }
  }
}
