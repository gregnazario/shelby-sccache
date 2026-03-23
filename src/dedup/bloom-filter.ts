import { createHash } from "crypto";

/**
 * Counting Bloom Filter
 *
 * Uses a Uint8Array of counters (max count 255 per cell) to support removal.
 * Optimal parameters are calculated from expected item count and desired
 * false positive rate (FPR).
 *
 * Size formula:  m = ceil(-(n * ln(fpr)) / ln(2)^2)
 * Hash count:    k = ceil((m / n) * ln(2))
 * Hash indices:  h(i) = (h1 + i * h2) % m  (enhanced double hashing)
 */
export class BloomFilter {
  private readonly cells: Uint8Array;
  private readonly size: number;
  private readonly hashCount: number;
  private _count: number = 0;

  constructor(expectedItems: number, fpr: number) {
    const ln2 = Math.LN2;
    const ln2sq = ln2 * ln2;

    this.size = Math.ceil(-(expectedItems * Math.log(fpr)) / ln2sq);
    this.hashCount = Math.ceil((this.size / expectedItems) * ln2);
    this.cells = new Uint8Array(this.size);
  }

  /** Number of items that have been added (net of removals). */
  get count(): number {
    return this._count;
  }

  /** Add a single item to the filter. */
  add(item: string): void {
    const indices = this.getIndices(item);
    for (const idx of indices) {
      if (this.cells[idx] < 255) {
        this.cells[idx]++;
      }
    }
    this._count++;
  }

  /** Add multiple items to the filter. */
  addAll(items: string[]): void {
    for (const item of items) {
      this.add(item);
    }
  }

  /**
   * Check if an item might exist in the filter.
   * Returns false means the item is definitely not present.
   * Returns true means the item is probably present (may be a false positive).
   */
  has(item: string): boolean {
    const indices = this.getIndices(item);
    for (const idx of indices) {
      if (this.cells[idx] === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Remove an item from the filter.
   * Only valid for items that were previously added; removing an item
   * that was never added may corrupt the filter.
   */
  remove(item: string): void {
    const indices = this.getIndices(item);
    for (const idx of indices) {
      if (this.cells[idx] > 0) {
        this.cells[idx]--;
      }
    }
    this._count--;
  }

  /**
   * Derive k hash indices for the given item using enhanced double hashing.
   * Two independent SHA-256 digests (with different prefixes) provide h1 and h2.
   * Index i is computed as: (h1 + i * h2) % size
   */
  private getIndices(item: string): number[] {
    // First base hash: SHA-256 of "0:" + item
    const digest1 = createHash("sha256").update("0:").update(item).digest();
    // Second base hash: SHA-256 of "1:" + item
    const digest2 = createHash("sha256").update("1:").update(item).digest();

    // Read two 32-bit unsigned ints from each digest as BigInt to avoid
    // precision loss, then reduce modulo size.
    const h1 = this.readUInt32BE(digest1, 0);
    const h2 = this.readUInt32BE(digest2, 0);

    const indices: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      // Use BigInt arithmetic to avoid integer overflow on large sizes
      const index = Number((h1 + BigInt(i) * h2) % BigInt(this.size));
      indices.push(index);
    }
    return indices;
  }

  /** Read a 32-bit big-endian unsigned integer from a Buffer as BigInt. */
  private readUInt32BE(buf: Buffer, offset: number): bigint {
    return BigInt(buf.readUInt32BE(offset));
  }
}
