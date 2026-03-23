import { describe, it, expect } from "bun:test";
import { BloomFilter } from "../../src/dedup/bloom-filter";

describe("BloomFilter", () => {
  it("returns false for items not added", () => {
    const bf = new BloomFilter(1000, 0.01);
    expect(bf.has("ghost")).toBe(false);
    expect(bf.has("phantom")).toBe(false);
    expect(bf.has("never-added-item")).toBe(false);
  });

  it("returns true for items that were added", () => {
    const bf = new BloomFilter(1000, 0.01);
    bf.add("hello");
    bf.add("world");
    bf.add("foo");
    expect(bf.has("hello")).toBe(true);
    expect(bf.has("world")).toBe(true);
    expect(bf.has("foo")).toBe(true);
  });

  it("has acceptable false positive rate (< 2% for 10k items at 1% FPR)", () => {
    const n = 10_000;
    const bf = new BloomFilter(n, 0.01);

    // Add n items
    for (let i = 0; i < n; i++) {
      bf.add(`item-${i}`);
    }

    // Test 10k items that were NOT added
    let falsePositives = 0;
    const testCount = 10_000;
    for (let i = n; i < n + testCount; i++) {
      if (bf.has(`item-${i}`)) {
        falsePositives++;
      }
    }

    const fpr = falsePositives / testCount;
    expect(fpr).toBeLessThan(0.02); // < 2%
  });

  it("rebuilds from array via addAll", () => {
    const bf = new BloomFilter(100, 0.01);
    const items = ["alpha", "beta", "gamma", "delta"];
    bf.addAll(items);
    for (const item of items) {
      expect(bf.has(item)).toBe(true);
    }
    expect(bf.has("epsilon")).toBe(false);
  });

  it("removes an item", () => {
    const bf = new BloomFilter(1000, 0.01);
    bf.add("to-remove");
    bf.add("to-keep");
    expect(bf.has("to-remove")).toBe(true);
    bf.remove("to-remove");
    expect(bf.has("to-remove")).toBe(false);
    expect(bf.has("to-keep")).toBe(true);
  });

  it("reports correct count", () => {
    const bf = new BloomFilter(1000, 0.01);
    expect(bf.count).toBe(0);
    bf.add("a");
    expect(bf.count).toBe(1);
    bf.add("b");
    bf.add("c");
    expect(bf.count).toBe(3);
    bf.addAll(["d", "e"]);
    expect(bf.count).toBe(5);
    bf.remove("a");
    expect(bf.count).toBe(4);
  });
});
